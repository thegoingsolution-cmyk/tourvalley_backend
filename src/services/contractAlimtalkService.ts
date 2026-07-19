import pool from '../config/database';
import { generateAlimTalkMessage } from './alimtalkMessageGenerator';
import { sendAlimTalk } from './aligoService';

const formatInsuranceDateTime = (value: any): string => {
  if (!value) return '';
  const raw = String(value).trim();
  const match = raw.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}.${match[2]}.${match[3]} ${match[4]}시`;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  return `${year}.${month}.${day} ${hour}시`;
};

const shouldSendContractCompleteAlimTalk = (paymentMethod?: string | null, paymentSubMethod?: string | null) => {
  const method = (paymentMethod || '').trim();
  const subMethod = (paymentSubMethod || '').trim();
  const excludedMethods = ['수기카드', '무통장', '무통장입금'];

  if (excludedMethods.includes(method)) {
    return false;
  }
  if (excludedMethods.includes(subMethod)) {
    return false;
  }
  return true;
};

// 관리자 백엔드 resolveTravelDetailInsuranceCompanyName 와 동일 기준으로 판별
const LONG_TERM_INSURANCE_TYPES = new Set([
  '유학/어학연수',
  '워킹홀리데이',
  '해외출장/주재원/교환교수',
]);

const isTradeAssociationMemberType = (memberType?: string | null): boolean =>
  memberType === '한국무역협회 회원사' || memberType === '무역협회';

const getInsuranceCompanyName = (
  insuranceType?: string | null,
  memberType?: string | null
) => {
  const it = (insuranceType || '').trim();
  // 세부 상품명(유학/어학연수 등)뿐 아니라 '해외장기체류' 계열 표기도 장기로 인정
  const isLongTerm = LONG_TERM_INSURANCE_TYPES.has(it) || it.includes('장기');

  if (isTradeAssociationMemberType(memberType) && (it === '해외여행보험' || isLongTerm)) {
    return '현대해상';
  }
  if (isLongTerm) {
    return '메리츠화재';
  }
  return '라이나손해보험';
};

const resolveAlimtalkTravelDestination = (contract: {
  insurance_type?: string | null;
  travel_region?: string | null;
  travel_country?: string | null;
}) => {
  const insuranceType = (contract.insurance_type || '').toLowerCase();
  if (insuranceType.includes('국내')) {
    return contract.travel_region || '전국일원';
  }
  return contract.travel_country || '';
};

export const sendContractCompleteAlimTalk = async (
  contractId: number,
  paymentMethod?: string | null,
  paymentSubMethod?: string | null
) => {
  if (!shouldSendContractCompleteAlimTalk(paymentMethod, paymentSubMethod)) {
    return;
  }

  const [contractRows] = await pool.execute<any[]>(
    `SELECT 
      tc.*,
      ctr.name as contractor_name,
      ctr.phone,
      ctr.mobile_phone,
      ctr.company_name,
      ctr.contractor_type,
      m.name as member_name,
      m.mobile_phone as member_phone,
      m.member_type as member_type
     FROM travel_contracts tc
     LEFT JOIN contractors ctr ON tc.id = ctr.contract_id
     LEFT JOIN members m ON tc.member_id = m.id
     WHERE tc.id = ?
     LIMIT 1`,
    [contractId]
  );

  if (!contractRows || contractRows.length === 0) {
    return;
  }

  const contract = contractRows[0];
  const isB2B = contract.contractor_type === '법인';
  const customerName = isB2B
    ? (contract.company_name || contract.contractor_name || contract.member_name || '')
    : (contract.contractor_name || contract.company_name || contract.member_name || '');
  const receiverPhone = contract.mobile_phone || contract.phone || contract.member_phone || '';
  if (!customerName || !receiverPhone) {
    return;
  }

  const [companionRows] = await pool.execute<any[]>(
    `SELECT name FROM companions WHERE contract_id = ? ORDER BY sequence_number ASC`,
    [contractId]
  );
  const companionCount = companionRows?.length ?? 0;
  const representativeName = companionRows?.[0]?.name?.trim() || customerName;
  const participantSummary =
    companionCount > 1 ? `${representativeName} 외 ${companionCount - 1}명` : representativeName;

  const travelDestination = resolveAlimtalkTravelDestination(contract);

  const insurancePeriod = `${formatInsuranceDateTime(contract.departure_date)} ~ ${formatInsuranceDateTime(
    contract.arrival_date
  )}`;

  const insuranceProduct = contract.insurance_type || '';
  const insuranceCompany = getInsuranceCompanyName(contract.insurance_type, contract.member_type);
  const totalPremium = Number(contract.total_premium || 0);
  const formattedPremium = totalPremium ? `${totalPremium.toLocaleString()}원` : '0원';

  const message = generateAlimTalkMessage('contract_complete', {
    customerName,
    insuranceProduct,
    insuranceCompany,
    insurancePeriod,
    travelDestination,
    participants: participantSummary,
    premium: formattedPremium,
  });

  await sendAlimTalk({
    receiver: receiverPhone,
    template_code: 'UE_8122',
    subject: '여행자보험 가입완료(국내/해외/해외장기)',
    message,
    receiver_name: customerName,
    button: [
      {
        name: '채널 추가',
        linkType: 'AC',
      },
    ],
  });
};

export default {
  sendContractCompleteAlimTalk,
};
