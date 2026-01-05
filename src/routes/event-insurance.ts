import { Router, Request, Response } from 'express';
import pool from '../config/database';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

// 업로드 기본 경로 설정
// 프로덕션: /home/b2c/uploads/
// 로컬 개발: 프로젝트 내부 uploads 폴더
const UPLOAD_BASE_PATH = process.env.UPLOAD_PATH || path.join(process.cwd(), 'uploads');

// 업로드 디렉토리 생성 (business, contracts)
const businessDir = path.join(UPLOAD_BASE_PATH, 'business');
const contractsDir = path.join(UPLOAD_BASE_PATH, 'contracts');

// 디렉토리 생성 (에러 처리 추가)
try {
  if (!fs.existsSync(businessDir)) {
    fs.mkdirSync(businessDir, { recursive: true });
  }
  if (!fs.existsSync(contractsDir)) {
    fs.mkdirSync(contractsDir, { recursive: true });
  }
} catch (error) {
  console.error('업로드 디렉토리 생성 실패:', error);
  console.log('UPLOAD_BASE_PATH:', UPLOAD_BASE_PATH);
}

// 파일 업로드 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 파일 필드명에 따라 저장 경로 결정
    if (file.fieldname === 'license') {
      cb(null, businessDir);
    } else if (file.fieldname === 'overview') {
      cb(null, contractsDir);
    } else {
      cb(null, businessDir); // 기본값
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(originalName);
    const basename = path.basename(originalName, ext);
    const filename = `${timestamp}_${basename}${ext}`;
    cb(null, filename);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExts = ['.hwp', '.hwpx', '.pdf', '.jpg', '.jpeg', '.gif', '.png', '.doc', '.docx'];
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(originalName).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('업로드할 수 없는 확장자입니다.'));
    }
  },
});

// 계약번호 생성 함수
function generateContractNumber(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `EE${year}${month}${day}${random}`; // EE: Event Estimate
}

// 행사명에서 행사장소 추출 (임시)
function extractEventLocation(eventName: string): string {
  // 기본값
  return eventName;
}

// 행사보험 견적 신청
router.post('/api/event-insurance/estimate', upload.fields([
  { name: 'license', maxCount: 1 },
  { name: 'overview', maxCount: 1 }
]), async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    console.log('=== 행사보험 견적 신청 시작 ===');
    console.log('Body:', req.body);
    console.log('Files:', req.files);

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    
    // 파일 경로 (nginx 설정에 맞춰 /uploads/ 경로 사용)
    const licenseFile = files?.license 
      ? `/uploads/business/${files.license[0].filename}` 
      : null;
    const overviewFile = files?.overview 
      ? `/uploads/contracts/${files.overview[0].filename}` 
      : null;

    const contract_number = generateContractNumber();

    // action_info 파싱 (예: "AT/FW/WR/PF/DR/ET")
    const actionInfo = req.body.action_info || '';
    const actionInfoArray = actionInfo.split('/').filter((v: string) => v);
    
    const sports_event = actionInfoArray.includes('AT') ? '유' : '무';
    const fireworks = actionInfoArray.includes('FW') ? '유' : '무';
    const water_hazard = actionInfoArray.includes('WR') ? '유' : '무';
    const amusement_facilities = actionInfoArray.includes('PF') ? '유' : '무';
    const drone = actionInfoArray.includes('DR') ? '유' : '무';
    const other = actionInfoArray.includes('ET') ? '유' : '무';

    const event_location = extractEventLocation(req.body.event_name || '');

    // 회원 ID 처리 (있으면 회원 견적, 없으면 비회원 견적)
    const memberId = req.body.member_id ? parseInt(req.body.member_id) : null;

    console.log('=== 견적 신청 데이터 확인 ===');
    console.log('회원 ID:', memberId);
    console.log('보험시작일시:', req.body.start_date);
    console.log('보험종료일시:', req.body.end_date);
    console.log('보험가입조건:');
    console.log('  - bi_person (대인배상 1인당):', req.body.bi_person);
    console.log('  - bi_occurence (대인배상 1사고당):', req.body.bi_occurence);
    console.log('  - pi_occurence (대물배상 1사고당):', req.body.pi_occurence);
    console.log('  - me_person (참가자치료비 1인당):', req.body.me_person);
    console.log('  - me_occurence (참가자치료비 1사고당):', req.body.me_occurence);
    console.log('  - dt_occurence (자기부담금 1사고당):', req.body.dt_occurence);

    // 1. 계약 정보 저장 (견적 신청 상태)
    const [contractResult] = await connection.execute<any>(
      `INSERT INTO event_contracts (
        contract_number, insurance_type, insurance_company, event_name, event_location,
        participants, start_date, end_date, sports_event, water_hazard, drone, fireworks,
        amusement_facilities, other, personal_liability_per_person, personal_liability_per_accident,
        property_damage_per_accident, medical_expense_per_person, medical_expense_per_accident,
        deductible_per_accident, premium, business_registration_file, event_outline_file,
        member_id, affiliate, device, access_path, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract_number,
        '행사주최자배상책임보험',
        '', // 보험회사는 나중에 지정
        req.body.event_name,
        event_location,
        parseInt(req.body.insured_cnt) || 1,
        req.body.start_date,
        req.body.end_date,
        sports_event,
        water_hazard,
        drone,
        fireworks,
        amusement_facilities,
        other,
        req.body.bi_person && req.body.bi_person !== '0' ? `${req.body.bi_person}만원` : null,
        req.body.bi_occurence && req.body.bi_occurence !== '0' ? `${req.body.bi_occurence}만원` : null,
        req.body.pi_occurence && req.body.pi_occurence !== '0' ? `${req.body.pi_occurence}만원` : null,
        req.body.me_person && req.body.me_person !== '0' ? `${req.body.me_person}만원` : null,
        req.body.me_occurence && req.body.me_occurence !== '0' ? `${req.body.me_occurence}만원` : null,
        req.body.dt_occurence && req.body.dt_occurence !== '0' ? `${req.body.dt_occurence}만원` : null,
        0, // 견적 신청 시점에는 보험료 미정
        licenseFile,
        overviewFile,
        memberId, // 로그인한 회원이면 member_id, 아니면 null
        '투어밸리',
        req.body.device || 'PC',
        '견적신청',
        '등록', // 견적신청 상태
        null, // 시스템 자동 등록
      ]
    );

    const contract_id = contractResult.insertId;

    // 2. 계약자 정보 저장
    await connection.execute<any>(
      `INSERT INTO event_contractors (
        contract_id, contractor, business_number, contact_person, email, mobile_phone, phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contract_id,
        req.body.contractor_name,
        req.body.registration_no,
        req.body.incharge,
        req.body.email,
        req.body.ctel_no,
        req.body.tel_no,
      ]
    );

    await connection.commit();

    console.log('=== 견적 신청 완료 ===');
    console.log('계약번호:', contract_number);

    res.json({
      success: true,
      message: '견적 신청이 완료되었습니다.',
      data: {
        contract_number,
        contract_id,
      },
    });

  } catch (error) {
    await connection.rollback();
    console.error('견적 신청 오류:', error);
    res.status(500).json({
      success: false,
      message: '견적 신청 중 오류가 발생했습니다.',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    connection.release();
  }
});

export default router;

