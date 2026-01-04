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

    const startDateStr = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const endDateStr = endDate.toISOString().slice(0, 19).replace('T', ' ');

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
      [memberId, startDate.toISOString().slice(0, 19).replace('T', ' '), endDate.toISOString().slice(0, 19).replace('T', ' ')]
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

export default router;

