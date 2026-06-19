import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { sendEstimateEmail, calculateAge, calculatePremium, getInsuranceType } from '../services/emailService';
import { generateAlimTalkMessage } from '../services/alimtalkMessageGenerator';
import { sendAlimTalk } from '../services/aligoService';
import {
  DOMESTIC_SILSOK_AGE,
  isDomesticMedicalExpenseOn,
} from '../constants/domesticAgeBrackets';

const router = Router();

const toDigits = (value: unknown): string => String(value || '').replace(/\D/g, '');

const getBirthDateFromResidentNumber = (residentNumber: unknown): string => {
  const digits = toDigits(residentNumber);
  if (digits.length < 7) return '';
  const yy = digits.substring(0, 2);
  const mm = digits.substring(2, 4);
  const dd = digits.substring(4, 6);
  const genderCode = parseInt(digits.substring(6, 7), 10);
  const century =
    genderCode === 3 || genderCode === 4 || genderCode === 7 || genderCode === 8
      ? '20'
      : '19';
  return `${century}${yy}${mm}${dd}`;
};

const normalizeEstimatePlanTypeForPrint = (
  insuranceType: string,
  rawPlanType: unknown,
  age?: number,
  hasMedicalExpense?: unknown
): string => {
  const raw = String(rawPlanType || '').trim();
  const p = raw.includes('|') ? raw.split('|')[0].trim() : raw;
  const a = Number.isFinite(age) ? Number(age) : null;
  const silsok = isDomesticMedicalExpenseOn(hasMedicalExpense);

  const isDomestic = insuranceType.includes('국내');
  if (!isDomestic) return p || '실속플랜';

  if (p === '어르신플랜' || p === '어르신플랜1' || p === '어르신플랜2') {
    return '어르신플랜1(실속)';
  }

  const seniorMin = DOMESTIC_SILSOK_AGE.seniorMin;
  if (!p) {
    if (a !== null && a >= seniorMin) return '어르신플랜1(실속)';
    return '실속플랜';
  }
  if (a !== null && a >= seniorMin) {
    if (p === '실속플랜') return '어르신플랜1(실속)';
    if (p === '표준플랜') return silsok ? '어르신플랜1(표준)' : '어르신플랜1(표준)';
  }
  return p;
};

// 견적 신청번호 생성 (YYYYMMDD + 일련번호)
// connection을 사용하여 트랜잭션 내에서 안전하게 생성
const generateRequestNumber = async (connection: any): Promise<string> => {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `EST${dateStr}`;
  
  // 오늘 날짜로 시작하는 견적 신청의 최대 일련번호 조회 (SELECT FOR UPDATE로 락)
  const [rows] = await connection.execute(
    `SELECT MAX(CAST(SUBSTRING(request_number, 12) AS UNSIGNED)) as max_seq 
     FROM estimate_requests 
     WHERE request_number LIKE ? FOR UPDATE`,
    [`${prefix}%`]
  ) as any[];
  
  const maxSeq = rows[0]?.max_seq || 0;
  const sequence = String(maxSeq + 1).padStart(4, '0');
  
  return `${prefix}${sequence}`;
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
      travel_region,
      travel_country,
      affiliate: bodyAffiliate,
      access_path: bodyAccessPath,
    } = req.body;

    const resolvedAffiliate =
      (bodyAffiliate && String(bodyAffiliate).trim()) || '투어밸리';
    const resolvedAccessPath =
      (bodyAccessPath && String(bodyAccessPath).trim()) || '투어밸리 사이트';

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

    const resolvedTravelCountry =
      travel_country && String(travel_country).trim()
        ? String(travel_country).trim()
        : null;
    let resolvedTravelRegion =
      travel_region !== undefined && travel_region !== null && String(travel_region).trim()
        ? String(travel_region).trim()
        : null;

    if (product_cd === '국내여행') {
      resolvedTravelRegion = '전국일원';
    } else if (product_cd === '해외여행') {
      resolvedTravelRegion = null;
      if (!resolvedTravelCountry) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: '여행국가를 선택해주세요.',
        });
      }
    }

    // 견적 신청번호 생성 (트랜잭션 내에서 안전하게 생성)
    const requestNumber = await generateRequestNumber(connection);

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
        travel_region,
        travel_country,
        affiliate,
        access_path,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        resolvedTravelRegion,
        resolvedTravelCountry,
        resolvedAffiliate,
        resolvedAccessPath,
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

    const submitInsuranceType = getInsuranceType(product_cd);
    for (let i = 0; i < participants.length; i++) {
      const participant = participants[i];
      const sequence = participant.sequence || (i + 1);
      const birthDate = participant.birth_date;
      const gender = participant.gender === '남자' ? '남자' : '여자';
      const age = calculateAgeFromBirthDate(birthDate);
      const residentNumber = generateResidentNumber(birthDate, gender);
      const rawPlanType =
        participant.planType ||
        participant.plan_type ||
        participant.plan ||
        '';
      const rawHasMedicalExpense =
        participant.has_medical_expense ?? participant.hasMedicalExpense;
      const hasMedicalExpense =
        rawHasMedicalExpense === 0 || rawHasMedicalExpense === '0' || rawHasMedicalExpense === false
          ? 0
          : 1;
      const normalizedPlanType = normalizeEstimatePlanTypeForPrint(
        submitInsuranceType,
        rawPlanType,
        age,
        hasMedicalExpense
      );

      // 3. estimate_companions에 저장 (모든 피보험자)
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
          hasMedicalExpense,
          normalizedPlanType,
          0,
          sequence,
        ]
      );
    }

    await connection.commit();

    // 상태를 신청으로 유지 (관리자가 견적 발송 버튼을 누를 때까지)
    // 이메일 발송은 관리자 화면에서 "견적 발송" 버튼을 통해 처리

    try {
      const now = new Date();
      const requestDateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const insurancePeriod = `${start_date} ${start_hour}시 ~ ${end_date} ${end_hour}시`;
      const insuranceProduct = getInsuranceType(product_cd);
      // 가입자 및 인원: 1번 피보험자(DB 저장명) 기준. participants 배열이 전체 인원이므로 총 인원 = participants.length
      const totalParticipants = participants.length;
      const firstCompanionName = '보험대상자1';
      const participantSummary =
        totalParticipants <= 1 ? firstCompanionName : `${firstCompanionName} 외 ${totalParticipants - 1}명`;

      const message = generateAlimTalkMessage('estimate_request', {
        customerName: contractor_name,
        queryDate: requestDateTime,
        insuranceProduct,
        insurancePeriod,
        participants: participantSummary,
      });

      await sendAlimTalk({
        receiver: contractor_phone,
        template_code: 'UE_8120',
        subject: '여행자 보험 견적 신청',
        message,
        receiver_name: contractor_name,
        button: [
          {
            name: '채널 추가',
            linkType: 'AC',
          },
        ],
      });
    } catch (error) {
      console.error('견적신청 알림톡 발송 실패:', error);
    }

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
        // 주민번호 → YYYYMMDD (성별자리 기준 세기 판단)
        const birthDate = getBirthDateFromResidentNumber(companion.resident_number);

        const age = birthDate ? calculateAge(birthDate) : 0;
        const planType = normalizeEstimatePlanTypeForPrint(
          insuranceType,
          companion.plan_type,
          age,
          companion.has_medical_expense
        );
        
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
        const planType = normalizeEstimatePlanTypeForPrint(
          insuranceType,
          participant.planType,
          age,
          participant.has_medical_expense ?? participant.hasMedicalExpense
        );
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

