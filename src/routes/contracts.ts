import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { toKstDateTimeStringForApi } from '../utils/dateTime';
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
    const { member_id, inyear = '1', block_type = 'C', str_cur_page = '1', str_page_size = '10' } = req.query;

    if (!member_id) {
      return res.status(400).json({
        success: false,
        message: 'member_id가 필요합니다.',
      });
    }

    const memberId = parseInt(member_id as string, 10);
    const inYear = parseInt(inyear as string, 10);
    const currentPage = parseInt(str_cur_page as string, 10);
    const pageSizeRaw = parseInt(str_page_size as string, 10);
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : 10; // 페이지당 항목 수

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
        AND tc.status <> '테스트'
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
        AND created_at <= ?
        AND status <> '테스트'`,
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
      departureDate: toKstDateTimeStringForApi(contract.departure_date),
      arrivalDate: toKstDateTimeStringForApi(contract.arrival_date),
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

// 비회원 계약 목록 조회 (인증 완료 후)
router.get('/api/contracts/non-member/list', async (req: Request, res: Response) => {
  try {
    const { 
      name, // 개인: 이름
      birth_date, // 개인: 생년월일 (YYYYMMDD)
      gender, // 개인: 성별 (1: 남자, 2: 여자)
      phone, // 휴대폰 번호
      company_name, // 단체: 회사명
      business_number, // 단체: 사업자번호
      inyear = '1', 
      block_type = 'C', 
      str_cur_page = '1',
      str_page_size = '10'
    } = req.query;

    // 개인 또는 단체 구분
    const isIndividual = !!name && !!birth_date && !!gender && !!phone;
    const isCorporate = !!company_name && !!business_number && !!phone;

    if (!isIndividual && !isCorporate) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    const inYear = parseInt(inyear as string, 10);
    const currentPage = parseInt(str_cur_page as string, 10);
    const pageSizeRaw = parseInt(str_page_size as string, 10);
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : 10;

    // 날짜 범위 계산
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - inYear);

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

    const offset = (currentPage - 1) * pageSize;
    const limitValue = parseInt(String(pageSize), 10);
    const offsetValue = parseInt(String(offset), 10);

    let query = '';
    let params: any[] = [];

    if (isIndividual) {
      // 개인: 이름, 생년월일, 성별, 휴대폰 번호로 조회
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBirthDate = (birth_date as string).replace(/-/g, '');
      
      query = `
        SELECT 
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
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        LEFT JOIN companions c ON tc.id = c.contract_id
        WHERE (
          -- 개인: 회원/비회원 공통 (계약자 정보 일치)
          (ct.contractor_type = '개인'
           AND ct.name = ?
           AND REPLACE(ct.mobile_phone, '-', '') = ?
           AND SUBSTRING(REPLACE(ct.resident_number, '-', ''), 1, 8) = ?)
        )
        AND tc.created_at >= ? 
        AND tc.created_at <= ?
        AND tc.status <> '테스트'
        GROUP BY tc.id
        ORDER BY tc.created_at DESC
        LIMIT ${limitValue} OFFSET ${offsetValue}
      `;
      params = [name, cleanedPhone, inputBirthDate, startDateStr, endDateStr];
    } else {
      // 단체: 사업자번호, 회사명, 담당자 휴대폰 번호로 조회
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBusinessNumber = (business_number as string).replace(/-/g, '');
      
      query = `
        SELECT 
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
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        LEFT JOIN companions c ON tc.id = c.contract_id
        WHERE (
          -- 법인: 회원/비회원 공통 (계약자 정보 일치)
          (ct.contractor_type = '법인'
           AND ct.company_name = ?
           AND REPLACE(ct.business_number, '-', '') = ?
           AND (REPLACE(ct.mobile_phone, '-', '') = ? OR REPLACE(ct.phone, '-', '') = ?))
        )
        AND tc.created_at >= ? 
        AND tc.created_at <= ?
        AND tc.status <> '테스트'
        GROUP BY tc.id
        ORDER BY tc.created_at DESC
        LIMIT ${limitValue} OFFSET ${offsetValue}
      `;
      params = [company_name, inputBusinessNumber, cleanedPhone, cleanedPhone, startDateStr, endDateStr];
    }

    const [contracts] = await pool.execute<any[]>(query, params);

    // 전체 개수 조회
    let countQuery = '';
    let countParams: any[] = [];

    if (isIndividual) {
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBirthDate = (birth_date as string).replace(/-/g, '');
      
      countQuery = `
        SELECT COUNT(DISTINCT tc.id) as total
        FROM travel_contracts tc
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE (
          ct.contractor_type = '개인'
          AND ct.name = ?
          AND REPLACE(ct.mobile_phone, '-', '') = ?
          AND SUBSTRING(REPLACE(ct.resident_number, '-', ''), 1, 8) = ?)
        AND tc.created_at >= ? 
        AND tc.created_at <= ?
        AND tc.status <> '테스트'
      `;
      countParams = [name, cleanedPhone, inputBirthDate, startDateStr, endDateStr];
    } else {
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBusinessNumber = (business_number as string).replace(/-/g, '');
      
      countQuery = `
        SELECT COUNT(DISTINCT tc.id) as total
        FROM travel_contracts tc
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE (
          ct.contractor_type = '법인'
          AND ct.company_name = ?
          AND REPLACE(ct.business_number, '-', '') = ?
          AND (REPLACE(ct.mobile_phone, '-', '') = ? OR REPLACE(ct.phone, '-', '') = ?))
        AND tc.created_at >= ? 
        AND tc.created_at <= ?
        AND tc.status <> '테스트'
      `;
      countParams = [company_name, inputBusinessNumber, cleanedPhone, cleanedPhone, startDateStr, endDateStr];
    }

    const [countResult] = await pool.execute<any[]>(countQuery, countParams);
    const totalCount = countResult[0]?.total || 0;
    const totalPages = Math.ceil(totalCount / pageSize);

    // 계약 데이터 포맷팅
    const formattedContracts = contracts.map((contract: any) => ({
      id: contract.id,
      contractNumber: contract.contract_number || '-',
      insuranceType: contract.insurance_type || '-',
      planTypes: contract.plan_types ? contract.plan_types.split(',') : [],
      departureDate: toKstDateTimeStringForApi(contract.departure_date),
      arrivalDate: toKstDateTimeStringForApi(contract.arrival_date),
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
    console.error('비회원 계약 목록 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '계약 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// 비회원 계약 상세 조회 (가입내역 조회에서 휴대폰 인증 후 동일 식별 정보로 호출)
router.get('/api/contracts/non-member/detail/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      birth_date,
      gender,
      phone,
      company_name,
      business_number,
    } = req.query;

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

    const isIndividual = !!name && !!birth_date && !!gender && !!phone;
    const isCorporate = !!company_name && !!business_number && !!phone;

    if (!isIndividual && !isCorporate) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    let query = '';
    let params: any[] = [];

    if (isIndividual) {
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBirthDate = (birth_date as string).replace(/-/g, '');
      query = `
        SELECT 
          tc.*,
          CONCAT(
            DATE_FORMAT(tc.created_at, '%y%m%d'),
            '-',
            tc.id
          ) as contract_number,
          COALESCE(m.name, ctr.name) as member_name,
          COALESCE(
            m.birth_date,
            SUBSTRING(REPLACE(ctr.resident_number, '-', ''), 1, 6)
          ) as member_birth_date,
          COALESCE(m.mobile_phone, ctr.mobile_phone) as member_phone,
          m.email as member_email,
          m.email_domain as member_email_domain,
          ctr.email as contractor_email,
          (SELECT COUNT(*) FROM companions c WHERE c.contract_id = tc.id) as participants_count,
          ctr.contractor_type,
          ctr.company_name,
          ctr.name as contractor_name,
          ctr.business_number as contractor_business_number
        FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN contractors ctr ON tc.id = ctr.contract_id
        WHERE tc.id = ?
          AND ctr.contractor_type = '개인'
          AND ctr.name = ?
          AND REPLACE(ctr.mobile_phone, '-', '') = ?
          AND SUBSTRING(REPLACE(ctr.resident_number, '-', ''), 1, 8) = ?
      `;
      params = [contractId, name, cleanedPhone, inputBirthDate];
    } else {
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBusinessNumber = (business_number as string).replace(/-/g, '');
      query = `
        SELECT 
          tc.*,
          CONCAT(
            DATE_FORMAT(tc.created_at, '%y%m%d'),
            '-',
            tc.id
          ) as contract_number,
          COALESCE(m.name, ctr.name) as member_name,
          COALESCE(
            m.birth_date,
            SUBSTRING(REPLACE(ctr.resident_number, '-', ''), 1, 6)
          ) as member_birth_date,
          COALESCE(m.mobile_phone, ctr.mobile_phone) as member_phone,
          m.email as member_email,
          m.email_domain as member_email_domain,
          ctr.email as contractor_email,
          (SELECT COUNT(*) FROM companions c WHERE c.contract_id = tc.id) as participants_count,
          ctr.contractor_type,
          ctr.company_name,
          ctr.name as contractor_name,
          ctr.business_number as contractor_business_number
        FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN contractors ctr ON tc.id = ctr.contract_id
        WHERE tc.id = ?
          AND ctr.contractor_type = '법인'
          AND ctr.company_name = ?
          AND REPLACE(ctr.business_number, '-', '') = ?
          AND (REPLACE(ctr.mobile_phone, '-', '') = ? OR REPLACE(ctr.phone, '-', '') = ?)
      `;
      params = [
        contractId,
        company_name,
        inputBusinessNumber,
        cleanedPhone,
        cleanedPhone,
      ];
    }

    const [contracts] = await pool.execute<any[]>(query, params);

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const contract = contracts[0];

    let paymentMethod = contract.payment_method || null;
    let paymentStatus = contract.payment_status || '미결제';
    let paidAmount: number | null = null;
    let paymentSubMethod: string | null = null;
    let paymentDate: string | null = null;
    let depositorName: string | null = null;
    let bankName: string | null = null;
    let accountNumber: string | null = null;
    let receiptUrl: string | null = null;
    let useAccidentFreeCash = 0;

    try {
      const [payments] = await pool.execute<any[]>(
        `SELECT payment_method, payment_sub_method, status, amount, payment_date, depositor_name, bank_name, account_number, receipt_url
         FROM payments 
         WHERE contract_id = ? 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [contractId]
      );

      if (payments.length > 0) {
        paymentMethod = payments[0].payment_method || paymentMethod;
        paymentSubMethod = payments[0].payment_sub_method || null;
        paymentStatus = payments[0].status || paymentStatus;
        paidAmount = payments[0].amount != null ? Number(payments[0].amount) : null;
        paymentDate = payments[0].payment_date || null;
        depositorName = payments[0].depositor_name || null;
        bankName = payments[0].bank_name || null;
        accountNumber = payments[0].account_number || null;
        receiptUrl = payments[0].receipt_url || null;
      }

      const [firstPayments] = await pool.execute<any[]>(
        `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? ORDER BY id ASC LIMIT 1`,
        [contractId]
      );
      if (firstPayments.length > 0 && firstPayments[0].use_accident_free_cash != null) {
        useAccidentFreeCash = Math.max(0, Number(firstPayments[0].use_accident_free_cash));
      }
    } catch (error) {
      console.error('결제 정보 조회 오류:', error);
    }

    const actualInsuredCount = contract.participants_count || contract.travel_participants || 1;

    const formattedContract = {
      id: contract.id,
      contractNumber: contract.contract_number || '-',
      insuranceType: contract.insurance_type || '-',
      departureDate: toKstDateTimeStringForApi(contract.departure_date),
      arrivalDate: toKstDateTimeStringForApi(contract.arrival_date),
      totalPremium: contract.total_premium || 0,
      status: contract.status || '-',
      createdAt: contract.created_at,
      memberName: contract.member_name || '-',
      memberBirthDate: contract.member_birth_date || '',
      memberPhone: contract.member_phone || '-',
      memberEmail: (() => {
        const email = contract.member_email || '';
        const domain = contract.member_email_domain || '';
        if (email && domain) return `${email}@${domain}`;
        if (email && email.includes('@')) return email;
        if (email) return email;
        const ce = contract.contractor_email || '';
        return ce || '-';
      })(),
      travelRegion: contract.travel_region || null,
      travelCountry: contract.travel_country || null,
      travelPurpose: contract.travel_purpose || null,
      travelParticipants: actualInsuredCount,
      paymentMethod: paymentMethod || '무통장입금',
      paymentSubMethod,
      paymentStatus: paymentStatus || '미결제',
      useAccidentFreeCash,
      paidAmount: paidAmount != null ? paidAmount : contract.total_premium || 0,
      paymentDate,
      depositorName,
      bankName,
      accountNumber,
      receiptUrl,
      subscriptionCertificateUrl: contract.subscription_certificate_url || null,
      contractorType: contract.contractor_type || '개인',
      contractorCompanyName: contract.company_name || null,
      businessNumber: contract.contractor_business_number || null,
    };

    res.json({
      success: true,
      contract: formattedContract,
    });
  } catch (error) {
    console.error('비회원 계약 상세 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '계약 상세 정보를 불러오는 중 오류가 발생했습니다.',
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

    const memberIdParam = (req.query.member_id ?? req.query.memberId) as
      | string
      | undefined;
    if (!memberIdParam) {
      return res.status(401).json({
        success: false,
        message: '인증이 필요합니다.',
      });
    }
    const memberId = parseInt(memberIdParam, 10);
    if (Number.isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id입니다.',
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
        m.email_domain as member_email_domain,
        (SELECT COUNT(*) FROM companions c WHERE c.contract_id = tc.id) as participants_count,
        ctr.contractor_type,
        ctr.company_name,
        ctr.name as contractor_name,
        ctr.business_number as contractor_business_number
      FROM travel_contracts tc
      LEFT JOIN members m ON tc.member_id = m.id
      LEFT JOIN contractors ctr ON tc.id = ctr.contract_id
      WHERE tc.id = ? AND tc.member_id = ?`,
      [contractId, memberId]
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
    let paidAmount: number | null = null; // 실제 결제 금액 (무사고캐시 차감 후)
    let paymentSubMethod: string | null = null;
    let paymentDate: string | null = null;
    let depositorName: string | null = null;
    let bankName: string | null = null;
    let accountNumber: string | null = null;
    let receiptUrl: string | null = null;
    let useAccidentFreeCash = 0; // 무사고캐시 사용액

    try {
      // 최신 결제 행(완료)에서 결제방법, 상태, 실제 결제 금액
      const [payments] = await pool.execute<any[]>(
        `SELECT payment_method, payment_sub_method, status, amount, payment_date, depositor_name, bank_name, account_number, receipt_url
         FROM payments 
         WHERE contract_id = ? 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [contractId]
      );

      if (payments.length > 0) {
        paymentMethod = payments[0].payment_method || paymentMethod;
        paymentSubMethod = payments[0].payment_sub_method || null;
        paymentStatus = payments[0].status || paymentStatus;
        paidAmount = payments[0].amount != null ? Number(payments[0].amount) : null;
        paymentDate = payments[0].payment_date || null;
        depositorName = payments[0].depositor_name || null;
        bankName = payments[0].bank_name || null;
        accountNumber = payments[0].account_number || null;
        receiptUrl = payments[0].receipt_url || null;
      }

      // 무사고캐시 사용액: 계약 등록 시 저장한 첫 결제 행에서 조회
      const [firstPayments] = await pool.execute<any[]>(
        `SELECT use_accident_free_cash FROM payments WHERE contract_id = ? ORDER BY id ASC LIMIT 1`,
        [contractId]
      );
      if (firstPayments.length > 0 && firstPayments[0].use_accident_free_cash != null) {
        useAccidentFreeCash = Math.max(0, Number(firstPayments[0].use_accident_free_cash));
      }
    } catch (error) {
      console.error('결제 정보 조회 오류:', error);
      // payments 테이블이 없거나 오류가 발생해도 계속 진행
    }

    // 실제 피보험자 수 계산 (companions 테이블에서)
    const actualInsuredCount = contract.participants_count || contract.travel_participants || 1;

    // 데이터 포맷팅
    const formattedContract = {
      id: contract.id,
      contractNumber: contract.contract_number || '-',
      insuranceType: contract.insurance_type || '-',
      departureDate: toKstDateTimeStringForApi(contract.departure_date),
      arrivalDate: toKstDateTimeStringForApi(contract.arrival_date),
      totalPremium: contract.total_premium || 0,
      status: contract.status || '-',
      createdAt: contract.created_at,
      memberName: contract.member_name || '-',
      memberBirthDate: contract.member_birth_date || '',
      memberPhone: contract.member_phone || '-',
      memberEmail: (() => {
        const email = contract.member_email || '';
        const domain = contract.member_email_domain || '';
        if (email && domain) return `${email}@${domain}`;
        if (email && email.includes('@')) return email;
        return email || '-';
      })(),
      travelRegion: contract.travel_region || null,
      travelCountry: contract.travel_country || null,
      travelPurpose: contract.travel_purpose || null,
      travelParticipants: actualInsuredCount, // 실제 피보험자 수
      paymentMethod: paymentMethod || '무통장입금', // 결제방법
      paymentSubMethod, // 결제 세부 방법
      paymentStatus: paymentStatus || '미결제', // 결제여부
      useAccidentFreeCash, // 무사고캐시 사용액 (원)
      paidAmount: paidAmount != null ? paidAmount : contract.total_premium || 0, // 실제 결제 금액 (무사고캐시 차감 후)
      paymentDate, // 결제일시
      depositorName, // 입금자명 (무통장입금)
      bankName, // 입금은행 (무통장입금)
      accountNumber, // 입금계좌번호 (무통장입금)
      receiptUrl, // 영수증 URL
      subscriptionCertificateUrl: contract.subscription_certificate_url || null, // 증권 파일 경로
      contractorType: contract.contractor_type || '개인', // 계약자 유형
      contractorCompanyName: contract.company_name || null, // 법인명 (법인인 경우)
      businessNumber: contract.contractor_business_number || null, // 사업자번호 (법인인 경우)
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

// 입금확인증 조회 (카드 영수증 본인인증 완료 후 접근하는 경로)
router.get('/api/contracts/bank-transfer-receipt/:id', async (req: Request, res: Response) => {
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

    const [contracts] = await pool.execute<any[]>(
      `SELECT id, insurance_type, total_premium
       FROM travel_contracts
       WHERE id = ?
       LIMIT 1`,
      [contractId]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const [payments] = await pool.execute<any[]>(
      `SELECT amount, payment_date, depositor_name, bank_name, account_number
       FROM payments
       WHERE contract_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [contractId]
    );

    const contract = contracts[0];
    const payment = payments.length > 0 ? payments[0] : null;

    return res.json({
      success: true,
      contract: {
        insuranceType: contract.insurance_type || '-',
        totalPremium: contract.total_premium ? Number(contract.total_premium) : 0,
        paidAmount: payment?.amount != null ? Number(payment.amount) : null,
        paymentDate: payment?.payment_date || null,
        depositorName: payment?.depositor_name || null,
        bankName: payment?.bank_name || null,
        accountNumber: payment?.account_number || null,
      },
    });
  } catch (error) {
    console.error('입금확인증 조회 오류:', error);
    return res.status(500).json({
      success: false,
      message: '입금확인증 정보를 불러오는 중 오류가 발생했습니다.',
    });
  }
});

// 비회원 계약 피보험자 정보 조회 (가입신청내역서 출력용)
router.get('/api/contracts/non-member/:id/participants', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      birth_date,
      gender,
      phone,
      company_name,
      business_number,
    } = req.query;

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

    const isIndividual = !!name && !!birth_date && !!gender && !!phone;
    const isCorporate = !!company_name && !!business_number && !!phone;

    if (!isIndividual && !isCorporate) {
      return res.status(400).json({
        success: false,
        message: '필수 파라미터가 누락되었습니다.',
      });
    }

    let authQuery = '';
    let authParams: any[] = [];

    if (isIndividual) {
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBirthDate = (birth_date as string).replace(/-/g, '');
      authQuery = `
        SELECT tc.id
        FROM travel_contracts tc
        LEFT JOIN contractors ctr ON tc.id = ctr.contract_id
        WHERE tc.id = ?
          AND ctr.contractor_type = '개인'
          AND ctr.name = ?
          AND REPLACE(ctr.mobile_phone, '-', '') = ?
          AND SUBSTRING(REPLACE(ctr.resident_number, '-', ''), 1, 8) = ?
        LIMIT 1
      `;
      authParams = [contractId, name, cleanedPhone, inputBirthDate];
    } else {
      const cleanedPhone = (phone as string).replace(/-/g, '');
      const inputBusinessNumber = (business_number as string).replace(/-/g, '');
      authQuery = `
        SELECT tc.id
        FROM travel_contracts tc
        LEFT JOIN contractors ctr ON tc.id = ctr.contract_id
        WHERE tc.id = ?
          AND ctr.contractor_type = '법인'
          AND ctr.company_name = ?
          AND REPLACE(ctr.business_number, '-', '') = ?
          AND (REPLACE(ctr.mobile_phone, '-', '') = ? OR REPLACE(ctr.phone, '-', '') = ?)
        LIMIT 1
      `;
      authParams = [contractId, company_name, inputBusinessNumber, cleanedPhone, cleanedPhone];
    }

    const [authorized] = await pool.execute<any[]>(authQuery, authParams);
    if (authorized.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const [companionsData] = await pool.execute<any[]>(
      `SELECT 
        c.id,
        c.name,
        c.gender,
        c.nationality_type,
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

    const insuredPersons = companionsData;

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

    // 회원 GET /api/contracts/:id/participants 와 동일한 포맷 (성별·생년월일·보험료)
    const formatBirthDate = (residentNumber: string | null) => {
      if (!residentNumber) return '';
      const part = residentNumber.split('-')[0]?.replace(/\D/g, '') ?? '';
      return part.length >= 8 ? part.slice(0, 8) : part.length >= 6 ? part.slice(0, 6) : '';
    };

    /** 외국인등록번호(YYMMDD-XXXXXXX) 7번째 자리로 성별 판별: 5,7=남자, 6,8=여자 */
    const genderFromForeignResidentNumber = (residentNumber: string | null): string | null => {
      if (!residentNumber) return null;
      const afterHyphen = residentNumber.split('-')[1]?.replace(/\D/g, '') ?? '';
      const seventh = afterHyphen.charAt(0);
      if (seventh === '5' || seventh === '7') return '남자';
      if (seventh === '6' || seventh === '8') return '여자';
      return null;
    };

    const totalPremium = contract.total_premium ? Number(contract.total_premium) : 0;

    const participants = insuredPersons.map((person: any, index: number) => {
      let premium = 0;
      if (person.premium !== null && person.premium !== undefined) {
        premium = Number(person.premium);
        if (isNaN(premium)) premium = 0;
      }

      let gender = person.gender || '남자';
      if (person.nationality_type === '외국인') {
        const derived = genderFromForeignResidentNumber(person.resident_number);
        if (derived) gender = derived;
      }

      return {
        id: person.id,
        sequence: person.sequence_number || index + 1,
        name: person.name || '-',
        gender,
        nationalityType: person.nationality_type || '-',
        birthDate: formatBirthDate(person.resident_number),
        planType: person.plan_type || '-',
        premium,
        hasMedicalExpense: Boolean(person.has_medical_expense),
      };
    });

    const hasAnyPremium = participants.some((p) => p.premium > 0);
    if (!hasAnyPremium && totalPremium > 0 && participants.length > 0) {
      const premiumPerPerson = Math.floor(totalPremium / participants.length);
      participants.forEach((p) => {
        p.premium = premiumPerPerson;
      });
    }

    res.json({
      success: true,
      participants,
      contractInfo: {
        totalPremium,
        insuranceType: contract.insurance_type || '-',
      },
    });
  } catch (error) {
    console.error('비회원 피보험자 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '피보험자 정보를 불러오는 중 오류가 발생했습니다.',
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

    const memberIdParam = (req.query.member_id ?? req.query.memberId) as
      | string
      | undefined;
    if (!memberIdParam) {
      return res.status(401).json({
        success: false,
        message: '인증이 필요합니다.',
      });
    }
    const memberId = parseInt(memberIdParam, 10);
    if (Number.isNaN(memberId)) {
      return res.status(400).json({
        success: false,
        message: '유효하지 않은 member_id입니다.',
      });
    }

    // 피보험자 정보 조회 (companions 테이블에서 직접 조회)
    const [companionsData] = await pool.execute<any[]>(
      `SELECT 
        c.id,
        c.name,
        c.gender,
        c.nationality_type,
        c.resident_number,
        c.sequence_number,
        c.plan_type,
        c.premium,
        c.has_medical_expense
      FROM companions c
      INNER JOIN travel_contracts tc
        ON tc.id = c.contract_id
      WHERE c.contract_id = ?
        AND tc.member_id = ?
      ORDER BY c.sequence_number ASC`,
      [contractId, memberId]
    );

    const insuredPersons = companionsData;

    // 계약 정보 조회 (총 보험료 등)
    const [contracts] = await pool.execute<any[]>(
      `SELECT total_premium, insurance_type
       FROM travel_contracts
       WHERE id = ? AND member_id = ?`,
      [contractId, memberId]
    );

    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '계약 정보를 찾을 수 없습니다.',
      });
    }

    const contract = contracts[0];

    // resident_number: "19670323-1******" → 하이픈 앞 8자리(YYYYMMDD) 그대로 반환
    const formatBirthDate = (residentNumber: string | null) => {
      if (!residentNumber) return '';
      const part = residentNumber.split('-')[0]?.replace(/\D/g, '') ?? '';
      return part.length >= 8 ? part.slice(0, 8) : part.length >= 6 ? part.slice(0, 6) : '';
    };

    /** 외국인등록번호(YYMMDD-XXXXXXX) 7번째 자리로 성별 판별: 5,7=남자, 6,8=여자 */
    const genderFromForeignResidentNumber = (residentNumber: string | null): string | null => {
      if (!residentNumber) return null;
      const afterHyphen = residentNumber.split('-')[1]?.replace(/\D/g, '') ?? '';
      const seventh = afterHyphen.charAt(0);
      if (seventh === '5' || seventh === '7') return '남자';
      if (seventh === '6' || seventh === '8') return '여자';
      return null;
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

      // 외국인: resident_number 7번째 자리(5,7=남자, 6,8=여자)로 성별 판별. 내국인: DB gender 사용
      let gender = person.gender || '남자';
      if (person.nationality_type === '외국인') {
        const derived = genderFromForeignResidentNumber(person.resident_number);
        if (derived) gender = derived;
      }

      return {
        id: person.id,
        name: person.name || '',
        gender,
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
      phone_number, // 휴대폰 번호
      contract_number: requested_contract_number // 선택: 지정 시 해당 계약만 조회 (없으면 최신 1건)
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
      // 개인: 회원 + 비회원 모두 검색 (contract_number 지정 시 해당 건만)
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
        ${requested_contract_number ? 'AND tc.contract_number = ?' : ''}
        ORDER BY tc.created_at DESC
        LIMIT 1
      `;
      // resident_number 형식: 198812-11****** → 하이픈 제거 후 앞 8자리 = YYYYMMDD
      params = [name, inputBirthDate, inputPhone, name, inputPhone, inputBirthDate];
      if (requested_contract_number) {
        params.push(String(requested_contract_number).trim());
      }
    } else {
      // 법인: 회원 + 비회원 모두 검색 (contract_number 지정 시 해당 건만)
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
        ${requested_contract_number ? 'AND tc.contract_number = ?' : ''}
        ORDER BY tc.created_at DESC
        LIMIT 1
      `;
      params = [company_name, inputBusinessNumber, inputPhone, company_name, inputBusinessNumber, inputPhone];
      if (requested_contract_number) {
        params.push(String(requested_contract_number).trim());
      }
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
        console.log(`     증서URL: ${contract.subscription_certificate_url ?? '(없음)'}`);
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
 * 이메일 링크 진입 시 contract_id + 본인확인(생년월일/사업자번호)으로 영수증 URL 조회
 * POST /api/certificate/verify-receipt-by-identity
 * - contract_number(contract_id) 필수, 휴대폰 인증 없음
 */
router.post('/api/certificate/verify-receipt-by-identity', async (req: Request, res: Response) => {
  try {
    const {
      contract_number,
      member_type,
      name,
      birth_date,
      company_name,
      business_number,
    } = req.body;

    if (!contract_number || typeof contract_number !== 'string' || !contract_number.trim()) {
      return res.status(400).json({
        success: false,
        message: '계약번호(contract_id)가 필요합니다.',
      });
    }

    const cn = String(contract_number).trim();
    const inputBirthDate = birth_date ? String(birth_date).replace(/-/g, '') : '';
    const inputBusinessNumber = business_number ? String(business_number).replace(/-/g, '') : '';

    if (!member_type || (member_type !== 'I' && member_type !== 'C')) {
      return res.status(400).json({
        success: false,
        message: '회원유형(개인/법인)을 선택해주세요.',
      });
    }

    let query = '';
    let params: any[] = [];

    if (member_type === 'I') {
      if (!birth_date || inputBirthDate.length !== 8) {
        return res.status(400).json({
          success: false,
          message: '생년월일(8자리)을 입력해주세요.',
        });
      }
      query = `
        SELECT tc.id FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE tc.contract_number = ?
        AND (
          (tc.member_id IS NOT NULL AND REPLACE(m.birth_date, '-', '') = ?)
          OR
          (tc.member_id IS NULL AND ct.contractor_type = '개인' AND SUBSTRING(REPLACE(ct.resident_number, '-', ''), 1, 8) = ?)
        )
        LIMIT 1
      `;
      params = [cn, inputBirthDate, inputBirthDate];
    } else {
      if (!business_number || inputBusinessNumber.length < 10) {
        return res.status(400).json({
          success: false,
          message: '사업자번호를 입력해주세요.',
        });
      }
      query = `
        SELECT tc.id FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN corporate_members cm ON m.id = cm.member_id
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE tc.contract_number = ?
        AND (
          (tc.member_id IS NOT NULL AND REPLACE(cm.business_number, '-', '') = ?)
          OR
          (tc.member_id IS NULL AND ct.contractor_type = '법인' AND REPLACE(ct.business_number, '-', '') = ?)
        )
        LIMIT 1
      `;
      params = [cn, inputBusinessNumber, inputBusinessNumber];
    }

    const [contracts] = await pool.execute<any[]>(query, params);
    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '입력하신 정보와 일치하는 계약을 찾을 수 없습니다.',
      });
    }

    const internalContractId = contracts[0].id;
    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');

    const [payments] = await pool.execute<any[]>(
      `SELECT id, payment_method, payment_sub_method, status, receipt_url
       FROM payments WHERE contract_id = ? ORDER BY created_at DESC LIMIT 1`,
      [internalContractId]
    );

    if (payments.length === 0) {
      return res.status(404).json({
        success: false,
        message: '결제 정보를 찾을 수 없습니다.',
      });
    }

    const payment = payments[0];
    const method = (payment.payment_method || '').trim();
    const subMethod = (payment.payment_sub_method || '').trim();

    // 무통장입금 → 입금확인증 페이지
    if (method === '무통장입금' || subMethod === '무통장입금' || (method === '기타결제' && subMethod === '무통장입금')) {
      return res.json({
        success: true,
        receiptUrl: `${frontendUrl}/payments/bank-transfer-receipt?contractId=${internalContractId}`,
      });
    }

    // 수기카드 → 관리자 업로드 영수증 URL
    if (method === '수기카드' || (method === '기타결제' && subMethod === '수기카드')) {
      const url = (payment.receipt_url || '').trim();
      if (!url) {
        return res.status(404).json({
          success: false,
          message: '영수증 정보를 찾을 수 없습니다.',
        });
      }
      const fullUrl = url.startsWith('http') ? url : `${frontendUrl}${url.startsWith('/') ? '' : '/'}${url}`;
      return res.json({
        success: true,
        receiptUrl: fullUrl,
      });
    }

    return res.status(400).json({
      success: false,
      message: '해당 결제 수단의 영수증은 이 경로에서 조회할 수 없습니다.',
    });
  } catch (error) {
    console.error('영수증 본인확인 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '처리 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 이메일 링크 진입 시 contract_id + 본인확인(생년월일/사업자번호)으로 가입증명서 다운로드용 계약 ID 조회
 * POST /api/certificate/verify-by-identity
 * - contract_number(contract_id) 필수, 휴대폰 인증 없음
 */
router.post('/api/certificate/verify-by-identity', async (req: Request, res: Response) => {
  try {
    const {
      contract_number,
      member_type,
      name,
      birth_date,
      company_name,
      business_number,
    } = req.body;

    if (!contract_number || typeof contract_number !== 'string' || !contract_number.trim()) {
      return res.status(400).json({
        success: false,
        message: '계약번호(contract_id)가 필요합니다.',
      });
    }

    const cn = String(contract_number).trim();
    const inputBirthDate = birth_date ? String(birth_date).replace(/-/g, '') : '';
    const inputBusinessNumber = business_number ? String(business_number).replace(/-/g, '') : '';

    if (!member_type || (member_type !== 'I' && member_type !== 'C')) {
      return res.status(400).json({
        success: false,
        message: '회원유형(개인/법인)을 선택해주세요.',
      });
    }

    let query = '';
    let params: any[] = [];

    if (member_type === 'I') {
      if (!birth_date || inputBirthDate.length !== 8) {
        return res.status(400).json({
          success: false,
          message: '생년월일(8자리)을 입력해주세요.',
        });
      }
      query = `
        SELECT tc.id FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE tc.contract_number = ?
        AND (
          (tc.member_id IS NOT NULL AND REPLACE(m.birth_date, '-', '') = ?)
          OR
          (tc.member_id IS NULL AND ct.contractor_type = '개인' AND SUBSTRING(REPLACE(ct.resident_number, '-', ''), 1, 8) = ?)
        )
        LIMIT 1
      `;
      params = [cn, inputBirthDate, inputBirthDate];
    } else {
      if (!business_number || inputBusinessNumber.length < 10) {
        return res.status(400).json({
          success: false,
          message: '사업자번호를 입력해주세요.',
        });
      }
      query = `
        SELECT tc.id FROM travel_contracts tc
        LEFT JOIN members m ON tc.member_id = m.id
        LEFT JOIN corporate_members cm ON m.id = cm.member_id
        LEFT JOIN contractors ct ON tc.id = ct.contract_id
        WHERE tc.contract_number = ?
        AND (
          (tc.member_id IS NOT NULL AND REPLACE(cm.business_number, '-', '') = ?)
          OR
          (tc.member_id IS NULL AND ct.contractor_type = '법인' AND REPLACE(ct.business_number, '-', '') = ?)
        )
        LIMIT 1
      `;
      params = [cn, inputBusinessNumber, inputBusinessNumber];
    }

    const [contracts] = await pool.execute<any[]>(query, params);
    if (contracts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '입력하신 정보와 일치하는 계약을 찾을 수 없습니다.',
      });
    }

    const internalContractId = contracts[0].id;

    return res.json({
      success: true,
      contractId: internalContractId,
    });
  } catch (error) {
    console.error('가입증명서 본인확인 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '처리 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 가입증서 파일 다운로드 (PDF/이미지 등 저장된 형식 그대로 제공)
 * GET /api/certificate/download/:contractId
 * - contractId: 내부 id(숫자) 또는 contract_number(예: 250312-123) 모두 지원
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

    // 숫자만 있으면 id로, 아니면 contract_number로 조회 (이메일 등에서 contract_number 전달 대비)
    const isNumericId = /^\d+$/.test(contractId);
    const [contracts] = await pool.execute<any[]>(
      isNumericId
        ? 'SELECT subscription_certificate_url, contract_number FROM travel_contracts WHERE id = ?'
        : 'SELECT subscription_certificate_url, contract_number FROM travel_contracts WHERE contract_number = ?',
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

    // 실제 파일 확장자 유지 (pdf 외 이미지 등 그대로 제공)
    const ext = path.extname(contract.subscription_certificate_url).toLowerCase() || '.pdf';
    const downloadFileName = `가입증서_${contract.contract_number}${ext}`;

    const mimeByExt: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const contentType = mimeByExt[ext] ?? 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
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
 * 행사보험 가입증서 파일 다운로드 (PDF/이미지 등 저장된 형식 그대로 제공)
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

    // 실제 파일 확장자 유지 (pdf 외 이미지 등 그대로 제공)
    const ext = path.extname(contract.subscription_certificate_url).toLowerCase() || '.pdf';
    const downloadFileName = `가입증서_${contract.contract_number}${ext}`;

    const mimeByExt: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const contentType = mimeByExt[ext] ?? 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
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

