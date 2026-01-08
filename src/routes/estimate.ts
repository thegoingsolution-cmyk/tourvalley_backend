import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { sendEstimateEmail } from '../services/emailService';

const router = Router();

// 견적 신청번호 생성 (YYYYMMDD + 일련번호)
const generateRequestNumber = async (): Promise<string> => {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  
  // 오늘 날짜로 시작하는 견적 신청 개수 조회
  const [rows] = await pool.execute(
    `SELECT COUNT(*) as count FROM estimate_requests 
     WHERE DATE(created_at) = CURDATE()`
  ) as any[];
  
  const count = rows[0]?.count || 0;
  const sequence = String(count + 1).padStart(4, '0');
  
  return `EST${dateStr}${sequence}`;
};

// 견적 신청 API
router.post('/api/estimate/submit', async (req: Request, res: Response) => {
  try {
    const {
      product_cd,
      start_date,
      start_hour,
      end_date,
      end_hour,
      tour_num,
      tour_day,
      contractor_name,
      contractor_phone,
      contractor_email,
      participants,
    } = req.body;

    // 필수 필드 검증
    if (!product_cd || !start_date || !end_date || !tour_num) {
      return res.status(400).json({
        success: false,
        message: '필수 정보가 누락되었습니다.',
      });
    }

    if (!contractor_name || !contractor_phone || !contractor_email) {
      return res.status(400).json({
        success: false,
        message: '신청자 정보를 모두 입력해주세요.',
      });
    }

    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({
        success: false,
        message: '피보험자 정보를 입력해주세요.',
      });
    }

    // 견적 신청번호 생성
    const requestNumber = await generateRequestNumber();

    // DB에 견적 신청 저장
    const [result] = await pool.execute(
      `INSERT INTO estimate_requests (
        request_number,
        product_cd,
        start_date,
        start_hour,
        end_date,
        end_hour,
        tour_num,
        tour_day,
        contractor_name,
        contractor_phone,
        contractor_email,
        participants,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestNumber,
        product_cd,
        start_date,
        start_hour,
        end_date,
        end_hour,
        parseInt(tour_num),
        tour_day ? parseInt(tour_day) : null,
        contractor_name,
        contractor_phone,
        contractor_email,
        JSON.stringify(participants),
        '신청',
      ]
    ) as any[];

    const estimateId = (result as any).insertId;

    // 이메일 발송
    let emailSent = false;
    let emailError = null;

    try {
      const emailResult = await sendEstimateEmail({
        contractorName: contractor_name,
        contractorEmail: contractor_email,
        productCd: product_cd,
        startDate: start_date,
        startHour: start_hour,
        endDate: end_date,
        endHour: end_hour,
        tourNum: parseInt(tour_num),
        participants: participants,
        requestNumber: requestNumber,
      });

      emailSent = emailResult.success;
      emailError = emailResult.success ? null : emailResult.message;

      // 이메일 발송 결과 업데이트
      if (emailSent) {
        await pool.execute(
          `UPDATE estimate_requests 
           SET email_sent = 1, 
               email_sent_at = NOW(), 
               email_error = NULL
           WHERE id = ?`,
          [estimateId]
        );
      } else {
        await pool.execute(
          `UPDATE estimate_requests 
           SET email_sent = 0, 
               email_error = ?
           WHERE id = ?`,
          [emailError, estimateId]
        );
      }
    } catch (emailErr) {
      console.error('이메일 발송 오류:', emailErr);
      emailError = emailErr instanceof Error ? emailErr.message : '이메일 발송 중 오류 발생';
      
      // 이메일 발송 실패해도 DB에는 저장됨
      await pool.execute(
        `UPDATE estimate_requests 
         SET email_sent = 0, 
             email_error = ?
         WHERE id = ?`,
        [emailError, estimateId]
      );
    }

    // 상태를 처리중으로 업데이트
    await pool.execute(
      `UPDATE estimate_requests SET status = '처리중' WHERE id = ?`,
      [estimateId]
    );

    return res.json({
      success: true,
      message: '견적 신청이 완료되었습니다.',
      data: {
        request_number: requestNumber,
        email_sent: emailSent,
      },
    });
  } catch (error) {
    console.error('견적 신청 오류:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '견적 신청 중 오류가 발생했습니다.',
    });
  }
});

export default router;

