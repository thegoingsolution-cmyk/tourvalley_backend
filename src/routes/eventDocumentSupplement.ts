import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  getLatestEventDocSupplementForGuest,
  getLatestEventDocSupplementForMember,
  saveEventDocumentSupplementFiles,
} from '../services/eventDocumentSupplementService';

const router = Router();

const MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);
const MAX_FILE_MB = 20;
const MAX_FILE = MAX_FILE_MB * 1024 * 1024;
const MAX_FILES = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('MIME'));
  },
});

function multerErrorHandler(err: unknown, res: Response): boolean {
  if (!err) return false;
  const e = err as Error & { code?: string };
  if (e.message === 'MIME') {
    res.status(400).json({
      success: false,
      message: '허용되지 않는 파일 형식입니다. (PDF, JPG, PNG만 허용)',
    });
    return true;
  }
  if (e.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({
      success: false,
      message: `파일 크기는 ${MAX_FILE_MB}MB 이하여야 합니다.`,
    });
    return true;
  }
  if (e.code === 'LIMIT_FILE_COUNT') {
    res.status(400).json({ success: false, message: `파일은 최대 ${MAX_FILES}개까지 업로드할 수 있습니다.` });
    return true;
  }
  console.error(err);
  res.status(500).json({ success: false, message: '파일 업로드에 실패했습니다.' });
  return true;
}

/** 회원 — 최신 서류보완 요청(미제출) */
router.get('/current', async (req: Request, res: Response) => {
  try {
    const memberIdRaw = req.query.memberId;
    const memberId = typeof memberIdRaw === 'string' ? Number(memberIdRaw) : NaN;
    if (!Number.isFinite(memberId) || memberId <= 0) {
      res.status(400).json({ success: false, message: '유효한 memberId가 필요합니다.' });
      return;
    }
    const item = await getLatestEventDocSupplementForMember(memberId);
    res.json({ success: true, item });
  } catch (e) {
    console.error('[GET /api/event-document-supplement/current]', e);
    res.status(500).json({ success: false, message: '조회에 실패했습니다.' });
  }
});

/** 비회원 — 견적번호(계약ID) + 사업자번호 */
router.post('/guest/lookup', async (req: Request, res: Response) => {
  try {
    const quoteRef = typeof req.body?.quoteRef === 'string' ? req.body.quoteRef.trim() : '';
    const businessNumber =
      typeof req.body?.businessNumber === 'string' ? req.body.businessNumber.trim() : '';
    if (!quoteRef || !businessNumber) {
      res.status(400).json({ success: false, message: '견적 번호와 사업자번호를 입력해주세요.' });
      return;
    }
    const item = await getLatestEventDocSupplementForGuest({ quoteRef, businessNumber });
    if (!item) {
      res.status(404).json({
        success: false,
        message: '일치하는 서류보완 요청이 없습니다. 견적번호·사업자번호를 확인해주세요.',
      });
      return;
    }
    res.json({ success: true, item });
  } catch (e) {
    console.error('[POST /api/event-document-supplement/guest/lookup]', e);
    res.status(500).json({ success: false, message: '조회에 실패했습니다.' });
  }
});

router.post(
  '/member/upload',
  (req: Request, res: Response, next: NextFunction) => {
    upload.array('files', MAX_FILES)(req, res, (err: unknown) => {
      if (multerErrorHandler(err, res)) return;
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const memberId = Number(req.body?.memberId);
      const requestId = Number(req.body?.requestId);
      if (!Number.isFinite(memberId) || memberId <= 0) {
        res.status(400).json({ success: false, message: 'memberId가 필요합니다.' });
        return;
      }
      if (!Number.isFinite(requestId) || requestId <= 0) {
        res.status(400).json({ success: false, message: 'requestId가 필요합니다.' });
        return;
      }
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files?.length) {
        res.status(400).json({ success: false, message: '파일을 선택해주세요.' });
        return;
      }
      const item = await saveEventDocumentSupplementFiles({
        requestId,
        memberId,
        files,
      });
      res.json({ success: true, message: '서류가 제출되었습니다.', item });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '제출에 실패했습니다.';
      res.status(400).json({ success: false, message: msg });
    }
  },
);

router.post(
  '/guest/upload',
  (req: Request, res: Response, next: NextFunction) => {
    upload.array('files', MAX_FILES)(req, res, (err: unknown) => {
      if (multerErrorHandler(err, res)) return;
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const requestId = Number(req.body?.requestId);
      const quoteRef = typeof req.body?.quoteRef === 'string' ? req.body.quoteRef.trim() : '';
      const businessNumber =
        typeof req.body?.businessNumber === 'string' ? req.body.businessNumber.trim() : '';
      if (!Number.isFinite(requestId) || requestId <= 0) {
        res.status(400).json({ success: false, message: 'requestId가 필요합니다.' });
        return;
      }
      if (!quoteRef || !businessNumber) {
        res.status(400).json({ success: false, message: '견적 번호와 사업자번호가 필요합니다.' });
        return;
      }
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files?.length) {
        res.status(400).json({ success: false, message: '파일을 선택해주세요.' });
        return;
      }
      const item = await saveEventDocumentSupplementFiles({
        requestId,
        guestQuoteRef: quoteRef,
        guestBusinessNumber: businessNumber,
        files,
      });
      res.json({ success: true, message: '서류가 제출되었습니다.', item });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '제출에 실패했습니다.';
      res.status(400).json({ success: false, message: msg });
    }
  },
);

export default router;
