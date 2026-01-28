import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { generateAlimTalkMessage } from '../services/alimtalkMessageGenerator';
import { sendAlimTalk } from '../services/aligoService';
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

// 숫자(만원 단위)를 어드민 형식으로 변환
// 예: 5000 -> "5천만", 10000 -> "1억", 20000 -> "2억", 50000 -> "5억", 100000 -> "10억"
function formatCoverageAmount(value: string | undefined): string | null {
  if (!value || value === '0' || value === '') {
    return null;
  }
  
  const numValue = parseInt(value, 10);
  if (isNaN(numValue) || numValue === 0) {
    return null;
  }

  // 만원 단위 값 그대로 사용
  const manwon = numValue;
  
  // 1억 이상인 경우
  if (manwon >= 10000) {
    const eok = manwon / 10000;
    if (eok === Math.floor(eok)) {
      return `${eok}억`;
    } else {
      // 소수점이 있는 경우 (예: 15000 -> "1억5천만")
      const eokPart = Math.floor(eok);
      const cheonPart = (manwon % 10000) / 1000;
      if (cheonPart === Math.floor(cheonPart) && cheonPart > 0) {
        return `${eokPart}억${cheonPart}천만`;
      } else {
        return `${manwon}만원`;
      }
    }
  } 
  // 1천만 이상인 경우
  else if (manwon >= 1000) {
    const cheon = manwon / 1000;
    if (cheon === Math.floor(cheon)) {
      return `${cheon}천만`;
    } else {
      return `${manwon}만원`;
    }
  } 
  // 그 외
  else {
    return `${manwon}만원`;
  }
}

// 참가자치료비 숫자를 어드민 형식으로 변환
// 예: 0 -> "가입안함", 50 -> "50만", 100 -> "100만", 500 -> "500만", 1000 -> "1000만", 2000 -> "2000만", 4000 -> "4000만"
function formatMedicalExpense(value: string | undefined): string | null {
  if (!value || value === '0' || value === '') {
    return '가입안함';
  }
  
  const numValue = parseInt(value, 10);
  if (isNaN(numValue) || numValue === 0) {
    return '가입안함';
  }

  // 어드민 프론트엔드와 동일한 형식으로 저장 ("1000만", "2000만", "4000만")
  return `${numValue}만`;
}

// 자기부담금 숫자를 어드민 형식으로 변환
// 예: 10 -> "10만", 50 -> "50만", 100 -> "100만"
function formatDeductible(value: string | undefined): string | null {
  if (!value || value === '0' || value === '') {
    return null;
  }
  
  const numValue = parseInt(value, 10);
  if (isNaN(numValue) || numValue === 0) {
    return null;
  }

  return `${numValue}만`;
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
    let memberId: number | null = null;
    if (req.body.member_id) {
      const parsedId = parseInt(req.body.member_id);
      memberId = isNaN(parsedId) ? null : parsedId;
    }

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
        formatCoverageAmount(req.body.bi_person),
        formatCoverageAmount(req.body.bi_occurence),
        formatCoverageAmount(req.body.pi_occurence),
        formatMedicalExpense(req.body.me_person),
        formatMedicalExpense(req.body.me_occurence),
        formatDeductible(req.body.dt_occurence),
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

    try {
      const customerName = req.body.contractor_name || '고객';
      const phoneNumber = req.body.ctel_no || req.body.tel_no || '';

      if (phoneNumber) {
        const message = generateAlimTalkMessage('event_estimate', {
          customerName,
        });

        await sendAlimTalk({
          receiver: phoneNumber,
          template_code: 'UE_8396',
          subject: '행사보험 견적 신청',
          message,
          receiver_name: customerName,
        });
      }
    } catch (alimtalkError) {
      console.error('행사보험 견적 알림톡 발송 실패:', alimtalkError);
    }

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

// 행사보험 계약 목록 조회
router.get('/api/event-contracts/list', async (req: Request, res: Response) => {
  try {
    const { member_id, inyear = '1', block_type = 'C', str_cur_page = '1' } = req.query;

    if (!member_id) {
      return res.status(400).json({
        success: false,
        message: 'member_id가 필요합니다.',
      });
    }

    const memberId = parseInt(member_id as string, 10);
    const inYear = parseInt(inyear as string, 10);
    const currentPage = parseInt(str_cur_page as string, 10);
    const pageSize = 10; // 페이지당 항목 수

    if (isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id입니다.',
      });
    }

    // 날짜 범위 계산 (최근 N년)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - inYear);

    // 날짜를 MySQL DATETIME 형식으로 포맷팅 (로컬 시간 그대로 사용)
    const formatDateForMySQL = (date: Date): string => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    const startDateStr = formatDateForMySQL(startDate);
    const endDateStr = formatDateForMySQL(endDate);

    // 계약 목록 조회
    const offset = (currentPage - 1) * pageSize;
    const limitValue = parseInt(String(pageSize), 10);
    const offsetValue = parseInt(String(offset), 10);
    
    const [contracts] = await pool.execute<any[]>(
      `SELECT 
        ec.id,
        ec.contract_number,
        ec.insurance_type,
        ec.insurance_company,
        ec.event_name,
        ec.event_location,
        ec.participants,
        ec.start_date,
        ec.end_date,
        ec.premium,
        ec.status,
        ec.created_at,
        ector.contractor
      FROM event_contracts ec
      LEFT JOIN event_contractors ector ON ec.id = ector.contract_id
      WHERE ec.member_id = ? 
        AND ec.created_at >= ? 
        AND ec.created_at <= ?
      GROUP BY ec.id
      ORDER BY ec.created_at DESC
      LIMIT ${limitValue} OFFSET ${offsetValue}`,
      [memberId, startDateStr, endDateStr]
    );

    // 전체 개수 조회
    const [countResult] = await pool.execute<any[]>(
      `SELECT COUNT(DISTINCT ec.id) as total
      FROM event_contracts ec
      WHERE ec.member_id = ? 
        AND ec.created_at >= ? 
        AND ec.created_at <= ?`,
      [memberId, startDateStr, endDateStr]
    );

    const totalCount = countResult[0]?.total || 0;
    const totalPages = Math.ceil(totalCount / pageSize);

    // 계약 데이터 포맷팅
    const formattedContracts = contracts.map((contract: any) => ({
      id: contract.id,
      contractNumber: contract.contract_number || '-',
      insuranceType: contract.insurance_type || '행사보험',
      insuranceCompany: contract.insurance_company || '행사주최자 배상책임보험',
      eventName: contract.event_name || '-',
      eventLocation: contract.event_location || null,
      participants: contract.participants || 0,
      startDate: contract.start_date,
      endDate: contract.end_date,
      premium: contract.premium || 0,
      status: contract.status || '-',
      createdAt: contract.created_at,
      contractor: contract.contractor || null,
    }));

    res.json({
      success: true,
      contracts: formattedContracts,
      pagination: {
        currentPage,
        totalPages,
        totalCount,
        pageSize,
      },
    });
  } catch (error) {
    console.error('행사보험 계약 목록 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '행사보험 계약 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
});

export default router;

