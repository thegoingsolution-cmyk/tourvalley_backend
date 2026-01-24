import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { generateVerificationCode, sendVerificationSms } from '../services/aligoService';
import path from 'path';
import fs from 'fs';

const router = Router();

// 인증번호 저장을 위한 임시 저장소 (실제로는 Redis나 DB 사용 권장)
interface VerificationData {
  code: string;
  contractId: number;
  phoneNumber: string;
  expiresAt: Date;
}

const verificationStore: Map<string, VerificationData> = new Map();

// 가입/신청 내역 조회
router.get('/api/contracts/list', async (req: Request, res: Response) => {
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
    
    // LIMIT와 OFFSET은 정수로 확실히 변환
    const limitValue = parseInt(String(pageSize), 10);
    const offsetValue = parseInt(String(offset), 10);
    
    // 디버깅 로그 (필요시 주석 해제)
    // console.log('Query params:', { memberId, startDateStr, endDateStr, limitValue, offsetValue });
    
    const [contracts] = await pool.execute<any[]>(
      `SELECT 
        tc.id,
        CONCAT(
          DATE_FORMAT(tc.created_at, '%y%m%d'),
          '-',
          tc.id
        ) as contract_number,
        tc.insurance_type,
        tc.departure_date,
        tc.arrival_date,
        tc.total_premium,
        tc.status,
        tc.created_at,
        tc.travel_region,
        tc.travel_country,
        tc.travel_purpose,
        GROUP_CONCAT(DISTINCT c.plan_type) as plan_types
      FROM travel_contracts tc
      LEFT JOIN companions c ON tc.id = c.contract_id
      WHERE tc.member_id = ? 
        AND tc.created_at >= ? 
        AND tc.created_at <= ?
      GROUP BY tc.id
      ORDER BY tc.created_at DESC
      LIMIT ${limitValue} OFFSET ${offsetValue}`,
      [memberId, startDateStr, endDateStr]
    );

    // 전체 개수 조회
    const [countResult] = await pool.execute<any[]>(
      `SELECT COUNT(DISTINCT id) as total
      FROM travel_contracts
      WHERE member_id = ? 
        AND created_at >= ? 
        AND created_at <= ?`,
      [memberId, startDateStr, endDateStr]
    );

    const totalCount = countResult[0]?.total || 0;
    const totalPages = Math.ceil(totalCount / pageSize);

    // 계약 데이터 포맷팅
    const formattedContracts = contracts.map((contract: any) => ({
      id: contract.id,
      contractNumber: contract.contract_number || '-',
      insuranceType: contract.insurance_type || '-',
      planTypes: contract.plan_types ? contract.plan_types.split(',') : [],
      departureDate: contract.departure_date,
      arrivalDate: contract.arrival_date,
      totalPremium: contract.total_premium || 0,
      status: contract.status || '-',
      createdAt: contract.created_at,
      travelRegion: contract.travel_region || null,
      travelCountry: contract.travel_country || null,
      travelPurpose: contract.travel_purpose || null,
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
    console.error('계약 목록 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '계약 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// 계약 상세 조회
router.get('/api/contracts/detail/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'contract_id가 필요합니다.',
      });
    }

    const contractId = parseInt(id, 10);

    if (isNaN(contractId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 contract_id입니다.',
      });
    }

    // 계약 상세 정보 조회
    const [contracts] = await pool.execute<any[]>(
      `SELECT 
        tc.*,
        CONCAT(
          DATE_FORMAT(tc.created_at, '%y%m%d'),
          '-',
          tc.id
        ) as contract_number,
        m.name as member_name,
        m.birth_date as member_birth_date,
        m.mobile_phone as member_phone,
        m.email as member_email,
        (SELECT COUNT(*) FROM insured_persons ip WHERE ip.contract_id = tc.id) as insured_persons_count,
        ctr.contractor_type,
        ctr.company_name,
        ctr.name as contractor_name
      FROM travel_contracts tc
      LEFT JOIN members m ON tc.member_id = m.id
      LEFT JOIN contractors ctr ON tc.id = ctr.contract_id
      WHERE tc.id = ?`,
      [contractId]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const contract = contracts[0];

    // 결제 정보 조회 (payments 테이블에서)
    let paymentMethod = contract.payment_method || null;
    let paymentStatus = contract.payment_status || '미결제';
    
    // payments 테이블에서 결제 정보 조회 시도
    try {
      const [payments] = await pool.execute<any[]>(
        `SELECT payment_method, status 
         FROM payments 
         WHERE contract_id = ? 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [contractId]
      );
      
      if (payments.length > 0) {
        paymentMethod = payments[0].payment_method || paymentMethod;
        paymentStatus = payments[0].status || paymentStatus;
      }
    } catch (error) {
      console.error('결제 정보 조회 오류:', error);
      // payments 테이블이 없거나 오류가 발생해도 계속 진행
    }

    // 실제 피보험자 수 계산 (insured_persons 테이블에서)
    const actualInsuredCount = contract.insured_persons_count || contract.travel_participants || 1;

    // 데이터 포맷팅
    const formattedContract = {
      id: contract.id,
      contractNumber: contract.contract_number || '-',
      insuranceType: contract.insurance_type || '-',
      departureDate: contract.departure_date,
      arrivalDate: contract.arrival_date,
      totalPremium: contract.total_premium || 0,
      status: contract.status || '-',
      createdAt: contract.created_at,
      memberName: contract.member_name || '-',
      memberBirthDate: contract.member_birth_date || '',
      memberPhone: contract.member_phone || '-',
      memberEmail: contract.member_email || '-',
      travelRegion: contract.travel_region || null,
      travelCountry: contract.travel_country || null,
      travelPurpose: contract.travel_purpose || null,
      travelParticipants: actualInsuredCount, // 실제 피보험자 수
      paymentMethod: paymentMethod || '무통장입금', // 결제방법
      paymentStatus: paymentStatus || '미결제', // 결제여부
      contractorType: contract.contractor_type || '개인', // 계약자 유형
      contractorCompanyName: contract.company_name || null, // 법인명 (법인인 경우)
    };

    res.json({
      success: true,
      contract: formattedContract,
    });
  } catch (error) {
    console.error('계약 상세 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '계약 상세 정보를 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// 계약 피보험자 정보 조회 (premium-detail 페이지용)
router.get('/api/contracts/:id/participants', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'contract_id가 필요합니다.',
      });
    }

    const contractId = parseInt(id, 10);

    if (isNaN(contractId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 contract_id입니다.',
      });
    }

    // 피보험자 정보 조회 (companions 테이블에서 직접 조회 - 모든 피보험자 정보가 여기에 있음)
    const [companionsData] = await pool.execute<any[]>(
      `SELECT 
        c.id,
        c.name,
        c.gender,
        c.resident_number,
        c.sequence_number,
        c.plan_type,
        c.premium,
        c.has_medical_expense
      FROM companions c
      WHERE c.contract_id = ?
      ORDER BY c.sequence_number ASC`,
      [contractId]
    );

    // companions가 없으면 insured_persons에서 조회 (fallback)
    let insuredPersons = companionsData;
    if (companionsData.length === 0) {
      const [insured] = await pool.execute<any[]>(
        `SELECT 
          ip.id,
          ip.name,
          ip.gender,
          ip.resident_number,
          ip.sequence_number,
          NULL as plan_type,
          0 as premium,
          0 as has_medical_expense
        FROM insured_persons ip
        WHERE ip.contract_id = ?
        ORDER BY ip.sequence_number ASC`,
        [contractId]
      );
      insuredPersons = insured;
    }

    // 계약 정보 조회 (총 보험료 등)
    const [contracts] = await pool.execute<any[]>(
      `SELECT total_premium, insurance_type
       FROM travel_contracts
       WHERE id = ?`,
      [contractId]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const contract = contracts[0];

    // 생년월일 포맷팅 함수
    const formatBirthDate = (residentNumber: string | null) => {
      if (!residentNumber) return '';
      const cleaned = residentNumber.replace(/-/g, '');
      if (cleaned.length >= 6) {
        const year = cleaned.substring(0, 2);
        const month = cleaned.substring(2, 4);
        const day = cleaned.substring(4, 6);
        // 1900년대 또는 2000년대 판단 (간단히 앞자리로 판단)
        const fullYear = parseInt(year) < 50 ? `20${year}` : `19${year}`;
        return `${fullYear}.${month}.${day}`;
      }
      return '';
    };

    // 총 보험료를 Number로 변환
    const totalPremium = contract.total_premium ? Number(contract.total_premium) : 0;
    
    // 피보험자 데이터 포맷팅
    const participants = insuredPersons.map((person: any) => {
      // premium을 Number로 명시적으로 변환 (DECIMAL 타입 처리)
      let premium = 0;
      if (person.premium !== null && person.premium !== undefined) {
        premium = Number(person.premium);
        if (isNaN(premium)) premium = 0;
      }
      
      return {
        id: person.id,
        name: person.name || '',
        gender: person.gender || '남자',
        birthDate: formatBirthDate(person.resident_number),
        planType: person.plan_type || '',
        premium: premium,
      };
    });

    // premium이 모두 0이거나 NULL인 경우, total_premium을 피보험자 수로 나눠서 분배
    const hasAnyPremium = participants.some(p => p.premium > 0);
    if (!hasAnyPremium && totalPremium > 0 && participants.length > 0) {
      const premiumPerPerson = Math.floor(totalPremium / participants.length);
      participants.forEach(p => {
        p.premium = premiumPerPerson;
      });
    }

    // has_medical_expense는 첫 번째 피보험자 또는 companions에서 가져오기
    const hasMedicalExpense = insuredPersons.length > 0 
      ? (insuredPersons[0].has_medical_expense !== undefined ? insuredPersons[0].has_medical_expense : true)
      : true;

    res.json({
      success: true,
      participants,
      totalPremium: totalPremium,
      hasMedicalExpense: hasMedicalExpense === 1 || hasMedicalExpense === true,
    });
  } catch (error) {
    console.error('피보험자 정보 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '피보험자 정보를 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// ==================== 가입증서 다운로드 관련 API ====================

/**
 * 입력 정보로 계약 검색 (가장 최근 계약)
 * POST /api/certificate/find-contract
 */
router.post('/api/certificate/find-contract', async (req: Request, res: Response) => {
  try {
    const {
      member_type, // 'I' (개인) 또는 'C' (법인)
      name, // 개인: 이름
      birth_date, // 개인: 생년월일 (YYYYMMDD)
      company_name, // 법인: 회사명
      business_number, // 법인: 사업자번호
      phone_number // 휴대폰 번호
    } = req.body;

    // 필수 파라미터 검증
    if (!member_type || !phone_number) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_PARAMS',
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    // 개인/법인 타입별 검증
    if (member_type === 'I') {
      if (!name || !birth_date) {
        return res.status(400).json({
          success: false,
          code: 'MISSING_PARAMS',
          message: '이름과 생년월일을 입력해주세요.',
        });
      }
    } else if (member_type === 'C') {
      if (!company_name || !business_number) {
        return res.status(400).json({
          success: false,
          code: 'MISSING_PARAMS',
          message: '법인(단체)명과 사업자번호를 입력해주세요.',
        });
      }
    }

    const inputPhone = phone_number.replace(/-/g, '');
    const inputBirthDate = birth_date ? birth_date.replace(/-/g, '') : '';
    const inputBusinessNumber = business_number ? business_number.replace(/-/g, '') : '';

    // 🔍 디버깅: 입력 파라미터
    console.log('============================================');
    console.log('📥 [인증번호 발송] 입력 파라미터:');
    console.log('  - 회원유형:', member_type === 'I' ? '개인' : '법인');
    console.log('  - 이름:', name || 'N/A');
    console.log('  - 생년월일(원본):', birth_date || 'N/A');
    console.log('  - 생년월일(정제):', inputBirthDate || 'N/A');
    console.log('  - 회사명:', company_name || 'N/A');
    console.log('  - 사업자번호(원본):', business_number || 'N/A');
    console.log('  - 사업자번호(정제):', inputBusinessNumber || 'N/A');
    console.log('  - 휴대폰(원본):', phone_number);
    console.log('  - 휴대폰(정제):', inputPhone);
    console.log('============================================');

    // 계약 검색 쿼리
    let query = '';
    let params: any[] = [];

    if (member_type === 'I') {
      // 개인: 회원 + 비회원 모두 검색
      query = `
        SELECT tc.id, tc.contract_number, tc.created_at,
               tc.subscription_certificate_url
        FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE (
          -- 회원 개인
          (tc.member_id IS NOT NULL 
           AND m.name = ? 
           AND REPLACE(m.birth_date, '-', '') = ?
           AND REPLACE(m.mobile_phone, '-', '') = ?)
          OR
          -- 비회원 개인
          (tc.member_id IS NULL 
           AND ct.contractor_type = '개인'
           AND ct.name = ?
           AND REPLACE(ct.mobile_phone, '-', '') = ?
           AND SUBSTRING(REPLACE(ct.resident_number, '-', ''), 1, 8) = ?)
        )
        AND tc.subscription_certificate_url IS NOT NULL
        ORDER BY tc.created_at DESC
        LIMIT 1
      `;
      // resident_number 형식: 198812-11****** → 하이픈 제거 후 앞 8자리 = YYYYMMDD
      params = [name, inputBirthDate, inputPhone, name, inputPhone, inputBirthDate];
    } else {
      // 법인: 회원 + 비회원 모두 검색
      query = `
        SELECT tc.id, tc.contract_number, tc.created_at,
               tc.subscription_certificate_url
        FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN corporate_members cm ON m.id = cm.member_id
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE (
          -- 회원 법인
          (tc.member_id IS NOT NULL
           AND cm.company_name = ?
           AND REPLACE(cm.business_number, '-', '') = ?
           AND REPLACE(m.mobile_phone, '-', '') = ?)
          OR
          -- 비회원 법인
          (tc.member_id IS NULL
           AND ct.contractor_type = '법인'
           AND ct.company_name = ?
           AND REPLACE(ct.business_number, '-', '') = ?
           AND REPLACE(ct.mobile_phone, '-', '') = ?)
        )
        AND tc.subscription_certificate_url IS NOT NULL
        ORDER BY tc.created_at DESC
        LIMIT 1
      `;
      params = [company_name, inputBusinessNumber, inputPhone, company_name, inputBusinessNumber, inputPhone];
    }

    // 🔍 디버깅: 실행할 쿼리 정보
    console.log('============================================');
    console.log('🔎 [SQL 쿼리] 실행 정보:');
    console.log('📄 쿼리:\n', query);
    console.log('📌 파라미터:', params);
    console.log('============================================');

    const [contracts] = await pool.execute<any[]>(query, params);

    // 🔍 디버깅: 쿼리 결과
    console.log('============================================');
    console.log('📊 [SQL 결과] 조회 건수:', contracts.length);
    if (contracts.length > 0) {
      console.log('✅ 찾은 계약 정보:');
      contracts.forEach((contract, idx) => {
        console.log(`  ${idx + 1}. 계약번호: ${contract.contract_number}`);
        console.log(`     계약ID: ${contract.id}`);
        console.log(`     생성일: ${contract.created_at}`);
        console.log(`     증서URL: ${contract.subscription_certificate_url ? '있음' : '없음'}`);
      });
    } else {
      console.log('❌ 일치하는 계약을 찾을 수 없음');
      console.log('💡 확인사항:');
      if (member_type === 'I') {
        console.log('  - 회원 테이블: name, birth_date, mobile_phone 일치 여부');
        console.log('  - 비회원 테이블: name, mobile_phone, resident_number 앞 8자리 일치 여부');
      } else {
        console.log('  - 회원 테이블: company_name, business_number, mobile_phone 일치 여부');
        console.log('  - 비회원 테이블: company_name, business_number, mobile_phone 일치 여부');
      }
      console.log('  - subscription_certificate_url이 NULL인지 확인');
    }
    console.log('============================================');

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'CONTRACT_NOT_FOUND',
        message: '입력하신 정보와 일치하는 계약을 찾을 수 없습니다.\n고객센터(1599-2541)로 문의해 주세요.',
      });
    }

    const contract = contracts[0];

    res.json({
      success: true,
      contract_number: contract.contract_number,
      contract_id: contract.id,
    });
  } catch (error) {
    console.error('계약 검색 오류:', error);
    res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: '계약 검색 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 가입증서 다운로드용 인증번호 발송
 * POST /api/certificate/send-code
 */
router.post('/api/certificate/send-code', async (req: Request, res: Response) => {
  try {
    const { 
      contract_id,
      member_type, // 'I' (개인) 또는 'C' (법인)
      name, // 개인: 이름
      birth_date, // 개인: 생년월일 (YYYYMMDD)
      company_name, // 법인: 회사명
      business_number, // 법인: 사업자번호 (10자리)
      phone_number // 휴대폰 번호
    } = req.body;

    // 필수 파라미터 검증
    if (!contract_id || !member_type || !phone_number) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_PARAMS',
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    // 개인/법인 타입별 검증
    if (member_type === 'I') {
      if (!name || !birth_date) {
        return res.status(400).json({
          success: false,
          code: 'MISSING_PARAMS',
          message: '이름과 생년월일을 입력해주세요.',
        });
      }
    } else if (member_type === 'C') {
      if (!company_name || !business_number) {
        return res.status(400).json({
          success: false,
          code: 'MISSING_PARAMS',
          message: '법인(단체)명과 사업자번호를 입력해주세요.',
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        code: 'INVALID_TYPE',
        message: '유효하지 않은 회원 타입입니다.',
      });
    }

    // 계약 조회 및 정보 확인 (회원 + 비회원 모두 지원)
    const [contracts] = await pool.execute<any[]>(
      `SELECT tc.*, 
              -- 회원 정보
              m.name as member_name, 
              m.birth_date as member_birth,
              m.mobile_phone as member_phone,
              cm.company_name as member_company_name,
              cm.business_number as member_business_number,
              -- 비회원(계약자) 정보
              ct.contractor_type,
              ct.name as contractor_name,
              ct.resident_number as contractor_resident_number,
              ct.mobile_phone as contractor_phone,
              ct.company_name as contractor_company_name,
              ct.business_number as contractor_business_number
       FROM travel_contracts tc
       LEFT JOIN members m ON tc.member_id = m.id
       LEFT JOIN corporate_members cm ON m.id = cm.member_id
       LEFT JOIN contractors ct ON tc.id = ct.contract_id
       WHERE tc.contract_number = ?`,
      [contract_id]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'CONTRACT_NOT_FOUND',
        message: '입력하신 내용과 일치하는 계약정보가 존재하지 않습니다.',
      });
    }

    const contract = contracts[0];

    // 가입증서 파일 존재 확인
    if (!contract.subscription_certificate_url) {
      return res.status(404).json({
        success: false,
        code: 'FILE_NOT_FOUND',
        message: '가입증서 파일이 없습니다.\n고객센터(1599-2541)에 문의바랍니다.',
      });
    }

    // 회원/비회원 구분하여 정보 확인
    const isMember = !!contract.member_id;
    
    // 휴대폰 번호 확인 (공통)
    const inputPhone = phone_number.replace(/-/g, '');
    let contractPhone = '';
    
    if (isMember) {
      // 회원: members 테이블의 휴대폰
      contractPhone = contract.member_phone ? contract.member_phone.replace(/-/g, '') : '';
    } else {
      // 비회원: contractors 테이블의 휴대폰
      contractPhone = contract.contractor_phone ? contract.contractor_phone.replace(/-/g, '') : '';
    }
    
    if (contractPhone !== inputPhone) {
      return res.status(400).json({
        success: false,
        code: 'PHONE_MISMATCH',
        message: '입력하신 휴대폰 번호가 계약정보와 일치하지 않습니다.\n고객센터(1599-2541)로 문의해 주세요.',
      });
    }

    // 개인 정보 일치 여부 확인
    if (member_type === 'I') {
      // 개인: 이름과 생년월일 확인
      let contractName = '';
      let contractBirthDate = '';
      
      if (isMember) {
        // 회원: members 테이블
        contractName = contract.member_name || '';
        contractBirthDate = contract.member_birth ? contract.member_birth.replace(/-/g, '') : '';
      } else {
        // 비회원: contractors 테이블
        contractName = contract.contractor_name || '';
        // resident_number 형식: 19881212-1****** (YYYYMMDD-G)
        if (contract.contractor_resident_number) {
          const residentNum = contract.contractor_resident_number.replace(/-/g, '');
          
          // 🔍 디버깅
          console.log('============================================');
          console.log('📋 [비회원 생년월일 추출]');
          console.log('  - resident_number(원본):', contract.contractor_resident_number);
          console.log('  - resident_number(정제):', residentNum);
          
          // resident_number 앞 8자리가 YYYYMMDD
          if (residentNum.length >= 8) {
            contractBirthDate = residentNum.substring(0, 8); // YYYYMMDD
            console.log('  - 추출된 생년월일:', contractBirthDate);
          } else {
            console.log('  - ⚠️ resident_number 길이 부족:', residentNum.length);
            contractBirthDate = '';
          }
          console.log('============================================');
        }
      }
      
      const inputBirthDate = birth_date.replace(/-/g, ''); // YYYYMMDD
      
      // 🔍 디버깅: 검증 전 정보
      console.log('============================================');
      console.log('🔐 [개인 정보 검증]');
      console.log('  - 회원 여부:', isMember ? '회원' : '비회원');
      console.log('  - 계약 이름:', contractName);
      console.log('  - 입력 이름:', name);
      console.log('  - 이름 일치:', contractName === name ? '✅' : '❌');
      console.log('  - 계약 생년월일:', contractBirthDate);
      console.log('  - 입력 생년월일:', inputBirthDate);
      console.log('  - 생년월일 일치:', contractBirthDate === inputBirthDate ? '✅' : '❌');
      console.log('============================================');
      
      if (contractName !== name || contractBirthDate !== inputBirthDate) {
        console.log('❌ [검증 실패] 이름 또는 생년월일 불일치');
        return res.status(400).json({
          success: false,
          code: 'INFO_MISMATCH',
          message: '입력하신 내용과 일치하는 계약정보가 존재하지 않습니다.\n고객센터(1599-2541)로 문의해 주세요.',
        });
      }
      
      console.log('✅ [검증 성공] 개인 정보 일치');
    } else if (member_type === 'C') {
      // 법인: 회사명과 사업자번호 확인
      let contractCompanyName = '';
      let contractBusinessNumber = '';
      
      if (isMember) {
        // 회원: corporate_members 테이블
        contractCompanyName = contract.member_company_name || '';
        contractBusinessNumber = contract.member_business_number ? contract.member_business_number.replace(/-/g, '') : '';
      } else {
        // 비회원: contractors 테이블
        contractCompanyName = contract.contractor_company_name || '';
        contractBusinessNumber = contract.contractor_business_number ? contract.contractor_business_number.replace(/-/g, '') : '';
      }
      
      const inputBusinessNumber = business_number.replace(/-/g, ''); // 하이픈 제거
      
      if (contractCompanyName !== company_name || 
          contractBusinessNumber !== inputBusinessNumber) {
        return res.status(400).json({
          success: false,
          code: 'INFO_MISMATCH',
          message: '입력하신 내용과 일치하는 계약정보가 존재하지 않습니다.\n고객센터(1599-2541)로 문의해 주세요.',
        });
      }
    }

    // 인증번호 생성 및 발송
    const verificationCode = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000); // 3분 후 만료

    // 인증 데이터 저장 (phone_number를 키로 사용)
    const key = phone_number.replace(/-/g, '');
    verificationStore.set(key, {
      code: verificationCode,
      contractId: contract.id,
      phoneNumber: key,
      expiresAt,
    });

    // SMS 발송
    try {
      const result = await sendVerificationSms(key, verificationCode, false);
      const resultCode = String(result.result_code);
      
      if (resultCode !== '1') {
        throw new Error(result.message || 'SMS 발송 실패');
      }

      res.json({
        success: true,
        message: '인증번호가 발송되었습니다.',
      });
    } catch (smsError) {
      console.error('SMS 발송 오류:', smsError);
      res.status(500).json({
        success: false,
        code: 'SMS_SEND_FAILED',
        message: '인증번호 발송에 실패했습니다.\n새로고침 후 다시 시도해주세요.',
      });
    }
  } catch (error) {
    console.error('인증번호 발송 오류:', error);
    res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: '인증번호 발송 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 인증번호 확인
 * POST /api/certificate/verify-code
 */
router.post('/api/certificate/verify-code', async (req: Request, res: Response) => {
  try {
    const { phone_number, verification_code } = req.body;

    if (!phone_number || !verification_code) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_PARAMS',
        message: '휴대폰 번호와 인증번호를 입력해주세요.',
      });
    }

    const key = phone_number.replace(/-/g, '');
    const storedData = verificationStore.get(key);

    if (!storedData) {
      return res.status(400).json({
        success: false,
        code: 'CODE_NOT_FOUND',
        message: '인증번호받기를 먼저 해주세요.',
      });
    }

    // 만료 시간 확인
    if (new Date() > storedData.expiresAt) {
      verificationStore.delete(key);
      return res.status(400).json({
        success: false,
        code: 'CODE_EXPIRED',
        message: '인증번호가 만료되었습니다. 다시 요청해주세요.',
      });
    }

    // 인증번호 확인
    if (storedData.code !== verification_code) {
      return res.status(400).json({
        success: false,
        code: 'CODE_MISMATCH',
        message: '인증번호가 일치하지 않습니다.',
      });
    }

    // 인증 성공 - 저장소에서 제거
    verificationStore.delete(key);

    res.json({
      success: true,
      message: '인증이 완료되었습니다.',
      contractId: storedData.contractId,
    });
  } catch (error) {
    console.error('인증번호 확인 오류:', error);
    res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: '인증 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 가입증서 파일 다운로드
 * GET /api/certificate/download/:contractId
 */
router.get('/api/certificate/download/:contractId', async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;

    if (!contractId) {
      return res.status(400).json({
        success: false,
        message: '계약 ID가 필요합니다.',
      });
    }

    // 계약 정보 조회
    const [contracts] = await pool.execute<any[]>(
      'SELECT subscription_certificate_url, contract_number FROM travel_contracts WHERE id = ?',
      [contractId]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const contract = contracts[0];
    
    if (!contract.subscription_certificate_url) {
      return res.status(404).json({
        success: false,
        message: '가입증서 파일이 없습니다.',
      });
    }

    // 파일 경로 생성 (uploads 폴더는 backend와 동일 레벨에 위치)
    const uploadsDir = path.join(__dirname, '../../../uploads');
    
    // subscription_certificate_url이 /uploads/contracts/파일명 형태라면 /uploads 제거
    let relativePath = contract.subscription_certificate_url;
    if (relativePath.startsWith('/uploads/')) {
      relativePath = relativePath.replace('/uploads/', '');
    }
    
    const filePath = path.join(uploadsDir, relativePath);

    // 파일 존재 확인
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '파일을 찾을 수 없습니다.',
      });
    }

    // 파일명 추출
    const fileName = path.basename(contract.subscription_certificate_url);
    const downloadFileName = `가입증서_${contract.contract_number}.pdf`;

    // 파일 다운로드
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadFileName)}"`);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    console.error('파일 다운로드 오류:', error);
    res.status(500).json({
      success: false,
      message: '파일 다운로드 중 오류가 발생했습니다.',
    });
  }
});

// ==================== 행사보험 가입증서 다운로드 관련 API ====================

/**
 * 행사보험 입력 정보로 계약 검색 (가장 최근 계약)
 * POST /api/event-certificate/find-contract
 */
router.post('/api/event-certificate/find-contract', async (req: Request, res: Response) => {
  try {
    const {
      contract_name, // 법인(단체)명
      business_number, // 사업자번호 (10자리)
      phone_number // 휴대폰 번호
    } = req.body;

    // 필수 파라미터 검증
    if (!contract_name || !business_number || !phone_number) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_PARAMS',
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    const inputPhone = phone_number.replace(/-/g, '');
    const inputBusinessNumber = business_number.replace(/-/g, '');
    const inputContractName = contract_name.trim();

    // 계약 검색 쿼리 (행사보험은 법인만)
    const query = `
      SELECT ec.id, ec.contract_number, ec.created_at,
             ec.subscription_certificate_url
      FROM event_contracts ec
      INNER JOIN event_contractors ector ON ec.id = ector.contract_id
      WHERE ector.contractor = ?
        AND REPLACE(ector.business_number, '-', '') = ?
        AND REPLACE(ector.mobile_phone, '-', '') = ?
        AND ec.subscription_certificate_url IS NOT NULL
        AND ec.subscription_certificate_url != ''
      ORDER BY ec.created_at DESC
      LIMIT 1
    `;

    const [contracts] = await pool.execute<any[]>(query, [
      inputContractName,
      inputBusinessNumber,
      inputPhone
    ]);

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'CONTRACT_NOT_FOUND',
        message: '입력하신 내용과 일치하는 계약정보가 존재하지 않습니다.\n고객센터(1599-2541)로 문의해 주세요.',
      });
    }

    const contract = contracts[0];

    res.json({
      success: true,
      contract_number: contract.contract_number,
      contract_id: contract.id,
    });
  } catch (error) {
    console.error('계약 검색 오류:', error);
    res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: '계약 검색 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 행사보험 가입증서 다운로드용 인증번호 발송
 * POST /api/event-certificate/send-code
 */
router.post('/api/event-certificate/send-code', async (req: Request, res: Response) => {
  try {
    const {
      contract_id,
      contract_name, // 법인(단체)명
      business_number, // 사업자번호
      phone_number // 휴대폰 번호
    } = req.body;

    if (!contract_id || !contract_name || !business_number || !phone_number) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_PARAMS',
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    const inputPhone = phone_number.replace(/-/g, '');
    const inputBusinessNumber = business_number.replace(/-/g, '');
    const inputContractName = contract_name.trim();

    // 계약 정보 확인 (계약번호로 검색)
    const [contracts] = await pool.execute<any[]>(
      `SELECT ec.id, ec.contract_number, ec.subscription_certificate_url,
              ector.contractor, ector.business_number, ector.mobile_phone
       FROM event_contracts ec
       INNER JOIN event_contractors ector ON ec.id = ector.contract_id
       WHERE ec.contract_number = ?`,
      [contract_id]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'CONTRACT_NOT_FOUND',
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const contract = contracts[0];

    // 가입증서 파일 존재 확인
    if (!contract.subscription_certificate_url || contract.subscription_certificate_url === '') {
      return res.status(404).json({
        success: false,
        code: 'FILE_NOT_FOUND',
        message: '업로드된 파일이 없습니다.\n고객센터(1599-2541)에 문의바랍니다.',
      });
    }

    // 입력 정보와 계약 정보 일치 확인
    const contractContractName = (contract.contractor || '').trim();
    const contractBusinessNumber = (contract.business_number || '').replace(/-/g, '');
    const contractPhone = (contract.mobile_phone || '').replace(/-/g, '');

    if (contractContractName !== inputContractName ||
        contractBusinessNumber !== inputBusinessNumber ||
        contractPhone !== inputPhone) {
      return res.status(400).json({
        success: false,
        code: 'INFO_MISMATCH',
        message: '입력하신 내용과 일치하는 계약정보가 존재하지 않습니다.\n고객센터(1599-2541)로 문의해 주세요.',
      });
    }

    // 인증번호 생성 및 발송
    const verificationCode = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000); // 3분 후 만료

    // 인증 데이터 저장 (phone_number를 키로 사용)
    const key = inputPhone;
    verificationStore.set(key, {
      code: verificationCode,
      contractId: contract.id,
      phoneNumber: key,
      expiresAt,
    });

    // SMS 발송
    try {
      const result = await sendVerificationSms(key, verificationCode, false);
      const resultCode = String(result.result_code);
      
      if (resultCode !== '1') {
        throw new Error(result.message || 'SMS 발송 실패');
      }

      res.json({
        success: true,
        message: '인증번호가 발송되었습니다.',
      });
    } catch (smsError) {
      console.error('SMS 발송 오류:', smsError);
      res.status(500).json({
        success: false,
        code: 'SMS_SEND_FAILED',
        message: '인증번호 발송에 실패했습니다.\n새로고침 후 다시 시도해주세요.',
      });
    }
  } catch (error) {
    console.error('인증번호 발송 오류:', error);
    res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: '인증번호 발송 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 행사보험 가입증서 파일 다운로드
 * GET /api/event-certificate/download/:contractId
 */
router.get('/api/event-certificate/download/:contractId', async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;

    if (!contractId) {
      return res.status(400).json({
        success: false,
        message: '계약 ID가 필요합니다.',
      });
    }

    // 계약 정보 조회
    const [contracts] = await pool.execute<any[]>(
      'SELECT subscription_certificate_url, contract_number FROM event_contracts WHERE id = ?',
      [contractId]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const contract = contracts[0];
    
    if (!contract.subscription_certificate_url) {
      return res.status(404).json({
        success: false,
        message: '가입증서 파일이 없습니다.',
      });
    }

    // 파일 경로 생성 (uploads 폴더는 backend와 동일 레벨에 위치)
    const uploadsDir = path.join(__dirname, '../../../uploads');
    
    // subscription_certificate_url이 /uploads/contracts/파일명 형태라면 /uploads 제거
    let relativePath = contract.subscription_certificate_url;
    if (relativePath.startsWith('/uploads/')) {
      relativePath = relativePath.replace('/uploads/', '');
    }
    
    const filePath = path.join(uploadsDir, relativePath);

    // 파일 존재 확인
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '파일을 찾을 수 없습니다.',
      });
    }

    // 파일명 추출
    const fileName = path.basename(contract.subscription_certificate_url);
    const downloadFileName = `가입증서_${contract.contract_number}.pdf`;

    // 파일 다운로드
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadFileName)}"`);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    console.error('파일 다운로드 오류:', error);
    res.status(500).json({
      success: false,
      message: '파일 다운로드 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 약관 PDF 다운로드
 * GET /api/pdf/download/:type
 * type: domestic (국내), overseas (해외), longterm (해외장기체류)
 */
router.get('/api/pdf/download/:type', async (req: Request, res: Response) => {
  try {
    const { type } = req.params;

    // 타입별 파일명 매핑
    const pdfMap: { [key: string]: string } = {
      'domestic': 'ACE손해_국내여행보험약관.pdf',
      'overseas': 'ACE손해_해외여행보험약관.pdf',
      'longterm': '해외장기체류보험_약관.pdf'
    };

    const filename = pdfMap[type];

    if (!filename) {
      return res.status(404).json({
        success: false,
        message: '유효하지 않은 약관 타입입니다. (domestic, overseas, longterm 중 선택)',
      });
    }

    // PDF 파일 경로 (frontend의 public/pdf 폴더)
    const pdfDir = path.join(__dirname, '../../../b2c_tourvalley_front/public/pdf');
    const filePath = path.join(pdfDir, filename);

    // 파일 존재 확인
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '파일을 찾을 수 없습니다.',
      });
    }

    // 파일 다운로드 (강제 다운로드)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    console.error('PDF 다운로드 오류:', error);
    res.status(500).json({
      success: false,
      message: '파일 다운로드 중 오류가 발생했습니다.',
    });
  }
});

export default router;

