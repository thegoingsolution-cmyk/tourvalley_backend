import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import iconv from 'iconv-lite';
import pool from '../config/database';
import { sendContractCompleteAlimTalk } from '../services/contractAlimtalkService';
import { sendSms } from '../services/aligoService';
import {
  addInsuranceCalendarMonthsFromKstInstant,
  getKstCalendarDateNow,
  parseDateTimeAsKst,
  toKstDateTimeStringForApi,
} from '../utils/dateTime';
import { withB2cPgProductPrefix } from '../utils/b2cPgProductName';

const router = Router();
type RawBodyRequest = Request & { rawBody?: Buffer };

const getRequestCharset = (contentType?: string): string => {
  if (!contentType) return 'utf-8';
  const match = contentType.match(/charset=([^;]+)/i);
  const raw = (match?.[1] || 'utf-8').trim().toLowerCase();
  if (raw === 'utf8') return 'utf-8';
  if (raw === 'euc-kr' || raw === 'cp949' || raw === 'ks_c_5601-1987') return 'cp949';
  return raw;
};

const parseRawJsonBody = (req: RawBodyRequest, encoding: iconv.Encoding): any | null => {
  if (!req.rawBody || req.rawBody.length === 0) return null;
  try {
    return JSON.parse(iconv.decode(req.rawBody, encoding));
  } catch {
    return null;
  }
};

const hasBrokenChars = (value?: string | null): boolean => {
  if (!value) return false;
  return value.includes('\uFFFD') || value.includes('�');
};

const buildBizplayPayloadSummary = (body: any) => ({
  join_contract_id: body?.join_contract_id ?? null,
  product_cd: body?.product_cd ?? null,
  join_access_point: body?.join_access_point ?? null,
  tour_place: body?.tour_place ?? null,
  insured_cnt: body?.insured_cnt ?? null,
  insured_length: Array.isArray(body?.insured) ? body.insured.length : null,
  has_email: !!body?.email,
  has_ctel_no: !!body?.ctel_no,
});

const buildBizplayInsuredSummary = (body: any) => {
  if (!Array.isArray(body?.insured)) return [];
  return body.insured.map((item: any) => ({
    insured_seq: item?.insured_seq ?? null,
    plan_cd: item?.plan_cd ?? null,
    premium: item?.premium ?? null,
    insured_ssn_encrypted: item?.insured_ssn ?? null,
    insured_name_encrypted: item?.insured_name ?? null,
  }));
};

const LONG_TERM_INSURANCE_TYPES = new Set([
  '유학/어학연수',
  '워킹홀리데이',
  '해외출장/주재원/교환교수',
]);

const LONG_TERM_RATE_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12];

