import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

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
          contract_id, contractor_id, is_same_as_contractor, name, resident_number, gender,
          health_status, has_illness_history, occupation, departure_status, sequence_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          contractor_id,
          1, // B2C는 계약자와 동일인으로 가정
          insured.name,
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
    
    // 오늘 날짜
    const today = new Date();
    // 하루 전날 날짜 계산
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
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

export default router;

