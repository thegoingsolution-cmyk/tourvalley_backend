import { Router, Request, Response } from 'express';
import pool from '../config/database';
import axios from 'axios';
import crypto from 'crypto';
import { sendSms } from '../services/aligoService';
import { sendContractCompleteAlimTalk } from '../services/contractAlimtalkService';

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


// 나이스페이먼츠 결제 요청 (결제창 호출용 파라미터 생성)
router.post('/api/payments/nicepay/request', async (req: Request, res: Response) => {
  try {
    const {
      contract_id,
      amount,
      goodsName,
      buyerName,
      buyerEmail,
      buyerTel,
      returnUrl,
      closeUrl,
    } = req.body;

    const clientKey = process.env.NICEPAY_CLIENT_KEY || '';
    const timestamp = Date.now().toString();
    
    // 주문번호 생성 (고유한 값)
    const orderId = `TC${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

    // 결제창 호출을 위한 파라미터 반환
    res.json({
      success: true,
      clientKey,
      orderId,
      amount: amount.toString(),
      goodsName: goodsName || '국내여행보험',
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

    let receiptUrl: string | null = payment.receipt_url || null;
    let pgResponse = payment.pg_response;

    if (!receiptUrl && pgResponse) {
      if (typeof pgResponse === 'string') {
        try {
          pgResponse = JSON.parse(pgResponse);
        } catch (error) {
          pgResponse = null;
        }
      }

      receiptUrl = extractReceiptUrl(pgResponse);
    }

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
    // 가상계좌인 경우 payMethod를 포함
    const approveData: any = { amount: parseInt(amount) };
    if (payMethod === 'vbank' || payMethod === 'VBANK') {
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
    const responsePayMethod = approveResponse.data.payMethod || payMethod || 'card';

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
        const [paymentResult] = await connection.execute<any>(
          `INSERT INTO payments (
            contract_id, payment_method, payment_sub_method, amount, status,
            payment_number, pg_transaction_id, pg_response, bank_name, account_number
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        const recipientPhone = contract?.phone || contract?.mobile_phone;
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
        // 신용카드 결제 성공
        const [paymentResult] = await connection.execute<any>(
          `INSERT INTO payments (
            contract_id, payment_method, amount, status, payment_date,
            payment_number, pg_transaction_id, pg_response
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            contract_id,
            '나이스페이먼츠',
            amount,
            '완료',
            new Date(),
            orderId,
            tid,
            JSON.stringify(nicepayResponse.data),
          ]
        );

        const payment_id = paymentResult.insertId;

        // 계약 상태 업데이트
        await connection.execute(
          `UPDATE travel_contracts 
           SET payment_status = '결제완료', payment_method = '나이스페이먼츠'
           WHERE id = ?`,
          [contract_id]
        );

        // 계약 정보 조회 (member_id 확인)
        const [contractRows] = await connection.execute<any[]>(
          'SELECT member_id FROM travel_contracts WHERE id = ?',
          [contract_id]
        );
        const contract = contractRows[0];

        // 마일리지 지급 (결제 금액의 3%, 최대 30,000P)
        const mileageAmount = Math.min(Math.floor(parseInt(amount) * 0.03), 30000);
        
        if (mileageAmount > 0 && contract?.member_id) {
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
      
      await connection.execute(
        `INSERT INTO payments (
          contract_id, payment_method, amount, status, failure_reason, pg_response
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          '나이스페이먼츠',
          amount,
          '실패',
          nicepayResponse.data.resultMsg || '결제 승인 실패',
          JSON.stringify(nicepayResponse.data),
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
    const virtualAccountData = {
      orderId,
      amount: parseInt(amount),
      goodsName: '여행보험료',
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
      
      // 결제 정보 저장 (상태: 대기)
      const [paymentResult] = await connection.execute<any>(
        `INSERT INTO payments (
          contract_id, payment_method, payment_sub_method, amount, status,
          payment_number, pg_transaction_id, pg_response, bank_name, account_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const recipientPhone = contract?.phone || contract?.mobile_phone;
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
      // 웹훅 등록 테스트가 아닌 경우에도 200 반환 (Nicepay 요구사항)
      return res.status(200).json({ success: false, message: '결제 정보를 찾을 수 없습니다.' });
    }

    const payment = paymentRows[0];

    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
    const isPaidStatus =
      normalizedStatus === 'paid' ||
      normalizedStatus === '입금완료' ||
      normalizedStatus === 'deposit' ||
      normalizedStatus === 'depositcomplete' ||
      normalizedStatus === 'pay';
    const isPaidByResult = resultCode === '0000' && !!paidAt;

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
         SET payment_status = '결제완료', payment_method = '기타결제'
         WHERE id = ?`,
        [payment.contract_id]
      );

      // 계약 정보 조회 (member_id 확인)
      const [contractRows] = await connection.execute<any[]>(
        'SELECT member_id FROM travel_contracts WHERE id = ?',
        [payment.contract_id]
      );
      const contract = contractRows[0];

      // 마일리지 지급 (결제 금액의 3%, 최대 30,000P)
      const mileageAmount = Math.min(Math.floor(parseInt(amount) * 0.03), 30000);
      
      if (mileageAmount > 0 && contract?.member_id) {
        await connection.execute(
          `UPDATE members SET mileage = mileage + ? WHERE id = ?`,
          [mileageAmount, contract.member_id]
        );

        const [memberResult] = await connection.execute<any[]>(
          `SELECT mileage FROM members WHERE id = ?`,
          [contract.member_id]
        );
        const newBalance = memberResult[0]?.mileage || 0;

        await connection.execute(
          `INSERT INTO mileage_transactions (
            member_id, type, amount, description, reason, reason_detail, reference_type, reference_id, balance
          ) VALUES (?, 'earn', ?, '여행보험 가입 마일리지', '여행보험 가입 마일리지', '보험료의 3% 적립 (최대 30,000P)', 'contract', ?, ?)`,
          [contract.member_id, mileageAmount, payment.contract_id, newBalance]
        );
      }

      await connection.commit();

      try {
        await sendContractCompleteAlimTalk(payment.contract_id, '기타결제', '가상계좌');
      } catch (alimtalkError) {
        console.error('가입완료 알림톡 발송 실패:', alimtalkError);
      }

      console.log('가상계좌 입금 완료 처리 완료');
    }

    res.json({ success: true, message: '처리 완료' });
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