const addMonthsPreserveDate = (date: Date, months: number): Date => {
  const year = date.getFullYear();
  const monthIndex = date.getMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDayOfMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(date.getDate(), lastDayOfMonth);

  return new Date(
    targetYear,
    targetMonth,
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
};

/** MySQL은 24:00:00 미지원. "YYYY-MM-DD 24:00:00" → 다음날 00:00:00으로 변환 */
const normalizeDatetimeForDb = (datetime: string | null | undefined): string => {
  if (datetime == null || typeof datetime !== 'string') return datetime ?? '';
  const trimmed = datetime.trim();
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2}) 24:00:00$/);
  if (!m) return trimmed;
  const d = new Date(m[1] + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day} 00:00:00`;
};

const getRateLookupCriteria = (
  insuranceType: string,
  departure: Date,
  arrival: Date,
  periodDays: number
): { unit: 'days' | 'months'; value: number } => {
  if (!LONG_TERM_INSURANCE_TYPES.has(insuranceType)) {
    return { unit: 'days', value: periodDays };
  }

  for (const months of LONG_TERM_RATE_MONTHS) {
    const boundary = addMonthsPreserveDate(departure, months);
    if (arrival.getTime() <= boundary.getTime()) {
      return { unit: 'months', value: months };
    }
  }

  return { unit: 'days', value: periodDays };
};

/** 해외여행 단기요율 테이블 최대 일수 구간(3개월=40% 행). 달력 3개월 허용기간은 90일 초과 ceil일 수 있음 */
const OVERSEAS_TRAVEL_MAX_SHORT_TERM_DAY_TIER = 90;

const kstYmd = (d: Date): string => toKstDateTimeStringForApi(d).slice(0, 10);

const resolveOverseasShortTripRateLookupPeriodDays = (
  insuranceType: string,
  departure: Date,
  arrival: Date,
  periodDays: number
): number => {
  if (insuranceType !== '해외여행보험') {
    return periodDays;
  }

  /** 달력 1·2·3개월 경계일(KST)에 도착이 속하면 요율표 30·60·90일 행(20·30·40%). 그 외는 일 단위 ceil 유지 */
  const b1 = addInsuranceCalendarMonthsFromKstInstant(departure, 1);
  const b2 = addInsuranceCalendarMonthsFromKstInstant(departure, 2);
  const b3 = addInsuranceCalendarMonthsFromKstInstant(departure, 3);
  if (b1 && b2 && b3 && ![b1, b2, b3].some((b) => Number.isNaN(b.getTime()))) {
    const arr = arrival.getTime();
    const d1 = kstYmd(b1);
    const d2 = kstYmd(b2);
    const d3 = kstYmd(b3);
    const arrDay = kstYmd(arrival);
    if (arr <= b1.getTime() && arrDay === d1) return 30;
    if (arr > b1.getTime() && arr <= b2.getTime() && arrDay === d2) return 60;
    if (arr > b2.getTime() && arr <= b3.getTime() && arrDay === d3) return 90;
  }

  if (periodDays <= OVERSEAS_TRAVEL_MAX_SHORT_TERM_DAY_TIER) {
    return periodDays;
  }
  const maxArrival = addInsuranceCalendarMonthsFromKstInstant(departure, 3);
  if (!maxArrival || Number.isNaN(maxArrival.getTime())) return periodDays;
  if (arrival.getTime() <= maxArrival.getTime()) {
    return OVERSEAS_TRAVEL_MAX_SHORT_TERM_DAY_TIER;
  }
  return periodDays;
};

const parseBirthDate = (birthDateStr?: string): Date | null => {
  if (!birthDateStr) return null;
  const compact = birthDateStr.replace(/[^0-9]/g, '');
  if (compact.length !== 8) return null;
  const year = parseInt(compact.substring(0, 4), 10);
  const month = parseInt(compact.substring(4, 6), 10);
  const day = parseInt(compact.substring(6, 8), 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
};

const calculateAgeDetail = (birthDate: Date, referenceDate: Date) => {
  if (referenceDate.getTime() < birthDate.getTime()) return null;

  let years = referenceDate.getFullYear() - birthDate.getFullYear();
  let lastBirthday = new Date(referenceDate.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  if (referenceDate.getTime() < lastBirthday.getTime()) {
    years -= 1;
    lastBirthday = new Date(referenceDate.getFullYear() - 1, birthDate.getMonth(), birthDate.getDate());
  }

  let months = 0;
  let cursor = lastBirthday;
  while (true) {
    const next = addMonthsPreserveDate(cursor, 1);
    if (next.getTime() <= referenceDate.getTime()) {
      months += 1;
      cursor = next;
    } else {
      break;
    }
  }

  const diffTime = referenceDate.getTime() - cursor.getTime();
  const days = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  const sixMonthsLater = addMonthsPreserveDate(lastBirthday, 6);

  return {
    years,
    months,
    days,
    lastBirthday: lastBirthday.toISOString(),
    sixMonthsLater: sixMonthsLater.toISOString(),
  };
};

/** 만 나이(전 나이): 기준일 기준 생일 경과 여부로 계산한 완전한 연수 */
const getFullYearsAge = (birthDate: Date, referenceDate: Date): number => {
  if (referenceDate.getTime() < birthDate.getTime()) return 0;
  let y = referenceDate.getFullYear() - birthDate.getFullYear();
  const refM = referenceDate.getMonth();
  const refD = referenceDate.getDate();
  const birthM = birthDate.getMonth();
  const birthD = birthDate.getDate();
  if (refM < birthM || (refM === birthM && refD < birthD)) y -= 1;
  return y;
};

const ADULT_PLAN_TYPES = ['실속플랜', '표준플랜', '고보장플랜', '고급플랜'];

/** 국내 단체 보험료: 71세 이상은 premium_rates 가 어르신플랜1(실속)/(표준) 만 사용 (레거시 어르신플랜1·실속/표준 성인명 → 정규화) */
const resolveDomesticSeniorPlanTypeForGroup = (planType: string): string => {
  if (planType === '어르신플랜2') return '어르신플랜2';
  if (planType === '어르신플랜1(실속)' || planType === '어르신플랜1(표준)') return planType;
  if (planType === '표준플랜') return '어르신플랜1(표준)';
  return '어르신플랜1(실속)';
};

// 프론트엔드 URL 추론 헬퍼 함수
const getFrontendUrl = (): string => {
  // 1. FRONTEND_URL 환경 변수가 있으면 사용
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.replace(/\/$/, '');
  }
  
  // 2. API_URL을 기반으로 추론 (https://www.bzvalley.net/api -> https://www.bzvalley.net)
  if (process.env.API_URL) {
    const apiUrl = process.env.API_URL.replace(/\/$/, '');
    // /api로 끝나면 제거
    if (apiUrl.endsWith('/api')) {
      return apiUrl.replace(/\/api$/, '');
    }
    return apiUrl;
  }
  
  // 3. 기본값 (프로덕션 환경에서는 https://www.bzvalley.net 사용)
  return process.env.NODE_ENV === 'production' 
    ? 'https://www.bzvalley.net'
    : 'http://localhost:3000';
};

const COUNTRY_NAME_ALIASES: Record<string, string> = {
  포르투갈: '포르투칼',
  남아프리카공화국: '남아공화국',
  파푸아뉴기니: '파푸아뉴기니아',
  터키: '터어키',
  코트디부아르: '코트디브와르',
};

const normalizeCountryName = (value?: string | null) => {
  if (!value) return '';
  const stripped = value.replace('(가입불가)', '').trim();
  return COUNTRY_NAME_ALIASES[stripped] || stripped;
};

const getBizplayAesKey = (): Buffer | null => {
  const rawKey = process.env.BIZPLAY_AES_KEY;
  if (!rawKey) return null;

  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  if (/^[A-Za-z0-9+/=]+$/.test(rawKey)) {
    const base64Buf = Buffer.from(rawKey, 'base64');
    if (base64Buf.length === 32) {
      return base64Buf;
    }
  }

  const utf8Buf = Buffer.from(rawKey, 'utf8');
  if (utf8Buf.length === 32) {
    return utf8Buf;
  }

  return null;
};

const decryptBizplayField = (value: string, aesKey: Buffer): string => {
  const decipher = crypto.createDecipheriv('aes-256-ecb', aesKey, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(value, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8').trim();
};

/** 비즈플레이 일시 파싱. 24시 허용 (JS Date가 자동으로 다음날 00:00으로 처리, MySQL 24:00 규칙과 동일) */
const parseBizplayDateTime = (value: string): Date | null => {
  if (!value) return null;
  const compact = value.replace(/[^0-9]/g, '');
  if (![8, 10, 12].includes(compact.length)) return null;
  const year = parseInt(compact.substring(0, 4), 10);
  const month = parseInt(compact.substring(4, 6), 10);
  const day = parseInt(compact.substring(6, 8), 10);
  const hour = compact.length >= 10 ? parseInt(compact.substring(8, 10), 10) : 0;
  const minute = compact.length === 12 ? parseInt(compact.substring(10, 12), 10) : 0;
  if ([year, month, day, hour, minute].some((num) => Number.isNaN(num))) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 24) return null;
  if (minute < 0 || minute > 59) return null;
  const parsed = new Date(year, month - 1, day, hour, minute);
  if (parsed.getTime() !== parsed.getTime()) return null;
  return parsed;
};

const resolveBizplayInsuranceType = (tourPlace: string): string => {
  return tourPlace === 'KR' ? '국내여행보험' : '해외여행보험';
};

const resolveCountryNameFromCode = (code: string): string | null => {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'KR') return '국내';
  try {
    const displayNames = new Intl.DisplayNames(['ko'], { type: 'region' });
    const label = displayNames.of(normalized);
    if (!label || label === normalized) return null;
    return label;
  } catch (error) {
    return null;
  }
};

const BIZPLAY_PLAN_MAP: Record<string, Record<string, { planType: string; hasMedicalExpense: 0 | 1 }>> = {
  N521029: {
    BAS: { planType: '실속플랜', hasMedicalExpense: 1 },
    STD: { planType: '표준플랜', hasMedicalExpense: 1 },
    CHV: { planType: '어린이플랜', hasMedicalExpense: 1 },
    OLD: { planType: '어르신플랜', hasMedicalExpense: 1 },
    DSM: { planType: '표준플랜', hasMedicalExpense: 0 },
    CHM: { planType: '어린이플랜', hasMedicalExpense: 0 },
    OLM: { planType: '어르신플랜', hasMedicalExpense: 0 },
    SP1: { planType: '실속플랜', hasMedicalExpense: 0 },
  },
  N520046: {
    BAS: { planType: '실속플랜', hasMedicalExpense: 1 },
    STD: { planType: '표준플랜', hasMedicalExpense: 1 },
    HCV: { planType: '고급플랜', hasMedicalExpense: 1 },
    CHV: { planType: '어린이플랜', hasMedicalExpense: 1 },
    OLD: { planType: '어르신플랜1', hasMedicalExpense: 1 },
    OL2: { planType: '어르신플랜2', hasMedicalExpense: 1 },
    BAM: { planType: '실속플랜', hasMedicalExpense: 0 },
    STM: { planType: '표준플랜', hasMedicalExpense: 0 },
    HCM: { planType: '고급플랜', hasMedicalExpense: 0 },
    CHM: { planType: '어린이플랜', hasMedicalExpense: 0 },
    OLM: { planType: '어르신플랜1', hasMedicalExpense: 0 },
    O2M: { planType: '어르신플랜2', hasMedicalExpense: 0 },
  },
  N010001: {
    BAS: { planType: '실속플랜', hasMedicalExpense: 1 },
    STD: { planType: '표준플랜', hasMedicalExpense: 1 },
    HCV: { planType: '고급플랜', hasMedicalExpense: 1 },
    CHV: { planType: '어린이플랜', hasMedicalExpense: 1 },
    CH2: { planType: '어린이플랜2', hasMedicalExpense: 1 },
  },
};

const resolveBizplayPlanInfo = (
  productCode: string,
  planCode: string
): { planType: string; hasMedicalExpense: 0 | 1 } | null => {
  const product = (productCode || '').trim().toUpperCase();
  const plan = (planCode || '').trim().toUpperCase();
  if (!product || !plan) return null;
  return BIZPLAY_PLAN_MAP[product]?.[plan] ?? null;
};

const formatBizplayResidentNumber = (value: string): string => {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  // Bizplay 복호화 주민번호는 보통 9자리(YYYYMMDD + 성별코드1자리) 형태로 들어옴
  // 저장 포맷: YYYYMMDD-1000000 (뒤 6자리는 0으로 마스킹)
  if (digits.length >= 9) {
    return `${digits.slice(0, 8)}-${digits.slice(8, 9)}000000`;
  }
  if (digits.length >= 8) {
    return `${digits.slice(0, 8)}-0000000`;
  }
  return value;
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

/** 네이버페이 영수증 미리보기 기준 URL (개발/상용 분기) */
const getNaverPayReceiptBaseUrl = (): string => {
  const override = process.env.NAVER_PAY_RECEIPT_BASE_URL;
  if (override) return override.replace(/\/$/, '');
  const env = process.env.NAVER_PAY_ENV;
  const isDev = env === 'dev' || env === 'development';
  return isDev
    ? 'https://test-pay.naver.com/receipts/preview/card'
    : 'https://pay.naver.com/receipts/preview/card';
};

/** 네이버페이 결제 승인 응답에서 영수증 미리보기 URL 생성 (API 호출 없이 paymentId, payHistId로 조합) */
const buildNaverPayReceiptUrl = (naverPayResponse: any, paymentId: string): string | null => {
  const detail = naverPayResponse?.body?.detail || naverPayResponse?.detail || {};
  const payHistId = detail.payHistId;
  if (!paymentId || !payHistId) {
    return null;
  }
  const params = new URLSearchParams({
    svcInfType: 'PD',
    paymentId,
    tid: payHistId,
  });
  return `${getNaverPayReceiptBaseUrl()}?${params.toString()}`;
};

/** 카카오페이 영수증 URL 생성. KAKAO_PAY_RECEIPT_BASE_URL 설정 시에만 생성 (공식 웹 영수증 URL 미제공, 앱 내 결제내역에서 확인) */
const buildKakaoPayReceiptUrl = (approveResponse: any): string | null => {
  const base = process.env.KAKAO_PAY_RECEIPT_BASE_URL?.trim();
  if (!base) return null;
  const tid = approveResponse?.tid;
  if (!tid) return null;
  const params = new URLSearchParams({ tid });
  if (approveResponse?.cid) params.set('cid', approveResponse.cid);
  return `${base.replace(/\/$/, '')}?${params.toString()}`;
};

/**
 * 네이버페이 승인 응답의 merchantPayKey에서 계약 ID 추출.
 * - 구형: ORDER_{timestamp}_{contractId}
 * - 신형: contractId만 전달
 */
const contractIdFromNaverMerchantPayKey = (merchantPayKey: string | undefined): number | null => {
  if (merchantPayKey == null || merchantPayKey === '') return null;
  const s = String(merchantPayKey).trim();
  const legacy = s.match(/_(\d+)$/);
  if (legacy) return parseInt(legacy[1], 10);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
};

// 보험료 계산 (국내여행보험용)
router.post('/api/travel/calculate-premium', async (req: Request, res: Response) => {
  try {
    const { 
      insurance_type, 
      age, 
      gender, 
      plan_type, 
      has_medical_expense, 
      departure_date, 
      arrival_date,
      currency_plan,
      travel_country,
      plan_variant,
      birth_date
    } = req.body;
    const planVariant = plan_variant || 'B';

    console.log('=== 보험료 계산 시작 ===');
    console.log('입력 파라미터:', {
      insurance_type,
      age,
      gender,
      plan_type,
      has_medical_expense,
      departure_date,
      arrival_date,
      currency_plan,
      travel_country,
      birth_date
    });

    const referenceDate = new Date();
    const parsedBirthDate = parseBirthDate(birth_date);
    if (parsedBirthDate) {
      const ageDetail = calculateAgeDetail(parsedBirthDate, referenceDate);
      console.log('보험나이 디버그:', {
        birth_date,
        reference_date: referenceDate.toISOString(),
        age_input: age,
        age_detail: ageDetail,
      });
    }

    // 필수 파라미터 검증
    if (!insurance_type || age === undefined || !gender || !plan_type || !departure_date || !arrival_date) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    // 보험기간 계산 (일수): 입력값을 KST로 해석, 부분일은 1일로 올림
    const departure = parseDateTimeAsKst(departure_date) ?? new Date(departure_date);
    const arrival = parseDateTimeAsKst(arrival_date) ?? new Date(arrival_date);
    const diffTime = arrival.getTime() - departure.getTime();
    const periodDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const rateLookupPeriodDays = resolveOverseasShortTripRateLookupPeriodDays(
      insurance_type,
      departure,
      arrival,
      periodDays
    );
    const rateLookup = getRateLookupCriteria(insurance_type, departure, arrival, rateLookupPeriodDays);

    console.log('기간 계산:', {
      departure: departure.toISOString(),
      arrival: arrival.toISOString(),
      diffTime_ms: diffTime,
      periodDays,
      rateLookupPeriodDays,
    });

    if (periodDays <= 0) {
      return res.status(400).json({
        success: false,
        message: '도착일시는 출발일시보다 이후여야 합니다.',
      });
    }

    // 보험나이 15세일 때만 만 나이로 성인/어린이 구분 (기준일: KST 당일 = 견적·가입 요청 시점)
    let finalPlanType = plan_type;
    if (age === 15 && parsedBirthDate) {
      const refForManNai = getKstCalendarDateNow();
      const manNai = getFullYearsAge(parsedBirthDate, refForManNai);
      if (manNai >= 15) {
        // 만 15세 이상 → 성인 플랜(실속/표준/고보장). 다른 성인 플랜 없으면 디폴트 실속플랜
        finalPlanType = ADULT_PLAN_TYPES.includes(plan_type) ? plan_type : '실속플랜';
      } else {
        // 만 15세 미만 → 어린이 플랜
        finalPlanType = '어린이플랜';
      }
      console.log('보험나이 15세 만나이 보정:', { manNai, original: plan_type, final: finalPlanType });
    }
    console.log('플랜 타입:', { original: plan_type, final: finalPlanType, age });

    let annualPremium: number;

    // 외화 플랜인 경우
    if (currency_plan === '외화' && ['유학/어학연수', '워킹홀리데이', '해외출장/주재원/교환교수'].includes(insurance_type)) {
      console.log('외화 플랜 보험료 계산 시작');

      // 유로 사용 국가 목록
      const euroCountries = [
        '독일', '프랑스', '이탈리아', '스페인', '네덜란드', '벨기에', '그리스', 
        '포르투갈', '오스트리아', '핀란드', '아일랜드', '룩셈부르크', '슬로바키아',
        '슬로베니아', '에스토니아', '라트비아', '리투아니아', '몰타', '키프로스'
      ];

      // 통화 결정: 워킹홀리데이(유로화플랜)는 무조건 EUR, 그 외는 EUR 우선, 없으면 USD
      let currency = 'USD'; // 기본값
      
      // 워킹홀리데이(유로화플랜)인 경우 무조건 EUR 사용
      if (plan_type === '워킹홀리데이(유로화플랜)') {
        currency = 'EUR';
        console.log('워킹홀리데이(유로화플랜): EUR 강제 사용');
      } else if (travel_country && euroCountries.includes(travel_country)) {
        // EUR 조회 시도
        const [eurRows] = await pool.execute<any[]>(
          `SELECT korean_premium, foreign_premium 
           FROM foreign_currency_premium_rates 
           WHERE insurance_type = ? 
             AND plan_type = ? 
             AND age = ? 
             AND gender = ? 
             AND has_medical_expense = ? 
             AND plan_variant = ?
             AND currency = 'EUR'
             AND is_active = 1
           ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
           LIMIT 1`,
          [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0, planVariant]
        );

        if (eurRows && eurRows.length > 0) {
          currency = 'EUR';
          console.log('EUR 보험료 데이터 발견');
        }
      }

      // 외화 플랜 보험료 조회 (EUR 우선, 없으면 USD)
      const [foreignPremiumRows] = await pool.execute<any[]>(
        `SELECT korean_premium, foreign_premium 
         FROM foreign_currency_premium_rates 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND age = ? 
           AND gender = ? 
           AND has_medical_expense = ? 
           AND plan_variant = ?
           AND currency = ?
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0, planVariant, currency]
      );

      console.log('외화 플랜 보험료 조회 결과:', { currency, rows: foreignPremiumRows });

      if (!foreignPremiumRows || foreignPremiumRows.length === 0) {
        // EUR 조회 실패 시 USD 재시도 (단, 워킹홀리데이(유로화플랜)는 제외)
        if (currency === 'EUR' && plan_type !== '워킹홀리데이(유로화플랜)') {
          const [usdRows] = await pool.execute<any[]>(
            `SELECT korean_premium, foreign_premium 
             FROM foreign_currency_premium_rates 
             WHERE insurance_type = ? 
               AND plan_type = ? 
               AND age = ? 
               AND gender = ? 
               AND has_medical_expense = ? 
               AND plan_variant = ?
               AND currency = 'USD'
               AND is_active = 1
             ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
             LIMIT 1`,
            [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0, planVariant]
          );

          if (usdRows && usdRows.length > 0) {
            currency = 'USD';
            foreignPremiumRows.push(...usdRows);
            console.log('USD 보험료 데이터로 대체');
          }
        }

        if (!foreignPremiumRows || foreignPremiumRows.length === 0) {
          console.log('외화 플랜 보험료 정보를 찾을 수 없음');
          return res.status(404).json({
            success: false,
            message: plan_type === '워킹홀리데이(유로화플랜)' 
              ? '해당 조건의 워킹홀리데이(유로화플랜) 보험료 정보를 찾을 수 없습니다.'
              : '해당 조건의 외화 플랜 보험료 정보를 찾을 수 없습니다.',
          });
        }
      }

      const koreanPremium = parseFloat(foreignPremiumRows[0].korean_premium);
      const foreignPremium = parseFloat(foreignPremiumRows[0].foreign_premium);
      console.log('외화 플랜 보험료:', { currency, koreanPremium, foreignPremium });

      // 환율 조회 (최신 환율 사용)
      const [exchangeRateRows] = await pool.execute<any[]>(
        `SELECT exchange_rate 
         FROM exchange_rates 
         WHERE currency = ? 
           AND is_active = 1
         ORDER BY rate_date DESC, id DESC
         LIMIT 1`,
        [currency]
      );

      if (!exchangeRateRows || exchangeRateRows.length === 0) {
        console.log('환율 정보를 찾을 수 없음:', currency);
        return res.status(404).json({
          success: false,
          message: `${currency} 환율 정보를 찾을 수 없습니다. 환율을 먼저 등록해주세요.`,
        });
      }

      const exchangeRate = parseFloat(exchangeRateRows[0].exchange_rate);
      console.log('환율:', { currency, exchangeRate });

      // 연간보험료 계산: 원화담보보험료 + (외화담보보험료 × 환율)
      annualPremium = koreanPremium + (foreignPremium * exchangeRate);
      console.log('외화 플랜 연간 보험료 계산:', {
        koreanPremium,
        foreignPremium,
        exchangeRate,
        annualPremium
      });
    } else {
      // 원화 플랜: 기존 로직
      const queryParams = [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0, planVariant];
      console.log('보험료 조회 쿼리 파라미터:', queryParams);

      const [premiumRows] = await pool.execute<any[]>(
        `SELECT annual_premium 
         FROM premium_rates 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND age = ? 
           AND gender = ? 
           AND has_medical_expense = ? 
           AND plan_variant = ?
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        queryParams
      );

      console.log('보험료 조회 결과:', premiumRows);

      if (!premiumRows || premiumRows.length === 0) {
        console.log('보험료 정보를 찾을 수 없음');
        return res.status(404).json({
          success: false,
          message: '해당 조건의 보험료 정보를 찾을 수 없습니다.',
        });
      }

      annualPremium = parseFloat(premiumRows[0].annual_premium);
      console.log('연간 보험료:', annualPremium);
    }

    // 단기요율 조회 (기간에 해당하는 요율 찾기)
    let shortTermRate = 100.0; // 기본값 (1년 이상 또는 테이블 최대값 초과 시)
    
    if (periodDays < 365) {
      console.log('단기요율 조회 (periodDays < 365):', { periodDays, rateLookup, insurance_type });
      
      // 해당 기간보다 크거나 같은 period_days 중 가장 작은 값 찾기
      let [rateRows] = await pool.execute<any[]>(
        `SELECT rate_percentage, period_days
         FROM short_term_rates 
         WHERE insurance_type = ? 
           AND period_unit = ?
           AND period_value >= ? 
           AND is_active = 1
         ORDER BY period_value ASC 
         LIMIT 1`,
        [insurance_type, rateLookup.unit, rateLookup.value]
      );

      console.log('단기요율 조회 결과:', rateRows);

      if ((!rateRows || rateRows.length === 0) && rateLookup.unit === 'months') {
        [rateRows] = await pool.execute<any[]>(
          `SELECT rate_percentage, period_days
           FROM short_term_rates 
           WHERE insurance_type = ? 
             AND period_unit = 'days'
             AND period_value >= ? 
             AND is_active = 1
           ORDER BY period_value ASC 
           LIMIT 1`,
          [insurance_type, rateLookup.value * 30]
        );
        console.log('단기요율(월→일) 폴백 조회 결과:', rateRows);
      }

      if (rateRows && rateRows.length > 0) {
        shortTermRate = parseFloat(rateRows[0].rate_percentage);
        console.log('단기요율 적용:', { periodDays: rateRows[0].period_days, rate: shortTermRate });
      } else {
        // 조회 실패 시 (테이블 최대 period_days보다 큰 경우) 100% 적용
        console.log('단기요율 조회 실패 (테이블 범위 초과), 100% 적용:', shortTermRate);
      }
    } else {
      console.log('1년 이상이므로 단기요율 100% 적용');
    }

    // 플랜별 추가 금액 조회 (해외여행보험만 적용)
    let additionalFee = 0;
    if (insurance_type === '해외여행보험') {
      const [additionalFeeRows] = await pool.execute<any[]>(
        `SELECT additional_fee 
         FROM plan_additional_fees 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND plan_variant = ?
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        [insurance_type, finalPlanType, planVariant]
      );

      if (additionalFeeRows && additionalFeeRows.length > 0) {
        additionalFee = parseFloat(additionalFeeRows[0].additional_fee);
        console.log('플랜별 추가 금액 (해외여행보험):', { plan: finalPlanType, additionalFee });
      }
    }

    // 최종 보험료 계산: (연간보험료 × (단기요율 / 100)) + 플랜별 추가 금액
    // 단수처리: 최종 보험료 십원단위 절사 (예: 317852.5 → 317850)
    const calculatedPremium = annualPremium * (shortTermRate / 100);
    const finalPremium = Math.floor((calculatedPremium + additionalFee) / 10) * 10;

    console.log('최종 계산:', {
      annualPremium,
      shortTermRate,
      calculatedPremium,
      additionalFee,
      finalPremium: finalPremium
    });
    console.log('=== 보험료 계산 완료 ===\n');

    // 응답 데이터 준비
    const responseData: any = {
      success: true,
      premium: finalPremium,
      annual_premium: annualPremium,
      short_term_rate: shortTermRate,
      period_days: periodDays,
    };

    // 외화 플랜인 경우 사용된 통화 정보 추가
    if (currency_plan === '외화' && ['유학/어학연수', '워킹홀리데이', '해외출장/주재원/교환교수'].includes(insurance_type)) {
      let usedCurrency = 'USD';
      
      if (plan_type === '워킹홀리데이(유로화플랜)') {
        usedCurrency = 'EUR';
      } else {
        const euroCountries = [
          '독일', '프랑스', '이탈리아', '스페인', '네덜란드', '벨기에', '그리스', 
          '포르투갈', '오스트리아', '핀란드', '아일랜드', '룩셈부르크', '슬로바키아',
          '슬로베니아', '에스토니아', '라트비아', '리투아니아', '몰타', '키프로스'
        ];

        if (travel_country && euroCountries.includes(travel_country)) {
          const [eurCheck] = await pool.execute<any[]>(
            `SELECT id FROM foreign_currency_premium_rates 
             WHERE insurance_type = ? AND plan_type = ? AND age = ? AND gender = ? 
               AND has_medical_expense = ? AND currency = 'EUR' AND is_active = 1
             LIMIT 1`,
            [insurance_type, finalPlanType, age, gender, has_medical_expense ? 1 : 0]
          );
          if (eurCheck && eurCheck.length > 0) {
            usedCurrency = 'EUR';
          }
        }
      }
      responseData.currency = usedCurrency;
    }

    res.json(responseData);
  } catch (error) {
    console.error('Calculate premium error:', error);
    res.status(500).json({
      success: false,
      message: '보험료 계산 중 오류가 발생했습니다.',
    });
  }
});

