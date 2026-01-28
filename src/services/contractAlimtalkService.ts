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
  const excludedMethods = ['수기카드', '무통장', '무통장입금', '가상계좌'];

  if (excludedMethods.includes(method)) {
    return false;
  }
  if (excludedMethods.includes(subMethod)) {
    return false;
  }
  return true;
};

const getInsuranceCompanyName = (insuranceType?: string | null) => {
  const type = (insuranceType || '').toLowerCase();
  if (type.includes('장기')) {
    return '메리츠화재';
  }
  return '라이나손해보험';
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
      m.name as member_name,
      m.mobile_phone as member_phone,
      (SELECT COUNT(*) FROM insured_persons ip WHERE ip.contract_id = tc.id) as insured_count
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
  const customerName = contract.contractor_name || contract.member_name || '';
  const receiverPhone = contract.mobile_phone || contract.phone || contract.member_phone || '';
  if (!customerName || !receiverPhone) {
    return;
  }

  const insuredCount = Number(contract.insured_count || contract.travel_participants || 1);
  const participantSummary =
    insuredCount > 1 ? `${customerName} 외 ${insuredCount - 1}명` : customerName;

  let travelDestination = [contract.travel_region, contract.travel_country]
    .filter((value: string | null) => !!value)
    .join(' ');

  if (!travelDestination) {
    const insuranceType = (contract.insurance_type || '').toLowerCase();
    if (insuranceType.includes('국내')) {
      travelDestination = '국내';
    }
  }

  const insurancePeriod = `${formatInsuranceDateTime(contract.departure_date)} ~ ${formatInsuranceDateTime(
    contract.arrival_date
  )}`;

  const insuranceProduct = contract.insurance_type || '';
  const insuranceCompany = getInsuranceCompanyName(contract.insurance_type);
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
