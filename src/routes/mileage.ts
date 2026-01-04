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
    // mileage_history에서 계산
    const [mileageResult] = await pool.execute<any[]>(
      `SELECT COALESCE(SUM(CASE WHEN type = '적립' THEN amount ELSE -amount END), 0) as total_mileage
      FROM mileage_history
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

    const startDateStr = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const endDateStr = endDate.toISOString().slice(0, 19).replace('T', ' ');

    // 마일리지 내역 조회
    const [mileageHistory] = await pool.execute<any[]>(
      `SELECT 
        id,
        type,
        amount,
        balance,
        reason,
        reason_detail,
        created_at
      FROM mileage_history
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
      FROM mileage_history
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

export default router;

