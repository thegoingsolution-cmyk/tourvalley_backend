import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { RowDataPacket } from 'mysql2';

const router = Router();

// 공지사항 목록 조회 (페이징 및 검색 지원)
router.get('/notices', async (req: Request, res: Response) => {
  try {
    const { 
      page = '1', 
      limit = '10',
      search = '',
      searchType = 'title' // title, content, all
    } = req.query;

    const pageNum = parseInt(page as string, 10) || 1;
    const limitNum = parseInt(limit as string, 10) || 10;
    const offset = (pageNum - 1) * limitNum;
    const searchQuery = (search as string).trim();

    // 검색 조건 구성
    let whereClause = 'WHERE is_deleted = 0';
    const queryParams: any[] = [];

    if (searchQuery) {
      if (searchType === 'title') {
        whereClause += ' AND title LIKE ?';
        queryParams.push(`%${searchQuery}%`);
      } else if (searchType === 'content') {
        whereClause += ' AND content LIKE ?';
        queryParams.push(`%${searchQuery}%`);
      } else if (searchType === 'all') {
        whereClause += ' AND (title LIKE ? OR content LIKE ?)';
        queryParams.push(`%${searchQuery}%`, `%${searchQuery}%`);
      }
    }

    // 전체 개수 조회
    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM notices ${whereClause}`,
      queryParams
    );
    const totalCount = countRows[0].total;

    // 목록 조회
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, title, author_name, view_count, created_at 
       FROM notices 
       ${whereClause}
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [...queryParams, limitNum, offset]
    );

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: {
        notices: rows,
        pagination: {
          currentPage: pageNum,
          totalPages,
          totalCount,
          limit: limitNum,
          hasNext: pageNum < totalPages,
          hasPrev: pageNum > 1,
        }
      }
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
    const [rows] = await pool.execute<RowDataPacket[]>(
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
      data: {
        notice: rows[0],
      }
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

