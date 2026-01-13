import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

const router = Router();

// 업로드 기본 경로 (공유 uploads 폴더)
// dist/routes/upload.js -> dist -> b2c_tourvalley_backend -> b2c -> uploads
const UPLOAD_BASE_PATH = process.env.UPLOAD_PATH || path.resolve(__dirname, '../../../uploads');

// 허용 파일 형식
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
];

// 최대 파일 크기 (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// multer 저장소 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 업로드 타입에 따라 폴더 분기
    const uploadType = req.params.type || 'images';
    const uploadPath = path.join(UPLOAD_BASE_PATH, uploadType);
    
    // 폴더가 없으면 생성
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // 고유 파일명 생성: uuid_원본파일명
    const ext = path.extname(file.originalname);
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  },
});

// 파일 필터
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('허용되지 않는 파일 형식입니다. (PDF, JPG, PNG만 허용)'));
  }
};

// multer 인스턴스
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

/**
 * POST /api/upload/:type
 * 파일 업로드
 * :type - business (사업자등록증), contracts (계약서), images (이미지)
 */
router.post('/:type', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const uploadType = req.params.type;
    
    // 허용된 업로드 타입 확인
    const allowedTypes = ['business', 'contracts', 'images'];
    if (!allowedTypes.includes(uploadType)) {
      return res.status(400).json({
        success: false,
        message: '잘못된 업로드 타입입니다.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '파일이 업로드되지 않았습니다.',
      });
    }

    // 파일 URL 경로 생성
    const fileUrl = `/uploads/${uploadType}/${req.file.filename}`;
    
    console.log(`✅ 파일 업로드 완료: ${req.file.originalname} -> ${fileUrl}`);

    res.json({
      success: true,
      message: '파일이 성공적으로 업로드되었습니다.',
      data: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        url: fileUrl,
      },
    });

  } catch (error) {
    console.error('파일 업로드 오류:', error);
    res.status(500).json({
      success: false,
      message: '파일 업로드에 실패했습니다.',
    });
  }
});

/**
 * DELETE /api/upload/:type/:filename
 * 파일 삭제
 */
router.delete('/:type/:filename', async (req: Request, res: Response) => {
  try {
    const { type, filename } = req.params;
    
    // 허용된 업로드 타입 확인
    const allowedTypes = ['business', 'contracts', 'images'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: '잘못된 업로드 타입입니다.',
      });
    }

    const filePath = path.join(UPLOAD_BASE_PATH, type, filename);
    
    // 파일 존재 확인
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '파일을 찾을 수 없습니다.',
      });
    }

    // 파일 삭제
    fs.unlinkSync(filePath);
    
    console.log(`✅ 파일 삭제 완료: ${filePath}`);

    res.json({
      success: true,
      message: '파일이 성공적으로 삭제되었습니다.',
    });

  } catch (error) {
    console.error('파일 삭제 오류:', error);
    res.status(500).json({
      success: false,
      message: '파일 삭제에 실패했습니다.',
    });
  }
});

// 에러 핸들링 미들웨어
router.use((error: any, req: Request, res: Response, next: any) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: '파일 크기는 5MB를 초과할 수 없습니다.',
      });
    }
  }
  
  return res.status(400).json({
    success: false,
    message: error.message || '파일 업로드 중 오류가 발생했습니다.',
  });
});

export default router;

