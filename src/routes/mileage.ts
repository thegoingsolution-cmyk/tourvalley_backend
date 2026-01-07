import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

// 마일리지 정보 조회 (현재 마일리지)
router.get('/api/mileage/info', async (req: Request, res: Response) => {
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

    // 현재 사용 가능한 마일리지 조회
    // members 테이블의 mileage 컬럼에서 조회하거나,
    // mileage_transactions에서 계산
    const [mileageResult] = await pool.execute<any[]>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'earn' THEN amount ELSE -amount END), 0) as total_mileage
      FROM mileage_transactions
      WHERE member_id = ?`,
      [memberId]
    );

    const totalMileage = parseFloat(mileageResult[0]?.total_mileage || '0');

    res.json({
      success: true,
      totalMileage: Math.floor(totalMileage), // 정수로 반환
    });
  } catch (error) {
    console.error('마일리지 정보 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '마일리지 정보를 불러오는 중 오류가 발생했습니다.',
      totalMileage: 0,
    });
  }
});

// 마일리지 내역 조회
router.get('/api/mileage/list', async (req: Request, res: Response) => {
  try {
    const { member_id, inyear = '1', block_type = 'C', str_cur_page = '1' } = req.query;

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

    // 마일리지 내역 조회
    // amount는 항상 양수로 정규화 (기존 음수 데이터와 새 양수 데이터 호환)
    const [mileageHistory] = await pool.execute<any[]>(
      `SELECT 
        id,
        CASE 
          WHEN type = 'earn' THEN '적립'
          WHEN type = 'use' THEN '사용'
          WHEN type = 'expire' THEN '만료'
          WHEN type = 'cancel' THEN '취소'
          ELSE type
        END as type,
        ABS(amount) as amount,
        balance,
        COALESCE(reason, description) as reason,
        reason_detail,
        created_at
      FROM mileage_transactions
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
      FROM mileage_transactions
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
      mileageList: mileageHistory,
      pagination: {
        currentPage,
        totalPages,
        totalCount,
        pageSize,
      },
    });
  } catch (error) {
    console.error('마일리지 내역 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '마일리지 내역을 불러오는 중 오류가 발생했습니다.',
      mileageList: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalCount: 0,
        pageSize: 10,
      },
    });
  }
});

// 문화상품권 전환신청
router.post('/api/mileage/exchange-gift', async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const { gift_type, quantity, total_amount, total_mileage, member_id } = req.body;

    if (!member_id) {
      return res.status(400).json({
        success: false,
        message: 'member_id가 필요합니다.',
      });
    }

    const memberId = parseInt(String(member_id), 10);

    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id입니다.',
      });
    }

    if (!gift_type || !quantity || !total_amount || !total_mileage) {
      return res.status(400).json({
        success: false,
        message: '필수 정보가 누락되었습니다.',
      });
    }

    if (total_amount < 10000) {
      return res.status(400).json({
        success: false,
        message: '최소 10,000원 이상 신청 가능합니다.',
      });
    }

    // 회원 존재 여부 확인
    const [memberCheck] = await connection.execute<any[]>(
      `SELECT id FROM members WHERE id = ?`,
      [memberId]
    );

    if (!memberCheck || memberCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: '회원 정보를 찾을 수 없습니다.',
      });
    }

    // 현재 마일리지 확인 (mileage_transactions에서 계산)
    const [mileageResult] = await connection.execute<any[]>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'earn' THEN amount ELSE -amount END), 0) as total_mileage
      FROM mileage_transactions
      WHERE member_id = ?`,
      [memberId]
    );

    const currentMileage = Math.floor(parseFloat(mileageResult[0]?.total_mileage || '0'));

    if (currentMileage < total_mileage) {
      return res.status(400).json({
        success: false,
        message: '사용 가능한 마일리지가 부족합니다.',
      });
    }

    // 마일리지 차감
    const newMileage = currentMileage - total_mileage;

    // mileage_transactions에 거래 기록 추가 (먼저 기록)
    // amount는 항상 양수로 저장 (type으로 구분)
    const descriptionText = `${gift_type === 'CO10000' ? '문화상품권 10,000원권(온라인)' : '문화상품권 10,000원권(모바일)'} ${quantity}매`;
    const reasonText = '문화상품권 전환';
    const reasonDetailText = descriptionText;

    const [transactionResult] = await connection.execute<any>(
      `INSERT INTO mileage_transactions (
        member_id, type, amount, description, reason, reason_detail, reference_type,
        balance, created_at
      ) VALUES (?, 'use', ?, ?, ?, ?, 'gift_exchange', ?, NOW())`,
      [
        memberId,
        total_mileage, // 양수로 저장 (type='use'이므로 계산 시 음수로 처리됨)
        descriptionText,
        reasonText,
        reasonDetailText,
        newMileage,
      ]
    );

    const transactionId = transactionResult.insertId;

    if (!transactionId) {
      throw new Error('mileage_transactions INSERT 실패: insertId가 없습니다.');
    }

    console.log(`✅ mileage_transactions INSERT 성공: transactionId=${transactionId}, memberId=${memberId}, amount=${total_mileage} (type=use)`);

    // members 테이블의 mileage 업데이트
    await connection.execute(
      `UPDATE members SET mileage = ? WHERE id = ?`,
      [newMileage, memberId]
    );

    // mileage_gift_exchanges 테이블에 신청 정보 저장 (배송 정보 관리용)
    // 테이블이 없으면 생성해야 함
    await connection.execute(
      `INSERT INTO mileage_gift_exchanges (
        transaction_id, member_id, gift_type, quantity, amount,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, '신청', NOW())`,
      [transactionId, memberId, gift_type, quantity, total_amount]
    );

    await connection.commit();

    res.json({
      success: true,
      message: '문화상품권 전환신청이 완료되었습니다.',
      transaction_id: transactionId,
      remaining_mileage: newMileage,
    });
  } catch (error) {
    await connection.rollback();
    console.error('문화상품권 전환신청 오류:', error);
    res.status(500).json({
      success: false,
      message: '신청 중 오류가 발생했습니다.',
    });
  } finally {
    connection.release();
  }
});

export default router;

