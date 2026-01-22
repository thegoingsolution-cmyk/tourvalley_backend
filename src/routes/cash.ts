import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

// 무사고캐시 정보 조회 (총액, 소멸예정 캐시)
router.get('/api/cash/info', async (req: Request, res: Response) => {
  try {
    const { member_id } = req.query;

    if (!member_id) {
      return res.status(400).json({
        success: false,
        message: 'member_id가 필요합니다.',
      });
    }

    const memberId = parseInt(member_id as string, 10);

    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id입니다.',
      });
    }

    // 무사고캐시 총액 조회 (현재 사용 가능한 캐시)
    // members 테이블의 accident_free_cash 컬럼에서 조회하거나, 
    // accident_free_cash_history에서 계산
    const [cashResult] = await pool.execute<any[]>(
      `SELECT COALESCE(SUM(CASE WHEN type = '충전' THEN amount ELSE -amount END), 0) as total_cash
      FROM accident_free_cash_history
      WHERE member_id = ?`,
      [memberId]
    );

    // 소멸예정 캐시는 현재 스키마에 expire_date가 없으므로 0으로 반환
    // TODO: 소멸예정일 로직이 추가되면 구현 필요
    const expireCash = 0;

    const totalCash = parseFloat(cashResult[0]?.total_cash || '0');

    res.json({
      success: true,
      totalCash: Math.floor(totalCash / 10) * 10, // 십원단위 절삭
      expireCash: Math.floor(expireCash / 10) * 10, // 십원단위 절삭
    });
  } catch (error) {
    console.error('무사고캐시 정보 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '무사고캐시 정보를 불러오는 중 오류가 발생했습니다.',
      totalCash: 0,
      expireCash: 0,
    });
  }
});

// 무사고캐시 내역 조회
router.get('/api/cash/list', async (req: Request, res: Response) => {
  try {
    const { member_id, inyear = '1', str_cur_page = '1' } = req.query;

    if (!member_id) {
      return res.status(400).json({
        success: false,
        message: 'member_id가 필요합니다.',
      });
    }

    const memberId = parseInt(member_id as string, 10);
    const inYear = parseInt(inyear as string, 10);
    const currentPage = parseInt(str_cur_page as string, 10);
    const pageSize = 10;

    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id입니다.',
      });
    }

    // 날짜 범위 계산
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - inYear);

    const offset = (currentPage - 1) * pageSize;

    // LIMIT와 OFFSET은 정수로 확실히 변환
    const limitValue = parseInt(String(pageSize), 10);
    const offsetValue = parseInt(String(offset), 10);

    // 날짜를 MySQL DATETIME 형식으로 포맷팅 (로컬 시간 사용, UTC 아님)
    const formatDateForMySQL = (date: Date): string => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    const startDateStr = formatDateForMySQL(startDate);
    const endDateStr = formatDateForMySQL(endDate);

    // 무사고캐시 내역 조회
    const [cashHistory] = await pool.execute<any[]>(
      `SELECT 
        id,
        type,
        amount,
        balance,
        reason,
        reason_detail,
        created_at
      FROM accident_free_cash_history
      WHERE member_id = ? 
        AND created_at >= ? 
        AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT ${limitValue} OFFSET ${offsetValue}`,
      [memberId, startDateStr, endDateStr]
    );

    // 전체 개수 조회
    const [countResult] = await pool.execute<any[]>(
      `SELECT COUNT(*) as total
      FROM accident_free_cash_history
      WHERE member_id = ? 
        AND created_at >= ? 
        AND created_at <= ?`,
      [memberId, startDateStr, endDateStr]
    );

    const totalCount = countResult[0]?.total || 0;
    const totalPages = Math.ceil(totalCount / pageSize);

    // 데이터만 반환 (HTML은 프론트에서 생성)
    res.json({
      success: true,
      cashList: cashHistory,
      pagination: {
        currentPage,
        totalPages,
        totalCount,
        pageSize,
      },
    });
  } catch (error) {
    console.error('무사고캐시 내역 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '무사고캐시 내역을 불러오는 중 오류가 발생했습니다.',
      cashList: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalCount: 0,
        pageSize: 10,
      },
    });
  }
});

