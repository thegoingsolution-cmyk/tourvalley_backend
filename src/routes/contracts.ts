import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

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

    // 날짜를 MySQL DATETIME 형식으로 포맷팅
    const formatDateForMySQL = (date: Date): string => {
      return date.toISOString().slice(0, 19).replace('T', ' ');
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
        m.email as member_email
      FROM travel_contracts tc
      LEFT JOIN members m ON tc.member_id = m.id
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

export default router;