// 계약번호 생성 함수
function generateContractNumber(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TC${year}${month}${day}${random}`;
}

/** 카드/PG 선택 후 실제 카드 금액이 0원인 경우(전액 무사고캐시 등): PG 결제창 호출 불가 → 등록 API에서 즉시 완료 처리 */
const PG_INSTANT_COMPLETE_METHODS = ['나이스페이먼츠', '네이버페이', '카카오페이'] as const;

// 계약 등록 (B2C/제휴사 공용)
router.post('/api/travel/register-contract', async (req: Request, res: Response) => {
  if (req.body?.join_contract_id) {
    return handleBizplayRegisterContract(req, res);
  }

  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const { contract, contractor, insured_persons, companions, payment } = req.body;

    const pgMethodForZeroCheck =
      typeof payment?.payment_method === 'string' ? payment.payment_method.trim() : '';
    const payAmountEarly = Number(payment?.amount) || 0;
    const totalPremiumEarly = Number(contract?.total_premium) || 0;
    const useCashEarly = Math.max(0, Number(payment?.use_accident_free_cash) || 0);
    if (
      payment?.status === '완료' &&
      payAmountEarly === 0 &&
      totalPremiumEarly > 0 &&
      PG_INSTANT_COMPLETE_METHODS.includes(pgMethodForZeroCheck as any)
    ) {
      if (useCashEarly !== totalPremiumEarly) {
        await connection.rollback();
        res.status(400).json({
          success: false,
          message:
            '무사고캐시 등으로 카드 결제 금액이 없을 때는 사용 무사고캐시가 합계 보험료와 같아야 합니다.',
        });
        return;
      }
      if (!contract?.member_id) {
        await connection.rollback();
        res.status(400).json({
          success: false,
          message: '무사고캐시 전액 결제는 로그인한 회원만 이용할 수 있습니다.',
        });
        return;
      }
    }

    let resolvedTravelRegion: string | null = contract?.travel_region || null;
    if (resolvedTravelRegion === '해외') {
      resolvedTravelRegion = null;
    }

    if (!resolvedTravelRegion && contract?.travel_country) {
      const normalizedCountry = normalizeCountryName(contract.travel_country);
      try {
        const insuranceType = contract?.insurance_type;
        let rows: any[] = [];
        if (insuranceType) {
          const [filteredRows] = await connection.execute<any[]>(
            `SELECT region_name
               FROM travel_regions
              WHERE is_active = 1
                AND country_name = ?
                AND JSON_CONTAINS(insurance_types, ?)
              ORDER BY display_order, id
              LIMIT 1`,
            [normalizedCountry, JSON.stringify(insuranceType)]
          );
          rows = filteredRows;
        }

        if (!rows.length) {
          const [fallbackRows] = await connection.execute<any[]>(
            `SELECT region_name
               FROM travel_regions
              WHERE is_active = 1
                AND country_name = ?
              ORDER BY display_order, id
              LIMIT 1`,
            [normalizedCountry]
          );
          rows = fallbackRows;
        }

        if (rows.length > 0 && rows[0]?.region_name) {
          resolvedTravelRegion = rows[0].region_name;
        }
      } catch (error) {
        console.error('Failed to resolve travel region:', error);
      }
    }

    // 수기카드 데이터 확인용 로그
    if (payment?.payment_sub_method === '수기카드') {
      console.log('백엔드 수신 수기카드 결제 데이터:', JSON.stringify(payment, null, 2));
    }

    // 계약번호 생성
    const contract_number = generateContractNumber();

    // 1. 계약 정보 저장
    const [contractResult] = await connection.execute<any>(
      `INSERT INTO travel_contracts (
        member_id, contract_number, insurance_type, departure_date, duration_months, duration_days,
        arrival_date, travel_region, travel_country, travel_purpose, travel_participants,
        payment_method, payment_status, total_premium, affiliate, device, access_path, system_input_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract.member_id || null, // 회원 ID (비회원은 null)
        contract_number,
        contract.insurance_type,
        normalizeDatetimeForDb(contract.departure_date),
        contract.duration_months,
        contract.duration_days,
        normalizeDatetimeForDb(contract.arrival_date),
        resolvedTravelRegion,
        contract.travel_country || null,
        contract.travel_purpose,
        contract.travel_participants,
        payment?.payment_method || null,
        payment?.status === '완료' ? '결제완료' : '미결제',
        contract.total_premium || 0,
        contract.affiliate || '투어밸리', // 프론트에서 전달받은 affiliate (네이버검색광고 등)
        contract.device || 'PC', // 프론트에서 전달받은 device
        contract.access_path || '투어밸리 사이트', // 프론트에서 전달받은 access_path
        '자동입력',
      ]
    );

    const contract_id = contractResult.insertId;

    // 2. 계약자 정보 저장
    const [contractorResult] = await connection.execute<any>(
      `INSERT INTO contractors (
        contract_id, contractor_type, name, resident_number, mobile_phone, email,
        company_name, business_number, contact_person, phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract_id,
        contractor.contractor_type || '개인',
        contractor.name || null,
        contractor.resident_number || null,
        contractor.mobile_phone || contractor.phone || null,
        contractor.email || null,
        contractor.company_name || null,
        contractor.business_number || null,
        contractor.contact_person || null,
        contractor.phone || contractor.mobile_phone || null,
      ]
    );

    const contractor_id = contractorResult.insertId;

    // 3. 피보험자 정보 저장 (companions 테이블에만 저장)
    for (let i = 0; i < insured_persons.length; i++) {
      const insured = insured_persons[i];
      
      // 피보험자를 companions 테이블에 저장 (플랜, 보험료 정보 포함)
      await connection.execute<any>(
        `INSERT INTO companions (
          contract_id, name, english_name, nationality_type, 
          nationality_continent, nationality_country, resident_number, gender,
          has_illness_history, has_medical_expense, plan_type, premium, sequence_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          insured.name,
          insured.english_name || null,
          insured.nationality_type || null,
          insured.nationality_continent || null,
          insured.nationality_country || null,
          insured.resident_number || null,
          insured.gender || null,
          0, // 과거상병 없음
          insured.has_medical_expense || 0,
          insured.plan_type || null,
          insured.premium || 0,
          insured.sequence_number || (i + 1),
        ]
      );
    }

    // 4. 결제 정보 저장 (use_accident_free_cash: 결제 완료 시 회원 무사고캐시 차감용)
    if (payment) {
      const useAccidentFreeCash = Math.max(0, Number(payment.use_accident_free_cash) || 0);
      // 무통장입금, 수기카드, 가상계좌는 '기타결제'로 저장하고 payment_sub_method에 저장 (관리자 백엔드와 통일)
      const isOfflinePayment = payment.payment_sub_method === '수기카드' || payment.payment_sub_method === '무통장입금' || payment.payment_sub_method === '가상계좌';
      const paymentMethodForDb = isOfflinePayment ? '기타결제' : (payment.payment_method || null);
      const paymentSubMethodForDb = isOfflinePayment ? payment.payment_sub_method : (payment.payment_sub_method || null);

      const [paymentResult] = await connection.execute<any>(
        `INSERT INTO payments (
          contract_id, payment_method, payment_sub_method, amount, status,
          payment_date, depositor_name, bank_name, account_number, use_accident_free_cash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          paymentMethodForDb,
          paymentSubMethodForDb,
          payment.amount || 0,
          payment.status || '대기',
          payment.status === '완료' ? new Date() : null,
          payment.payment_sub_method === '무통장입금' ? payment.depositor_name : null,
          payment.payment_sub_method === '무통장입금' ? payment.bank_name : null,
          payment.payment_sub_method === '무통장입금' ? payment.account_number : null,
          useAccidentFreeCash,
        ]
      );

      const payment_id = paymentResult.insertId;

      // 결제 상세 정보 저장 (수기카드, 무통장입금)
      if (payment_id && (payment.payment_sub_method === '수기카드' || payment.payment_sub_method === '무통장입금')) {
        console.log('payment_details 저장 시도:', {
          payment_id,
          payment_sub_method: payment.payment_sub_method,
          card_type: payment.card_type,
          card_category: payment.card_category,
          card_number: payment.card_number,
          card_expiry_month: payment.card_expiry_month,
          card_expiry_year: payment.card_expiry_year,
          cardholder_name: payment.cardholder_name,
          cardholder_resident_number: payment.cardholder_resident_number,
          approval_date: payment.approval_date,
        });
        
        await connection.execute(
          `INSERT INTO payment_details (
            payment_id, payment_method,
            card_type, card_category, card_number, card_expiry_month, card_expiry_year,
            cardholder_name, cardholder_resident_number, approval_date,
            deposit_bank, depositor_name, expected_deposit_date, deposit_date,
            normal_premium, receipt_premium
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payment_id,
            payment.payment_sub_method,
            payment.card_type || null,
            payment.card_category || null,
            payment.card_number || null,
            payment.card_expiry_month || null,
            payment.card_expiry_year || null,
            payment.cardholder_name || null,
            payment.cardholder_resident_number || null,
            payment.approval_date || null,
            payment.bank_name || null,
            payment.depositor_name || null,
            payment.expected_deposit_date || null,
            null, // deposit_date는 별도로 처리 필요
            payment.normal_premium || 0,
            payment.receipt_premium || 0,
          ]
        );
        
        console.log('payment_details 저장 완료');
      }
      // 나이스페이/네이버페이/카카오페이 등 PG 결제는 payment_sub_method가 null → payment_details 미저장(정상)
    }

    // PG 즉시 완료 포함, 결제완료로 등록된 계약은 콜백 없이 가입완료 상태로 맞춤
    if (payment?.status === '완료') {
      await connection.execute(
        `UPDATE travel_contracts SET status = '가입완료', updated_at = NOW() WHERE id = ?`,
        [contract_id]
      );
    }

    // 5. 마일리지 적립 (결제 완료인 경우)
    if (payment?.status === '완료' && contract.member_id) {
      const paymentAmount = payment.amount || contract.total_premium || 0;
      // 마일리지 지급 (결제 금액의 3%, 최대 30,000P)
      const mileageAmount = Math.min(Math.floor(paymentAmount * 0.03), 30000);
      
      if (mileageAmount > 0) {
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

      // 무사고캐시 사용분 차감 (무통장/수기 등 즉시 완료 시)
      const useAccidentFreeCash = Math.max(0, Number(payment.use_accident_free_cash) || 0);
      if (useAccidentFreeCash > 0 && contract.member_id) {
        const [memberRows] = await connection.execute<any[]>(
          `SELECT accident_free_cash FROM members WHERE id = ?`,
          [contract.member_id]
        );
        const currentCash = Number(memberRows[0]?.accident_free_cash ?? 0);
        const newCashBalance = Math.max(0, currentCash - useAccidentFreeCash);
        await connection.execute(
          `UPDATE members SET accident_free_cash = ?, updated_at = NOW() WHERE id = ?`,
          [newCashBalance, contract.member_id]
        );
        // reason_detail에 travel_contracts.id(계약 ID) 값 저장
        await connection.execute(
          `INSERT INTO accident_free_cash_history (member_id, type, amount, balance, reason, reason_detail, contract_id, created_at)
           VALUES (?, '사용', ?, ?, '보험료 결제 시 무사고캐시 사용', ?, ?, NOW())`,
          [contract.member_id, useAccidentFreeCash, newCashBalance, `계약번호: ${contract_id}`, contract_id]
        );
      }
    }

    await connection.commit();

    if (
      payment?.status === '완료' &&
      payAmountEarly === 0 &&
      totalPremiumEarly > 0 &&
      useCashEarly === totalPremiumEarly &&
      !!contract?.member_id &&
      PG_INSTANT_COMPLETE_METHODS.includes(pgMethodForZeroCheck as any)
    ) {
      try {
        await sendContractCompleteAlimTalk(contract_id, payment.payment_method, payment.payment_sub_method ?? null);
      } catch (alimtalkError) {
        console.error('가입완료 알림톡 발송 실패(전액 무사고캐시·PG 선택):', alimtalkError);
      }
    }

    if (payment?.payment_sub_method === '무통장입금') {
      const receiverPhone = contractor?.mobile_phone || contractor?.phone;
      if (receiverPhone) {
        const totalPremium = Number(payment.amount ?? contract.total_premium ?? 0);
        const useAccidentFreeCash = Math.max(0, Number(payment.use_accident_free_cash) || 0);
        const amountToPay = Math.max(0, totalPremium - useAccidentFreeCash);
        if (amountToPay > 0) {
          const expectedDate = payment.expected_deposit_date;
          const expectedDateText = expectedDate
            ? `${expectedDate.substring(0, 4)}년 ${expectedDate.substring(5, 7)}월 ${expectedDate.substring(8, 10)}일`
            : '가능한 빠른 시일 내';
          const bankName = payment.bank_name || '';
          const accountNumber = payment.account_number || '';
          const accountHolderName = '빨주노초파남보';
          const message = `[투어밸리] 여행자보험료 입금안내

보험료 무통장입금 안내입니다.
아래의 보험료 입금 전용계좌로 ${expectedDateText}까지
보험료를 입금해 주세요

은행 : ${bankName}
계좌번호 : ${accountNumber}
예금주 : ${accountHolderName}
보험료 : ${Number(amountToPay).toLocaleString()}원

보험료 입금확인 후 보험가입이 완료됩니다.`;

          try {
            await sendSms({
              receiver: receiverPhone,
              message,
              title: '[투어밸리] 무통장입금 안내',
            });
          } catch (smsError) {
            console.error('무통장입금 안내 LMS 발송 실패:', smsError);
          }
        }
      }
    }

    res.json({
      success: true,
      contract_id,
      contract_number,
      message: '계약이 성공적으로 등록되었습니다.',
    });
  } catch (error) {
    await connection.rollback();
    console.error('Contract registration error:', error);
    res.status(500).json({
      success: false,
      message: '계약 등록 중 오류가 발생했습니다.',
    });
  } finally {
    connection.release();
  }
});