// 무사고캐시 적립 가능한 계약 목록 조회
router.get('/api/cash/eligible-contracts', async (req: Request, res: Response) => {
  try {
    const { member_id } = req.query;

    if (!member_id) {
      return res.status(400).json({
        success: false,
        message: 'member_id가 필요합니다.',
      });
    }

    const memberId = parseInt(member_id as string, 10);

    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id입니다.',
      });
    }

    // 회원 타입 확인 (개인만 가능)
    const [memberResult] = await pool.execute<any[]>(
      `SELECT member_type FROM members WHERE id = ?`,
      [memberId]
    );

    if (!memberResult || memberResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: '회원을 찾을 수 없습니다.',
      });
    }

    if (memberResult[0].member_type !== '개인') {
      return res.json({
        success: true,
        contracts: [],
      });
    }

    const now = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(now.getFullYear() - 1);

    // 이미 적립한 계약 ID 조회
    const [accumulatedContracts] = await pool.execute<any[]>(
      `SELECT reason_detail
      FROM accident_free_cash_history 
      WHERE member_id = ? 
        AND reason LIKE '%보험기간 종료 후 무사고캐시 적립%'
        AND type = '충전'
        AND reason_detail LIKE '%계약번호: %'`,
      [memberId]
    );

    const accumulatedContractIds = new Set<number>();
    accumulatedContracts.forEach((row: any) => {
      const match = row.reason_detail?.match(/계약번호:\s*(\d+)/);
      if (match) {
        accumulatedContractIds.add(parseInt(match[1], 10));
      }
    });

    // 보험기간 종료 후 1년 이내이고, 아직 적립하지 않은 계약 조회
    // 해외여행보험, 국내여행보험만 가능
    // 주의: arrival_date는 보험기간 종료일(도착일)을 의미
    let contractsQuery = `SELECT 
      tc.id,
      CONCAT(
        DATE_FORMAT(tc.created_at, '%y%m%d'),
        '-',
        tc.id
      ) as contract_number,
      tc.insurance_type,
      tc.departure_date,
      tc.arrival_date,
      tc.total_premium,
      tc.status,
      tc.created_at,
      tc.travel_region,
      tc.travel_country,
      tc.travel_purpose,
      DATEDIFF(?, tc.arrival_date) as days_since_end,
      CASE 
        WHEN DATEDIFF(?, tc.arrival_date) > 365 THEN 0
        ELSE 1
      END as is_eligible
    FROM travel_contracts tc
    WHERE tc.member_id = ?
      AND tc.insurance_type IN ('해외여행보험', '국내여행보험')
      AND tc.arrival_date < ?
      AND tc.arrival_date >= ?
      AND tc.payment_status = '결제완료'`;

    if (accumulatedContractIds.size > 0) {
      const ids = Array.from(accumulatedContractIds).join(',');
      contractsQuery += ` AND tc.id NOT IN (${ids})`;
    }

    contractsQuery += ` ORDER BY tc.arrival_date DESC`;

    console.log('적립 가능 계약 조회 쿼리:', contractsQuery);
    console.log('파라미터:', { memberId, now: now.toISOString(), oneYearAgo: oneYearAgo.toISOString() });

    const [contracts] = await pool.execute<any[]>(
      contractsQuery,
      [now, now, memberId, now, oneYearAgo]
    );

    console.log('조회된 계약 수:', contracts.length);
    if (contracts.length > 0) {
      console.log('첫 번째 계약 샘플:', {
        id: contracts[0].id,
        arrival_date: contracts[0].arrival_date,
        status: contracts[0].status,
        days_since_end: contracts[0].days_since_end,
        is_eligible: contracts[0].is_eligible
      });
    }

    // 적립 가능 금액 계산 (보험료의 10%, 최대 30,000원)
    const eligibleContracts = contracts.map((contract: any) => {
      const premium = parseFloat(contract.total_premium || '0');
      const cashAmount = Math.min(Math.floor(premium * 0.1), 30000);
      const cashAmountRounded = Math.floor(cashAmount / 10) * 10; // 십원 단위 절삭

      return {
        ...contract,
        eligibleCashAmount: cashAmountRounded,
        daysSinceEnd: contract.days_since_end,
        isEligible: contract.is_eligible === 1,
      };
    }).filter((contract: any) => contract.isEligible);

    res.json({
      success: true,
      contracts: eligibleContracts,
    });
  } catch (error) {
    console.error('무사고캐시 적립 가능 계약 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '적립 가능한 계약을 불러오는 중 오류가 발생했습니다.',
      contracts: [],
    });
  }
});

