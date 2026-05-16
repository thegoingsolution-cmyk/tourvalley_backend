import { Router, Request, Response } from 'express';
import pool from '../config/database';
import axios from 'axios';
import crypto from 'crypto';
import { sendSms } from '../services/aligoService';
import { sendContractCompleteAlimTalk } from '../services/contractAlimtalkService';
import { withB2cPgProductPrefix } from '../utils/b2cPgProductName';

const router = Router();

const getNicepayApiBaseUrl = () => {
  if (process.env.NICEPAY_API_BASE_URL) {
    return process.env.NICEPAY_API_BASE_URL;
  }

  const env = (process.env.NICEPAY_ENVIRONMENT || '').toLowerCase();
  if (env === 'test' || env === 'dev' || env === 'development') {
    return 'https://sandbox-api.nicepay.co.kr';
  }

  return 'https://api.nicepay.co.kr';
};

const extractVbankInfo = (responseData: any) => {
  const vbank = responseData?.vbank || {};
  const bankCode =
    vbank.bankCode ||
    vbank.bankCd ||
    vbank.vbankCode ||
    responseData?.vbankBankCode ||
    responseData?.bankCode ||
    responseData?.bankCd ||
    '';
  const bankName =
    vbank.bankName ||
    vbank.bank ||
    vbank.vbankName ||
    responseData?.vbankBankName ||
    responseData?.bankName ||
    responseData?.bank ||
    bankCode ||
    '';
  const accountNumber =
    vbank.accountNumber ||
    vbank.account ||
    vbank.vbankNumber ||
    responseData?.vbankNum ||
    responseData?.accountNumber ||
    responseData?.account ||
    responseData?.vbankAccount ||
    responseData?.vbankAccountNo ||
    '';
  const accountHolderName =
    vbank.accountHolderName ||
    vbank.accountHolder ||
    vbank.vbankHolder ||
    responseData?.vbankHolder ||
    responseData?.accountHolderName ||
    responseData?.accountHolder ||
    '';
  const expireDate =
    vbank.expireDate ||
    vbank.expDate ||
    responseData?.vbankExpDate ||
    responseData?.expireDate ||
    responseData?.expDate ||
    '';

  return {
    accountNumber,
    bankName,
    bankCode,
    accountHolderName,
    expireDate,
  };
};

const isReceiptUrl = (value: string) => {
  return value.startsWith('http://') || value.startsWith('https://');
};

const extractReceiptUrl = (responseData: any): string | null => {
  if (!responseData) {
    return null;
  }

  const knownKeys = new Set([
    'receipturl',
    'receipt_url',
    'cashreceipturl',
    'cash_receipt_url',
    'cardreceipturl',
    'card_receipt_url',
  ]);

  const findUrl = (value: any, keyHint?: string): string | null => {
    if (!value) {
      return null;
    }

    if (typeof value === 'string') {
      if (keyHint && keyHint.toLowerCase().includes('receipt') && isReceiptUrl(value)) {
        return value;
      }
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findUrl(item, keyHint);
        if (found) return found;
      }
      return null;
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value);
      for (const [key, nestedValue] of entries) {
        if (knownKeys.has(key.toLowerCase()) && typeof nestedValue === 'string' && isReceiptUrl(nestedValue)) {
          return nestedValue;
        }
      }
      for (const [key, nestedValue] of entries) {
        if (key.toLowerCase().includes('receipt') && typeof nestedValue === 'string' && isReceiptUrl(nestedValue)) {
          return nestedValue;
        }
        const found = findUrl(nestedValue, key);
        if (found) return found;
      }
    }

    return null;
  };

  return findUrl(responseData);
};

/** 네이버페이 영수증 미리보기 기준 URL (개발/상용 분기) */
const getNaverPayReceiptBaseUrl = (): string => {
  const override = process.env.NAVER_PAY_RECEIPT_BASE_URL;
  if (override) return override.replace(/\/$/, '');
  const env = process.env.NAVER_PAY_ENV;
  const isDev = env === 'dev' || env === 'development';
  return isDev
    ? 'https://test-pay.naver.com/receipts/preview/card'
    : 'https://pay.naver.com/receipts/preview/card';
};

/** 네이버페이 결제 승인 응답에서 영수증 미리보기 URL 생성 */
const buildNaverPayReceiptUrl = (naverPayResponse: any, paymentId: string): string | null => {
  const detail = naverPayResponse?.body?.detail || naverPayResponse?.detail || {};
  const payHistId = detail.payHistId;
  if (!paymentId || !payHistId) {
    return null;
  }
  const params = new URLSearchParams({
    svcInfType: 'PD',
    paymentId,
    tid: payHistId,
  });
  return `${getNaverPayReceiptBaseUrl()}?${params.toString()}`;
};

/** 카카오페이 영수증 URL 생성. KAKAO_PAY_RECEIPT_BASE_URL 설정 시에만 사용 (공식 웹 영수증 URL 미제공) */
const buildKakaoPayReceiptUrl = (approveResponse: any): string | null => {
  const base = process.env.KAKAO_PAY_RECEIPT_BASE_URL?.trim();
  if (!base) return null;
  const tid = approveResponse?.tid;
  if (!tid) return null;
  const params = new URLSearchParams({ tid });
  if (approveResponse?.cid) params.set('cid', approveResponse.cid);
  return `${base.replace(/\/$/, '')}?${params.toString()}`;
};