// 계약 등록 (비즈플레이 연동용)
const handleBizplayRegisterContract = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();
  const requestId =
    (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']) ||
    `bizplay-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  try {
    const detectedCharset = getRequestCharset(req.headers['content-type']);
    const rawParsedByDetected = parseRawJsonBody(req as RawBodyRequest, detectedCharset as iconv.Encoding);
    const rawParsedByCp949 = parseRawJsonBody(req as RawBodyRequest, 'cp949');

    // charset 선언이 잘못되었거나 누락된 경우(cp949) 복구 시도
    const shouldUseCp949Fallback =
      hasBrokenChars(req.body?.join_access_point) &&
      !!rawParsedByCp949?.join_access_point &&
      !hasBrokenChars(rawParsedByCp949.join_access_point);
    const body = shouldUseCp949Fallback ? rawParsedByCp949 : (rawParsedByDetected || req.body || {});

    const {
      join_contract_id,
      product_cd,
      insuperiod_from,
      insuperiod_to,
      tour_place,
      insured_cnt,
      tot_premium,
      join_access_point,
      affiliate_name,
      email,
      ctel_no,
      insured,
    } = body || {};

    console.log('[bizplay-register] request received', {
      requestId,
      contentType: req.headers['content-type'] || '',
      detectedCharset,
      usedCp949Fallback: shouldUseCp949Fallback,
      bodySummary: buildBizplayPayloadSummary(req.body),
      parsedBodySummary: buildBizplayPayloadSummary(body),
      insuredRequestSummary: buildBizplayInsuredSummary(req.body),
      insuredParsedSummary: buildBizplayInsuredSummary(body),
    });

    if (hasBrokenChars(req.body?.join_access_point) || hasBrokenChars(join_access_point)) {
      console.log('[bizplay-register] join_access_point charset diagnostics', {
        requestId,
        bodyJoinAccessPoint: req.body?.join_access_point || null,
        parsedDetectedJoinAccessPoint: rawParsedByDetected?.join_access_point || null,
        parsedCp949JoinAccessPoint: rawParsedByCp949?.join_access_point || null,
        finalJoinAccessPoint: join_access_point || null,
      });
    }

    if (
      !join_contract_id ||
      !product_cd ||
      !insuperiod_from ||
      !insuperiod_to ||
      !tour_place ||
      !insured_cnt ||
      !tot_premium ||
      !join_access_point ||
      !email ||
      !ctel_no ||
      !Array.isArray(insured) ||
      insured.length === 0
    ) {
      return res.json({
        result_cd: '201',
        message: '필수 데이터가 누락되었거나 형식이 올바르지 않습니다.',
      });
    }

    const insuredCountValue = Number(insured_cnt);
    const totalPremiumValue = Number(tot_premium);
    if (!Number.isFinite(insuredCountValue) || insuredCountValue <= 0 || !Number.isFinite(totalPremiumValue)) {
      return res.json({
        result_cd: '201',
        message: '인원수 또는 보험료 값이 올바르지 않습니다.',
      });
    }

    const departureDate = parseBizplayDateTime(insuperiod_from);
    const arrivalDate = parseBizplayDateTime(insuperiod_to);
    if (!departureDate || !arrivalDate || arrivalDate.getTime() <= departureDate.getTime()) {
      return res.json({
        result_cd: '201',
        message: '여행기간 형식이 올바르지 않습니다.',
      });
    }

    const aesKey = getBizplayAesKey();
    if (!aesKey) {
      return res.json({
        result_cd: '200',
        message: 'BIZPLAY_AES_KEY가 설정되어 있지 않습니다.',
      });
    }

    let decryptedEmail = '';
    let decryptedPhone = '';
    try {
      decryptedEmail = decryptBizplayField(email, aesKey);
      decryptedPhone = decryptBizplayField(ctel_no, aesKey);
    } catch (error) {
      return res.json({
        result_cd: '201',
        message: '암호화 데이터 형식이 올바르지 않습니다.',
      });
    }

    const insuredRecords: Array<{
      sequence: number;
      name: string;
      ssn: string;
      masked_ssn: string;
      plan_cd: string;
      plan_type: string;
      has_medical_expense: 0 | 1;
      premium: number;
    }> = [];

    for (let i = 0; i < insured.length; i++) {
      const item = insured[i] || {};
      const sequence = Number(item.insured_seq);
      const premiumValue = Number(item.premium);
      if (!item.insured_seq || !item.plan_cd || !item.insured_ssn || !item.insured_name) {
        return res.json({
          result_cd: '201',
          message: '피보험자 정보가 누락되었습니다.',
        });
      }
      if (!Number.isFinite(sequence) || sequence <= 0 || !Number.isFinite(premiumValue)) {
        return res.json({
          result_cd: '201',
          message: '피보험자 정보 형식이 올바르지 않습니다.',
        });
      }

      const planInfo = resolveBizplayPlanInfo(product_cd, item.plan_cd);
      if (!planInfo) {
        return res.json({
          result_cd: '201',
          message: '플랜 코드가 올바르지 않습니다.',
        });
      }

      try {
        const decryptedSsn = decryptBizplayField(item.insured_ssn, aesKey);
        insuredRecords.push({
          sequence,
          name: decryptBizplayField(item.insured_name, aesKey),
          ssn: decryptedSsn,
          masked_ssn: formatBizplayResidentNumber(decryptedSsn),
          plan_cd: item.plan_cd,
          plan_type: planInfo.planType,
          has_medical_expense: planInfo.hasMedicalExpense,
          premium: premiumValue,
        });
      } catch (error) {
        return res.json({
          result_cd: '201',
          message: '피보험자 암호화 데이터 형식이 올바르지 않습니다.',
        });
      }
    }

    const [existingRows] = await connection.execute<any[]>(
      `SELECT id
       FROM travel_contracts
       WHERE bizplay_contract_number = ?
          OR contract_number = ?
       LIMIT 1`,
      [join_contract_id, join_contract_id]
    );
    if (existingRows.length > 0) {
      return res.json({
        result_cd: '202',
        contract_id: existingRows[0].id,
        message: '이미 등록된 계약입니다.',
      });
    }

    await connection.beginTransaction();

    const tourPlaceCode = String(tour_place).trim().toUpperCase();
    const insuranceType = resolveBizplayInsuranceType(tourPlaceCode);
    const countryLabel = resolveCountryNameFromCode(tourPlaceCode);
    if (!countryLabel) {
      return res.json({
        result_cd: '201',
        message: '국가 코드가 올바르지 않습니다.',
      });
    }
    const normalizedCountry = normalizeCountryName(countryLabel);
    let resolvedTravelRegion: string | null = null;

    if (tourPlaceCode === 'KR') {
      resolvedTravelRegion = '전국일원';
    } else {
      try {
        const [filteredRows] = await connection.execute<any[]>(
          `SELECT region_name
             FROM travel_regions
            WHERE is_active = 1
              AND country_name = ?
              AND JSON_CONTAINS(insurance_types, ?)
            ORDER BY display_order, id
            LIMIT 1`,
          [normalizedCountry, JSON.stringify(insuranceType)]
        );
        if (filteredRows.length > 0 && filteredRows[0]?.region_name) {
          resolvedTravelRegion = filteredRows[0].region_name;
        } else {
          const [fallbackRows] = await connection.execute<any[]>(
            `SELECT region_name
               FROM travel_regions
              WHERE is_active = 1
                AND country_name = ?
              ORDER BY display_order, id
              LIMIT 1`,
            [normalizedCountry]
          );
          if (fallbackRows.length > 0 && fallbackRows[0]?.region_name) {
            resolvedTravelRegion = fallbackRows[0].region_name;
          }
        }
      } catch (error) {
        console.error('Failed to resolve travel region for Bizplay:', error);
      }
    }

    if (!resolvedTravelRegion) {
      return res.json({
        result_cd: '201',
        message: '여행지 정보를 확인할 수 없습니다.',
      });
    }
    const durationDays = Math.max(
      1,
      Math.ceil((arrivalDate.getTime() - departureDate.getTime()) / (1000 * 60 * 60 * 24))
    );
    const travelParticipants = Math.max(insuredCountValue, insuredRecords.length);
    const resolvedAffiliate = String(affiliate_name || '').trim() || '비즈플레이';
    const memo = `Bizplay join_contract_id: ${join_contract_id}, product_cd: ${product_cd}`;

    const [contractResult] = await connection.execute<any>(
      `INSERT INTO travel_contracts (
        member_id, contract_number, bizplay_contract_number, insurance_type, departure_date, duration_months, duration_days,
        arrival_date, travel_region, travel_country, travel_purpose, travel_participants,
        payment_method, payment_status, total_premium, affiliate, device, access_path,
        system_input_status, memo, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        null,
        join_contract_id,
        join_contract_id,
        insuranceType,
        departureDate,
        0,
        durationDays,
        arrivalDate,
        resolvedTravelRegion,
        normalizedCountry,
        '여행',
        travelParticipants,
        null,
        '결제완료',
        totalPremiumValue,
        resolvedAffiliate,
        'PC',
        join_access_point,
        '자동입력',
        memo,
        '가입완료',
      ]
    );

    const contract_id = contractResult.insertId;
    const primaryInsured = insuredRecords[0];

    const [contractorResult] = await connection.execute<any>(
      `INSERT INTO contractors (
        contract_id, contractor_type, name, resident_number, mobile_phone, email,
        company_name, business_number, contact_person, phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contract_id,
        '개인',
        primaryInsured.name,
        primaryInsured.masked_ssn,
        decryptedPhone,
        decryptedEmail,
        null,
        null,
        null,
        decryptedPhone,
      ]
    );

    const contractor_id = contractorResult.insertId;

    for (let i = 0; i < insuredRecords.length; i++) {
      const record = insuredRecords[i];
      
      // 피보험자를 companions 테이블에만 저장
      await connection.execute<any>(
        `INSERT INTO companions (
          contract_id, name, english_name, nationality_type, 
          nationality_continent, nationality_country, resident_number, gender,
          has_illness_history, has_medical_expense, plan_type, premium, sequence_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contract_id,
          record.name,
          null,
          null,
          null,
          null,
          record.masked_ssn,
          null,
          0,
          record.has_medical_expense,
          record.plan_type,
          record.premium,
          record.sequence,
        ]
      );
    }

    // 비즈플레이(B2B 포괄) 결제 — 월 단위 정산용 payments 기록
    await connection.execute(
      `INSERT INTO payments (
        contract_id, payment_method, payment_sub_method, amount, status,
        payment_date, use_accident_free_cash
      ) VALUES (?, '기타결제', 'b2b포괄결제', ?, '완료', ?, 0)`,
      [contract_id, totalPremiumValue, new Date()]
    );

    await connection.commit();

    console.log('[bizplay-register] request completed', {
      requestId,
      contract_id,
      join_contract_id,
      product_cd,
      join_access_point,
      insuredCount: insuredRecords.length,
      totalPremiumValue,
    });

    res.json({
      result_cd: '100',
      contract_id,
      message: '계약이 성공적으로 등록되었습니다.',
    });
  } catch (error) {
    await connection.rollback();
    console.error('[bizplay-register] request failed', {
      requestId,
      error,
      contentType: req.headers['content-type'] || '',
      bodySummary: buildBizplayPayloadSummary(req.body),
    });
    res.json({
      result_cd: '200',
      message: '계약 등록 중 오류가 발생했습니다.',
    });
  } finally {
    connection.release();
  }
};