// 무사고캐시 적립
router.post('/api/cash/accumulate', async (req: Request, res: Response) => {
  try {
    const { member_id, contract_id } = req.body;

    if (!member_id || !contract_id) {
      return res.status(400).json({
        success: false,
        message: 'member_id와 contract_id가 필요합니다.',
      });
    }

    const memberId = parseInt(member_id as string, 10);
    const contractId = parseInt(contract_id as string, 10);

    if (isNaN(memberId) || isNaN(contractId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id 또는 contract_id입니다.',
      });
    }

    // 회원 타입 확인
    const [memberResult] = await pool.execute<any[]>(
      `SELECT member_type FROM members WHERE id = ?`,
      [memberId]
    );

    if (!memberResult || memberResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: '회원을 찾을 수 없습니다.',
      });
    }

    if (memberResult[0].member_type !== '개인') {
      return res.status(403).json({
        success: false,
        message: '법인 고객은 무사고캐시를 적립할 수 없습니다.',
      });
    }

    // 계약 정보 조회
    const [contractResult] = await pool.execute<any[]>(
      `SELECT 
        id,
        insurance_type,
        arrival_date,
        total_premium,
        status
      FROM travel_contracts
      WHERE id = ? AND member_id = ?`,
      [contractId, memberId]
    );

    if (!contractResult || contractResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약을 찾을 수 없습니다.',
      });
    }

    const contract = contractResult[0];

    // 보험 종류 확인
    if (!['해외여행보험', '국내여행보험'].includes(contract.insurance_type)) {
      return res.status(400).json({
        success: false,
        message: '해당 보험 종류는 무사고캐시 적립이 불가능합니다.',
      });
    }

    // 보험기간 종료 후 1년 이내인지 확인
    const arrivalDate = new Date(contract.arrival_date);
    const now = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(now.getFullYear() - 1);

    if (arrivalDate >= now || arrivalDate < oneYearAgo) {
      return res.status(400).json({
        success: false,
        message: '보험기간 종료 후 1년 이내에만 적립 가능합니다.',
      });
    }

    // 이미 적립했는지 확인
    const [existingResult] = await pool.execute<any[]>(
      `SELECT id FROM accident_free_cash_history
      WHERE member_id = ? 
        AND reason LIKE '%보험기간 종료 후 무사고캐시 적립%'
        AND reason_detail LIKE ?
        AND type = '충전'`,
      [memberId, `%계약번호: ${contractId}%`]
    );

    if (existingResult && existingResult.length > 0) {
      return res.status(400).json({
        success: false,
        message: '이미 적립된 계약입니다.',
      });
    }

    // 적립 금액 계산 (보험료의 10%, 최대 30,000원)
    const premium = parseFloat(contract.total_premium || '0');
    const cashAmount = Math.min(Math.floor(premium * 0.1), 30000);
    const cashAmountRounded = Math.floor(cashAmount / 10) * 10; // 십원 단위 절삭

    if (cashAmountRounded <= 0) {
      return res.status(400).json({
        success: false,
        message: '적립 가능한 금액이 없습니다.',
      });
    }

    // 현재 잔액 조회
    const [balanceResult] = await pool.execute<any[]>(
      `SELECT COALESCE(SUM(CASE WHEN type = '충전' THEN amount ELSE -amount END), 0) as balance
      FROM accident_free_cash_history
      WHERE member_id = ?`,
      [memberId]
    );

    const currentBalance = parseFloat(balanceResult[0]?.balance || '0');
    const newBalance = currentBalance + cashAmountRounded;

    // 트랜잭션 시작
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 무사고캐시 이력 추가
      await connection.execute(
        `INSERT INTO accident_free_cash_history 
        (member_id, type, amount, balance, reason, reason_detail, created_at)
        VALUES (?, '충전', ?, ?, ?, ?, NOW())`,
        [
          memberId,
          cashAmountRounded,
          newBalance,
          '보험기간 종료 후 무사고캐시 적립',
          `${contract.insurance_type} 계약번호: ${contractId}`,
        ]
      );

      // members 테이블의 accident_free_cash 업데이트
      await connection.execute(
        `UPDATE members 
        SET accident_free_cash = ?,
            updated_at = NOW()
        WHERE id = ?`,
        [newBalance, memberId]
      );

      await connection.commit();

      res.json({
        success: true,
        message: '무사고캐시가 적립되었습니다.',
        cashAmount: cashAmountRounded,
        newBalance: newBalance,
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('무사고캐시 적립 오류:', error);
    res.status(500).json({
      success: false,
      message: '무사고캐시 적립 중 오류가 발생했습니다.',
    });
  }
});

export default router;

