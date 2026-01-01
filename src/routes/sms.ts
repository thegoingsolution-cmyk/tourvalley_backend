import { Router, Request, Response } from 'express';
import { sendVerification, verifyCode, checkVerificationStatus } from '../services/verificationService';
import { checkRemainSms } from '../services/aligoService';

const router = Router();

/**
 * POST /api/sms/send
 * 인증번호 발송
 */
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { phoneNumber, testmode } = req.body;

    // 전화번호 유효성 검사
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: '휴대폰 번호를 입력해주세요.',
      });
    }

    // 전화번호 형식 검사 (한국 휴대폰)
    const phoneRegex = /^01[0-9]{8,9}$/;
    const cleanPhone = phoneNumber.replace(/-/g, '');
    
    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: '올바른 휴대폰 번호 형식이 아닙니다.',
      });
    }

    // 인증번호 발송
    const result = await sendVerification(cleanPhone, testmode === true);

    res.json(result);
  } catch (error) {
    console.error('인증번호 발송 API 오류:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'SMS 발송에 실패했습니다.',
    });
  }
});

/**
 * POST /api/sms/verify
 * 인증번호 확인
 */
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const { phoneNumber, code } = req.body;

    // 필수값 검사
    if (!phoneNumber || !code) {
      return res.status(400).json({
        success: false,
        message: '휴대폰 번호와 인증번호를 입력해주세요.',
      });
    }

    const cleanPhone = phoneNumber.replace(/-/g, '');

    // 인증번호 확인
    const result = await verifyCode(cleanPhone, code);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('인증번호 확인 API 오류:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '인증 확인에 실패했습니다.',
    });
  }
});

/**
 * GET /api/sms/status/:phoneNumber
 * 인증 상태 확인
 */
router.get('/status/:phoneNumber', async (req: Request, res: Response) => {
  try {
    const { phoneNumber } = req.params;
    const cleanPhone = phoneNumber.replace(/-/g, '');

    const result = await checkVerificationStatus(cleanPhone);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('인증 상태 확인 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '인증 상태 확인에 실패했습니다.',
    });
  }
});

/**
 * GET /api/sms/remain
 * 잔여 SMS 수량 확인 (관리용)
 */
router.get('/remain', async (req: Request, res: Response) => {
  try {
    const result = await checkRemainSms();

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('잔여 SMS 조회 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '잔여 SMS 조회에 실패했습니다.',
    });
  }
});

export default router;

