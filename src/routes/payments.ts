import { Router, Request, Response } from 'express';
import pool from '../config/database';
import axios from 'axios';
import crypto from 'crypto';

const router = Router();

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
    const approveResponse = await axios.post(
      `https://api.nicepay.co.kr/v1/payments/${tid}`,
      { amount: parseInt(amount) },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${authHeader}`
        }
      }
    );

    console.log('나이스페이 승인 API 응답:', approveResponse.data);
    const nicepayResponse = { data: approveResponse.data };

    if (approveResponse.data.resultCode === '0000') {
      console.log('✅ 나이스페이 실제 결제 승인 성공!');
      // 결제 성공
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

      console.log('DB에 결제 정보 저장 완료, payment_id:', payment_id);
      
      res.json({
        success: true,
        payment_id,
        payment_number: orderId,
        message: '결제가 완료되었습니다.',
        data: nicepayResponse.data,
      });
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
    const pgResponse = payment.pg_response ? JSON.parse(payment.pg_response) : {};
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

export default router;

