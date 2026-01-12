import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { sendEstimateEmail, calculateAge, calculatePremium, getInsuranceType } from '../services/emailService';

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

// 견적서 조회 API (출력용)
router.get('/api/estimate/:requestNumber', async (req: Request, res: Response) => {
  try {
    const { requestNumber } = req.params;

    // 견적 신청 정보 조회
    const [rows] = await pool.execute(
      `SELECT * FROM estimate_requests WHERE request_number = ?`,
      [requestNumber]
    ) as any[];

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '견적서를 찾을 수 없습니다.',
      });
    }

    const estimate = rows[0];

    // participants JSON 파싱
    let participants = [];
    try {
      if (typeof estimate.participants === 'string') {
        participants = JSON.parse(estimate.participants);
      } else if (Array.isArray(estimate.participants)) {
        participants = estimate.participants;
      }
    } catch (e) {
      console.error('참가자 정보 파싱 오류:', e);
      console.error('participants 데이터:', estimate.participants);
    }

    // 참가자가 없으면 에러 반환
    if (!participants || participants.length === 0) {
      console.error('참가자 정보가 없습니다. estimate_id:', estimate.id);
      return res.status(400).json({
        success: false,
        message: '참가자 정보가 없습니다. 견적서를 다시 신청해주세요.',
      });
    }

    // 날짜 형식 변환 (ISO -> YYYY-MM-DD)
    const formatDate = (dateStr: string): string => {
      if (!dateStr) return '';
      const date = new Date(dateStr);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const startDate = formatDate(estimate.start_date);
    const endDate = formatDate(estimate.end_date);

    // 보험종류 결정
    const insuranceType = getInsuranceType(estimate.product_cd);

    // 피보험자별 보험료 계산
    const participantsWithPremium = [];
    let totalPremium = 0;

    for (const participant of participants) {
      const age = calculateAge(participant.birth_date);
      const planType = age < 15 ? '어린이플랜' : '실속플랜';
      const premium = await calculatePremium(
        insuranceType,
        age,
        participant.gender === '남자' ? '남자' : '여자',
        planType,
        startDate,
        endDate
      );

      participantsWithPremium.push({
        ...participant,
        age,
        planType,
        premium,
      });

      totalPremium += premium;
    }

    return res.json({
      success: true,
      data: {
        request_number: estimate.request_number,
        product_cd: estimate.product_cd,
        insurance_type: insuranceType,
        start_date: startDate,
        start_hour: estimate.start_hour,
        end_date: endDate,
        end_hour: estimate.end_hour,
        tour_num: estimate.tour_num,
        tour_day: estimate.tour_day,
        contractor_name: estimate.contractor_name,
        contractor_phone: estimate.contractor_phone,
        contractor_email: estimate.contractor_email,
        participants: participantsWithPremium,
        total_premium: totalPremium,
        created_at: estimate.created_at,
        status: estimate.status,
      },
    });
  } catch (error) {
    console.error('견적서 조회 오류:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '견적서 조회 중 오류가 발생했습니다.',
    });
  }
});

export default router;

