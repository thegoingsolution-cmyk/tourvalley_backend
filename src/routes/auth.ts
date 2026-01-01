import { Router, Request, Response } from 'express';
import { 
  checkUsernameExists, 
  registerPersonalMember, 
  registerCorporateMember,
  loginMember,
  updateMember,
  getCorporateMemberInfo,
  updateCorporateMember
} from '../services/authService';

const router = Router();

/**
 * POST /api/auth/login
 * 로그인
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    // 필수값 검증
    if (!username) {
      return res.status(400).json({
        success: false,
        message: '아이디를 입력해주세요.',
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: '비밀번호를 입력해주세요.',
      });
    }

    const result = await loginMember(username, password);

    if (result.success) {
      res.json(result);
    } else {
      res.status(401).json(result);
    }

  } catch (error) {
    console.error('로그인 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '로그인에 실패했습니다.',
    });
  }
});

/**
 * POST /api/auth/check-username
 * 아이디 중복 확인
 */
router.post('/check-username', async (req: Request, res: Response) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        message: '아이디를 입력해주세요.',
      });
    }

    // 아이디 유효성 검사 (4-20자, 영문/숫자만)
    const usernameRegex = /^[a-zA-Z0-9]{4,20}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({
        success: false,
        message: '아이디는 4-20자의 영문, 숫자만 사용 가능합니다.',
      });
    }

    const exists = await checkUsernameExists(username);

    if (exists) {
      return res.status(400).json({
        success: false,
        message: '이미 사용중인 아이디입니다.',
      });
    }

    res.json({
      success: true,
      message: '사용 가능한 아이디입니다.',
    });

  } catch (error) {
    console.error('아이디 중복확인 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '아이디 확인에 실패했습니다.',
    });
  }
});

/**
 * POST /api/auth/register/personal
 * 개인회원 가입
 */
router.post('/register/personal', async (req: Request, res: Response) => {
  try {
    const {
      username,
      password,
      name,
      birthDate,
      gender,
      email,
      emailDomain,
      phone,
      termsAgreed,
      privacyAgreed,
      marketingAgreed,
    } = req.body;

    // 필수값 검증
    if (!username || !password || !name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: '필수 정보를 모두 입력해주세요.',
      });
    }

    // 비밀번호 유효성 검사 (최소 8자)
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: '비밀번호는 최소 8자 이상이어야 합니다.',
      });
    }

    // 약관 동의 확인
    if (!termsAgreed || !privacyAgreed) {
      return res.status(400).json({
        success: false,
        message: '필수 약관에 동의해주세요.',
      });
    }

    const result = await registerPersonalMember({
      username,
      password,
      name,
      birthDate,
      gender,
      email,
      emailDomain,
      phone,
      termsAgreed,
      privacyAgreed,
      marketingAgreed: marketingAgreed || false,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('개인회원 가입 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '회원가입에 실패했습니다.',
    });
  }
});

/**
 * POST /api/auth/register/corporate
 * 법인회원 가입
 */
router.post('/register/corporate', async (req: Request, res: Response) => {
  try {
    const {
      username,
      password,
      companyName,
      businessNumber,
      contacts,
      comprehensiveContract,
      termsAgreed,
      privacyAgreed,
      marketingAgreed,
      primaryPhone,
      businessFilePath,
      businessFileName,
    } = req.body;

    // 필수값 검증
    if (!username || !password || !companyName || !businessNumber || !contacts || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        message: '필수 정보를 모두 입력해주세요.',
      });
    }

    // 담당자 필수 정보 확인
    if (!contacts[0].name) {
      return res.status(400).json({
        success: false,
        message: '담당자명을 입력해주세요.',
      });
    }

    // 비밀번호 유효성 검사 (최소 8자)
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: '비밀번호는 최소 8자 이상이어야 합니다.',
      });
    }

    // 약관 동의 확인
    if (!termsAgreed || !privacyAgreed) {
      return res.status(400).json({
        success: false,
        message: '필수 약관에 동의해주세요.',
      });
    }

    const result = await registerCorporateMember({
      username,
      password,
      companyName,
      businessNumber,
      contacts,
      comprehensiveContract: comprehensiveContract === 'apply',
      termsAgreed,
      privacyAgreed,
      marketingAgreed: marketingAgreed || false,
      primaryPhone: primaryPhone || contacts[0].phone,
      businessFilePath,
      businessFileName,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('법인회원 가입 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '회원가입에 실패했습니다.',
    });
  }
});

/**
 * PUT /api/auth/member/:id
 * 회원 정보 수정
 */
router.put('/member/:id', async (req: Request, res: Response) => {
  try {
    const memberId = parseInt(req.params.id, 10);
    
    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '잘못된 회원 ID입니다.',
      });
    }

    const {
      password,
      email,
      emailDomain,
      mobilePhone,
      marketingAgreed,
      emailReceive,
      smsReceive,
    } = req.body;

    // 비밀번호 유효성 검사 (입력된 경우에만)
    if (password && password.length < 4) {
      return res.status(400).json({
        success: false,
        message: '비밀번호는 최소 4자 이상이어야 합니다.',
      });
    }

    const result = await updateMember(memberId, {
      password,
      email,
      emailDomain,
      mobilePhone,
      marketingAgreed,
      emailReceive,
      smsReceive,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('회원정보 수정 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '회원정보 수정에 실패했습니다.',
    });
  }
});

/**
 * GET /api/auth/corporate/:memberId
 * 법인회원 정보 조회
 */
router.get('/corporate/:memberId', async (req: Request, res: Response) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    
    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '잘못된 회원 ID입니다.',
      });
    }

    const result = await getCorporateMemberInfo(memberId);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('법인회원 정보 조회 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '법인회원 정보 조회에 실패했습니다.',
    });
  }
});

/**
 * PUT /api/auth/corporate/:memberId
 * 법인회원 정보 수정
 */
router.put('/corporate/:memberId', async (req: Request, res: Response) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    
    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '잘못된 회원 ID입니다.',
      });
    }

    const {
      password,
      contacts,
      comprehensiveContract,
      marketingAgreed,
      emailReceive,
      smsReceive,
      businessFilePath,
      businessFileName,
    } = req.body;

    // 비밀번호 유효성 검사 (입력된 경우에만)
    if (password && password.length < 4) {
      return res.status(400).json({
        success: false,
        message: '비밀번호는 최소 4자 이상이어야 합니다.',
      });
    }

    const result = await updateCorporateMember(memberId, {
      password,
      contacts,
      comprehensiveContract,
      marketingAgreed,
      emailReceive,
      smsReceive,
      businessFilePath,
      businessFileName,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('법인회원 정보 수정 API 오류:', error);
    res.status(500).json({
      success: false,
      message: '법인회원 정보 수정에 실패했습니다.',
    });
  }
});

export default router;