// 계약 취소 (비즈플레이 연동용)
const handleBizplayCancelContract = async (req: Request, res: Response) => {
  try {
    const { join_contract_id } = req.body || {};
    if (!join_contract_id) {
      return res.json({
        result_cd: '201',
        contract_id: -1,
        message: 'join_contract_id가 필요합니다.',
      });
    }

    const [rows] = await pool.execute<any[]>(
      `SELECT id
       FROM travel_contracts
       WHERE bizplay_contract_number = ?
          OR contract_number = ?
       LIMIT 1`,
      [join_contract_id, join_contract_id]
    );

    if (!rows.length) {
      return res.json({
        result_cd: '201',
        contract_id: -1,
        message: '해당 비즈플레이 예약번호로 등록된 계약이 없습니다.',
      });
    }

    const contractId = rows[0].id;
    await pool.execute(
      `UPDATE travel_contracts
         SET status = '취소신청(계약자)',
             system_input_status = '미입력',
             updated_at = NOW()
       WHERE id = ?`,
      [contractId]
    );

    res.json({
      result_cd: '100',
      contract_id: contractId,
      message: '계약 취소가 완료되었습니다.',
    });
  } catch (error) {
    console.error('Bizplay contract cancel error:', error);
    res.json({
      result_cd: '200',
      contract_id: -1,
      message: '계약 취소 중 오류가 발생했습니다.',
    });
  }
};

router.post('/api/travel/bizplay/cancel-contract', handleBizplayCancelContract);
router.post('/api/travel/cancel-contract', handleBizplayCancelContract);

// 환율 정보 조회 (하루 전날 환율)
router.get('/api/travel/exchange-rate', async (req: Request, res: Response) => {
  try {
    const { currency = 'USD' } = req.query;
    
    // 오늘 날짜 (한국 시간대 기준)
    const today = new Date();
    // 하루 전날 날짜 계산 (한국 시간대 기준)
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    // 날짜만 추출 (YYYY-MM-DD 형식, 로컬 시간 기준)
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    
    // 하루 전날 환율 조회
    const [rows] = await pool.execute<any[]>(
      `SELECT currency, exchange_rate, rate_date 
       FROM exchange_rates 
       WHERE currency = ? 
         AND rate_date = ? 
         AND is_active = 1 
       ORDER BY id DESC
       LIMIT 1`,
      [currency, yesterdayStr]
    );
    
    // 하루 전날 데이터가 없으면 가장 최근 데이터 조회
    let exchangeRateData = rows && rows.length > 0 ? rows[0] : null;
    
    if (!exchangeRateData) {
      const [latestRows] = await pool.execute<any[]>(
        `SELECT currency, exchange_rate, rate_date 
         FROM exchange_rates 
         WHERE currency = ? 
           AND is_active = 1 
         ORDER BY rate_date DESC, id DESC
         LIMIT 1`,
        [currency]
      );
      
      if (latestRows && latestRows.length > 0) {
        exchangeRateData = latestRows[0];
      }
    }
    
    if (!exchangeRateData) {
      return res.status(404).json({
        success: false,
        message: `${currency} 환율 정보를 찾을 수 없습니다.`,
      });
    }
    
    res.json({
      success: true,
      currency: exchangeRateData.currency,
      exchangeRate: parseFloat(exchangeRateData.exchange_rate),
      rateDate: exchangeRateData.rate_date,
    });
  } catch (error) {
    console.error('Get exchange rate error:', error);
    res.status(500).json({
      success: false,
      message: '환율 정보를 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// ==================== 네이버페이 결제 ====================

// 네이버페이 결제 준비
router.post('/api/travel/contracts/:contractId/create-naver-payment', async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const {
      amount,
      productName,
      productCount,
      customerName,
      customerEmail,
      customerPhone,
      checkOutDate, // 보험 종료일 (YYYY-MM-DD)
      purchaserName,   // 보험사 가맹점: 구매자 성명 (customerName과 동일 또는 별도)
      purchaserBirthday, // 보험사 가맹점: 구매자 생년월일 (YYYYMMDD)
    } = req.body;

    // 보험사 가맹점: purchaserName 또는 purchaserBirthday 필요 시 프론트에서 전달
    const resolvedPurchaserName = (purchaserName && String(purchaserName).trim()) || (customerName && String(customerName).trim()) || undefined;
    const resolvedPurchaserBirthday = purchaserBirthday ? String(purchaserBirthday).replace(/[^0-9]/g, '').slice(0, 8) : undefined;

    // 필수 필드 검증
    if (!amount || !productName || !checkOutDate) {
      return res.status(400).json({
        success: false,
        message: '필수 항목이 누락되었습니다.',
      });
    }

    const productNameForPg = withB2cPgProductPrefix(String(productName).trim());

    console.log('네이버페이 결제 준비:', { contractId, amount, productName: productNameForPg, checkOutDate, purchaserName: resolvedPurchaserName, purchaserBirthday: resolvedPurchaserBirthday ? '***' : undefined });

    // 계약 정보 조회
    const [contractRows] = await pool.execute<any[]>(
      'SELECT * FROM travel_contracts WHERE id = ?',
      [contractId]
    );

    if (contractRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약을 찾을 수 없습니다.',
      });
    }

    const contract = contractRows[0];

    // orderId: 계약 ID만 사용 (네이버 merchantPayKey와 동일)
    const orderId = String(contractId);
    const merchantPayKey = orderId;

    // useCfmYmdt 설정 (보험 종료일)
    let useCfmYmdt: string | undefined = undefined;
    if (checkOutDate) {
      const checkoutDateObj = new Date(checkOutDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      checkoutDateObj.setHours(0, 0, 0, 0);
      
      if (checkoutDateObj >= today) {
        useCfmYmdt = checkOutDate.replace(/-/g, '');
      } else {
        return res.status(400).json({
          success: false,
          message: '보험 종료일은 오늘 이후여야 합니다.',
        });
      }
    }

    // 네이버페이 트랜잭션 저장
    await pool.execute(
      `INSERT INTO naver_pay_transactions (
        order_id, contract_id, amount, product_name, use_cfm_ymdt, status
      ) VALUES (?, ?, ?, ?, ?, 'ready')
      ON DUPLICATE KEY UPDATE amount = ?, product_name = ?, use_cfm_ymdt = ?, status = 'ready'`,
      [orderId, contractId, amount, productNameForPg, useCfmYmdt, amount, productNameForPg, useCfmYmdt]
    );

    res.json({
      success: true,
      data: {
        orderId,
        merchantPayKey,
        amount: Math.round(amount),
        productName: productNameForPg,
        productCount: productCount || 1,
        useCfmYmdt,
        // 보험사 가맹점: 클라이언트 oPay.open() 시 purchaserName / purchaserBirthday 로 전달 권장
        purchaserName: resolvedPurchaserName,
        purchaserBirthday: resolvedPurchaserBirthday,
        // 면세점: 전액 비과세 (프론트에서 네이버페이 주문/결제 시 사용)
        taxFreeAmount: Math.round(amount),
        productTaxType: 'TAX_FREE',
      },
    });
  } catch (error) {
    console.error('네이버페이 결제 준비 실패:', error);
    res.status(500).json({
      success: false,
      message: '네이버페이 결제 준비에 실패했습니다.',
    });
  }
});

// 네이버페이 결제 콜백 처리
router.get('/api/travel/naver-pay-callback', async (req: Request, res: Response) => {
  try {
    const { resultCode, paymentId, resultMessage } = req.query;

    console.log('네이버페이 콜백:', { resultCode, paymentId, resultMessage });

    // 결제 실패 처리
    if (resultCode === 'Fail') {
      let errorMessage = '결제가 실패했습니다.';
      
      if (resultMessage === 'userCancel') {
        errorMessage = '결제를 취소하셨습니다.';
      } else if (resultMessage === 'OwnerAuthFail') {
        errorMessage = '타인 명의 카드는 결제가 불가능합니다.';
      } else if (resultMessage === 'paymentTimeExpire') {
        errorMessage = '결제 가능한 시간이 지났습니다.';
      }

      // 네이버페이 트랜잭션 상태 업데이트 (실패)
      try {
        await pool.execute(
          `UPDATE naver_pay_transactions SET status = 'failed' WHERE payment_id = ?`,
          [paymentId || '']
        );
      } catch (updateError) {
        console.error('네이버페이 트랜잭션 실패 상태 업데이트 오류:', updateError);
      }

      const frontendUrl = getFrontendUrl();
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(errorMessage)}`;
      
      return res.redirect(failUrl);
    }

    // 결제 성공 처리
    if (resultCode === 'Success' && paymentId) {
      const naverPayClientId = process.env.NAVER_PAY_CLIENT_ID;
      const naverPayClientSecret = process.env.NAVER_PAY_CLIENT_SECRET;
      
      if (!naverPayClientId || !naverPayClientSecret) {
        console.error('네이버 페이 환경 변수 누락:', {
          hasClientId: !!naverPayClientId,
          hasClientSecret: !!naverPayClientSecret,
        });
        const frontendUrl = getFrontendUrl();
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('네이버 페이 설정이 완료되지 않았습니다.')}`;
        return res.redirect(failUrl);
      }

      try {
        // 네이버 페이 결제 승인 API 호출
        const naverPayEnv = process.env.NAVER_PAY_ENV;
        const isDev = naverPayEnv === 'dev' || naverPayEnv === 'development';
        const naverPayChainId = process.env.NAVER_PAY_CHAIN_ID;
        
        console.log('네이버 페이 환경 설정:', {
          NAVER_PAY_ENV: naverPayEnv,
          isDev: isDev,
          hasClientId: !!naverPayClientId,
          hasClientSecret: !!naverPayClientSecret,
          hasChainId: !!naverPayChainId,
          clientId: naverPayClientId?.substring(0, 10) + '...', // 일부만 표시
          chainId: naverPayChainId,
        });
        
        const naverPayApiUrl = isDev
          ? 'https://dev-pay.paygate.naver.com/naverpay-partner/naverpay/payments/v2.2/apply/payment'
          : 'https://pay.paygate.naver.com/naverpay-partner/naverpay/payments/v2.2/apply/payment';
        
        const idempotencyKey = `naverpay-${paymentId}-${Date.now()}`;
        
        console.log('네이버 페이 결제 승인 API 호출:', { 
          url: naverPayApiUrl, 
          paymentId,
          environment: isDev ? 'development' : 'production',
        });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        const confirmResponse = await fetch(naverPayApiUrl, {
          method: 'POST',
          headers: {
            'X-Naver-Client-Id': naverPayClientId,
            'X-Naver-Client-Secret': naverPayClientSecret,
            'X-NaverPay-Chain-Id': naverPayChainId || '',
            'X-NaverPay-Idempotency-Key': idempotencyKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `paymentId=${encodeURIComponent(paymentId as string)}`,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

        const responseText = await confirmResponse.text();
        console.log('네이버 페이 API 응답:', responseText);
        
        const naverPayResponse = JSON.parse(responseText);

        if (!confirmResponse.ok || naverPayResponse.code === 'Fail' || naverPayResponse.error) {
          const frontendUrl = getFrontendUrl();
          const errorMsg = naverPayResponse.message || '결제 승인에 실패했습니다.';
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(errorMsg)}`;
          return res.redirect(failUrl);
        }

        // 결제 정보 추출
        const detail = naverPayResponse.body?.detail || naverPayResponse.detail || {};
        const merchantPayKey = detail.merchantPayKey || naverPayResponse.merchantPayKey;
        const totalPayAmount = detail.totalPayAmount || naverPayResponse.totalPayAmount || 0;
        const admissionState = detail.admissionState || naverPayResponse.admissionState || '';

        if (admissionState !== 'SUCCESS') {
          const frontendUrl = getFrontendUrl();
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 승인이 완료되지 않았습니다.')}`;
          return res.redirect(failUrl);
        }

        const contractId = contractIdFromNaverMerchantPayKey(merchantPayKey);

        if (!contractId) {
          const frontendUrl = getFrontendUrl();
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('계약 정보를 찾을 수 없습니다.')}`;
          return res.redirect(failUrl);
        }

        // 트랜잭션 시작
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
          // 계약 정보 조회
          const [contractRows] = await connection.execute<any[]>(
            'SELECT * FROM travel_contracts WHERE id = ?',
            [contractId]
          );

          if (contractRows.length === 0) {
            await connection.rollback();
            const frontendUrl = getFrontendUrl();
            const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('계약을 찾을 수 없습니다.')}`;
            return res.redirect(failUrl);
          }

          const contract = contractRows[0];

          // 계약 상태 업데이트
          await connection.execute(
            `UPDATE travel_contracts 
             SET payment_status = '결제완료', payment_method = '네이버페이', status = '가입완료', updated_at = NOW()
             WHERE id = ?`,
            [contractId]
          );

          // 영수증 URL: apply 응답에 있으면 추출, 없으면 paymentId·payHistId로 미리보기 URL 생성
          let receiptUrl = extractReceiptUrl(naverPayResponse);
          if (!receiptUrl && paymentId) {
            receiptUrl = buildNaverPayReceiptUrl(naverPayResponse, paymentId as string);
          }
          // 대기 건의 무사고캐시 사용액을 완료 건에 반영
          const [naverPendingRows] = await connection.execute<any[]>(
            `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? AND status = '대기' ORDER BY id ASC LIMIT 1`,
            [contractId]
          );
          const naverUseAccidentFreeCash = naverPendingRows[0]?.use_accident_free_cash != null
            ? Math.max(0, Number(naverPendingRows[0].use_accident_free_cash))
            : 0;
          // 결제 정보 저장
          await connection.execute(
            `INSERT INTO payments (
              contract_id, payment_method, amount, status, payment_date,
              payment_number, pg_transaction_id, pg_response, receipt_url, use_accident_free_cash
            ) VALUES (?, '네이버페이', ?, '완료', NOW(), ?, ?, ?, ?, ?)`,
            [
              contractId,
              totalPayAmount,
              merchantPayKey,
              paymentId,
              JSON.stringify(naverPayResponse),
              receiptUrl,
              naverUseAccidentFreeCash,
            ]
          );

          // 네이버페이 트랜잭션 상태 업데이트
          await connection.execute(
            `UPDATE naver_pay_transactions 
             SET status = 'approved', payment_id = ?, pg_response = ? 
             WHERE order_id = ?`,
            [paymentId, JSON.stringify(naverPayResponse), merchantPayKey]
          );

          // 마일리지 지급 (결제 금액의 3%, 최대 30,000P)
          const mileageAmount = Math.min(Math.floor(totalPayAmount * 0.03), 30000);
          
          if (mileageAmount > 0 && contract.member_id) {
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
              [contract.member_id, mileageAmount, contractId, newBalance]
            );
          }

          // 무사고캐시 사용분 차감 (계약 등록 시 저장한 use_accident_free_cash)
          const [pendingPaymentRows] = await connection.execute<any[]>(
            `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? AND status = '대기' ORDER BY id ASC LIMIT 1`,
            [contractId]
          );
          const useAccidentFreeCash = pendingPaymentRows[0]?.use_accident_free_cash != null
            ? Math.max(0, Number(pendingPaymentRows[0].use_accident_free_cash))
            : 0;
          if (useAccidentFreeCash > 0 && contract.member_id) {
            const [memberRows] = await connection.execute<any[]>(
              `SELECT accident_free_cash FROM members WHERE id = ?`,
              [contract.member_id]
            );
            const currentCash = Number(memberRows[0]?.accident_free_cash ?? 0);
            const newCashBalance = Math.max(0, currentCash - useAccidentFreeCash);
            await connection.execute(
              `UPDATE members SET accident_free_cash = ?, updated_at = NOW() WHERE id = ?`,
              [newCashBalance, contract.member_id]
            );
            // reason_detail에 travel_contracts.id(계약 ID) 값 저장
            await connection.execute(
              `INSERT INTO accident_free_cash_history (member_id, type, amount, balance, reason, reason_detail, contract_id, created_at)
               VALUES (?, '사용', ?, ?, '보험료 결제 시 무사고캐시 사용', ?, ?, NOW())`,
              [contract.member_id, useAccidentFreeCash, newCashBalance, `계약번호: ${contractId}`, contractId]
            );
          }

          try {
            await sendContractCompleteAlimTalk(contractId, '네이버페이');
          } catch (alimtalkError) {
            console.error('가입완료 알림톡 발송 실패:', alimtalkError);
          }

          await connection.commit();
          connection.release();

          // 성공 페이지로 리다이렉트
          const frontendUrl = getFrontendUrl();
          const successUrl = `${frontendUrl}/payment/success?contractId=${contractId}&customerName=${encodeURIComponent(contract.customer_name || '')}&contractNumber=${merchantPayKey}`;
          res.redirect(successUrl);
        } catch (dbError) {
          await connection.rollback();
          connection.release();
          throw dbError;
        }
      } catch (error: any) {
        console.error('네이버페이 승인 처리 실패:', error);
        const frontendUrl = getFrontendUrl();
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(error.message || '결제 처리 중 오류가 발생했습니다.')}`;
        return res.redirect(failUrl);
      }
    } else {
      const frontendUrl = getFrontendUrl();
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 정보가 올바르지 않습니다.')}`;
      return res.redirect(failUrl);
    }
  } catch (error) {
    console.error('네이버페이 콜백 처리 실패:', error);
    const frontendUrl = getFrontendUrl();
    const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 처리 중 오류가 발생했습니다.')}`;
    return res.redirect(failUrl);
  }
});

