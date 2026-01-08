import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

// 프론트엔드 URL 추론 헬퍼 함수
const getFrontendUrl = (): string => {
  // 1. FRONTEND_URL 환경 변수가 있으면 사용
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.replace(/\/$/, '');
  }
  
  // 2. API_URL을 기반으로 추론 (https://www.bzvalley.net/api -> https://www.bzvalley.net)
  if (process.env.API_URL) {
    const apiUrl = process.env.API_URL.replace(/\/$/, '');
    // /api로 끝나면 제거
    if (apiUrl.endsWith('/api')) {
      return apiUrl.replace(/\/api$/, '');
    }
    return apiUrl;
  }
  
  // 3. 기본값 (프로덕션 환경에서는 https://www.bzvalley.net 사용)
  return process.env.NODE_ENV === 'production' 
    ? 'https://www.bzvalley.net'
    : 'http://localhost:3000';
};

// 보험료 계산 (국내여행보험용)
router.post('/api/travel/calculate-premium', async (req: Request, res: Response) => {
  try {
    const { 
      insurance_type, 
      age, 
      gender, 
      plan_type, 
      has_medical_expense, 
      departure_date, 
      arrival_date,
      currency_plan,
      travel_country
    } = req.body;

    console.log('=== 보험료 계산 시작 ===');
    console.log('입력 파라미터:', {
      insurance_type,
      age,
      gender,
      plan_type,
      has_medical_expense,
      departure_date,
      arrival_date,
      currency_plan,
      travel_country
    });

    // 필수 파라미터 검증
    if (!insurance_type || age === undefined || !gender || !plan_type || !departure_date || !arrival_date) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    // 보험기간 계산 (일수)
    const departure = new Date(departure_date);
    const arrival = new Date(arrival_date);
    const diffTime = arrival.getTime() - departure.getTime();
    const periodDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    console.log('기간 계산:', {
      departure: departure.toISOString(),
      arrival: arrival.toISOString(),
      diffTime_ms: diffTime,
      periodDays
    });

    if (periodDays <= 0) {
      return res.status(400).json({
        success: false,
        message: '도착일시는 출발일시보다 이후여야 합니다.',
      });
    }

    // 15세 미만일 경우 어린이플랜으로 강제 변경
    const finalPlanType = age < 15 ? '어린이플랜' : plan_type;
    console.log('플랜 타입:', { original: plan_type, final: finalPlanType, age });

    let annualPremium: number;

    // 외화 플랜인 경우
    if (currency_plan === '외화' && ['유학/어학연수', '워킹홀리데이', '해외출장/주재원/교환교수'].includes(insurance_type)) {
      console.log('외화 플랜 보험료 계산 시작');

      // 유로 사용 국가 목록
      const euroCountries = [
        '독일', '프랑스', '이탈리아', '스페인', '네덜란드', '벨기에', '그리스', 
        '포르투갈', '오스트리아', '핀란드', '아일랜드', '룩셈부르크', '슬로바키아',
        '슬로베니아', '에스토니아', '라트비아', '리투아니아', '몰타', '키프로스'
      ];

      // 통화 결정: 워킹홀리데이(유로화플랜)는 무조건 EUR, 그 외는 EUR 우선, 없으면 USD
      let currency = 'USD'; // 기본값
      
      // 워킹홀리데이(유로화플랜)인 경우 무조건 EUR 사용
      if (plan_type === '워킹홀리데이(유로화플랜)') {
        currency = 'EUR';
        console.log('워킹홀리데이(유로화플랜): EUR 강제 사용');
      } else if (travel_country && euroCountries.includes(travel_country)) {
        // EUR 조회 시도
        const [eurRows] = await pool.execute<any[]>(
          `SELECT korean_premium, foreign_premium 
           FROM foreign_currency_premium_rates 
           WHERE insurance_type = ? 
             AND plan_type = ? 
             AND age = ? 
             AND gender = ? 
             AND has_medical_expense = ? 
             AND currency = 'EUR'
             AND is_active = 1
           ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
           LIMIT 1`,
          [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0]
        );

        if (eurRows && eurRows.length > 0) {
          currency = 'EUR';
          console.log('EUR 보험료 데이터 발견');
        }
      }

      // 외화 플랜 보험료 조회 (EUR 우선, 없으면 USD)
      const [foreignPremiumRows] = await pool.execute<any[]>(
        `SELECT korean_premium, foreign_premium 
         FROM foreign_currency_premium_rates 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND age = ? 
           AND gender = ? 
           AND has_medical_expense = ? 
           AND currency = ?
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0, currency]
      );

      console.log('외화 플랜 보험료 조회 결과:', { currency, rows: foreignPremiumRows });

      if (!foreignPremiumRows || foreignPremiumRows.length === 0) {
        // EUR 조회 실패 시 USD 재시도 (단, 워킹홀리데이(유로화플랜)는 제외)
        if (currency === 'EUR' && plan_type !== '워킹홀리데이(유로화플랜)') {
          const [usdRows] = await pool.execute<any[]>(
            `SELECT korean_premium, foreign_premium 
             FROM foreign_currency_premium_rates 
             WHERE insurance_type = ? 
               AND plan_type = ? 
               AND age = ? 
               AND gender = ? 
               AND has_medical_expense = ? 
               AND currency = 'USD'
               AND is_active = 1
             ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
             LIMIT 1`,
            [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0]
          );

          if (usdRows && usdRows.length > 0) {
            currency = 'USD';
            foreignPremiumRows.push(...usdRows);
            console.log('USD 보험료 데이터로 대체');
          }
        }

        if (!foreignPremiumRows || foreignPremiumRows.length === 0) {
          console.log('외화 플랜 보험료 정보를 찾을 수 없음');
          return res.status(404).json({
            success: false,
            message: plan_type === '워킹홀리데이(유로화플랜)' 
              ? '해당 조건의 워킹홀리데이(유로화플랜) 보험료 정보를 찾을 수 없습니다.'
              : '해당 조건의 외화 플랜 보험료 정보를 찾을 수 없습니다.',
          });
        }
      }

      const koreanPremium = parseFloat(foreignPremiumRows[0].korean_premium);
      const foreignPremium = parseFloat(foreignPremiumRows[0].foreign_premium);
      console.log('외화 플랜 보험료:', { currency, koreanPremium, foreignPremium });

      // 환율 조회 (최신 환율 사용)
      const [exchangeRateRows] = await pool.execute<any[]>(
        `SELECT exchange_rate 
         FROM exchange_rates 
         WHERE currency = ? 
           AND is_active = 1
         ORDER BY rate_date DESC, id DESC
         LIMIT 1`,
        [currency]
      );

      if (!exchangeRateRows || exchangeRateRows.length === 0) {
        console.log('환율 정보를 찾을 수 없음:', currency);
        return res.status(404).json({
          success: false,
          message: `${currency} 환율 정보를 찾을 수 없습니다. 환율을 먼저 등록해주세요.`,
        });
      }

      const exchangeRate = parseFloat(exchangeRateRows[0].exchange_rate);
      console.log('환율:', { currency, exchangeRate });

      // 연간보험료 계산: 원화담보보험료 + (외화담보보험료 × 환율)
      annualPremium = koreanPremium + (foreignPremium * exchangeRate);
      console.log('외화 플랜 연간 보험료 계산:', {
        koreanPremium,
        foreignPremium,
        exchangeRate,
        annualPremium
      });
    } else {
      // 원화 플랜: 기존 로직
      const queryParams = [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0];
      console.log('보험료 조회 쿼리 파라미터:', queryParams);

      const [premiumRows] = await pool.execute<any[]>(
        `SELECT annual_premium 
         FROM premium_rates 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND age = ? 
           AND gender = ? 
           AND has_medical_expense = ? 
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        queryParams
      );

      console.log('보험료 조회 결과:', premiumRows);

      if (!premiumRows || premiumRows.length === 0) {
        console.log('보험료 정보를 찾을 수 없음');
        return res.status(404).json({
          success: false,
          message: '해당 조건의 보험료 정보를 찾을 수 없습니다.',
        });
      }

      annualPremium = parseFloat(premiumRows[0].annual_premium);
      console.log('연간 보험료:', annualPremium);
    }

    // 단기요율 조회 (기간에 해당하는 요율 찾기)
    let shortTermRate = 100.0; // 기본값 (1년 이상 또는 테이블 최대값 초과 시)
    
    if (periodDays < 365) {
      console.log('단기요율 조회 (periodDays < 365):', { periodDays, insurance_type });
      
      // 해당 기간보다 크거나 같은 period_days 중 가장 작은 값 찾기
      const [rateRows] = await pool.execute<any[]>(
        `SELECT rate_percentage, period_days
         FROM short_term_rates 
         WHERE insurance_type = ? 
           AND period_days >= ? 
           AND is_active = 1
         ORDER BY period_days ASC 
         LIMIT 1`,
        [insurance_type, periodDays]
      );

      console.log('단기요율 조회 결과:', rateRows);

      if (rateRows && rateRows.length > 0) {
        shortTermRate = parseFloat(rateRows[0].rate_percentage);
        console.log('단기요율 적용:', { periodDays: rateRows[0].period_days, rate: shortTermRate });
      } else {
        // 조회 실패 시 (테이블 최대 period_days보다 큰 경우) 100% 적용
        console.log('단기요율 조회 실패 (테이블 범위 초과), 100% 적용:', shortTermRate);
      }
    } else {
      console.log('1년 이상이므로 단기요율 100% 적용');
    }

    // 플랜별 추가 금액 조회 (해외여행보험만 적용)
    let additionalFee = 0;
    if (insurance_type === '해외여행보험') {
      const [additionalFeeRows] = await pool.execute<any[]>(
        `SELECT additional_fee 
         FROM plan_additional_fees 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        [insurance_type, finalPlanType]
      );

      if (additionalFeeRows && additionalFeeRows.length > 0) {
        additionalFee = parseFloat(additionalFeeRows[0].additional_fee);
        console.log('플랜별 추가 금액 (해외여행보험):', { plan: finalPlanType, additionalFee });
      }
    }

    // 최종 보험료 계산: (연간보험료 × (단기요율 / 100)) + 플랜별 추가 금액
    // 단수처리: 최종 보험료 십원단위 절사 (예: 317852.5 → 317850)
    const calculatedPremium = annualPremium * (shortTermRate / 100);
    const finalPremium = Math.floor((calculatedPremium + additionalFee) / 10) * 10;

    console.log('최종 계산:', {
      annualPremium,
      shortTermRate,
      calculatedPremium,
      additionalFee,
      finalPremium: finalPremium
    });
    console.log('=== 보험료 계산 완료 ===\n');

    // 응답 데이터 준비
    const responseData: any = {
      success: true,
      premium: finalPremium,
      annual_premium: annualPremium,
      short_term_rate: shortTermRate,
      period_days: periodDays,
    };

    // 외화 플랜인 경우 사용된 통화 정보 추가
    if (currency_plan === '외화' && ['유학/어학연수', '워킹홀리데이', '해외출장/주재원/교환교수'].includes(insurance_type)) {
      let usedCurrency = 'USD';
      
      if (plan_type === '워킹홀리데이(유로화플랜)') {
        usedCurrency = 'EUR';
      } else {
        const euroCountries = [
          '독일', '프랑스', '이탈리아', '스페인', '네덜란드', '벨기에', '그리스', 
          '포르투갈', '오스트리아', '핀란드', '아일랜드', '룩셈부르크', '슬로바키아',
          '슬로베니아', '에스토니아', '라트비아', '리투아니아', '몰타', '키프로스'
        ];

        if (travel_country && euroCountries.includes(travel_country)) {
          const [eurCheck] = await pool.execute<any[]>(
            `SELECT id FROM foreign_currency_premium_rates 
             WHERE insurance_type = ? AND plan_type = ? AND age = ? AND gender = ? 
               AND has_medical_expense = ? AND currency = 'EUR' AND is_active = 1
             LIMIT 1`,
            [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0]
          );
          if (eurCheck && eurCheck.length > 0) {
            usedCurrency = 'EUR';
          }
        }
      }
      responseData.currency = usedCurrency;
    }

    res.json(responseData);
  } catch (error) {
    console.error('Calculate premium error:', error);
    res.status(500).json({
      success: false,
      message: '보험료 계산 중 오류가 발생했습니다.',
    });
  }
});

// 계약번호 생성 함수
function generateContractNumber(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TC${year}${month}${day}${random}`;
}

// 계약 등록 (B2C 프론트엔드용)
router.post('/api/travel/register-contract', async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const { contract, contractor, insured_persons, companions, payment } = req.body;

    // 계약번호 생성
    const contract_number = generateContractNumber();

    // 1. 계약 정보 저장
    const [contractResult] = await connection.execute<any>(
      `INSERT INTO travel_contracts (
        member_id, contract_number, insurance_type, departure_date, duration_months, duration_days,
        arrival_date, travel_region, travel_country, travel_purpose, travel_participants,
        payment_method, payment_status, total_premium, affiliate, device, access_path, system_input_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract.member_id || null, // 회원 ID (비회원은 null)
        contract_number,
        contract.insurance_type,
        contract.departure_date,
        contract.duration_months,
        contract.duration_days,
        contract.arrival_date,
        contract.travel_region || null,
        contract.travel_country || null,
        contract.travel_purpose,
        contract.travel_participants,
        payment?.payment_method || null,
        payment?.status === '완료' ? '결제완료' : '미결제',
        contract.total_premium || 0,
        '투어밸리',
        'PC', // B2C는 PC 또는 Mobile로 구분 가능
        '/domestic',
        '자동입력',
      ]
    );

    const contract_id = contractResult.insertId;

    // 2. 계약자 정보 저장
    const [contractorResult] = await connection.execute<any>(
      `INSERT INTO contractors (
        contract_id, contractor_type, name, resident_number, mobile_phone, email
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contract_id,
        contractor.contractor_type || '개인',
        contractor.name || null,
        contractor.resident_number || null,
        contractor.mobile_phone || null,
        contractor.email || null,
      ]
    );

    const contractor_id = contractorResult.insertId;

    // 3. 피보험자 정보 저장
    for (let i = 0; i < insured_persons.length; i++) {
      const insured = insured_persons[i];
      
      const [insuredResult] = await connection.execute<any>(
        `INSERT INTO insured_persons (
          contract_id, contractor_id, is_same_as_contractor, name, english_name, resident_number, gender,
          health_status, has_illness_history, occupation, departure_status, sequence_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          contractor_id,
          1, // B2C는 계약자와 동일인으로 가정
          insured.name,
          insured.english_name || null,
          insured.resident_number || null,
          insured.gender || null,
          '좋다', // 기본값
          0, // 과거상병 없음
          null, // 직업 정보 없음
          null, // 출국여부 정보 없음
          insured.sequence_number || (i + 1),
        ]
      );

      const insured_person_id = insuredResult.insertId;

      // 피보험자를 companions 테이블에도 저장 (플랜, 보험료 정보 포함)
      await connection.execute<any>(
        `INSERT INTO companions (
          contract_id, insured_person_id, name, resident_number, gender,
          has_illness_history, has_medical_expense, plan_type, premium, sequence_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          insured_person_id,
          insured.name,
          insured.resident_number || null,
          insured.gender || null,
          0, // 과거상병 없음
          insured.has_medical_expense || 0,
          insured.plan_type || null,
          insured.premium || 0,
          insured.sequence_number || (i + 1),
        ]
      );
    }

    // 4. 결제 정보 저장
    if (payment) {
      const [paymentResult] = await connection.execute<any>(
        `INSERT INTO payments (
          contract_id, payment_method, payment_sub_method, amount, status,
          payment_date, depositor_name, bank_name, account_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          payment.payment_method,
          payment.payment_sub_method || null,
          payment.amount || 0,
          payment.status || '대기',
          payment.status === '완료' ? new Date() : null,
          payment.payment_sub_method === '무통장입금' ? payment.depositor_name : null,
          payment.payment_sub_method === '무통장입금' ? payment.bank_name : null,
          payment.payment_sub_method === '무통장입금' ? payment.account_number : null,
        ]
      );

      const payment_id = paymentResult.insertId;

      // 결제 상세 정보 저장 (수기카드, 무통장입금)
      if (payment_id && (payment.payment_sub_method === '수기카드' || payment.payment_sub_method === '무통장입금')) {
        await connection.execute(
          `INSERT INTO payment_details (
            payment_id, payment_method,
            card_type, card_category, card_number, card_expiry_month, card_expiry_year,
            cardholder_name, cardholder_resident_number, approval_date,
            deposit_bank, depositor_name, expected_deposit_date, deposit_date,
            normal_premium, receipt_premium
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payment_id,
            payment.payment_sub_method,
            payment.card_type || null,
            payment.card_category || null,
            payment.card_number || null,
            payment.card_expiry_month || null,
            payment.card_expiry_year || null,
            payment.cardholder_name || null,
            payment.cardholder_resident_number || null,
            payment.approval_date || null,
            payment.bank_name || null,
            payment.depositor_name || null,
            null, // expected_deposit_date는 별도로 처리 필요
            null, // deposit_date는 별도로 처리 필요
            payment.normal_premium || 0,
            payment.receipt_premium || 0,
          ]
        );
      }
    }

    await connection.commit();

    res.json({
      success: true,
      contract_id,
      contract_number,
      message: '계약이 성공적으로 등록되었습니다.',
    });
  } catch (error) {
    await connection.rollback();
    console.error('Contract registration error:', error);
    res.status(500).json({
      success: false,
      message: '계약 등록 중 오류가 발생했습니다.',
    });
  } finally {
    connection.release();
  }
});

// 환율 정보 조회 (하루 전날 환율)
router.get('/api/travel/exchange-rate', async (req: Request, res: Response) => {
  try {
    const { currency = 'USD' } = req.query;
    
    // 오늘 날짜 (한국 시간대 기준)
    const today = new Date();
    // 하루 전날 날짜 계산 (한국 시간대 기준)
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    // 날짜만 추출 (YYYY-MM-DD 형식, 로컬 시간 기준)
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    
    // 하루 전날 환율 조회
    const [rows] = await pool.execute<any[]>(
      `SELECT currency, exchange_rate, rate_date 
       FROM exchange_rates 
       WHERE currency = ? 
         AND rate_date = ? 
         AND is_active = 1 
       ORDER BY id DESC
       LIMIT 1`,
      [currency, yesterdayStr]
    );
    
    // 하루 전날 데이터가 없으면 가장 최근 데이터 조회
    let exchangeRateData = rows && rows.length > 0 ? rows[0] : null;
    
    if (!exchangeRateData) {
      const [latestRows] = await pool.execute<any[]>(
        `SELECT currency, exchange_rate, rate_date 
         FROM exchange_rates 
         WHERE currency = ? 
           AND is_active = 1 
         ORDER BY rate_date DESC, id DESC
         LIMIT 1`,
        [currency]
      );
      
      if (latestRows && latestRows.length > 0) {
        exchangeRateData = latestRows[0];
      }
    }
    
    if (!exchangeRateData) {
      return res.status(404).json({
        success: false,
        message: `${currency} 환율 정보를 찾을 수 없습니다.`,
      });
    }
    
    res.json({
      success: true,
      currency: exchangeRateData.currency,
      exchangeRate: parseFloat(exchangeRateData.exchange_rate),
      rateDate: exchangeRateData.rate_date,
    });
  } catch (error) {
    console.error('Get exchange rate error:', error);
    res.status(500).json({
      success: false,
      message: '환율 정보를 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// ==================== 네이버페이 결제 ====================

// 네이버페이 결제 준비
router.post('/api/travel/contracts/:contractId/create-naver-payment', async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const {
      amount,
      productName,
      productCount,
      customerName,
      customerEmail,
      customerPhone,
      checkOutDate, // 보험 종료일 (YYYY-MM-DD)
    } = req.body;

    console.log('네이버페이 결제 준비:', { contractId, amount, productName, checkOutDate });

    // 필수 필드 검증
    if (!amount || !productName || !checkOutDate) {
      return res.status(400).json({
        success: false,
        message: '필수 항목이 누락되었습니다.',
      });
    }

    // 계약 정보 조회
    const [contractRows] = await pool.execute<any[]>(
      'SELECT * FROM travel_contracts WHERE id = ?',
      [contractId]
    );

    if (contractRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약을 찾을 수 없습니다.',
      });
    }

    const contract = contractRows[0];

    // orderId 생성
    const orderId = `ORDER_${Date.now()}_${contractId}`;
    const merchantPayKey = orderId;

    // useCfmYmdt 설정 (보험 종료일)
    let useCfmYmdt: string | undefined = undefined;
    if (checkOutDate) {
      const checkoutDateObj = new Date(checkOutDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      checkoutDateObj.setHours(0, 0, 0, 0);
      
      if (checkoutDateObj >= today) {
        useCfmYmdt = checkOutDate.replace(/-/g, '');
      } else {
        return res.status(400).json({
          success: false,
          message: '보험 종료일은 오늘 이후여야 합니다.',
        });
      }
    }

    // 네이버페이 트랜잭션 저장
    await pool.execute(
      `INSERT INTO naver_pay_transactions (
        order_id, contract_id, amount, product_name, use_cfm_ymdt, status
      ) VALUES (?, ?, ?, ?, ?, 'ready')
      ON DUPLICATE KEY UPDATE amount = ?, product_name = ?, use_cfm_ymdt = ?, status = 'ready'`,
      [orderId, contractId, amount, productName, useCfmYmdt, amount, productName, useCfmYmdt]
    );

    res.json({
      success: true,
      data: {
        orderId,
        merchantPayKey,
        amount: Math.round(amount),
        productName,
        productCount: productCount || 1,
        useCfmYmdt,
      },
    });
  } catch (error) {
    console.error('네이버페이 결제 준비 실패:', error);
    res.status(500).json({
      success: false,
      message: '네이버페이 결제 준비에 실패했습니다.',
    });
  }
});

// 네이버페이 결제 콜백 처리
router.get('/api/travel/naver-pay-callback', async (req: Request, res: Response) => {
  try {
    const { resultCode, paymentId, resultMessage } = req.query;

    console.log('네이버페이 콜백:', { resultCode, paymentId, resultMessage });

    // 결제 실패 처리
    if (resultCode === 'Fail') {
      let errorMessage = '결제가 실패했습니다.';
      
      if (resultMessage === 'userCancel') {
        errorMessage = '결제를 취소하셨습니다.';
      } else if (resultMessage === 'OwnerAuthFail') {
        errorMessage = '타인 명의 카드는 결제가 불가능합니다.';
      } else if (resultMessage === 'paymentTimeExpire') {
        errorMessage = '결제 가능한 시간이 지났습니다.';
      }

      // 네이버페이 트랜잭션 상태 업데이트 (실패)
      try {
        await pool.execute(
          `UPDATE naver_pay_transactions SET status = 'failed' WHERE payment_id = ?`,
          [paymentId || '']
        );
      } catch (updateError) {
        console.error('네이버페이 트랜잭션 실패 상태 업데이트 오류:', updateError);
      }

      const frontendUrl = getFrontendUrl();
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(errorMessage)}`;
      
      return res.redirect(failUrl);
    }

    // 결제 성공 처리
    if (resultCode === 'Success' && paymentId) {
      const naverPayClientId = process.env.NAVER_PAY_CLIENT_ID;
      const naverPayClientSecret = process.env.NAVER_PAY_CLIENT_SECRET;
      
      if (!naverPayClientId || !naverPayClientSecret) {
        console.error('네이버 페이 환경 변수 누락:', {
          hasClientId: !!naverPayClientId,
          hasClientSecret: !!naverPayClientSecret,
        });
        const frontendUrl = getFrontendUrl();
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('네이버 페이 설정이 완료되지 않았습니다.')}`;
        return res.redirect(failUrl);
      }

      try {
        // 네이버 페이 결제 승인 API 호출
        const naverPayEnv = process.env.NAVER_PAY_ENV;
        const isDev = naverPayEnv === 'dev' || naverPayEnv === 'development';
        const naverPayChainId = process.env.NAVER_PAY_CHAIN_ID;
        
        console.log('네이버 페이 환경 설정:', {
          NAVER_PAY_ENV: naverPayEnv,
          isDev: isDev,
          hasClientId: !!naverPayClientId,
          hasClientSecret: !!naverPayClientSecret,
          hasChainId: !!naverPayChainId,
          clientId: naverPayClientId?.substring(0, 10) + '...', // 일부만 표시
          chainId: naverPayChainId,
        });
        
        const naverPayApiUrl = isDev
          ? 'https://dev-pay.paygate.naver.com/naverpay-partner/naverpay/payments/v2.2/apply/payment'
          : 'https://pay.paygate.naver.com/naverpay-partner/naverpay/payments/v2.2/apply/payment';
        
        const idempotencyKey = `naverpay-${paymentId}-${Date.now()}`;
        
        console.log('네이버 페이 결제 승인 API 호출:', { 
          url: naverPayApiUrl, 
          paymentId,
          environment: isDev ? 'development' : 'production',
        });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        const confirmResponse = await fetch(naverPayApiUrl, {
          method: 'POST',
          headers: {
            'X-Naver-Client-Id': naverPayClientId,
            'X-Naver-Client-Secret': naverPayClientSecret,
            'X-NaverPay-Chain-Id': naverPayChainId || '',
            'X-NaverPay-Idempotency-Key': idempotencyKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `paymentId=${encodeURIComponent(paymentId as string)}`,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

        const responseText = await confirmResponse.text();
        console.log('네이버 페이 API 응답:', responseText);
        
        const naverPayResponse = JSON.parse(responseText);

        if (!confirmResponse.ok || naverPayResponse.code === 'Fail' || naverPayResponse.error) {
          const frontendUrl = getFrontendUrl();
          const errorMsg = naverPayResponse.message || '결제 승인에 실패했습니다.';
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(errorMsg)}`;
          return res.redirect(failUrl);
        }

        // 결제 정보 추출
        const detail = naverPayResponse.body?.detail || naverPayResponse.detail || {};
        const merchantPayKey = detail.merchantPayKey || naverPayResponse.merchantPayKey;
        const totalPayAmount = detail.totalPayAmount || naverPayResponse.totalPayAmount || 0;
        const admissionState = detail.admissionState || naverPayResponse.admissionState || '';

        if (admissionState !== 'SUCCESS') {
          const frontendUrl = getFrontendUrl();
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 승인이 완료되지 않았습니다.')}`;
          return res.redirect(failUrl);
        }

        // orderId에서 contractId 추출
        const contractIdMatch = merchantPayKey.match(/_(\d+)$/);
        const contractId = contractIdMatch ? parseInt(contractIdMatch[1]) : null;

        if (!contractId) {
          const frontendUrl = getFrontendUrl();
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('계약 정보를 찾을 수 없습니다.')}`;
          return res.redirect(failUrl);
        }

        // 트랜잭션 시작
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
          // 계약 정보 조회
          const [contractRows] = await connection.execute<any[]>(
            'SELECT * FROM travel_contracts WHERE id = ?',
            [contractId]
          );

          if (contractRows.length === 0) {
            await connection.rollback();
            const frontendUrl = getFrontendUrl();
            const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('계약을 찾을 수 없습니다.')}`;
            return res.redirect(failUrl);
          }

          const contract = contractRows[0];

          // 계약 상태 업데이트
          await connection.execute(
            `UPDATE travel_contracts 
             SET payment_status = '결제완료', payment_method = '네이버페이', updated_at = NOW()
             WHERE id = ?`,
            [contractId]
          );

          // 결제 정보 저장
          await connection.execute(
            `INSERT INTO payments (
              contract_id, payment_method, amount, status, payment_date,
              payment_number, pg_transaction_id, pg_response
            ) VALUES (?, '네이버페이', ?, '완료', NOW(), ?, ?, ?)`,
            [
              contractId,
              totalPayAmount,
              merchantPayKey,
              paymentId,
              JSON.stringify(naverPayResponse),
            ]
          );

          // 네이버페이 트랜잭션 상태 업데이트
          await connection.execute(
            `UPDATE naver_pay_transactions 
             SET status = 'approved', payment_id = ?, pg_response = ? 
             WHERE order_id = ?`,
            [paymentId, JSON.stringify(naverPayResponse), merchantPayKey]
          );

          // 마일리지 지급 (결제 금액의 3%, 최대 30,000P)
          const mileageAmount = Math.min(Math.floor(totalPayAmount * 0.03), 30000);
          
          if (mileageAmount > 0 && contract.member_id) {
            // members 테이블의 mileage 업데이트
            await connection.execute(
              `UPDATE members SET mileage = mileage + ? WHERE id = ?`,
              [mileageAmount, contract.member_id]
            );

            // 업데이트 후 잔액 조회
            const [memberResult] = await connection.execute<any[]>(
              `SELECT mileage FROM members WHERE id = ?`,
              [contract.member_id]
            );
            const newBalance = memberResult[0]?.mileage || 0;

            // mileage_transactions 테이블에 저장
            await connection.execute(
              `INSERT INTO mileage_transactions (
                member_id, type, amount, description, reason, reason_detail, reference_type, reference_id, balance
              ) VALUES (?, 'earn', ?, '여행보험 가입 마일리지', '여행보험 가입 마일리지', '보험료의 3% 적립 (최대 30,000P)', 'contract', ?, ?)`,
              [contract.member_id, mileageAmount, contractId, newBalance]
            );
          }

          // TODO: 알림톡 발송 (선택사항)

          await connection.commit();
          connection.release();

          // 성공 페이지로 리다이렉트
          const frontendUrl = getFrontendUrl();
          const successUrl = `${frontendUrl}/payment/success?contractId=${contractId}&customerName=${encodeURIComponent(contract.customer_name || '')}&contractNumber=${merchantPayKey}`;
          res.redirect(successUrl);
        } catch (dbError) {
          await connection.rollback();
          connection.release();
          throw dbError;
        }
      } catch (error: any) {
        console.error('네이버페이 승인 처리 실패:', error);
        const frontendUrl = getFrontendUrl();
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(error.message || '결제 처리 중 오류가 발생했습니다.')}`;
        return res.redirect(failUrl);
      }
    } else {
      const frontendUrl = getFrontendUrl();
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 정보가 올바르지 않습니다.')}`;
      return res.redirect(failUrl);
    }
  } catch (error) {
    console.error('네이버페이 콜백 처리 실패:', error);
    const frontendUrl = getFrontendUrl();
    const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 처리 중 오류가 발생했습니다.')}`;
    return res.redirect(failUrl);
  }
});

// ==================== 카카오페이 결제 ====================

// 카카오페이 결제 준비
router.post('/api/travel/contracts/:contractId/prepare-kakao-payment', async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const {
      amount,
      itemName,
      quantity,
      customerName,
      customerEmail,
      customerPhone,
    } = req.body;

    console.log('카카오페이 결제 준비:', { contractId, amount, itemName });

    // 필수 필드 검증
    if (!amount || !itemName) {
      return res.status(400).json({
        success: false,
        message: '필수 항목이 누락되었습니다.',
      });
    }

    // 계약 정보 조회
    const [contractRows] = await pool.execute<any[]>(
      'SELECT * FROM travel_contracts WHERE id = ?',
      [contractId]
    );

    if (contractRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약을 찾을 수 없습니다.',
      });
    }

    // orderId 생성
    const orderId = `ORDER_${Date.now()}_${contractId}`;

    // 카카오페이 설정 (신 카카오페이 API)
    const kakaoPayClientId = process.env.KAKAO_PAY_CLIENT_ID;
    const kakaoPayClientSecret = process.env.KAKAO_PAY_CLIENT_SECRET;
    const kakaoPayEnv = process.env.KAKAO_PAY_ENV || 'dev';
    const kakaoPaySecretKey = kakaoPayEnv === 'production' 
      ? process.env.KAKAO_PAY_SECRET_KEY 
      : process.env.KAKAO_PAY_SECRET_KEY_DEV;
    const kakaoPayCid = process.env.KAKAO_PAY_CID || 'CTL803FNNQ';
    const apiBaseUrl = process.env.FRONTEND_URL || 'http://localhost:4000';
    const frontendBaseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (!kakaoPayClientId || !kakaoPayClientSecret || !kakaoPaySecretKey) {
      return res.status(500).json({
        success: false,
        message: '카카오페이 설정이 완료되지 않았습니다.',
      });
    }

    try {
      // 카카오페이 결제 준비 API 호출 (신 카카오페이 API)
      const kakaoPayApiUrl = 'https://open-api.kakaopay.com/online/v1/payment/ready';
      
      // JSON 형식으로 요청 데이터 준비
      const requestBody = {
        cid: kakaoPayCid,
        cid_secret: kakaoPayClientSecret,
        partner_order_id: orderId,
        partner_user_id: String(contractId),
        item_name: itemName,
        quantity: quantity || 1,
        total_amount: Math.round(amount),
        tax_free_amount: 0,
        approval_url: `${apiBaseUrl}/api/travel/kakao-pay-callback?partner_order_id=${orderId}&partner_user_id=${contractId}`,
        cancel_url: `${frontendBaseUrl}/payment/cancel`,
        fail_url: `${frontendBaseUrl}/payment/fail`,
      };

      console.log('카카오페이 결제 준비 요청:', {
        cid: kakaoPayCid,
        orderId,
        amount: Math.round(amount),
        itemName,
      });

      const response = await fetch(kakaoPayApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `SECRET_KEY ${kakaoPaySecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      console.log('카카오페이 API 응답:', responseText);

      if (!response.ok) {
        const errorData = JSON.parse(responseText);
        return res.status(response.status).json({
          success: false,
          message: errorData.msg || '카카오페이 결제 준비에 실패했습니다.',
          error: errorData,
        });
      }

      const kakaoPayResponse = JSON.parse(responseText);
      const { tid, next_redirect_pc_url, next_redirect_mobile_url } = kakaoPayResponse;

      // tid 저장 (나중에 승인 시 사용)
      // 간단하게 메모리나 Redis에 저장 가능, 여기서는 DB에 임시 저장
      await pool.execute(
        `INSERT INTO kakao_pay_transactions (order_id, tid, contract_id, amount, status)
         VALUES (?, ?, ?, ?, 'ready')
         ON DUPLICATE KEY UPDATE tid = ?, amount = ?, status = 'ready'`,
        [orderId, tid, contractId, amount, tid, amount]
      );

      res.json({
        success: true,
        data: {
          tid,
          next_redirect_pc_url,
          next_redirect_mobile_url,
          orderId,
        },
      });
    } catch (error: any) {
      console.error('카카오페이 결제 준비 오류:', error);
      res.status(500).json({
        success: false,
        message: error.message || '카카오페이 결제 준비 중 오류가 발생했습니다.',
      });
    }
  } catch (error) {
    console.error('카카오페이 결제 준비 실패:', error);
    res.status(500).json({
      success: false,
      message: '카카오페이 결제 준비에 실패했습니다.',
    });
  }
});

// 카카오페이 결제 승인 콜백
router.get('/api/travel/kakao-pay-callback', async (req: Request, res: Response) => {
  try {
    const { pg_token, partner_order_id } = req.query;

    console.log('카카오페이 콜백:', { pg_token, partner_order_id });

    if (!pg_token || !partner_order_id) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 정보가 올바르지 않습니다.')}`;
      return res.redirect(failUrl);
    }

    // tid 조회
    const [transactionRows] = await pool.execute<any[]>(
      'SELECT * FROM kakao_pay_transactions WHERE order_id = ? AND status = "ready"',
      [partner_order_id]
    );

    if (transactionRows.length === 0) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 정보를 찾을 수 없습니다.')}`;
      return res.redirect(failUrl);
    }

    const transaction = transactionRows[0];
    const { tid, contract_id, amount } = transaction;

    // 카카오페이 승인 API 호출 (신 카카오페이 API)
    const kakaoPayClientId = process.env.KAKAO_PAY_CLIENT_ID;
    const kakaoPayClientSecret = process.env.KAKAO_PAY_CLIENT_SECRET;
    const kakaoPayEnv = process.env.KAKAO_PAY_ENV || 'dev';
    const kakaoPaySecretKey = kakaoPayEnv === 'production' 
      ? process.env.KAKAO_PAY_SECRET_KEY 
      : process.env.KAKAO_PAY_SECRET_KEY_DEV;
    const kakaoPayCid = process.env.KAKAO_PAY_CID || 'CTL803FNNQ';

    if (!kakaoPayClientId || !kakaoPayClientSecret || !kakaoPaySecretKey) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('카카오페이 설정이 완료되지 않았습니다.')}`;
      return res.redirect(failUrl);
    }

    try {
      const approveUrl = 'https://open-api.kakaopay.com/online/v1/payment/approve';
      
      // JSON 형식으로 요청 데이터 준비 (공식 문서 기준)
      const requestBody = {
        cid: kakaoPayCid,
        tid: tid,
        partner_order_id: partner_order_id as string,
        partner_user_id: String(contract_id),
        pg_token: pg_token as string,
      };

      console.log('카카오페이 승인 요청:', {
        cid: kakaoPayCid,
        tid,
        partner_order_id,
      });

      const response = await fetch(approveUrl, {
        method: 'POST',
        headers: {
          'Authorization': `SECRET_KEY ${kakaoPaySecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      console.log('카카오페이 승인 응답:', responseText);

      if (!response.ok) {
        const errorData = JSON.parse(responseText);
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(errorData.msg || '결제 승인에 실패했습니다.')}`;
        return res.redirect(failUrl);
      }

      const approveResponse = JSON.parse(responseText);

      // 결제 금액 검증
      const paidAmount = approveResponse.amount?.total || 0;
      if (Math.abs(paidAmount - amount) > 1) {
        console.error('결제 금액 불일치:', { expected: amount, actual: paidAmount });
        // TODO: 결제 취소 처리
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 금액이 일치하지 않습니다.')}`;
        return res.redirect(failUrl);
      }

      // 트랜잭션 시작
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        // 계약 정보 조회
        const [contractRows] = await connection.execute<any[]>(
          'SELECT * FROM travel_contracts WHERE id = ?',
          [contract_id]
        );

        if (contractRows.length === 0) {
          await connection.rollback();
          const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('계약을 찾을 수 없습니다.')}`;
          return res.redirect(failUrl);
        }

        const contract = contractRows[0];

        // 계약 상태 업데이트
        await connection.execute(
          `UPDATE travel_contracts 
           SET payment_status = '결제완료', payment_method = '카카오페이', updated_at = NOW()
           WHERE id = ?`,
          [contract_id]
        );

        // 결제 정보 저장
        await connection.execute(
          `INSERT INTO payments (
            contract_id, payment_method, amount, status, payment_date,
            payment_number, pg_transaction_id, pg_response
          ) VALUES (?, '카카오페이', ?, '완료', NOW(), ?, ?, ?)`,
          [
            contract_id,
            paidAmount,
            partner_order_id,
            tid,
            JSON.stringify(approveResponse),
          ]
        );

        // 카카오페이 트랜잭션 상태 업데이트
        await connection.execute(
          `UPDATE kakao_pay_transactions SET status = 'approved', pg_response = ? WHERE order_id = ?`,
          [JSON.stringify(approveResponse), partner_order_id]
        );

        // 마일리지 지급 (결제 금액의 3%, 최대 30,000P)
        const mileageAmount = Math.min(Math.floor(paidAmount * 0.03), 30000);
        
        if (mileageAmount > 0 && contract.member_id) {
          // members 테이블의 mileage 업데이트
          await connection.execute(
            `UPDATE members SET mileage = mileage + ? WHERE id = ?`,
            [mileageAmount, contract.member_id]
          );

          // 업데이트 후 잔액 조회
          const [memberResult] = await connection.execute<any[]>(
            `SELECT mileage FROM members WHERE id = ?`,
            [contract.member_id]
          );
          const newBalance = memberResult[0]?.mileage || 0;

          // mileage_transactions 테이블에 저장
          await connection.execute(
            `INSERT INTO mileage_transactions (
              member_id, type, amount, description, reason, reason_detail, reference_type, reference_id, balance
            ) VALUES (?, 'earn', ?, '여행보험 가입 마일리지', '여행보험 가입 마일리지', '보험료의 3% 적립 (최대 30,000P)', 'contract', ?, ?)`,
            [contract.member_id, mileageAmount, contract_id, newBalance]
          );
        }

        // TODO: 알림톡 발송 (선택사항)

        await connection.commit();
        connection.release();

        // 성공 페이지로 리다이렉트
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const successUrl = `${frontendUrl}/payment/success?contractId=${contract_id}&customerName=${encodeURIComponent(contract.customer_name || '')}&contractNumber=${partner_order_id}`;
        res.redirect(successUrl);
      } catch (dbError) {
        await connection.rollback();
        connection.release();
        throw dbError;
      }
    } catch (error: any) {
      console.error('카카오페이 승인 처리 실패:', error);
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(error.message || '결제 처리 중 오류가 발생했습니다.')}`;
      return res.redirect(failUrl);
    }
  } catch (error) {
    console.error('카카오페이 콜백 처리 실패:', error);
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 처리 중 오류가 발생했습니다.')}`;
    return res.redirect(failUrl);
  }
});

