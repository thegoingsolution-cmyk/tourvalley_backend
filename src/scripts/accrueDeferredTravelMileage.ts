/**
 * 여행 계약 마일리지 적립 배치 (보험 종료일 + 3일 후, 가입완료 계약만)
 *
 * 크론 예시 (30분마다, 배포 후 dist 기준): cron 분 필드에 0,30 과 같이 두 번 실행해 주세요.
 *   cd /path/to/b2c_tourvalley_backend && node dist/scripts/accrueDeferredTravelMileage.js
 */
import dotenv from 'dotenv';
import pool from '../config/database';
import {
  TRAVEL_CONTRACT_MILEAGE_REASON,
  computeTravelContractMileageAmount,
} from '../utils/travelMileageEarn';

dotenv.config();

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** MySQL 과 비교용 — Node 프로세스의 로컬 타임존 기준 문자열(DB·서버 권장: Asia/Seoul) */
function formatLocalMysqlDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function parseCutoff(raw: string | undefined): Date | null {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim();
  const asDate = new Date(s.replace(' ', 'T'));
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

type EligibleRow = {
  contract_id: number;
  member_id: number;
  total_premium: string | number;
};

async function accrueDeferredTravelMileage(): Promise<void> {
  const cutoff = parseCutoff(process.env.MILEAGE_DEFER_ELIGIBLE_FROM);
  if (!cutoff) {
    console.error(
      '[accrueDeferredTravelMileage] MILEAGE_DEFER_ELIGIBLE_FROM 미설정 또는 형식 오류 (예: 2026-05-12 17:00:00, 서버 로컬시간 기준 권장: Asia/Seoul)'
    );
    process.exit(1);
    return;
  }

  const cutoffSql = formatLocalMysqlDateTime(cutoff);

  const [rows] = await pool.execute(
    `
    SELECT tc.id AS contract_id, tc.member_id, COALESCE(tc.total_premium, 0) AS total_premium
    FROM travel_contracts tc
    WHERE tc.status = '가입완료'
      AND tc.member_id IS NOT NULL
      AND tc.arrival_date IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM payments pay
        WHERE pay.contract_id = tc.id AND pay.status = '완료'
      )
      AND DATE(DATE_ADD(DATE(tc.arrival_date), INTERVAL 3 DAY)) <= CURDATE()
      AND tc.created_at >= ?
      AND NOT EXISTS (
        SELECT 1
        FROM mileage_transactions mt
        WHERE mt.reference_type = 'contract'
          AND mt.reference_id = tc.id
          AND mt.type = 'earn'
          AND mt.reason = ?
      )
    `,
    [cutoffSql, TRAVEL_CONTRACT_MILEAGE_REASON]
  );

  const eligible = (Array.isArray(rows) ? rows : []) as EligibleRow[];
  console.log(`[accrueDeferredTravelMileage] 대상 계약 건수: ${eligible.length} (created_at>=${cutoffSql})`);

  let ok = 0;
  let skip = 0;
  let err = 0;

  for (const row of eligible) {
    const contractId = Number(row.contract_id);
    const memberId = Number(row.member_id);
    const totalPremium = Number(row.total_premium);
    const mileageAmount = computeTravelContractMileageAmount(totalPremium);

    if (mileageAmount <= 0 || !memberId || !contractId) {
      skip++;
      continue;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [already] = await conn.execute(
        `SELECT COUNT(*) AS cnt
         FROM mileage_transactions
         WHERE reference_type = 'contract'
           AND reference_id = ?
           AND type = 'earn'
           AND reason = ?`,
        [contractId, TRAVEL_CONTRACT_MILEAGE_REASON]
      );
      if (Number((already as Array<{ cnt: number }>)[0]?.cnt) > 0) {
        await conn.rollback();
        skip++;
        continue;
      }

      await conn.execute(`SELECT id FROM travel_contracts WHERE id = ? FOR UPDATE`, [contractId]);

      await conn.execute(`UPDATE members SET mileage = mileage + ? WHERE id = ?`, [mileageAmount, memberId]);

      const [memberResult] = await conn.execute(
        `SELECT mileage FROM members WHERE id = ?`,
        [memberId]
      );
      const newBalance = Number((memberResult as Array<{ mileage: number }>)[0]?.mileage ?? 0);

      await conn.execute(
        `INSERT INTO mileage_transactions (
          member_id, type, amount, description, reason, reason_detail,
          reference_type, reference_id, balance
        ) VALUES (?, 'earn', ?, ?, ?, ?, 'contract', ?, ?)`,
        [
          memberId,
          mileageAmount,
          TRAVEL_CONTRACT_MILEAGE_REASON,
          TRAVEL_CONTRACT_MILEAGE_REASON,
          '보험 종료 후 적립 · 총 보험료의 3% (최대 30,000P)',
          contractId,
          newBalance,
        ]
      );

      await conn.commit();
      ok++;
      console.log(`[accrueDeferredTravelMileage] 적립 OK contract=${contractId} member=${memberId} +${mileageAmount}P`);
    } catch (e) {
      await conn.rollback();
      err++;
      console.error(`[accrueDeferredTravelMileage] 오류 contract=${contractId}`, e);
    } finally {
      conn.release();
    }
  }

  console.log(`[accrueDeferredTravelMileage] 완료 ok=${ok} skip=${skip} err=${err}`);
}

accrueDeferredTravelMileage()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[accrueDeferredTravelMileage] 치명적 오류', e);
    process.exit(1);
  });