// ==================== 카카오페이 결제 ====================

// 카카오페이 결제 준비
router.post('/api/travel/contracts/:contractId/prepare-kakao-payment', async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const {
      amount,
      itemName,
      quantity,
      customerName,
      customerEmail,
      customerPhone,
    } = req.body;

    console.log('카카오페이 결제 준비:', { contractId, amount, itemName });

    // 필수 필드 검증
    if (!amount || !itemName) {
      return res.status(400).json({
        success: false,
        message: '필수 항목이 누락되었습니다.',
      });
    }

    const itemNameForPg = withB2cPgProductPrefix(String(itemName).trim());

    // 계약 정보 조회
    const [contractRows] = await pool.execute<any[]>(
      'SELECT * FROM travel_contracts WHERE id = ?',
      [contractId]
    );

    if (contractRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약을 찾을 수 없습니다.',
      });
    }

    // partner_order_id: 계약 ID만 사용
    const orderId = String(contractId);

    // 카카오페이 설정 (신 카카오페이 API)
    const kakaoPayClientId = process.env.KAKAO_PAY_CLIENT_ID;
    const kakaoPayClientSecret = process.env.KAKAO_PAY_CLIENT_SECRET;
    const kakaoPayEnv = process.env.KAKAO_PAY_ENV || 'dev';
    const kakaoPaySecretKey = kakaoPayEnv === 'production' 
      ? process.env.KAKAO_PAY_SECRET_KEY 
      : process.env.KAKAO_PAY_SECRET_KEY_DEV;
    const kakaoPayCid = process.env.KAKAO_PAY_CID || 'CTL803FNNQ';
    const apiBaseUrl = process.env.FRONTEND_URL || 'http://localhost:4000';
    const frontendBaseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (!kakaoPayClientId || !kakaoPayClientSecret || !kakaoPaySecretKey) {
      return res.status(500).json({
        success: false,
        message: '카카오페이 설정이 완료되지 않았습니다.',
      });
    }

    try {
      // 카카오페이 결제 준비 API 호출 (신 카카오페이 API)
      const kakaoPayApiUrl = 'https://open-api.kakaopay.com/online/v1/payment/ready';
      
      // 면세점: 전액 비과세 (tax_free_amount = 결제금액, vat_amount = 0)
      const totalAmount = Math.round(amount);
      const requestBody = {
        cid: kakaoPayCid,
        cid_secret: kakaoPayClientSecret,
        partner_order_id: orderId,
        partner_user_id: String(contractId),
        item_name: itemNameForPg,
        quantity: quantity || 1,
        total_amount: totalAmount,
        tax_free_amount: totalAmount,
        vat_amount: 0,
        approval_url: `${apiBaseUrl}/api/travel/kakao-pay-callback?partner_order_id=${orderId}&partner_user_id=${contractId}`,
        cancel_url: `${frontendBaseUrl}/payment/cancel`,
        fail_url: `${frontendBaseUrl}/payment/fail`,
      };

      console.log('카카오페이 결제 준비 요청:', {
        cid: kakaoPayCid,
        orderId,
        amount: Math.round(amount),
        itemName: itemNameForPg,
      });

      const response = await fetch(kakaoPayApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `SECRET_KEY ${kakaoPaySecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      console.log('카카오페이 API 응답:', responseText);

      if (!response.ok) {
        const errorData = JSON.parse(responseText);
        return res.status(response.status).json({
          success: false,
          message: errorData.msg || '카카오페이 결제 준비에 실패했습니다.',
          error: errorData,
        });
      }

      const kakaoPayResponse = JSON.parse(responseText);
      const { tid, next_redirect_pc_url, next_redirect_mobile_url } = kakaoPayResponse;

      // tid 저장 (나중에 승인 시 사용)
      // 간단하게 메모리나 Redis에 저장 가능, 여기서는 DB에 임시 저장
      await pool.execute(
        `INSERT INTO kakao_pay_transactions (order_id, tid, contract_id, amount, status)
         VALUES (?, ?, ?, ?, 'ready')
         ON DUPLICATE KEY UPDATE tid = ?, amount = ?, status = 'ready'`,
        [orderId, tid, contractId, amount, tid, amount]
      );

      res.json({
        success: true,
        data: {
          tid,
          next_redirect_pc_url,
          next_redirect_mobile_url,
          orderId,
        },
      });
    } catch (error: any) {
      console.error('카카오페이 결제 준비 오류:', error);
      res.status(500).json({
        success: false,
        message: error.message || '카카오페이 결제 준비 중 오류가 발생했습니다.',
      });
    }
  } catch (error) {
    console.error('카카오페이 결제 준비 실패:', error);
    res.status(500).json({
      success: false,
      message: '카카오페이 결제 준비에 실패했습니다.',
    });
  }
});

// 카카오페이 결제 승인 콜백
router.get('/api/travel/kakao-pay-callback', async (req: Request, res: Response) => {
  try {
    const { pg_token, partner_order_id } = req.query;

    console.log('카카오페이 콜백:', { pg_token, partner_order_id });

    if (!pg_token || !partner_order_id) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 정보가 올바르지 않습니다.')}`;
      return res.redirect(failUrl);
    }

    // tid 조회
    const [transactionRows] = await pool.execute<any[]>(
      'SELECT * FROM kakao_pay_transactions WHERE order_id = ? AND status = "ready"',
      [partner_order_id]
    );

    if (transactionRows.length === 0) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 정보를 찾을 수 없습니다.')}`;
      return res.redirect(failUrl);
    }

    const transaction = transactionRows[0];
    const { tid, contract_id, amount } = transaction;

    // 카카오페이 승인 API 호출 (신 카카오페이 API)
    const kakaoPayClientId = process.env.KAKAO_PAY_CLIENT_ID;
    const kakaoPayClientSecret = process.env.KAKAO_PAY_CLIENT_SECRET;
    const kakaoPayEnv = process.env.KAKAO_PAY_ENV || 'dev';
    const kakaoPaySecretKey = kakaoPayEnv === 'production' 
      ? process.env.KAKAO_PAY_SECRET_KEY 
      : process.env.KAKAO_PAY_SECRET_KEY_DEV;
    const kakaoPayCid = process.env.KAKAO_PAY_CID || 'CTL803FNNQ';

    if (!kakaoPayClientId || !kakaoPayClientSecret || !kakaoPaySecretKey) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('카카오페이 설정이 완료되지 않았습니다.')}`;
      return res.redirect(failUrl);
    }

    try {
      const approveUrl = 'https://open-api.kakaopay.com/online/v1/payment/approve';
      
      // JSON 형식으로 요청 데이터 준비 (공식 문서 기준)
      const requestBody = {
        cid: kakaoPayCid,
        tid: tid,
        partner_order_id: partner_order_id as string,
        partner_user_id: String(contract_id),
        pg_token: pg_token as string,
      };

      console.log('카카오페이 승인 요청:', {
        cid: kakaoPayCid,
        tid,
        partner_order_id,
      });

      const response = await fetch(approveUrl, {
        method: 'POST',
        headers: {
          'Authorization': `SECRET_KEY ${kakaoPaySecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      console.log('카카오페이 승인 응답:', responseText);

      if (!response.ok) {
        const errorData = JSON.parse(responseText);
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(errorData.msg || '결제 승인에 실패했습니다.')}`;
        return res.redirect(failUrl);
      }

      const approveResponse = JSON.parse(responseText);

      // 결제 금액 검증
      const paidAmount = approveResponse.amount?.total || 0;
      if (Math.abs(paidAmount - amount) > 1) {
        console.error('결제 금액 불일치:', { expected: amount, actual: paidAmount });
        // TODO: 결제 취소 처리
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 금액이 일치하지 않습니다.')}`;
        return res.redirect(failUrl);
      }

      // 트랜잭션 시작
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        // 계약 정보 조회
        const [contractRows] = await connection.execute<any[]>(
          'SELECT * FROM travel_contracts WHERE id = ?',
          [contract_id]
        );

        if (contractRows.length === 0) {
          await connection.rollback();
          const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
          const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('계약을 찾을 수 없습니다.')}`;
          return res.redirect(failUrl);
        }

        const contract = contractRows[0];

        // 계약 상태 업데이트
        await connection.execute(
          `UPDATE travel_contracts 
           SET payment_status = '결제완료', payment_method = '카카오페이', status = '가입완료', updated_at = NOW()
           WHERE id = ?`,
          [contract_id]
        );

        // 영수증 URL: 승인 응답에 있으면 추출, 없으면 tid로 URL 생성
        let receiptUrl = extractReceiptUrl(approveResponse);
        if (!receiptUrl) {
          receiptUrl = buildKakaoPayReceiptUrl(approveResponse);
        }
        // 대기 건의 무사고캐시 사용액을 완료 건에 반영
        const [kakaoPendingRows] = await connection.execute<any[]>(
          `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? AND status = '대기' ORDER BY id ASC LIMIT 1`,
          [contract_id]
        );
        const kakaoUseAccidentFreeCash = kakaoPendingRows[0]?.use_accident_free_cash != null
          ? Math.max(0, Number(kakaoPendingRows[0].use_accident_free_cash))
          : 0;
        // 결제 정보 저장
        await connection.execute(
          `INSERT INTO payments (
            contract_id, payment_method, amount, status, payment_date,
            payment_number, pg_transaction_id, pg_response, receipt_url, use_accident_free_cash
          ) VALUES (?, '카카오페이', ?, '완료', NOW(), ?, ?, ?, ?, ?)`,
          [
            contract_id,
            paidAmount,
            partner_order_id,
            tid,
            JSON.stringify(approveResponse),
            receiptUrl,
            kakaoUseAccidentFreeCash,
          ]
        );

        // 카카오페이 트랜잭션 상태 업데이트
        await connection.execute(
          `UPDATE kakao_pay_transactions SET status = 'approved', pg_response = ? WHERE order_id = ?`,
          [JSON.stringify(approveResponse), partner_order_id]
        );

        // 마일리지 지급 (결제 금액의 3%, 최대 30,000P)
        const mileageAmount = Math.min(Math.floor(paidAmount * 0.03), 30000);
        
        if (mileageAmount > 0 && contract.member_id) {
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

        // 무사고캐시 사용분 차감 (계약 등록 시 저장한 use_accident_free_cash)
        const [pendingPaymentRows] = await connection.execute<any[]>(
          `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? AND status = '대기' ORDER BY id ASC LIMIT 1`,
          [contract_id]
        );
        const useAccidentFreeCash = pendingPaymentRows[0]?.use_accident_free_cash != null
          ? Math.max(0, Number(pendingPaymentRows[0].use_accident_free_cash))
          : 0;
        if (useAccidentFreeCash > 0 && contract.member_id) {
          const [memberRows] = await connection.execute<any[]>(
            `SELECT accident_free_cash FROM members WHERE id = ?`,
            [contract.member_id]
          );
          const currentCash = Number(memberRows[0]?.accident_free_cash ?? 0);
          const newCashBalance = Math.max(0, currentCash - useAccidentFreeCash);
          await connection.execute(
            `UPDATE members SET accident_free_cash = ?, updated_at = NOW() WHERE id = ?`,
            [newCashBalance, contract.member_id]
          );
          // reason_detail에 travel_contracts.id(계약 ID) 값 저장
          await connection.execute(
            `INSERT INTO accident_free_cash_history (member_id, type, amount, balance, reason, reason_detail, contract_id, created_at)
             VALUES (?, '사용', ?, ?, '보험료 결제 시 무사고캐시 사용', ?, ?, NOW())`,
            [contract.member_id, useAccidentFreeCash, newCashBalance, `계약번호: ${contract_id}`, contract_id]
          );
        }

        try {
          await sendContractCompleteAlimTalk(contract_id, '카카오페이');
        } catch (alimtalkError) {
          console.error('가입완료 알림톡 발송 실패:', alimtalkError);
        }

        await connection.commit();
        connection.release();

        // 성공 페이지로 리다이렉트
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const successUrl = `${frontendUrl}/payment/success?contractId=${contract_id}&customerName=${encodeURIComponent(contract.customer_name || '')}&contractNumber=${partner_order_id}`;
        res.redirect(successUrl);
      } catch (dbError) {
        await connection.rollback();
        connection.release();
        throw dbError;
      }
    } catch (error: any) {
      console.error('카카오페이 승인 처리 실패:', error);
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent(error.message || '결제 처리 중 오류가 발생했습니다.')}`;
      return res.redirect(failUrl);
    }
  } catch (error) {
    console.error('카카오페이 콜백 처리 실패:', error);
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const failUrl = `${frontendUrl}/payment/fail?error=${encodeURIComponent('결제 처리 중 오류가 발생했습니다.')}`;
    return res.redirect(failUrl);
  }
});