// 단체여행보험 보험료 계산 (법인/단체용)
router.post('/api/travel/calculate-group-premium', async (req: Request, res: Response) => {
  try {
    const { 
      insurance_type,  // '국내여행보험', '해외여행보험', '해외장기체류보험'
      insured_persons,  // 피보험자 배열 [{ age, gender, plan_type, has_medical_expense }]
      departure_date,
      arrival_date
    } = req.body;

    console.log('=== 단체여행보험 보험료 계산 시작 ===');
    console.log('입력 파라미터:', {
      insurance_type,
      insured_persons_count: insured_persons?.length,
      departure_date,
      arrival_date
    });

    // 필수 파라미터 검증
    if (!insurance_type || !insured_persons || !Array.isArray(insured_persons) || insured_persons.length === 0) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    if (!departure_date || !arrival_date) {
      return res.status(400).json({
        success: false,
        message: '출발일시와 도착일시가 필요합니다.',
      });
    }

    // 보험기간 계산 (일수)
    const departure = new Date(departure_date);
    const arrival = new Date(arrival_date);
    const diffTime = arrival.getTime() - departure.getTime();
    const periodDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    if (periodDays <= 0) {
      return res.status(400).json({
        success: false,
        message: '도착일시는 출발일시보다 이후여야 합니다.',
      });
    }

    // 각 피보험자별 보험료 계산
    const results = [];
    let totalPremium = 0;

    for (let i = 0; i < insured_persons.length; i++) {
      const insured = insured_persons[i];
      const { age, gender, plan_type, has_medical_expense } = insured;

      console.log(`피보험자 ${i + 1} 보험료 계산:`, { age, gender, plan_type, has_medical_expense });

      // 필수 필드 검증
      if (age === undefined || !gender || !plan_type) {
        return res.status(400).json({
          success: false,
          message: `피보험자 ${i + 1}의 정보가 불완전합니다.`,
        });
      }

      // 15세 미만일 경우 어린이플랜으로 강제 변경
      const finalPlanType = age < 15 ? '어린이플랜' : plan_type;
      const hasMedicalExpenseValue = has_medical_expense ? 1 : 0;

      console.log('보험료 조회 조건:', {
        insurance_type,
        finalPlanType,
        age,
        gender,
        has_medical_expense,
        hasMedicalExpenseValue
      });

      // 보험료 조회
      const [premiumRows] = await pool.execute<any[]>(
        `SELECT annual_premium 
         FROM premium_rates 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND age = ? 
           AND gender = ? 
           AND has_medical_expense = ? 
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        [insurance_type, finalPlanType, age, gender, hasMedicalExpenseValue]
      );

      console.log('조회된 보험료 데이터:', premiumRows);

      if (!premiumRows || premiumRows.length === 0) {
        console.log(`피보험자 ${i + 1} 보험료 정보를 찾을 수 없음`);
        
        // 조건을 완화하여 어떤 데이터가 있는지 확인
        const [debugRows] = await pool.execute<any[]>(
          `SELECT insurance_type, plan_type, age, gender, has_medical_expense, annual_premium 
           FROM premium_rates 
           WHERE insurance_type = ? 
             AND is_active = 1
           LIMIT 5`,
          [insurance_type]
        );
        console.log('DB에 존재하는 보험료 샘플 데이터:', debugRows);
        
        return res.status(404).json({
          success: false,
          message: `피보험자 ${i + 1}의 보험료 정보를 찾을 수 없습니다. (보험종류: ${insurance_type}, 플랜: ${finalPlanType}, 나이: ${age}, 성별: ${gender}, 실손: ${hasMedicalExpenseValue})`,
        });
      }

      const annualPremium = parseFloat(premiumRows[0].annual_premium);

      // 단기요율 조회
      let shortTermRate = 100.0;
      
      if (periodDays < 365) {
        const [rateRows] = await pool.execute<any[]>(
          `SELECT rate_percentage 
           FROM short_term_rates 
           WHERE insurance_type = ? 
             AND period_days >= ? 
             AND is_active = 1
           ORDER BY period_days ASC 
           LIMIT 1`,
          [insurance_type, periodDays]
        );

        if (rateRows && rateRows.length > 0) {
          shortTermRate = parseFloat(rateRows[0].rate_percentage);
        }
      }

      // 플랜별 추가 금액 조회 (해외여행보험만 적용)
      let additionalFee = 0;
      if (insurance_type === '해외여행보험') {
        const [additionalFeeRows] = await pool.execute<any[]>(
          `SELECT additional_fee 
           FROM plan_additional_fees 
           WHERE insurance_type = ? 
             AND plan_type = ? 
             AND is_active = 1
           ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
           LIMIT 1`,
          [insurance_type, finalPlanType]
        );

        if (additionalFeeRows && additionalFeeRows.length > 0) {
          additionalFee = parseFloat(additionalFeeRows[0].additional_fee);
        }
      }

      // 최종 보험료 계산: (연간보험료 × (단기요율 / 100)) + 플랜별 추가 금액
      // 단수처리: 최종 보험료 십원단위 절사
      const calculatedPremium = annualPremium * (shortTermRate / 100);
      const finalPremium = Math.floor((calculatedPremium + additionalFee) / 10) * 10;

      totalPremium += finalPremium;

      results.push({
        index: i + 1,
        age,
        gender,
        plan_type: finalPlanType,
        has_medical_expense,
        premium: finalPremium,
        annual_premium: annualPremium,
        short_term_rate: shortTermRate,
      });

      console.log(`피보험자 ${i + 1} 보험료:`, {
        annualPremium,
        shortTermRate,
        additionalFee,
        finalPremium
      });
    }

    console.log('=== 단체여행보험 보험료 계산 완료 ===');
    console.log('총 보험료:', totalPremium);

    res.json({
      success: true,
      total_premium: totalPremium,
      period_days: periodDays,
      insured_persons: results,
    });
  } catch (error) {
    console.error('Calculate group premium error:', error);
    res.status(500).json({
      success: false,
      message: '보험료 계산 중 오류가 발생했습니다.',
    });
  }
});

export default router;

