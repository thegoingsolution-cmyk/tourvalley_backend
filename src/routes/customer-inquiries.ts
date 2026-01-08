import { Router, Request, Response } from 'express';
import pool from '../config/database';
import bcrypt from 'bcrypt';

const router = Router();

// 고객 질의 목록 조회 (페이지네이션 지원)
router.get('/customer-inquiries', async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '10' } = req.query;
    const pageNum = parseInt(page as string, 10) || 1;
    const limitNum = parseInt(limit as string, 10) || 10;
    const offset = (pageNum - 1) * limitNum;

    // 목록 조회
    const [rows] = await pool.query<any[]>(
      `SELECT id, title, author_name, status, is_secret, view_count, created_at 
       FROM customer_inquiries 
       WHERE is_deleted = 0
       ORDER BY created_at DESC 
       LIMIT ${Number(limitNum)} OFFSET ${Number(offset)}`
    );

    // 전체 개수 조회
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM customer_inquiries WHERE is_deleted = 0`
    );
    const total = countRows[0]?.total || 0;

    res.json({
      success: true,
      inquiries: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Get customer inquiries error:', error);
    res.status(500).json({
      success: false,
      message: '고객 질의 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// 고객 질의 상세 조회
router.get('/customer-inquiries/:id', async (req: Request, res: Response) => {
  try {
    const inquiryId = parseInt(req.params.id, 10);

    if (isNaN(inquiryId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 질의 ID입니다.',
      });
    }

    // 조회수 증가
    await pool.execute(
      'UPDATE customer_inquiries SET view_count = view_count + 1 WHERE id = ? AND is_deleted = 0',
      [inquiryId]
    );

    // 질의 상세 정보 조회
    const [inquiryRows] = await pool.execute<any[]>(
      `SELECT id, title, content, author_name, status, is_secret, view_count, created_at, updated_at 
       FROM customer_inquiries 
       WHERE id = ? AND is_deleted = 0`,
      [inquiryId]
    );

    if (!inquiryRows || inquiryRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '질의를 찾을 수 없습니다.',
      });
    }

    const inquiry = inquiryRows[0];
    
    // 비밀글인 경우 본인 확인 (쿼리 파라미터로 author_name 전달)
    const { author_name: requestAuthorName } = req.query;
    
    if (inquiry.is_secret === 1) {
      // 본인이 작성한 경우 내용 표시
      if (requestAuthorName && requestAuthorName === inquiry.author_name) {
        // 본인이 작성한 경우 내용 그대로 표시
      } else {
        // 본인이 아닌 경우 내용을 숨김
        inquiry.content = null;
        inquiry.is_secret_required = true;
      }
    }

    // 답변 조회
    const [responseRows] = await pool.execute<any[]>(
      `SELECT id, content, responder_name, created_at 
       FROM customer_inquiry_responses 
       WHERE inquiry_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [inquiryId]
    );

    if (responseRows && responseRows.length > 0) {
      inquiry.response = responseRows[0];
    }

    res.json({
      success: true,
      inquiry,
    });
  } catch (error) {
    console.error('Get customer inquiry detail error:', error);
    res.status(500).json({
      success: false,
      message: '질의를 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// 고객 질의 등록
router.post('/customer-inquiries', async (req: Request, res: Response) => {
  try {
    const { title, content, author_name, is_secret, secret_password } = req.body;
    const ip_address = req.ip || req.connection.remoteAddress || '';

    if (!title || !content || !author_name) {
      return res.status(400).json({
        success: false,
        message: '제목, 내용, 작성자를 모두 입력해주세요.',
      });
    }

    // 비밀글인 경우 비밀번호 확인
    if (is_secret && !secret_password) {
      return res.status(400).json({
        success: false,
        message: '비밀글은 비밀번호를 입력해주세요.',
      });
    }

    // 비밀번호 해시화
    let hashedPassword = null;
    if (is_secret && secret_password) {
      hashedPassword = await bcrypt.hash(secret_password, 10);
    }

    const [result] = await pool.execute<any>(
      `INSERT INTO customer_inquiries (title, content, author_name, ip_address, status, is_secret, secret_password) 
       VALUES (?, ?, ?, ?, '미완료', ?, ?)`,
      [title, content, author_name, ip_address, is_secret ? 1 : 0, hashedPassword]
    );

    res.json({
      success: true,
      inquiry_id: result.insertId,
      message: '질문이 등록되었습니다.',
    });
  } catch (error) {
    console.error('Create inquiry error:', error);
    res.status(500).json({
      success: false,
      message: '질문 등록 중 오류가 발생했습니다.',
    });
  }
});

// 비밀글 비밀번호 확인
router.post('/customer-inquiries/:id/verify-password', async (req: Request, res: Response) => {
  try {
    const inquiryId = parseInt(req.params.id, 10);
    const { password } = req.body;

    if (isNaN(inquiryId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 질의 ID입니다.',
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: '비밀번호를 입력해주세요.',
      });
    }

    // 질의 정보 조회 (비밀번호 포함)
    const [inquiryRows] = await pool.execute<any[]>(
      `SELECT id, title, content, author_name, status, is_secret, secret_password, view_count, created_at, updated_at 
       FROM customer_inquiries 
       WHERE id = ? AND is_deleted = 0`,
      [inquiryId]
    );

    if (!inquiryRows || inquiryRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '질의를 찾을 수 없습니다.',
      });
    }

    const inquiry = inquiryRows[0];

    if (inquiry.is_secret !== 1) {
      return res.status(400).json({
        success: false,
        message: '비밀글이 아닙니다.',
      });
    }

    // 비밀번호 확인
    if (!inquiry.secret_password) {
      return res.status(400).json({
        success: false,
        message: '비밀번호가 설정되지 않았습니다.',
      });
    }

    const isPasswordValid = await bcrypt.compare(password, inquiry.secret_password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: '비밀번호가 일치하지 않습니다.',
      });
    }

    // 비밀번호가 맞으면 내용 반환
    const { secret_password, ...inquiryWithoutPassword } = inquiry;
    
    // 답변 조회
    const [responseRows] = await pool.execute<any[]>(
      `SELECT id, content, responder_name, created_at 
       FROM customer_inquiry_responses 
       WHERE inquiry_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [inquiryId]
    );

    if (responseRows && responseRows.length > 0) {
      inquiryWithoutPassword.response = responseRows[0];
    }

    res.json({
      success: true,
      inquiry: inquiryWithoutPassword,
    });
  } catch (error) {
    console.error('Verify password error:', error);
    res.status(500).json({
      success: false,
      message: '비밀번호 확인 중 오류가 발생했습니다.',
    });
  }
});

export default router;

