import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

// 공지사항 목록 조회 (최신 순, 제한 개수)
router.get('/notices', async (req: Request, res: Response) => {
  try {
    const { limit = '10' } = req.query;
    const limitNum = parseInt(limit as string, 10) || 10;

    const [rows] = await pool.query<any[]>(
      `SELECT id, title, author_name, view_count, created_at 
       FROM notices 
       WHERE is_deleted = 0
       ORDER BY created_at DESC 
       LIMIT ?`,
      [limitNum]
    );

    res.json({
      success: true,
      notices: rows,
    });
  } catch (error) {
    console.error('Get notices error:', error);
    res.status(500).json({
      success: false,
      message: '공지사항 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// 공지사항 상세 조회
router.get('/notices/:id', async (req: Request, res: Response) => {
  try {
    const noticeId = parseInt(req.params.id, 10);

    if (isNaN(noticeId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 공지사항 ID입니다.',
      });
    }

    // 조회수 증가
    await pool.execute(
      'UPDATE notices SET view_count = view_count + 1 WHERE id = ? AND is_deleted = 0',
      [noticeId]
    );

    // 상세 정보 조회
    const [rows] = await pool.execute<any[]>(
      `SELECT id, title, content, author_name, view_count, created_at, updated_at 
       FROM notices 
       WHERE id = ? AND is_deleted = 0`,
      [noticeId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '공지사항을 찾을 수 없습니다.',
      });
    }

    res.json({
      success: true,
      notice: rows[0],
    });
  } catch (error) {
    console.error('Get notice detail error:', error);
    res.status(500).json({
      success: false,
      message: '공지사항을 불러오는 중 오류가 발생했습니다.',
    });
  }
});

export default router;

