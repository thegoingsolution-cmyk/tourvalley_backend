import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { toKstDateTimeStringForApi } from '../utils/dateTime';
import { generateAlimTalkMessage } from '../services/alimtalkMessageGenerator';
import { sendAlimTalk } from '../services/aligoService';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

// 업로드 기본 경로 설정 (upload.ts와 동일하게 맞춤)
// 프로덕션: UPLOAD_PATH=/home/b2c/uploads 환경변수 설정 필요
// nginx: location /uploads/ { alias /home/b2c/uploads/; } 로 정적 파일 서빙
const UPLOAD_BASE_PATH = process.env.UPLOAD_PATH || path.resolve(__dirname, '../../../uploads');

// 업로드 디렉토리 생성 (business, contracts, amusement)
const businessDir = path.join(UPLOAD_BASE_PATH, 'business');
const contractsDir = path.join(UPLOAD_BASE_PATH, 'contracts');
const amusementDir = path.join(UPLOAD_BASE_PATH, 'amusement');

// 디렉토리 생성 (에러 처리 추가)
try {
  if (!fs.existsSync(businessDir)) {
    fs.mkdirSync(businessDir, { recursive: true });
  }
  if (!fs.existsSync(contractsDir)) {
    fs.mkdirSync(contractsDir, { recursive: true });
  }
  if (!fs.existsSync(amusementDir)) {
    fs.mkdirSync(amusementDir, { recursive: true });
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
    } else if (file.fieldname === 'amusement_photos') {
      cb(null, amusementDir);
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

/** '유'/'무' 또는 boolean-ish → ENUM('유','무') */
function parseYuMu(value: unknown, defaultVal: '유' | '무' = '무'): '유' | '무' {
  if (value === '유' || value === true || value === 'true' || value === '1' || value === 1 || value === 'Y' || value === 'y') {
    return '유';
  }
  if (value === '무' || value === false || value === 'false' || value === '0' || value === 0 || value === 'N' || value === 'n') {
    return '무';
  }
  if (typeof value === 'string' && value.trim() === '유') return '유';
  if (typeof value === 'string' && value.trim() === '무') return '무';
  return defaultVal;
}

/** 특약 on/off → 0|1 (false/'0'/빈값 = 0) */
function parseCovFlag(value: unknown, defaultOn = false): 0 | 1 {
  if (value === undefined || value === null || value === '') {
    return defaultOn ? 1 : 0;
  }
  if (value === false || value === 'false' || value === '0' || value === 0 || value === 'N' || value === 'n' || value === '무' || value === 'off') {
    return 0;
  }
  if (value === true || value === 'true' || value === '1' || value === 1 || value === 'Y' || value === 'y' || value === '유' || value === 'on') {
    return 1;
  }
  return defaultOn ? 1 : 0;
}

/** risk_detail JSON 문자열 또는 객체 → MySQL JSON용 문자열 */
function normalizeRiskDetail(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify(trimmed);
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

function parsePlaces(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v || '').trim()).filter(Boolean);
      }
    } catch {
      // comma / slash separated fallback
      return trimmed.split(/\s*[\/,|]\s*/).map((v) => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function resolveEventLocation(body: Record<string, any>): string {
  const preferred = String(body.event_location || '').trim();
  if (preferred) return preferred;

  const locationType = String(body.location_type || '').trim();

  if (locationType === '복수' || locationType === '복수장소' || locationType === 'multi') {
    const places = parsePlaces(body.places);
    if (places.length) return `[복수] ${places.join(' / ')}`;
  }

  if (locationType === '이동' || locationType === '복수·이동' || locationType === 'route') {
    const from = String(body.route_from || '').trim();
    const via = String(body.route_via || '').trim();
    const to = String(body.route_to || '').trim();
    const parts = [from, via, to].filter(Boolean);
    if (parts.length) return `[이동] ${parts.join(' → ')}`;
  }

  const singleText = String(body.region || body.event_location || '').trim();
  if (singleText) return singleText;
  return extractEventLocation(String(body.event_name || ''));
}

// 행사보험 견적 신청
router.post('/api/event-insurance/estimate', upload.fields([
  { name: 'license', maxCount: 1 },
  { name: 'overview', maxCount: 1 },
  { name: 'amusement_photos', maxCount: 10 },
]), async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    console.log('=== 행사보험 견적 신청 시작 ===');
    console.log('Body:', req.body);
    console.log('Files:', req.files);
    console.log('UPLOAD_BASE_PATH:', UPLOAD_BASE_PATH);
    console.log('businessDir:', businessDir);
    console.log('contractsDir:', contractsDir);
    console.log('amusementDir:', amusementDir);

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    // 파일 실제 저장 여부 검증 및 로깅
    if (files?.license?.[0]) {
      const lic = files.license[0];
      const licPath = (lic as any).path || path.join(businessDir, lic.filename);
      const licExists = fs.existsSync(licPath);
      console.log('[license] 저장경로:', licPath, '| 파일존재:', licExists);
      if (!licExists) {
        console.error('[license] 파일 저장 실패 - 경로에 파일이 없습니다:', licPath);
      }
    }
    if (files?.overview?.[0]) {
      const ov = files.overview[0];
      const ovPath = (ov as any).path || path.join(contractsDir, ov.filename);
      const ovExists = fs.existsSync(ovPath);
      console.log('[overview] 저장경로:', ovPath, '| 파일존재:', ovExists);
      if (!ovExists) {
        console.error('[overview] 파일 저장 실패 - 경로에 파일이 없습니다:', ovPath);
      }
    }
    if (files?.amusement_photos?.length) {
      for (const photo of files.amusement_photos) {
        const photoPath = (photo as any).path || path.join(amusementDir, photo.filename);
        const exists = fs.existsSync(photoPath);
        console.log('[amusement_photos] 저장경로:', photoPath, '| 파일존재:', exists);
        if (!exists) {
          console.error('[amusement_photos] 파일 저장 실패 - 경로에 파일이 없습니다:', photoPath);
        }
      }
    }

    // 파일 경로 (nginx 설정에 맞춰 /uploads/ 경로 사용)
    const licenseFile = files?.license?.[0]
      ? `/uploads/business/${files.license[0].filename}`
      : null;
    const overviewFile = files?.overview?.[0]
      ? `/uploads/contracts/${files.overview[0].filename}`
      : null;
    const amusementPhotoPaths = (files?.amusement_photos || []).map(
      (f) => `/uploads/amusement/${f.filename}`
    );
    const amusementPhotosJson =
      amusementPhotoPaths.length > 0 ? JSON.stringify(amusementPhotoPaths) : null;

    const contract_number = generateContractNumber();

    // action_info 파싱 (예: "AT/FW/WR/PF/DR/ET/MV")
    const actionInfo = req.body.action_info || '';
    const actionInfoArray = String(actionInfo)
      .split(/[\/,|]/)
      .map((v: string) => v.trim())
      .filter((v: string) => v);

    const sports_event = actionInfoArray.includes('AT') ? '유' : '무';
    const fireworks = actionInfoArray.includes('FW') ? '유' : '무';
    const water_hazard = actionInfoArray.includes('WR') ? '유' : '무';
    const amusement_facilities = actionInfoArray.includes('PF') ? '유' : '무';
    const drone = actionInfoArray.includes('DR') ? '유' : '무';
    const other = actionInfoArray.includes('ET') ? '유' : '무';
    const moving_parade = actionInfoArray.includes('MV') ? '유' : '무';

    const event_form_type = req.body.event_form_type ? String(req.body.event_form_type).trim() : null;
    const event_category = req.body.event_category ? String(req.body.event_category).trim() : null;
    const venue_type = req.body.venue_type ? String(req.body.venue_type).trim() : null;
    const location_type = req.body.location_type ? String(req.body.location_type).trim() : null;
    const isMoveType = location_type === '이동';
    const isMultiPlaceType = location_type === '복수';
    const route_from = isMoveType && req.body.route_from ? String(req.body.route_from).trim() : null;
    const route_via = isMoveType && req.body.route_via ? String(req.body.route_via).trim() : null;
    const route_to = isMoveType && req.body.route_to ? String(req.body.route_to).trim() : null;
    const move_note = isMoveType && req.body.move_note ? String(req.body.move_note).trim() : null;
    const placesArr = isMultiPlaceType ? parsePlaces(req.body.places) : [];
    const places = placesArr.length > 0 ? JSON.stringify(placesArr) : null;
    const event_location = resolveEventLocation(req.body);
    const has_performer = parseYuMu(req.body.has_performer, '무');
    const risk_detail = normalizeRiskDetail(req.body.risk_detail);
    const budget_type = req.body.budget_type ? String(req.body.budget_type).trim() : null;
    const budgetAmountRaw = req.body.budget_amount != null && req.body.budget_amount !== ''
      ? parseInt(String(req.body.budget_amount).replace(/,/g, ''), 10)
      : NaN;
    const budget_amount = Number.isFinite(budgetAmountRaw) ? budgetAmountRaw : null;
    const marketing_consent = parseCovFlag(req.body.marketing_consent, false);
    const department = req.body.department ? String(req.body.department).trim() : null;

    // plan_label은 quote_plans.label 전용 (event_contracts 컬럼 아님)
    const planLabelRaw = String(req.body.plan_label || '').trim();
    const plan_label =
      planLabelRaw === '1형' || planLabelRaw === '2형' || planLabelRaw === '직접입력'
        ? planLabelRaw
        : (planLabelRaw || '직접입력');

    const participants = parseInt(req.body.insured_cnt, 10) || 1;

    // 특약 플래그 / 금액 (만원 단위 — 기존 format* 헬퍼 사용)
    const cov_pmed = parseCovFlag(req.body.cov_pmed, true);
    const cov_food = parseCovFlag(req.body.cov_food, false);
    const cov_install = parseCovFlag(req.body.cov_install, false);
    const cov_rented = parseCovFlag(req.body.cov_rented, false);
    const cov_bailee = parseCovFlag(req.body.cov_bailee, false);

    const personal_liability_per_person = formatCoverageAmount(req.body.bi_person);
    const personal_liability_per_accident = formatCoverageAmount(req.body.bi_occurence);
    const property_damage_per_accident = formatCoverageAmount(req.body.pi_occurence);
    const deductible_per_accident = formatDeductible(req.body.dt_occurence);

    const medical_expense_per_person =
      cov_pmed === 0 ? '가입안함' : formatMedicalExpense(req.body.me_person);
    const medical_expense_per_accident =
      cov_pmed === 0 ? '가입안함' : formatMedicalExpense(req.body.me_occurence);

    const food_per_accident = formatCoverageAmount(req.body.food_per_accident);
    const food_deductible = formatDeductible(req.body.food_deductible);
    const install_per_accident = formatCoverageAmount(req.body.install_per_accident);
    const rented_per_accident = formatCoverageAmount(req.body.rented_per_accident);
    const bailee_per_accident = formatCoverageAmount(req.body.bailee_per_accident);

    // 회원 ID 처리 (있으면 회원 견적, 없으면 비회원 견적)
    let memberId: number | null = null;
    if (req.body.member_id) {
      const parsedId = parseInt(req.body.member_id);
      memberId = isNaN(parsedId) ? null : parsedId;
    }

    const resolvedAffiliate =
      (req.body.affiliate && String(req.body.affiliate).trim()) || '투어밸리';
    const resolvedAccessPath =
      (req.body.access_path && String(req.body.access_path).trim()) || '견적신청';

    console.log('=== 견적 신청 데이터 확인 ===');
    console.log('회원 ID:', memberId);
    console.log('event_form_type:', event_form_type, '| event_category:', event_category);
    console.log('location_type:', location_type, '| event_location:', event_location);
    console.log('plan_label:', plan_label, '| has_performer:', has_performer);
    console.log('보험시작일시:', req.body.start_date);
    console.log('보험종료일시:', req.body.end_date);
    console.log('보험가입조건:');
    console.log('  - bi_person (대인배상 1인당):', req.body.bi_person);
    console.log('  - bi_occurence (대인배상 1사고당):', req.body.bi_occurence);
    console.log('  - pi_occurence (대물배상 1사고당):', req.body.pi_occurence);
    console.log('  - cov_pmed / me_person / me_occurence:', cov_pmed, req.body.me_person, req.body.me_occurence);
    console.log('  - dt_occurence (자기부담금 1사고당):', req.body.dt_occurence);
    console.log('  - cov_food/install/rented/bailee:', cov_food, cov_install, cov_rented, cov_bailee);

    // 1. 계약 정보 저장 (신규접수)
    const [contractResult] = await connection.execute<any>(
      `INSERT INTO event_contracts (
        contract_number, insurance_type, insurance_company, event_name,
        event_form_type, event_category, event_location, venue_type, location_type,
        places, route_from, route_via, route_to, move_note,
        participants, has_performer, start_date, end_date,
        sports_event, water_hazard, drone, fireworks,
        amusement_facilities, other, moving_parade, risk_detail,
        personal_liability_per_person, personal_liability_per_accident,
        property_damage_per_accident, medical_expense_per_person, medical_expense_per_accident,
        deductible_per_accident, budget_type, budget_amount, marketing_consent,
        premium, business_registration_file, event_outline_file, amusement_photos,
        member_id, affiliate, device, access_path, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract_number,
        '행사주최자배상책임보험',
        '', // 보험회사는 나중에 지정
        req.body.event_name,
        event_form_type,
        event_category,
        event_location,
        venue_type,
        location_type,
        places,
        route_from,
        route_via,
        route_to,
        move_note,
        participants,
        has_performer,
        req.body.start_date,
        req.body.end_date,
        sports_event,
        water_hazard,
        drone,
        fireworks,
        amusement_facilities,
        other,
        moving_parade,
        risk_detail,
        personal_liability_per_person,
        personal_liability_per_accident,
        property_damage_per_accident,
        medical_expense_per_person,
        medical_expense_per_accident,
        deductible_per_accident,
        budget_type,
        budget_amount,
        marketing_consent,
        0, // 견적 신청 시점에는 보험료 미정
        licenseFile,
        overviewFile,
        amusementPhotosJson,
        memberId,
        resolvedAffiliate,
        req.body.device || 'PC',
        resolvedAccessPath,
        '신규접수',
        null, // 시스템 자동 등록
      ]
    );

    const contract_id = contractResult.insertId;

    // 2. 계약자 정보 저장
    await connection.execute<any>(
      `INSERT INTO event_contractors (
        contract_id, contractor, business_number, contact_person, department, email, mobile_phone, phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract_id,
        req.body.contractor_name,
        req.body.registration_no,
        req.body.incharge,
        department,
        req.body.email,
        req.body.ctel_no,
        req.body.tel_no,
      ]
    );

    // 3. 견적안 1건 (plan_label → label, 대표 견적)
    await connection.execute<any>(
      `INSERT INTO event_contract_quote_plans (
        contract_id, quote_no, label, people, is_primary,
        personal_liability_per_person, personal_liability_per_accident,
        property_damage_per_accident, deductible_per_accident,
        medical_expense_per_person, medical_expense_per_accident, cov_pmed,
        cov_food, food_per_accident, food_deductible,
        cov_install, install_per_accident,
        cov_rented, rented_per_accident,
        cov_bailee, bailee_per_accident
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract_id,
        1,
        plan_label,
        participants,
        1,
        personal_liability_per_person,
        personal_liability_per_accident,
        property_damage_per_accident,
        deductible_per_accident,
        medical_expense_per_person,
        medical_expense_per_accident,
        cov_pmed,
        cov_food,
        food_per_accident,
        food_deductible,
        cov_install,
        install_per_accident,
        cov_rented,
        rented_per_accident,
        cov_bailee,
        bailee_per_accident,
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

// multer 에러 핸들링 (파일 크기 초과, 확장자 오류 등)
router.use((err: any, req: Request, res: Response, next: any) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: '파일 크기는 10MB를 초과할 수 없습니다.',
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        message: '예상치 못한 파일 필드입니다.',
      });
    }
  }
  if (err?.message?.includes('확장자')) {
    return res.status(400).json({
      success: false,
      message: err.message || '업로드할 수 없는 파일 형식입니다.',
    });
  }
  next(err);
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
      startDate: toKstDateTimeStringForApi(contract.start_date),
      endDate: toKstDateTimeStringForApi(contract.end_date),
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