// 단체/개인 공통: 조건에 맞는 플랜 목록 조회
router.post('/api/travel/available-plans', async (req: Request, res: Response) => {
  try {
    const {
      insurance_type,
      age,
      gender,
      plan_variant = 'B',
      has_medical_expense = 1,
      include_foreign_currency = false,
      birth_date,
      departure_date, // 기준일(만 나이 계산용). 없으면 오늘
    } = req.body;

    if (!insurance_type || age === undefined || !gender) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    console.log('available-plans 요청:', {
      insurance_type,
      age,
      gender,
      birth_date: birth_date ?? '(없음)',
      departure_date: departure_date ?? '(없음)',
    });

    const hasMedicalExpenseValue = has_medical_expense ? 1 : 0;
    const params = [insurance_type, age, gender, hasMedicalExpenseValue, plan_variant];

    const [premiumRows] = await pool.execute<any[]>(
      `SELECT DISTINCT plan_type
       FROM premium_rates
       WHERE insurance_type = ?
         AND age = ?
         AND gender = ?
         AND has_medical_expense = ?
         AND plan_variant = ?
         AND is_active = 1`,
      params
    );

    let planTypes = (premiumRows || []).map(row => row.plan_type);

    if (include_foreign_currency) {
      const [foreignRows] = await pool.execute<any[]>(
        `SELECT DISTINCT plan_type
         FROM foreign_currency_premium_rates
         WHERE insurance_type = ?
           AND age = ?
           AND gender = ?
           AND has_medical_expense = ?
           AND plan_variant = ?
           AND is_active = 1`,
        params
      );
      const foreignPlanTypes = (foreignRows || []).map(row => row.plan_type);
      planTypes = planTypes.concat(foreignPlanTypes);
    }

    let uniquePlanTypes = Array.from(new Set(planTypes));

    console.log('available-plans DB 조회 결과:', { age, plan_types: uniquePlanTypes });

    // 보험나이 15세 + birth_date 있으면 만 나이로 성인/어린이 플랜만 노출 (기준일: KST 당일)
    if (age === 15 && birth_date) {
      const refDate = getKstCalendarDateNow();
      const parsedBirth = parseBirthDate(birth_date);
      if (parsedBirth) {
        const manNai = getFullYearsAge(parsedBirth, refDate);
        const beforeFilter = [...uniquePlanTypes];
        if (manNai >= 15) {
          uniquePlanTypes = uniquePlanTypes.filter(p => ADULT_PLAN_TYPES.includes(p));
          if (uniquePlanTypes.length === 0) uniquePlanTypes = ['실속플랜'];
        } else {
          uniquePlanTypes = uniquePlanTypes.filter(p => p === '어린이플랜' || p.startsWith('어린이'));
        }
        console.log('보험나이 15세 만나이 보정(available-plans):', {
          birth_date,
          reference_date: refDate.toISOString(),
          manNai,
          구분: manNai >= 15 ? '성인' : '어린이',
          beforeFilter,
          afterFilter: uniquePlanTypes,
        });
      } else {
        console.log('보험나이 15세이나 birth_date 파싱 실패 → 만 나이 보정 미적용');
      }
    } else if (age === 15) {
        console.log('보험나이 15세이나 birth_date 없음 → 만 나이 보정 미적용, DB 결과 그대로 반환');
    }

    return res.json({
      success: true,
      plan_types: uniquePlanTypes,
    });
  } catch (error) {
    console.error('플랜 목록 조회 실패:', error);
    return res.status(500).json({
      success: false,
      message: '플랜 목록 조회 중 오류가 발생했습니다.',
    });
  }
});

// 플랜 보장내용 조회
router.post('/api/travel/plan-coverages', async (req: Request, res: Response) => {
  try {
    const { insurance_type, plan_types, currency_plan, has_medical_expense, plan_variant } = req.body;

    if (!insurance_type || !Array.isArray(plan_types) || plan_types.length === 0) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    const normalizeWorkingHolidayPlan = (planType: string) => {
      if (planType === '워킹홀리데이실속플랜') return '실속플랜';
      if (planType === '워킹홀리데이표준플랜') return '표준플랜';
      if (planType === '워킹홀리데이(유로화플랜)') return '고급플랜';
      return planType;
    };

    const medicalExpenseType =
      has_medical_expense === undefined || has_medical_expense ? '실손' : '비실손';

    // 프론트에서 plan_variant를 보내지 않으면 null → DB의 plan_variant IS NULL 행 매칭
    const planVariant =
      plan_variant !== undefined && plan_variant !== null ? plan_variant : null;

    const resolveCurrencyPlan = (planType: string) => {
      if (planType === '워킹홀리데이(유로화플랜)') {
        return '외화';
      }
      if (insurance_type === '워킹홀리데이') {
        return '원화';
      }
      if (insurance_type === '유학/어학연수' || insurance_type === '해외출장/주재원/교환교수') {
        return currency_plan || '원화';
      }
      return null;
    };

    const fetchPlanCoveragesFromDb = async (
      insuranceType: string,
      planType: string,
      planCurrency: string | null,
      variant: string | null
    ) => {
      const [rows] = await pool.execute<any[]>(
        `SELECT label_text, amount_text
           FROM plan_coverages
          WHERE insurance_type = ?
            AND plan_type = ?
            AND medical_expense_type = ?
            AND (currency_plan = ? OR (currency_plan IS NULL AND ? IS NULL))
            AND (plan_variant = ? OR (plan_variant IS NULL AND ? IS NULL))
            AND is_active = 1
            AND (effective_from_date IS NULL OR effective_from_date <= CURRENT_DATE())
            AND (effective_to_date IS NULL OR effective_to_date >= CURRENT_DATE())
          ORDER BY display_order ASC, id ASC`,
        [insuranceType, planType, medicalExpenseType, planCurrency, planCurrency, variant, variant]
      );
      return rows.map((row) => ({
        label: row.label_text,
        amount: row.amount_text,
      }));
    };

    const coverages: Record<string, { label: string; amount: string }[]> = {};
    for (const planType of plan_types) {
      const basePlanType = normalizeWorkingHolidayPlan(planType);
      const planCurrency = resolveCurrencyPlan(planType);
      const dbCoverages = await fetchPlanCoveragesFromDb(
        insurance_type,
        basePlanType,
        planCurrency,
        planVariant
      );

      if (dbCoverages.length === 0) {
        return res.status(404).json({
          success: false,
          message: `보장내용이 DB에 없습니다. (insurance_type=${insurance_type}, plan_type=${basePlanType}, currency_plan=${planCurrency ?? 'NULL'}, plan_variant=${planVariant ?? 'NULL'})`,
        });
      }

      coverages[planType] = dbCoverages;
    }

    return res.json({ success: true, coverages });
  } catch (error) {
    console.error('플랜 보장내용 조회 실패:', error);
    return res.status(500).json({
      success: false,
      message: '플랜 보장내용 조회 중 오류가 발생했습니다.',
    });
  }
});

// 보장 상세보기 데이터 조회
router.post('/api/travel/coverage-details', async (req: Request, res: Response) => {
  try {
    const { insurance_type, plan_type, is_medical_expense, currency_plan, plan_variant } = req.body;

    if (!insurance_type || !plan_type) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    const needsMedicalExpenseDistinction = insurance_type === '국내여행보험' || insurance_type === '해외여행보험';
    const needsCurrencyPlanDistinction =
      insurance_type === '유학/어학연수' || insurance_type === '해외출장/주재원/교환교수';

    const medicalExpenseType = needsMedicalExpenseDistinction
      ? (is_medical_expense === false ? '비실손' : '실손')
      : null;

    const currencyPlanType = needsCurrencyPlanDistinction
      ? (currency_plan || '원화플랜')
      : null;

    // 프론트에서 plan_variant를 보내지 않으면 null → DB의 plan_variant IS NULL 행 매칭
    const planVariant =
      plan_variant !== undefined && plan_variant !== null ? plan_variant : null;

    const [sectionRows] = await pool.execute<any[]>(
      `SELECT id, section_title, help_url
         FROM coverage_detail_sections
        WHERE insurance_type = ?
          AND plan_type = ?
          AND (plan_variant = ? OR (plan_variant IS NULL AND ? IS NULL))
          AND (medical_expense_type = ? OR (medical_expense_type IS NULL AND ? IS NULL))
          AND (currency_plan = ? OR (currency_plan IS NULL AND ? IS NULL))
          AND is_active = 1
          AND (effective_from_date IS NULL OR effective_from_date <= CURRENT_DATE())
          AND (effective_to_date IS NULL OR effective_to_date >= CURRENT_DATE())
        ORDER BY display_order ASC, id ASC`,
      [
        insurance_type,
        plan_type,
        planVariant,
        planVariant,
        medicalExpenseType,
        medicalExpenseType,
        currencyPlanType,
        currencyPlanType,
      ]
    );

    if (sectionRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '보장 상세 데이터가 없습니다.',
      });
    }

    const sectionIds = sectionRows.map((row) => row.id);
    const placeholders = sectionIds.map(() => '?').join(', ');
    const [itemRows] = await pool.execute<any[]>(
      `SELECT section_id, item_label, amount_text, note
         FROM coverage_detail_items
        WHERE section_id IN (${placeholders})
          AND is_active = 1
        ORDER BY display_order ASC, id ASC`,
      sectionIds
    );

    const itemsBySection = new Map<number, { label: string; amount: string; note?: string }[]>();
    itemRows.forEach((row) => {
      const items = itemsBySection.get(row.section_id) || [];
      items.push({
        label: row.item_label,
        amount: row.amount_text,
        note: row.note || undefined,
      });
      itemsBySection.set(row.section_id, items);
    });

    const sections = sectionRows.map((row) => ({
      title: row.section_title,
      helpUrl: row.help_url,
      items: itemsBySection.get(row.id) || [],
    }));

    return res.json({
      success: true,
      planName: plan_type,
      sections,
    });
  } catch (error) {
    console.error('보장 상세 조회 실패:', error);
    return res.status(500).json({
      success: false,
      message: '보장 상세 조회 중 오류가 발생했습니다.',
    });
  }
});

