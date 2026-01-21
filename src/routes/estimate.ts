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
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

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
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: '필수 정보가 누락되었습니다.',
      });
    }

    if (!contractor_name || !contractor_phone || !contractor_email) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: '신청자 정보를 모두 입력해주세요.',
      });
    }

    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: '피보험자 정보를 입력해주세요.',
      });
    }

    // 견적 신청번호 생성
    const requestNumber = await generateRequestNumber();

    // 1. estimate_requests 테이블에 기본 정보 저장
    const [result] = await connection.execute(
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
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        '견적신청',
      ]
    ) as any[];

    const estimateId = (result as any).insertId;

    // 2. estimate_contractors 테이블에 계약자 정보 저장
    const [contractorResult] = await connection.execute(
      `INSERT INTO estimate_contractors (
        estimate_request_id,
        contractor_type,
        name,
        mobile_phone,
        email
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        estimateId,
        '개인',
        contractor_name,
        contractor_phone,
        contractor_email,
      ]
    ) as any[];

    const contractorId = (contractorResult as any).insertId;

    // 3. estimate_insured_persons 및 estimate_companions 테이블에 피보험자 정보 저장
    // 생년월일에서 나이 계산 및 성별 추출
    const calculateAgeFromBirthDate = (birthDate: string): number => {
      if (!birthDate || birthDate.length !== 8) return 0;
      const year = parseInt(birthDate.substring(0, 4));
      const month = parseInt(birthDate.substring(4, 6));
      const day = parseInt(birthDate.substring(6, 8));
      const today = new Date();
      const birth = new Date(year, month - 1, day);
      let age = today.getFullYear() - birth.getFullYear();
      const monthDiff = today.getMonth() - birth.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
      }
      return age;
    };

    // 생년월일에서 주민번호 생성 (YYMMDD-GNNNNNN 형식)
    // 생년월일: YYYYMMDD (예: 19931208)
    // 주민번호: YYMMDD-GNNNNNN (예: 931208-1000000)
    const generateResidentNumber = (birthDate: string, gender: string): string => {
      if (!birthDate || birthDate.length !== 8) return '';
      
      // YYYYMMDD에서 YYMMDD 추출 (연도 뒷 2자리만 사용)
      const year = birthDate.substring(0, 4);
      const month = birthDate.substring(4, 6);
      const day = birthDate.substring(6, 8);
      const yy = year.substring(2, 4); // 연도 뒷 2자리
      
      // 성별 코드 결정 (남자: 1 또는 3, 여자: 2 또는 4)
      // 2000년대생 여부에 따라 다르지만, 일단 기본값으로 설정
      // 1900년대생: 남자 1, 여자 2
      // 2000년대생: 남자 3, 여자 4
      let genderCode = '1'; // 기본값: 남자 (1900년대)
      if (gender === '여자') {
        genderCode = '2'; // 여자 (1900년대)
      }
      
      // 연도 앞자리가 20이면 2000년대생
      if (year.startsWith('20')) {
        if (gender === '남자') {
          genderCode = '3'; // 남자 (2000년대)
        } else {
          genderCode = '4'; // 여자 (2000년대)
        }
      }
      
      // YYMMDD + G + 000000 (총 13자리)
      return `${yy}${month}${day}${genderCode}000000`;
    };

    let totalPremium = 0;

    for (let i = 0; i < participants.length; i++) {
      const participant = participants[i];
      const sequence = participant.sequence || (i + 1);
      const birthDate = participant.birth_date;
      const gender = participant.gender === '남자' ? '남자' : '여자';
      const age = calculateAgeFromBirthDate(birthDate);
      const residentNumber = generateResidentNumber(birthDate, gender);

      // 3-1. estimate_insured_persons에 저장 (첫 번째만, 나머지는 companions로)
      if (i === 0) {
        await connection.execute(
          `INSERT INTO estimate_insured_persons (
            estimate_request_id,
            contractor_id,
            is_same_as_contractor,
            name,
            resident_number,
            gender,
            health_status,
            has_illness_history,
            sequence_number
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            estimateId,
            contractorId,
            0,
            '보험대상자1',
            residentNumber,
            gender,
            '좋다',
            0,
            sequence,
          ]
        );
      }

      // 3-2. estimate_companions에 저장 (모든 피보험자)
      // 보험료는 나중에 계산하거나 0으로 설정
      await connection.execute(
        `INSERT INTO estimate_companions (
          estimate_request_id,
          name,
          resident_number,
          gender,
          has_illness_history,
          has_medical_expense,
          plan_type,
          premium,
          sequence_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          estimateId,
          `보험대상자${sequence}`,
          residentNumber,
          gender,
          0,
          0,
          age < 15 ? '어린이플랜' : '실속플랜',
          0,
          sequence,
        ]
      );
    }

    await connection.commit();

    // 상태를 신청으로 유지 (관리자가 견적 발송 버튼을 누를 때까지)
    // 이메일 발송은 관리자 화면에서 "견적 발송" 버튼을 통해 처리

    return res.json({
      success: true,
      message: '견적 신청이 완료되었습니다.',
      data: {
        request_number: requestNumber,
        estimate_id: estimateId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error('견적 신청 오류:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '견적 신청 중 오류가 발생했습니다.',
    });
  } finally {
    connection.release();
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

    // 참가자 정보 조회 (새 테이블 구조 우선, 없으면 기존 participants JSON 사용)
    let participants = [];
    let totalPremium = 0;

    // estimate_companions 테이블에서 조회 시도
    const [companionRows] = await pool.execute(
      `SELECT * FROM estimate_companions 
       WHERE estimate_request_id = ? 
       ORDER BY sequence_number ASC`,
      [estimate.id]
    ) as any[];

    if (companionRows && companionRows.length > 0) {
      // 새 테이블 구조 사용
      for (const companion of companionRows) {
        // 주민번호에서 생년월일 추출 (앞 6자리: YYMMDD)
        let birthDate = '';
        if (companion.resident_number && companion.resident_number.length >= 6) {
          const yy = companion.resident_number.substring(0, 2);
          const mm = companion.resident_number.substring(2, 4);
          const dd = companion.resident_number.substring(4, 6);
          // 1900년대 또는 2000년대 판단 (간단히 50 이상이면 1900년대)
          const yearPrefix = parseInt(yy) >= 50 ? '19' : '20';
          birthDate = `${yearPrefix}${yy}${mm}${dd}`;
        }

        const age = birthDate ? calculateAge(birthDate) : 0;
        const planType = companion.plan_type || (age < 15 ? '어린이플랜' : '실속플랜');
        
        // 보험료가 0이면 계산
        let premium = parseFloat(companion.premium) || 0;
        if (premium === 0 && birthDate) {
          premium = await calculatePremium(
            insuranceType,
            age,
            companion.gender || '남자',
            planType,
            startDate,
            endDate
          );
        }

        participants.push({
          sequence: companion.sequence_number,
          gender: companion.gender || '남자',
          birth_date: birthDate,
          age,
          planType,
          premium,
        });

        totalPremium += premium;
      }
    } else {
      // 기존 participants JSON 사용 (호환성)
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

      // 피보험자별 보험료 계산
      const participantsWithPremium = [];
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
      participants = participantsWithPremium;
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
        participants: participants,
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

