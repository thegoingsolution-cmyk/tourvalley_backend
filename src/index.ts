import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';

// 환경 변수 로드
dotenv.config();

// 라우트 임포트
import smsRoutes from './routes/sms';
import authRoutes from './routes/auth';
import uploadRoutes from './routes/upload';
import travelRoutes from './routes/travel';
import paymentRoutes from './routes/payments';
import noticesRoutes from './routes/notices';
import customerInquiriesRoutes from './routes/customer-inquiries';
import contractsRoutes from './routes/contracts';
import cashRoutes from './routes/cash';
import mileageRoutes from './routes/mileage';
import eventInsuranceRoutes from './routes/event-insurance';

// 데이터베이스 연결 테스트
import { testConnection } from './config/database';

const app: Application = express();
const PORT = process.env.PORT || 4000;

// CORS 허용 도메인 설정
const allowedOrigins = [
  'http://localhost:3000',
  'https://www.bzvalley.net',
  'https://bzvalley.net',
  process.env.CORS_ORIGIN,
].filter(Boolean) as string[];

// 미들웨어 설정
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // 서버 간 요청 (origin이 없는 경우) 또는 허용된 도메인인 경우 허용
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API 라우트
app.use('/api/sms', smsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/', travelRoutes);
app.use('/', paymentRoutes);
app.use('/api', noticesRoutes);
app.use('/api', customerInquiriesRoutes);
app.use('/', contractsRoutes);
app.use('/', cashRoutes);
app.use('/', mileageRoutes);
app.use('/', eventInsuranceRoutes);

// 헬스 체크 라우트
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: 'B2C Backend API 서버가 정상 작동 중입니다.',
    timestamp: new Date().toISOString(),
  });
});

// 기본 라우트
app.get('/api', (req: Request, res: Response) => {
  res.json({
    name: 'BZValley B2C API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      sms: {
        send: 'POST /api/sms/send',
        verify: 'POST /api/sms/verify',
        status: 'GET /api/sms/status/:phoneNumber',
        remain: 'GET /api/sms/remain',
      },
      auth: {
        checkUsername: 'POST /api/auth/check-username',
        registerPersonal: 'POST /api/auth/register/personal',
        registerCorporate: 'POST /api/auth/register/corporate',
      },
      upload: {
        upload: 'POST /api/upload/:type',
        delete: 'DELETE /api/upload/:type/:filename',
      },
      eventInsurance: {
        estimate: 'POST /api/event-insurance/estimate',
      },
    },
  });
});

// 404 핸들러
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// 에러 핸들러
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : '서버 오류가 발생했습니다.',
  });
});

// 서버 시작
app.listen(PORT, async () => {
  console.log(`🚀 B2C Backend Server is running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📱 SMS API: http://localhost:${PORT}/api/sms`);
  
  // 데이터베이스 연결 테스트
  await testConnection();
});