// 단체여행보험 보험료 계산 (법인/단체용)
router.post('/api/travel/calculate-group-premium', async (req: Request, res: Response) => {
  try {
    const { 
      insurance_type,  // '국내여행보험', '해외여행보험', '해외장기체류보험'
      insured_persons,  // 피보험자 배열 [{ age, gender, plan_type, has_medical_expense }]
      departure_date,
      arrival_date
    } = req.body;

    console.log('=== 단체여행보험 보험료 계산 시작 ===');
    console.log('입력 파라미터:', {
      insurance_type,
      insured_persons_count: insured_persons?.length,
      departure_date,
      arrival_date
    });

    // 필수 파라미터 검증
    if (!insurance_type || !insured_persons || !Array.isArray(insured_persons) || insured_persons.length === 0) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    if (!departure_date || !arrival_date) {
      return res.status(400).json({
        success: false,
        message: '출발일시와 도착일시가 필요합니다.',
      });
    }

    // 보험기간 계산 (일수): 입력값을 KST로 해석, 부분일은 1일로 올림
    const departure = parseDateTimeAsKst(departure_date) ?? new Date(departure_date);
    const arrival = parseDateTimeAsKst(arrival_date) ?? new Date(arrival_date);
    if (arrival.getTime() <= departure.getTime()) {
      return res.status(400).json({
        success: false,
        message: '도착일시는 출발일시보다 이후여야 합니다.',
      });
    }
    const diffTime = arrival.getTime() - departure.getTime();
    const periodDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const rateLookupPeriodDays = resolveOverseasShortTripRateLookupPeriodDays(
      insurance_type,
      departure,
      arrival,
      periodDays
    );
    const rateLookup = getRateLookupCriteria(insurance_type, departure, arrival, rateLookupPeriodDays);

    // 1차: 각 피보험자별 만 나이·유효 플랜 계산 (보험나이 15세일 때 성인/어린이 구분, 기준일 KST 당일)
    type EffectivePlan = { effectivePlanType: string; manNai: number | null };
    const refTodayKst = getKstCalendarDateNow();
    const effectivePlans: EffectivePlan[] = insured_persons.map((insured: { age?: number; plan_type?: string; birth_date?: string }) => {
      const age = insured.age;
      const plan_type = insured.plan_type || '';
      const birthDate = parseBirthDate(insured.birth_date);
      let effectivePlanType = plan_type;
      let manNai: number | null = null;
      if (age === 15 && birthDate) {
        manNai = getFullYearsAge(birthDate, refTodayKst);
        if (manNai >= 15) {
          effectivePlanType = ADULT_PLAN_TYPES.includes(plan_type) ? plan_type : '실속플랜';
        } else {
          effectivePlanType = '어린이플랜';
        }
      } else if ((age ?? 0) >= 71) {
        effectivePlanType =
          insurance_type === '국내여행보험'
            ? resolveDomesticSeniorPlanTypeForGroup(plan_type)
            : plan_type === '어르신플랜2'
              ? '어르신플랜2'
              : '어르신플랜1';
      }
      return { effectivePlanType, manNai };
    });
    // 다른 성인 플랜: 성인(만15+)이 선택한 실속/표준/고보장 중 첫 번째
    const otherAdultPlan: string | null = effectivePlans.find((_, i) => {
      const ins = insured_persons[i] as { age?: number; birth_date?: string };
      const { effectivePlanType, manNai } = effectivePlans[i];
      const insAge = ins.age ?? 0;
      const isAdult = insAge > 15 || (insAge === 15 && manNai !== null && manNai >= 15);
      return isAdult && ADULT_PLAN_TYPES.includes(effectivePlanType);
    })?.effectivePlanType ?? null;

    // 각 피보험자별 보험료 계산
    const results = [];
    let totalPremium = 0;

    for (let i = 0; i < insured_persons.length; i++) {
      const insured = insured_persons[i];
      const { age, gender, plan_type, has_medical_expense, plan_variant } = insured;
      const planVariant = plan_variant || 'B';

      // 필수 필드 검증
      if (age === undefined || !gender || !plan_type) {
        return res.status(400).json({
          success: false,
          message: `피보험자 ${i + 1}의 정보가 불완전합니다.`,
        });
      }

      const ep = effectivePlans[i];
      let finalPlanType = ep.effectivePlanType;
      const manNaiVal = ep.manNai;
      // 보험나이 15세·만 15세 이상인데 디폴트(실속)로 둔 경우, 다른 성인 플랜이 있으면 따름
      if (age === 15 && manNaiVal != null && manNaiVal >= 15 && finalPlanType === '실속플랜') {
        finalPlanType = otherAdultPlan ?? finalPlanType;
      }

      console.log(`피보험자 ${i + 1} 보험료 계산:`, { age, gender, plan_type: finalPlanType, has_medical_expense });
      const hasMedicalExpenseValue = has_medical_expense ? 1 : 0;

      console.log('보험료 조회 조건:', {
        insurance_type,
        finalPlanType,
        age,
        gender,
        has_medical_expense,
        hasMedicalExpenseValue
      });

      // 보험료 조회
      const [premiumRows] = await pool.execute<any[]>(
        `SELECT annual_premium 
         FROM premium_rates 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND age = ? 
           AND gender = ? 
           AND has_medical_expense = ? 
           AND plan_variant = ?
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        [insurance_type, finalPlanType, age, gender, hasMedicalExpenseValue, planVariant]
      );

      console.log('조회된 보험료 데이터:', premiumRows);

      if (!premiumRows || premiumRows.length === 0) {
        console.log(`피보험자 ${i + 1} 보험료 정보를 찾을 수 없음`);
        
        // 조건을 완화하여 어떤 데이터가 있는지 확인
        const [debugRows] = await pool.execute<any[]>(
          `SELECT insurance_type, plan_type, age, gender, has_medical_expense, annual_premium 
           FROM premium_rates 
           WHERE insurance_type = ? 
             AND is_active = 1
           LIMIT 5`,
          [insurance_type]
        );
        console.log('DB에 존재하는 보험료 샘플 데이터:', debugRows);
        
        return res.status(404).json({
          success: false,
          message: `피보험자 ${i + 1}의 보험료 정보를 찾을 수 없습니다. (보험종류: ${insurance_type}, 플랜: ${finalPlanType}, 나이: ${age}, 성별: ${gender}, 실손: ${hasMedicalExpenseValue})`,
        });
      }

      const annualPremium = parseFloat(premiumRows[0].annual_premium);

      // 단기요율 조회
      let shortTermRate = 100.0;
      
      if (periodDays < 365) {
        let [rateRows] = await pool.execute<any[]>(
          `SELECT rate_percentage 
           FROM short_term_rates 
           WHERE insurance_type = ? 
             AND period_unit = ?
             AND period_value >= ? 
             AND is_active = 1
           ORDER BY period_value ASC 
           LIMIT 1`,
          [insurance_type, rateLookup.unit, rateLookup.value]
        );

        if ((!rateRows || rateRows.length === 0) && rateLookup.unit === 'months') {
          [rateRows] = await pool.execute<any[]>(
            `SELECT rate_percentage 
             FROM short_term_rates 
             WHERE insurance_type = ? 
               AND period_unit = 'days'
               AND period_value >= ? 
               AND is_active = 1
             ORDER BY period_value ASC 
             LIMIT 1`,
            [insurance_type, rateLookup.value * 30]
          );
        }

        if (rateRows && rateRows.length > 0) {
          shortTermRate = parseFloat(rateRows[0].rate_percentage);
        }
      }

      // 플랜별 추가 금액 조회 (해외여행보험만 적용)
      let additionalFee = 0;
      if (insurance_type === '해외여행보험') {
      const [additionalFeeRows] = await pool.execute<any[]>(
        `SELECT additional_fee 
         FROM plan_additional_fees 
         WHERE insurance_type = ? 
           AND plan_type = ? 
           AND plan_variant = ?
           AND is_active = 1
         ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
         LIMIT 1`,
        [insurance_type, finalPlanType, planVariant]
      );

        if (additionalFeeRows && additionalFeeRows.length > 0) {
          additionalFee = parseFloat(additionalFeeRows[0].additional_fee);
        }
      }

      // 최종 보험료 계산: (연간보험료 × (단기요율 / 100)) + 플랜별 추가 금액
      // 단수처리: 최종 보험료 십원단위 절사
      const calculatedPremium = annualPremium * (shortTermRate / 100);
      const finalPremium = Math.floor((calculatedPremium + additionalFee) / 10) * 10;

      totalPremium += finalPremium;

      results.push({
        index: i + 1,
        age,
        gender,
        plan_type: finalPlanType,
        has_medical_expense,
        premium: finalPremium,
        annual_premium: annualPremium,
        short_term_rate: shortTermRate,
      });

      console.log(`피보험자 ${i + 1} 보험료:`, {
        annualPremium,
        shortTermRate,
        additionalFee,
        finalPremium
      });
    }

    console.log('=== 단체여행보험 보험료 계산 완료 ===');
    console.log('총 보험료:', totalPremium);

    res.json({
      success: true,
      total_premium: totalPremium,
      period_days: periodDays,
      insured_persons: results,
    });
  } catch (error) {
    console.error('Calculate group premium error:', error);
    res.status(500).json({
      success: false,
      message: '보험료 계산 중 오류가 발생했습니다.',
    });
  }
});

// 기존 가입 이력 불러오기 - 계약 확인 및 인증번호 발송
router.post('/api/travel/group/check-contract', async (req: Request, res: Response) => {
  try {
    const { business_number, company_name, mobile_phone } = req.body;

    if (!business_number || !company_name || !mobile_phone) {
      return res.status(400).json({
        success: false,
        message: '사업자번호, 단체명, 휴대폰번호를 모두 입력해주세요.',
      });
    }

    const cleanBusinessNumber = business_number.replace(/-/g, '');
    const cleanPhone = mobile_phone.replace(/-/g, '');

    // 계약자 정보 확인 (법인 계약만)
    const [contractRows] = await pool.execute<any[]>(
      `SELECT tc.id, tc.contract_number, tc.created_at, ctr.company_name, ctr.business_number, ctr.mobile_phone
       FROM travel_contracts tc
       INNER JOIN contractors ctr ON tc.id = ctr.contract_id
       WHERE ctr.contractor_type = '법인'
         AND REPLACE(ctr.business_number, '-', '') = ?
         AND ctr.company_name = ?
         AND REPLACE(ctr.mobile_phone, '-', '') = ?
       ORDER BY tc.created_at DESC
       LIMIT 1`,
      [cleanBusinessNumber, company_name, cleanPhone]
    );

    if (!contractRows || contractRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '일치하는 가입정보가 없습니다. 입력하신 내용을 다시 확인해주세요.',
      });
    }

    res.json({
      success: true,
      message: '계약 정보가 확인되었습니다.',
    });
  } catch (error) {
    console.error('Check contract error:', error);
    res.status(500).json({
      success: false,
      message: '계약 확인 중 오류가 발생했습니다.',
    });
  }
});

// 기존 가입 이력 불러오기 - 인증번호 발송
router.post('/api/travel/group/send-verification', async (req: Request, res: Response) => {
  try {
    const { sendVerificationSms } = await import('../services/aligoService');
    const { business_number, company_name, mobile_phone } = req.body;

    if (!business_number || !company_name || !mobile_phone) {
      return res.status(400).json({
        success: false,
        message: '사업자번호, 단체명, 휴대폰번호를 모두 입력해주세요.',
      });
    }

    const cleanBusinessNumber = business_number.replace(/-/g, '');
    const cleanPhone = mobile_phone.replace(/-/g, '');

    // 계약 확인
    const [contractRows] = await pool.execute<any[]>(
      `SELECT tc.id, ctr.company_name, ctr.business_number, ctr.mobile_phone
       FROM travel_contracts tc
       INNER JOIN contractors ctr ON tc.id = ctr.contract_id
       WHERE ctr.contractor_type = '법인'
         AND REPLACE(ctr.business_number, '-', '') = ?
         AND ctr.company_name = ?
         AND REPLACE(ctr.mobile_phone, '-', '') = ?
       LIMIT 1`,
      [cleanBusinessNumber, company_name, cleanPhone]
    );

    if (!contractRows || contractRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '일치하는 가입정보가 없습니다.',
      });
    }

    // 인증번호 생성 및 발송
    const { sendVerification } = await import('../services/verificationService');
    const result = await sendVerification(cleanPhone, false);

    if (result.success) {
      res.json({
        success: true,
        message: '인증번호가 발송되었습니다.',
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message || '인증번호 발송에 실패했습니다.',
      });
    }
  } catch (error) {
    console.error('Send verification error:', error);
    res.status(500).json({
      success: false,
      message: '인증번호 발송 중 오류가 발생했습니다.',
    });
  }
});

// 기존 가입 이력 불러오기 - 인증번호 확인
router.post('/api/travel/group/verify-code', async (req: Request, res: Response) => {
  try {
    const { mobile_phone, verification_code } = req.body;

    if (!mobile_phone || !verification_code) {
      return res.status(400).json({
        success: false,
        message: '휴대폰번호와 인증번호를 입력해주세요.',
      });
    }

    const cleanPhone = mobile_phone.replace(/-/g, '');

    // 인증번호 확인
    const { verifyCode } = await import('../services/verificationService');
    const result = await verifyCode(cleanPhone, verification_code);

    if (result.success) {
      res.json({
        success: true,
        message: '인증이 완료되었습니다.',
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message || '인증번호가 일치하지 않습니다.',
      });
    }
  } catch (error) {
    console.error('Verify code error:', error);
    res.status(500).json({
      success: false,
      message: '인증번호 확인 중 오류가 발생했습니다.',
    });
  }
});

// 기존 가입 이력 불러오기 - 계약 목록 조회
router.post('/api/travel/group/contract-list', async (req: Request, res: Response) => {
  try {
    const { business_number, company_name, mobile_phone } = req.body;

    if (!business_number || !company_name || !mobile_phone) {
      return res.status(400).json({
        success: false,
        message: '사업자번호, 단체명, 휴대폰번호를 모두 입력해주세요.',
      });
    }

    const cleanBusinessNumber = business_number.replace(/-/g, '');
    const cleanPhone = mobile_phone.replace(/-/g, '');

    // 계약 목록 조회
    const [contractRows] = await pool.execute<any[]>(
      `SELECT 
        tc.id,
        tc.contract_number,
        tc.insurance_type,
        tc.departure_date,
        tc.arrival_date,
        tc.total_premium,
        tc.created_at,
        (SELECT COUNT(*) FROM companions WHERE contract_id = tc.id) as participant_count
       FROM travel_contracts tc
       INNER JOIN contractors ctr ON tc.id = ctr.contract_id
       WHERE ctr.contractor_type = '법인'
         AND REPLACE(ctr.business_number, '-', '') = ?
         AND ctr.company_name = ?
         AND REPLACE(ctr.mobile_phone, '-', '') = ?
       ORDER BY tc.created_at DESC
       LIMIT 10`,
      [cleanBusinessNumber, company_name, cleanPhone]
    );

    res.json({
      success: true,
      contracts: contractRows || [],
    });
  } catch (error) {
    console.error('Get contract list error:', error);
    res.status(500).json({
      success: false,
      message: '계약 목록 조회 중 오류가 발생했습니다.',
    });
  }
});

// 기존 가입 이력 불러오기 - 선택한 계약의 동반자 정보 조회
router.get('/api/travel/group/contract/:contractId/companions', async (req: Request, res: Response) => {
  try {
    const contractId = parseInt(req.params.contractId, 10);

    if (isNaN(contractId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 계약 ID입니다.',
      });
    }

    // 동반자 정보 조회
    const [companionRows] = await pool.execute<any[]>(
      `SELECT 
        name,
        resident_number,
        gender,
        has_illness_history,
        has_medical_expense,
        plan_type,
        premium,
        sequence_number
       FROM companions
       WHERE contract_id = ?
       ORDER BY sequence_number ASC`,
      [contractId]
    );

    res.json({
      success: true,
      companions: companionRows || [],
    });
  } catch (error) {
    console.error('Get companions error:', error);
    res.status(500).json({
      success: false,
      message: '동반자 정보 조회 중 오류가 발생했습니다.',
    });
  }
});

export default router;