// 나이스페이먼츠 결제 요청 (결제창 호출용 파라미터 생성)
router.post('/api/payments/nicepay/request', async (req: Request, res: Response) => {
  try {
    const {
      contract_id,
      amount,
      orderId: orderIdFromBody,
      goodsName,
      buyerName,
      buyerEmail,
      buyerTel,
      returnUrl,
      closeUrl,
    } = req.body;

    const clientKey = process.env.NICEPAY_CLIENT_KEY || '';
    const timestamp = Date.now().toString();
    
    // 주문번호: 프론트에서 보낸 계약 ID(contract_id) 사용, 없으면 TC... 형식 생성
    const orderId = orderIdFromBody != null && String(orderIdFromBody).trim()
      ? String(orderIdFromBody).trim()
      : `TC${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

    const goodsNameResolved = String(goodsName ?? '').trim() || '국내여행보험';
    const goodsNameForPg = withB2cPgProductPrefix(goodsNameResolved);

    // 결제창 호출을 위한 파라미터 반환
    res.json({
      success: true,
      clientKey,
      orderId,
      amount: amount.toString(),
      goodsName: goodsNameForPg,
      buyerName,
      buyerEmail,
      buyerTel,
      returnUrl: returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/callback`,
      closeUrl: closeUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/close`,
      contract_id,
    });
  } catch (error: any) {
    console.error('Nicepay request error:', error);
    res.status(500).json({
      success: false,
      message: '결제 요청 중 오류가 발생했습니다.',
      error: error.message,
    });
  }
});

/** 결제 1건에서 영수증 URL 계산 (나이스/네이버/카카오). 수기카드는 receipt_url 그대로 반환 */
function resolveReceiptUrlFromPayment(payment: any): string | null {
  let receiptUrl: string | null = payment.receipt_url || null;
  let pgResponse = payment.pg_response;
  if (typeof pgResponse === 'string') {
    try {
      pgResponse = JSON.parse(pgResponse);
    } catch {
      pgResponse = null;
    }
  }
  if (!receiptUrl && pgResponse) {
    receiptUrl = extractReceiptUrl(pgResponse);
    if (!receiptUrl && payment.payment_method === '네이버페이' && pgResponse) {
      const paymentId = pgResponse?.body?.detail?.paymentId ?? pgResponse?.body?.paymentId ?? pgResponse?.detail?.paymentId;
      if (paymentId) receiptUrl = buildNaverPayReceiptUrl(pgResponse, paymentId);
    }
    if (!receiptUrl && payment.payment_method === '카카오페이' && pgResponse) {
      receiptUrl = buildKakaoPayReceiptUrl(pgResponse);
    }
  }
  return receiptUrl || null;
}

// 결제 영수증 URL 조회 (나이스페이/네이버페이/카카오페이)
router.get('/api/payments/receipt', async (req: Request, res: Response) => {
  try {
    const { contract_id } = req.query;

    if (!contract_id) {
      return res.status(400).json({
        success: false,
        message: 'contract_id가 필요합니다.',
      });
    }

    const contractId = parseInt(contract_id as string, 10);
    if (isNaN(contractId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 contract_id입니다.',
      });
    }

    const [payments] = await pool.execute<any[]>(
      `SELECT id, payment_method, status, receipt_url, pg_response
       FROM payments
       WHERE contract_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [contractId]
    );

    if (payments.length === 0) {
      return res.status(404).json({
        success: false,
        message: '결제 정보를 찾을 수 없습니다.',
      });
    }

    const payment = payments[0];
    const supportedMethods = ['나이스페이먼츠', '네이버페이', '카카오페이'];
    if (!supportedMethods.includes(payment.payment_method)) {
      return res.status(400).json({
        success: false,
        message: '해당 결제 수단의 영수증은 준비 중입니다.',
      });
    }

    if (payment.status !== '완료') {
      return res.status(400).json({
        success: false,
        message: '결제 완료 후 영수증을 확인할 수 있습니다.',
      });
    }

    let receiptUrl = resolveReceiptUrlFromPayment(payment);

    if (!receiptUrl) {
      return res.status(404).json({
        success: false,
        message: '영수증 URL을 찾을 수 없습니다.',
      });
    }

    if (!payment.receipt_url) {
      await pool.execute(
        'UPDATE payments SET receipt_url = ? WHERE id = ?',
        [receiptUrl, payment.id]
      );
    }

    res.json({
      success: true,
      receiptUrl,
      paymentMethod: payment.payment_method,
    });
  } catch (error) {
    console.error('Receipt URL 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '영수증 정보를 불러오는 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 이메일 등에서 클릭 시 결제 수단별 영수증으로 바로 이동 (302 리다이렉트)
 * GET /api/payments/receipt-redirect?contract_id=xxx
 * - contract_id: 내부 id(숫자) 또는 contract_number(예: 250312-123)
 * - 나이스/네이버/카카오: PG 영수증 URL로 리다이렉트
 * - 수기 카드: 관리자 업로드 영수증 URL로 리다이렉트
 * - 무통장 입금: /payments/bank-transfer-receipt 페이지로 리다이렉트
 */
router.get('/api/payments/receipt-redirect', async (req: Request, res: Response) => {
  const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  const fallbackUrl = `${frontendUrl}/card-receipt-download`;

  try {
    const { contract_id } = req.query;
    if (!contract_id || typeof contract_id !== 'string') {
      return res.redirect(302, fallbackUrl);
    }

    let internalContractId: number;
    const isNumeric = /^\d+$/.test(contract_id);
    if (isNumeric) {
      internalContractId = parseInt(contract_id, 10);
    } else {
      const [rows] = await pool.execute<any[]>(
        'SELECT id FROM travel_contracts WHERE contract_number = ?',
        [contract_id]
      );
      if (rows.length === 0) {
        return res.redirect(302, `${fallbackUrl}?contract_id=${encodeURIComponent(contract_id)}`);
      }
      internalContractId = rows[0].id;
    }

    console.log('[receipt-redirect] contract_id:', contract_id, '→ internalContractId:', internalContractId);

    const [payments] = await pool.execute<any[]>(
      `SELECT id, payment_method, payment_sub_method, status, receipt_url, pg_response
       FROM payments WHERE contract_id = ? ORDER BY created_at DESC LIMIT 1`,
      [internalContractId]
    );

    if (payments.length === 0) {
      return res.redirect(302, `${fallbackUrl}?contract_id=${encodeURIComponent(contract_id)}`);
    }

    const payment = payments[0];
    const method = payment.payment_method || '';
    const subMethod = (payment.payment_sub_method || '').trim();

    // 무통장 입금 / 수기 카드 → card-receipt-download 페이지 (생년월일 또는 사업자번호 인증 후 영수증 조회)
    if (method === '무통장입금' || subMethod === '무통장입금' || (method === '기타결제' && subMethod === '무통장입금')) {
      return res.redirect(302, `${fallbackUrl}?contract_id=${encodeURIComponent(contract_id)}`);
    }
    if (method === '수기카드' || (method === '기타결제' && subMethod === '수기카드')) {
      return res.redirect(302, `${fallbackUrl}?contract_id=${encodeURIComponent(contract_id)}`);
    }

    // 나이스페이먼츠, 네이버페이, 카카오페이 → PG 영수증 URL
    const receiptUrl = resolveReceiptUrlFromPayment(payment);
    if (receiptUrl) {
      if (!payment.receipt_url) {
        await pool.execute('UPDATE payments SET receipt_url = ? WHERE id = ?', [receiptUrl, payment.id]);
      }
      return res.redirect(302, receiptUrl);
    }

    return res.redirect(302, `${fallbackUrl}?contract_id=${encodeURIComponent(contract_id)}`);
  } catch (error) {
    console.error('Receipt redirect 오류:', error);
    return res.redirect(302, fallbackUrl);
  }
});

// 나이스페이먼츠 결제 승인
router.post('/api/payments/nicepay/approve', async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    console.log('===== 나이스페이 결제 승인 API 시작 =====');
    console.log('요청 body:', req.body);
    
    await connection.beginTransaction();

    const {
      contract_id,
      amount,
      orderId,
      tid,
      authToken,
      clientId,
      signature,
      authResultCode,
      authResultMsg,
      mallReserved,
      payMethod, // 결제 방법 (card, vbank 등)
    } = req.body;

    console.log('파싱된 요청 데이터:', {
      contract_id,
      amount,
      orderId,
      tid,
      authToken,
      clientId,
      signature,
      authResultCode,
      authResultMsg,
      mallReserved,
    });

    // 멱등 처리: 이미 동일 orderId로 완료된 결제가 있으면 재승인 API 호출 없이 성공 반환 (모바일 이중 호출 방지)
    if (orderId && contract_id) {
      const [existingRows] = await connection.execute<any[]>(
        `SELECT id, payment_number, pg_transaction_id, pg_response 
         FROM payments 
         WHERE contract_id = ? AND (payment_number = ? OR pg_transaction_id = ?) AND status = '완료' 
         LIMIT 1`,
        [contract_id, orderId, tid || '']
      );
      if (existingRows && existingRows.length > 0) {
        await connection.rollback();
        connection.release();
        console.log('이미 완료된 결제(orderId) - 멱등 반환:', orderId);
        const existing = existingRows[0];
        // MySQL JSON 컬럼(pg_response)은 드라이버/환경에 따라 이미 object로 내려올 수 있어
        // 문자열일 때만 JSON.parse를 수행하도록 방어합니다.
        let pgData: any = {};
        const rawPgResponse = existing.pg_response;
        if (rawPgResponse) {
          if (typeof rawPgResponse === 'string') {
            try {
              pgData = JSON.parse(rawPgResponse);
            } catch (parseError) {
              console.warn('멱등(pg_response) JSON.parse 실패, rawPgResponse를 무시합니다.', {
                orderId,
                error: (parseError as Error)?.message,
              });
              pgData = {};
            }
          } else if (typeof rawPgResponse === 'object') {
            pgData = rawPgResponse;
          }
        }
        return res.json({
          success: true,
          payment_id: existing.id,
          payment_number: orderId,
          message: '결제가 완료되었습니다.',
          data: pgData,
        });
      }
    }

    // AUTHNICE API 실제 결제 승인 처리
    console.log('✅ AUTHNICE 인증 성공 (authResultCode: 0000)');
    console.log('실제 결제 승인 API 호출 시작');

    // Basic Auth 생성 (clientId:secretKey)
    const clientKey = process.env.NICEPAY_CLIENT_KEY || '';
    const secretKey = process.env.NICEPAY_SECRET_KEY || '';
    
    console.log('환경변수 확인:', {
      clientKey: clientKey ? `${clientKey.substring(0, 10)}...` : '없음',
      secretKey: secretKey ? '설정됨' : '없음',
    });

    const authHeader = Buffer.from(`${clientKey}:${secretKey}`).toString('base64');
    console.log('Basic Auth 생성 완료');

    // 나이스페이 승인 API 호출 (실제 결제 처리)
    // 가상계좌인 경우 payMethod를 포함 (프론트에서 누락될 수 있어 DB도 확인)
    const approveAmount = parseInt(amount);
    const approveData: any = {
      amount: approveAmount,
      taxFreeAmt: approveAmount,
      supplyAmt: 0,
      vat: 0,
    };
    let isPendingVbank = false;
    if (contract_id) {
      const [pendingVbankRows] = await connection.execute<any[]>(
        `SELECT id FROM payments 
         WHERE contract_id = ? 
           AND payment_sub_method = '가상계좌' 
           AND status = '대기'
         ORDER BY id DESC
         LIMIT 1`,
        [contract_id]
      );
      isPendingVbank = pendingVbankRows.length > 0;
    }
    if (payMethod === 'vbank' || payMethod === 'VBANK' || isPendingVbank) {
      approveData.payMethod = 'VBANK';
    }

    const approveResponse = await axios.post(
      `${getNicepayApiBaseUrl()}/v1/payments/${tid}`,
      approveData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${authHeader}`
        }
      }
    );

    console.log('나이스페이 승인 API 응답:', approveResponse.data);
    const nicepayResponse = { data: approveResponse.data };
    const responsePayMethod = approveResponse.data.payMethod || payMethod || (isPendingVbank ? 'VBANK' : 'card');

    if (approveResponse.data.resultCode === '0000') {
      // 가상계좌인지 확인
      const isVirtualAccount = responsePayMethod === 'VBANK' || responsePayMethod === 'vbank';
      
      if (isVirtualAccount) {
        console.log('✅ 나이스페이 가상계좌 발급 성공!');
        
        // 가상계좌 정보 추출
        const {
          accountNumber,
          bankName,
          accountHolderName,
          expireDate,
        } = extractVbankInfo(approveResponse.data);

        if (!accountNumber || !bankName) {
          throw new Error('가상계좌 정보를 받지 못했습니다.');
        }

        // 가상계좌 결제 정보 저장 (상태: 대기)
        const receiptUrl = extractReceiptUrl(nicepayResponse.data);
        const [paymentResult] = await connection.execute<any>(
          `INSERT INTO payments (
            contract_id, payment_method, payment_sub_method, amount, status,
            payment_number, pg_transaction_id, pg_response, bank_name, account_number, receipt_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            contract_id,
            '기타결제',
            '가상계좌',
            amount,
            '대기',
            orderId,
            tid,
            JSON.stringify(nicepayResponse.data),
            bankName,
            accountNumber,
            receiptUrl,
          ]
        );

        const payment_id = paymentResult.insertId;

        // 계약 정보 조회 (고객 전화번호 확인)
        const [contractRows] = await connection.execute<any[]>(
          `SELECT tc.*, c.phone, c.mobile_phone, c.email, c.name as contractor_name
           FROM travel_contracts tc
           LEFT JOIN contractors c ON tc.id = c.contract_id
           WHERE tc.id = ? LIMIT 1`,
          [contract_id]
        );
        const contract = contractRows[0];

        // SMS 발송
        console.log('가상계좌 SMS 대상 조회 (approve):', {
          contract_id,
          contractor_name: contract?.contractor_name,
          mobile_phone: contract?.mobile_phone,
          phone: contract?.phone,
        });
        const recipientPhone = contract?.mobile_phone || contract?.phone;
        console.log('가상계좌 SMS 수신번호 (approve):', recipientPhone);
        if (recipientPhone) {
          const smsMessage = `[투어밸리] 여행보험료 입금 안내

은행: ${bankName}
계좌번호: ${accountNumber}
예금주: ${accountHolderName}
입금금액: ${parseInt(amount).toLocaleString()}원

위 계좌로 입금해주시기 바랍니다.`;
          
          try {
            // 알리고 SMS 발송
            await sendSms({
              receiver: recipientPhone,
              message: smsMessage,
              title: '[투어밸리] 여행보험료 입금 안내',
            });
            console.log('SMS 발송 성공');
          } catch (smsError) {
            console.error('SMS 발송 실패:', smsError);
            // SMS 발송 실패해도 가상계좌 발급은 성공으로 처리
          }
        }

        await connection.commit();

        console.log('DB에 가상계좌 정보 저장 완료, payment_id:', payment_id);
        
        res.json({
          success: true,
          payment_id,
          payment_number: orderId,
          accountNumber,
          bankName,
          accountHolderName,
          expireDate,
          message: '가상계좌가 발급되었습니다. 계좌번호는 문자로 발송됩니다.',
          data: nicepayResponse.data,
        });
      } else {
        console.log('✅ 나이스페이 실제 결제 승인 성공!');
        // 신용카드 결제 성공 — 대기 건의 무사고캐시 사용액을 완료 건에 반영
        const [pendingRows] = await connection.execute<any[]>(
          `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? AND status = '대기' ORDER BY id ASC LIMIT 1`,
          [contract_id]
        );
        const useAccidentFreeCash = pendingRows[0]?.use_accident_free_cash != null
          ? Math.max(0, Number(pendingRows[0].use_accident_free_cash))
          : 0;

        const receiptUrl = extractReceiptUrl(nicepayResponse.data);
        const [paymentResult] = await connection.execute<any>(
          `INSERT INTO payments (
            contract_id, payment_method, amount, status, payment_date,
            payment_number, pg_transaction_id, pg_response, receipt_url, use_accident_free_cash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            contract_id,
            '나이스페이먼츠',
            amount,
            '완료',
            new Date(),
            orderId,
            tid,
            JSON.stringify(nicepayResponse.data),
            receiptUrl,
            useAccidentFreeCash,
          ]
        );

        const payment_id = paymentResult.insertId;

        // 계약 상태 업데이트
        await connection.execute(
          `UPDATE travel_contracts 
           SET payment_status = '결제완료', payment_method = '나이스페이먼츠', status = '가입완료', updated_at = NOW()
           WHERE id = ?`,
          [contract_id]
        );

        // 계약 정보 조회 (member_id 확인)
        const [contractRows] = await connection.execute<any[]>(
          'SELECT member_id FROM travel_contracts WHERE id = ?',
          [contract_id]
        );
        const contract = contractRows[0];

        // 여행 계약 마일리지는 보험종료일+3일 경과 후 배치에서 적립 (scripts/accrueDeferredTravelMileage.ts)

        // 무사고캐시 사용분 차감 (위에서 조회한 useAccidentFreeCash 사용)
        if (useAccidentFreeCash > 0 && contract?.member_id) {
          const [memberRows] = await connection.execute<any[]>(
            `SELECT accident_free_cash FROM members WHERE id = ?`,
            [contract.member_id]
          );
          const currentCash = Number(memberRows[0]?.accident_free_cash ?? 0);
          const newCashBalance = Math.max(0, currentCash - useAccidentFreeCash);
          await connection.execute(
            `UPDATE members SET accident_free_cash = ?, updated_at = NOW() WHERE id = ?`,
            [newCashBalance, contract.member_id]
          );
          // reason_detail에 travel_contracts.id(계약 ID) 값 저장
          await connection.execute(
            `INSERT INTO accident_free_cash_history (member_id, type, amount, balance, reason, reason_detail, contract_id, created_at)
             VALUES (?, '사용', ?, ?, '보험료 결제 시 무사고캐시 사용', ?, ?, NOW())`,
            [contract.member_id, useAccidentFreeCash, newCashBalance, `계약번호: ${contract_id}`, contract_id]
          );
        }

        await connection.commit();

        try {
          await sendContractCompleteAlimTalk(contract_id, '나이스페이먼츠');
        } catch (alimtalkError) {
          console.error('가입완료 알림톡 발송 실패:', alimtalkError);
        }

        console.log('DB에 결제 정보 저장 완료, payment_id:', payment_id);
        
        res.json({
          success: true,
          payment_id,
          payment_number: orderId,
          message: '결제가 완료되었습니다.',
          data: nicepayResponse.data,
        });
      }
    } else {
      // 결제 실패
      console.error('❌ 나이스페이 결제 승인 실패:', nicepayResponse.data);
      
      const receiptUrl = extractReceiptUrl(nicepayResponse.data);
      await connection.execute(
        `INSERT INTO payments (
          contract_id, payment_method, amount, status, failure_reason, pg_response, receipt_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          '나이스페이먼츠',
          amount,
          '실패',
          nicepayResponse.data.resultMsg || '결제 승인 실패',
          JSON.stringify(nicepayResponse.data),
          receiptUrl,
        ]
      );

      await connection.commit();

      res.status(400).json({
        success: false,
        message: nicepayResponse.data.resultMsg || '결제 승인에 실패했습니다.',
        data: nicepayResponse.data,
      });
    }
  } catch (error: any) {
    await connection.rollback();
    console.error('❌ Nicepay approve error:', error);
    console.error('Error stack:', error.stack);
    
    if (error.response) {
      console.error('나이스페이 API 에러 응답:', error.response.data);
    }
    
    res.status(500).json({
      success: false,
      message: '결제 처리 중 오류가 발생했습니다.',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

// 나이스페이먼츠 결제 취소
router.post('/api/payments/nicepay/cancel', async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const { payment_id, cancelAmount, cancelReason } = req.body;

    // 결제 정보 조회
    const [paymentRows] = await connection.execute<any[]>(
      'SELECT * FROM payments WHERE id = ?',
      [payment_id]
    );

    if (!paymentRows || paymentRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '결제 정보를 찾을 수 없습니다.',
      });
    }

    const payment = paymentRows[0];
    console.log('vbank refund pg_response type:', typeof payment.pg_response);
    console.log('vbank refund pg_response raw:', payment.pg_response);
    let pgResponse: any = {};
    if (payment.pg_response) {
      if (typeof payment.pg_response === 'string') {
        try {
          pgResponse = JSON.parse(payment.pg_response);
        } catch (parseError) {
          console.warn('vbank refund pg_response parse failed, using raw value');
          pgResponse = {};
        }
      } else if (typeof payment.pg_response === 'object') {
        pgResponse = payment.pg_response;
      }
    }
    const tid = pgResponse.tid || payment.pg_transaction_id;

    if (!tid) {
      return res.status(400).json({
        success: false,
        message: '결제 거래 ID가 없습니다.',
      });
    }

    // 나이스페이먼츠 취소 API 호출
    const timestamp = Date.now().toString();
    const clientKey = process.env.NICEPAY_CLIENT_KEY || '';
    const secretKey = process.env.NICEPAY_SECRET_KEY || '';
    
    const signatureData = `${timestamp}${secretKey}`;
    const signature = crypto.createHash('sha256').update(signatureData).digest('hex');

    const cancelData = {
      timestamp,
      clientKey,
      signature,
      tid,
      cancelAmount: cancelAmount.toString(),
      cancelReason: cancelReason || '고객 요청',
    };

    const nicepayResponse = await axios.post(
      'https://webapi.nicepay.co.kr/webapi/payment/cancel.jsp',
      cancelData,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (nicepayResponse.data.resultCode === '0000') {
      // 취소 성공
      await connection.execute(
        `UPDATE payments 
         SET status = '취소', refund_amount = ?, refund_date = ?, refund_reason = ?, pg_response = JSON_MERGE_PATCH(COALESCE(pg_response, '{}'), ?)
         WHERE id = ?`,
        [
          cancelAmount,
          new Date(),
          cancelReason || '고객 요청',
          JSON.stringify(nicepayResponse.data),
          payment_id,
        ]
      );

      await connection.commit();

      res.json({
        success: true,
        message: '결제가 취소되었습니다.',
        data: nicepayResponse.data,
      });
    } else {
      await connection.rollback();
      res.status(400).json({
        success: false,
        message: nicepayResponse.data.resultMsg || '결제 취소에 실패했습니다.',
        data: nicepayResponse.data,
      });
    }
  } catch (error: any) {
    await connection.rollback();
    console.error('Nicepay cancel error:', error);
    res.status(500).json({
      success: false,
      message: '결제 취소 중 오류가 발생했습니다.',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

// 나이스페이 가상계좌 환불 (관리용 간이 API)
router.post('/api/payments/nicepay/vbank-refund', async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const {
      payment_id,
      orderId,
      tid,
      cancelAmt,
      reason,
      refundAccount,
      refundBankCode,
      refundHolder,
    } = req.body;

    if (!refundAccount || !refundBankCode || !refundHolder) {
      return res.status(400).json({
        success: false,
        message: '환불계좌 정보(은행코드/계좌/예금주)가 필요합니다.',
      });
    }

    const [paymentRows] = await connection.execute<any[]>(
      payment_id
        ? 'SELECT * FROM payments WHERE id = ?'
        : orderId
          ? 'SELECT * FROM payments WHERE payment_number = ?'
          : tid
            ? 'SELECT * FROM payments WHERE pg_transaction_id = ?'
            : 'SELECT * FROM payments WHERE 1=0',
      [payment_id || orderId || tid]
    );

    if (!paymentRows || paymentRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '결제 정보를 찾을 수 없습니다.',
      });
    }

    const payment = paymentRows[0];
    console.log('vbank refund pg_response type:', typeof payment.pg_response);
    console.log('vbank refund pg_response raw:', payment.pg_response);
    let pgResponse: any = {};
    if (payment.pg_response) {
      if (typeof payment.pg_response === 'string') {
        try {
          pgResponse = JSON.parse(payment.pg_response);
        } catch (parseError) {
          console.warn('vbank refund pg_response parse failed, using raw value');
          pgResponse = {};
        }
      } else if (typeof payment.pg_response === 'object') {
        pgResponse = payment.pg_response;
      }
    }
    const resolvedTid = tid || pgResponse.tid || payment.pg_transaction_id;
    const resolvedOrderId = orderId || payment.payment_number || pgResponse.orderId;

    if (!resolvedTid || !resolvedOrderId) {
      return res.status(400).json({
        success: false,
        message: '결제 거래 정보(tid/orderId)가 부족합니다.',
      });
    }

    const refundAmount = cancelAmt ? parseInt(cancelAmt, 10) : parseInt(payment.amount, 10);
    if (!refundAmount || refundAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: '환불 금액이 올바르지 않습니다.',
      });
    }

    const clientKey = process.env.NICEPAY_CLIENT_KEY || '';
    const secretKey = process.env.NICEPAY_SECRET_KEY || '';
    const authHeader = Buffer.from(`${clientKey}:${secretKey}`).toString('base64');

    const cancelOrderId = `${resolvedOrderId}-RF${Date.now()}`;
    const cancelPayload: any = {
      reason: reason || '관리자 환불',
      orderId: cancelOrderId,
      refundAccount,
      refundBankCode,
      refundHolder,
    };
    const isEscrow = pgResponse?.useEscrow === true;
    const paymentAmount = parseInt(payment.amount, 10);
    const isFullRefund = refundAmount === paymentAmount;
    if (!(isEscrow && isFullRefund)) {
      cancelPayload.cancelAmt = refundAmount;
    }

    console.log('vbank refund request payload:', cancelPayload);
    const nicepayResponse = await axios.post(
      `${getNicepayApiBaseUrl()}/v1/payments/${resolvedTid}/cancel`,
      cancelPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${authHeader}`,
        },
      }
    );
    console.log('vbank refund response:', nicepayResponse.data);

    if (nicepayResponse.data?.resultCode === '0000') {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE payments
         SET status = '환불', refund_amount = ?, refund_date = ?, refund_reason = ?,
             pg_response = JSON_MERGE_PATCH(COALESCE(pg_response, '{}'), ?)
         WHERE id = ?`,
        [
          refundAmount,
          new Date(),
          cancelPayload.reason,
          JSON.stringify(nicepayResponse.data),
          payment.id,
        ]
      );

      await connection.execute(
        `UPDATE travel_contracts
         SET payment_status = '미결제'
         WHERE id = ?`,
        [payment.contract_id]
      );

      await connection.commit();
      return res.json({
        success: true,
        message: '가상계좌 환불이 요청되었습니다.',
        data: nicepayResponse.data,
      });
    }

    return res.status(400).json({
      success: false,
      message: nicepayResponse.data?.resultMsg || '환불 요청에 실패했습니다.',
      data: nicepayResponse.data,
    });
  } catch (error: any) {
    await connection.rollback();
    console.error('Nicepay vbank refund error:', error);
    res.status(500).json({
      success: false,
      message: '가상계좌 환불 처리 중 오류가 발생했습니다.',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

// 네이버페이 결제 준비 (추후 구현)
router.post('/api/payments/naverpay/prepare', async (req: Request, res: Response) => {
  // 네이버페이 연동 준비 중
  res.json({
    success: false,
    message: '네이버페이 연동 준비 중입니다.',
  });
});

// 카카오페이 결제 준비 (추후 구현)
router.post('/api/payments/kakaopay/prepare', async (req: Request, res: Response) => {
  // 카카오페이 연동 준비 중
  res.json({
    success: false,
    message: '카카오페이 연동 준비 중입니다.',
  });
});

// 나이스페이 결제 콜백 (POST) - 나이스페이에서 결제 완료 후 호출
router.post('/api/payments/nicepay/callback', async (req: Request, res: Response) => {
  try {
    console.log('===== 나이스페이 콜백 (POST) 받음 =====');
    console.log('받은 데이터:', req.body);
    
    // 나이스페이에서 전달받은 파라미터들
    const { authResultCode, authResultMsg, tid, clientId, orderId, amount, mallReserved, authToken, signature } = req.body;
    
    // URL 쿼리 파라미터로 변환하여 결제 완료 페이지로 리다이렉트
    const params = new URLSearchParams();
    if (authResultCode) params.append('authResultCode', authResultCode);
    if (authResultMsg) params.append('authResultMsg', authResultMsg);
    if (tid) params.append('tid', tid);
    if (clientId) params.append('clientId', clientId);
    if (orderId) params.append('orderId', orderId);
    if (amount) params.append('amount', amount.toString());
    if (mallReserved) params.append('mallReserved', mallReserved);
    if (authToken) params.append('authToken', authToken);
    if (signature) params.append('signature', signature);
    
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUrl = `${frontendUrl}/payment/complete?${params.toString()}`;
    
    console.log('프론트엔드로 리다이렉트:', redirectUrl);
    
    // 302 리다이렉트
    res.redirect(302, redirectUrl);
  } catch (error) {
    console.error('나이스페이 콜백 처리 오류:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(302, `${frontendUrl}/payment/complete?error=callback_failed`);
  }
});

// 나이스페이 결제 콜백 (GET) - 나이스페이가 GET으로 보내는 경우
router.get('/api/payments/nicepay/callback', async (req: Request, res: Response) => {
  try {
    console.log('===== 나이스페이 콜백 (GET) 받음 =====');
    console.log('받은 파라미터:', req.query);
    
    const { authResultCode, authResultMsg, tid, clientId, orderId, amount, mallReserved, authToken, signature } = req.query;
    
    const params = new URLSearchParams();
    if (authResultCode) params.append('authResultCode', authResultCode as string);
    if (authResultMsg) params.append('authResultMsg', authResultMsg as string);
    if (tid) params.append('tid', tid as string);
    if (clientId) params.append('clientId', clientId as string);
    if (orderId) params.append('orderId', orderId as string);
    if (amount) params.append('amount', amount as string);
    if (mallReserved) params.append('mallReserved', mallReserved as string);
    if (authToken) params.append('authToken', authToken as string);
    if (signature) params.append('signature', signature as string);
    
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUrl = `${frontendUrl}/payment/complete?${params.toString()}`;
    
    console.log('프론트엔드로 리다이렉트:', redirectUrl);
    
    res.redirect(302, redirectUrl);
  } catch (error) {
    console.error('나이스페이 콜백 처리 오류:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(302, `${frontendUrl}/payment/complete?error=callback_failed`);
  }
});

// 나이스페이 가상계좌 발급
router.post('/api/payments/nicepay/virtual-account', async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const {
      contract_id,
      amount,
      buyerName,
      buyerEmail,
      buyerTel,
      bankCode, // 은행 코드 (003, 004, 011 등)
    } = req.body;

    if (!contract_id || !amount || !bankCode) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    console.log('===== 나이스페이 가상계좌 발급 시작 =====');
    console.log('요청 데이터:', { contract_id, amount, buyerName, buyerEmail, buyerTel, bankCode });

    const clientKey = process.env.NICEPAY_CLIENT_KEY || '';
    const secretKey = process.env.NICEPAY_SECRET_KEY || '';
    
    // 주문번호 생성
    const orderId = `VA${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    
    // 나이스페이 가상계좌 발급 API 호출
    const authHeader = Buffer.from(`${clientKey}:${secretKey}`).toString('base64');

    // 만료일시 계산 (7일 후, YYMMDDHHMMSS 형식)
    const expireDate = new Date(Date.now() + 168 * 60 * 60 * 1000);
    const year = expireDate.getFullYear().toString().slice(-2);
    const month = (expireDate.getMonth() + 1).toString().padStart(2, '0');
    const day = expireDate.getDate().toString().padStart(2, '0');
    const hours = expireDate.getHours().toString().padStart(2, '0');
    const minutes = expireDate.getMinutes().toString().padStart(2, '0');
    const seconds = expireDate.getSeconds().toString().padStart(2, '0');
    const vbankExpDate = `${year}${month}${day}${hours}${minutes}${seconds}`;

    // 웹훅 URL 설정 (가상계좌 입금 통지용)
    const notifyBaseUrl = process.env.FRONTEND_URL || process.env.BACKEND_URL || 'http://localhost:4000';
    const notifyUrl = `${notifyBaseUrl}/api/payments/nicepay/virtual-account/notify`;

    // 가상계좌 발급 요청 (한 번에 처리)
    const vbankAmount = parseInt(amount);
    const virtualAccountData = {
      orderId,
      amount: vbankAmount,
      taxFreeAmt: vbankAmount,
      supplyAmt: 0,
      vat: 0,
      goodsName: withB2cPgProductPrefix('여행보험료'),
      buyerName: buyerName || '',
      buyerEmail: buyerEmail || '',
      buyerTel: buyerTel || '',
      payMethod: 'VBANK',
      bankCode, // 은행 코드
      vbankExpDate, // 7일 후 (YYMMDDHHMMSS 형식)
      notifyUrl, // 웹훅 URL (가상계좌 입금 통지용)
    };

    console.log('나이스페이 가상계좌 발급 API 호출:', virtualAccountData);

    const nicepayResponse = await axios.post(
      `${getNicepayApiBaseUrl()}/v1/payments`,
      virtualAccountData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${authHeader}`,
        },
      }
    );

    console.log('나이스페이 가상계좌 발급 응답:', nicepayResponse.data);

    if (nicepayResponse.data.resultCode === '0000') {
      // 가상계좌 정보는 vbank 객체 안에 있음
      const {
        accountNumber,
        bankName,
        accountHolderName,
        expireDate,
      } = extractVbankInfo(nicepayResponse.data);

      if (!accountNumber || !bankName) {
        throw new Error('가상계좌 정보를 받지 못했습니다.');
      }

      const tid = nicepayResponse.data.tid || '';
      
      // 대기 건(계약 등록 시 생성)의 무사고캐시 사용액을 이 행에도 반영 (입금 완료 시 같은 행이 완료로 UPDATE됨)
      const [vbankPendingRows] = await connection.execute<any[]>(
        `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? AND status = '대기' ORDER BY id ASC LIMIT 1`,
        [contract_id]
      );
      const vbankUseAccidentFreeCash = vbankPendingRows[0]?.use_accident_free_cash != null
        ? Math.max(0, Number(vbankPendingRows[0].use_accident_free_cash))
        : 0;

      // 결제 정보 저장 (상태: 대기)
      const receiptUrl = extractReceiptUrl(nicepayResponse.data);
      const [paymentResult] = await connection.execute<any>(
        `INSERT INTO payments (
          contract_id, payment_method, payment_sub_method, amount, status,
          payment_number, pg_transaction_id, pg_response, bank_name, account_number, receipt_url, use_accident_free_cash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          '기타결제',
          '가상계좌',
          amount,
          '대기',
          orderId,
          tid,
          JSON.stringify(nicepayResponse.data),
          bankName,
          accountNumber,
          receiptUrl,
          vbankUseAccidentFreeCash,
        ]
      );

      const payment_id = paymentResult.insertId;

      // 계약 정보 조회 (고객 전화번호 확인)
      const [contractRows] = await connection.execute<any[]>(
        `SELECT tc.*, c.phone, c.mobile_phone, c.email, c.name as contractor_name
         FROM travel_contracts tc
         LEFT JOIN contractors c ON tc.id = c.contract_id
         WHERE tc.id = ? LIMIT 1`,
        [contract_id]
      );
      const contract = contractRows[0];

      // SMS 발송
      console.log('가상계좌 SMS 대상 조회:', {
        contract_id,
        contractor_name: contract?.contractor_name,
        mobile_phone: contract?.mobile_phone,
        phone: contract?.phone,
      });
      const recipientPhone = contract?.mobile_phone || contract?.phone;
      console.log('가상계좌 SMS 수신번호:', recipientPhone);
      if (recipientPhone) {
        const smsMessage = `[투어밸리] 여행보험료 입금 안내

은행: ${bankName}
계좌번호: ${accountNumber}
예금주: ${accountHolderName}
입금금액: ${parseInt(amount).toLocaleString()}원

위 계좌로 입금해주시기 바랍니다.`;
        
        try {
          // 알리고 SMS 발송
          await sendSms({
            receiver: recipientPhone,
            message: smsMessage,
            title: '[투어밸리] 여행보험료 입금 안내',
          });
          console.log('SMS 발송 성공');
        } catch (smsError) {
          console.error('SMS 발송 실패:', smsError);
          // SMS 발송 실패해도 가상계좌 발급은 성공으로 처리
        }
      }

      await connection.commit();

      res.json({
        success: true,
        payment_id,
        orderId,
        accountNumber,
        bankName,
        accountHolderName,
        expireDate,
        message: '가상계좌가 발급되었습니다. 계좌번호는 문자로 발송됩니다.',
        data: nicepayResponse.data,
      });
    } else {
      await connection.rollback();
      res.status(400).json({
        success: false,
        message: nicepayResponse.data.resultMsg || '가상계좌 발급에 실패했습니다.',
        data: nicepayResponse.data,
      });
    }
  } catch (error: any) {
    await connection.rollback();
    console.error('나이스페이 가상계좌 발급 오류:', error);
    
    if (error.response) {
      console.error('나이스페이 API 에러 응답:', error.response.data);
    }
    
    res.status(500).json({
      success: false,
      message: '가상계좌 발급 중 오류가 발생했습니다.',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

// 나이스페이 가상계좌 입금 통지 (웹훅)
router.post('/api/payments/nicepay/virtual-account/notify', async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    console.log('===== 나이스페이 가상계좌 입금 통지 =====');
    console.log('받은 데이터:', req.body);

    const { orderId, tid, status, accountNumber, bankName, amount, mallReserved, resultCode, paidAt } = req.body;

    // 웹훅 등록 테스트 요청인지 확인 (mallReserved에 테스트 메시지가 있는 경우)
    const isTestRequest = mallReserved && (
      mallReserved.includes('TEST') || 
      mallReserved.includes('테스트') ||
      mallReserved.includes('웹훅 등록')
    );

    if (isTestRequest) {
      console.log('웹훅 등록 테스트 요청입니다. 200 응답 및 OK 문자열 반환');
      return res.status(200).setHeader('Content-Type', 'text/plain').send('OK');
    }

    // 결제 정보 조회
    const [paymentRows] = await connection.execute<any[]>(
      'SELECT * FROM payments WHERE payment_number = ?',
      [orderId]
    );

    if (!paymentRows || paymentRows.length === 0) {
      console.error('결제 정보를 찾을 수 없습니다:', orderId);
      // 나이스페이 웹훅은 200 + OK 응답을 요구함
      return res.status(200).setHeader('Content-Type', 'text/plain').send('OK');
    }

    const payment = paymentRows[0];

    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
    const isPaidStatus =
      normalizedStatus === 'paid' ||
      normalizedStatus === '입금완료' ||
      normalizedStatus === 'deposit' ||
      normalizedStatus === 'depositcomplete' ||
      normalizedStatus === 'pay';
    // paidAt은 발급 시점에도 내려오는 경우가 있어 status가 없는 경우에만 보조 판단
    const isPaidByResult = resultCode === '0000' && !!paidAt && !normalizedStatus;

    if (isPaidStatus || isPaidByResult) {
      await connection.beginTransaction();

      // 결제 상태 업데이트
      await connection.execute(
        `UPDATE payments 
         SET status = '완료', payment_date = NOW(), pg_response = JSON_MERGE_PATCH(COALESCE(pg_response, '{}'), ?)
         WHERE id = ?`,
        [JSON.stringify(req.body), payment.id]
      );

      // 계약 상태 업데이트
      await connection.execute(
        `UPDATE travel_contracts 
         SET payment_status = '결제완료', payment_method = '기타결제', status = '가입완료', updated_at = NOW()
         WHERE id = ?`,
        [payment.contract_id]
      );

      // 계약 정보 조회 (member_id 확인)
      const [contractRows] = await connection.execute<any[]>(
        'SELECT member_id FROM travel_contracts WHERE id = ?',
        [payment.contract_id]
      );
      const contract = contractRows[0];

      // 여행 계약 마일리지는 보험종료일+3일 경과 후 배치에서 적립 (scripts/accrueDeferredTravelMileage.ts)

      // 무사고캐시 사용분 차감 (가상계좌 입금 완료 시) - register-contract 시 저장한 값은 계약의 첫 번째 대기 결제 행에 있음
      const [pendingPaymentRows] = await connection.execute<any[]>(
        `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? ORDER BY id ASC LIMIT 1`,
        [payment.contract_id]
      );
      const useAccidentFreeCash = pendingPaymentRows[0]?.use_accident_free_cash != null
        ? Math.max(0, Number(pendingPaymentRows[0].use_accident_free_cash))
        : 0;
      if (useAccidentFreeCash > 0 && contract?.member_id) {
        const [memberRows] = await connection.execute<any[]>(
          `SELECT accident_free_cash FROM members WHERE id = ?`,
          [contract.member_id]
        );
        const currentCash = Number(memberRows[0]?.accident_free_cash ?? 0);
        const newCashBalance = Math.max(0, currentCash - useAccidentFreeCash);
        await connection.execute(
          `UPDATE members SET accident_free_cash = ?, updated_at = NOW() WHERE id = ?`,
          [newCashBalance, contract.member_id]
        );
        // reason_detail에 travel_contracts.id(계약 ID) 값 저장
        await connection.execute(
          `INSERT INTO accident_free_cash_history (member_id, type, amount, balance, reason, reason_detail, contract_id, created_at)
           VALUES (?, '사용', ?, ?, '보험료 결제 시 무사고캐시 사용', ?, ?, NOW())`,
          [contract.member_id, useAccidentFreeCash, newCashBalance, `계약번호: ${payment.contract_id}`, payment.contract_id]
        );
      }

      await connection.commit();

      try {
        await sendContractCompleteAlimTalk(payment.contract_id, '기타결제', '가상계좌');
      } catch (alimtalkError) {
        console.error('가입완료 알림톡 발송 실패:', alimtalkError);
      }

      console.log('가상계좌 입금 완료 처리 완료');
    } else {
      console.log('가상계좌 입금 통지 무시 (대기 상태):', {
        orderId,
        status,
        resultCode,
        paidAt,
      });
    }

    // 나이스페이 웹훅은 200 + OK 응답을 요구함
    res.status(200).setHeader('Content-Type', 'text/plain').send('OK');
  } catch (error: any) {
    await connection.rollback();
    console.error('가상계좌 입금 통지 처리 오류:', error);
    res.status(500).json({
      success: false,
      message: '처리 중 오류가 발생했습니다.',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

export default router;

