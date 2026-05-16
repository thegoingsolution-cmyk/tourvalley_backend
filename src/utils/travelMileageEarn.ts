/** 여행 계약 적립 마일리지 (거래/중복판별용 문자열 통일) */
export const TRAVEL_CONTRACT_MILEAGE_REASON = '여행보험 가입 마일리지';

/** 총 보험료(또는 동일 규칙 금액)의 floor(금액×3%), 상한 30,000P */
export function computeTravelContractMileageAmount(paymentAmount: number): number {
  const n = Number(paymentAmount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n * 0.03), 30000);
}
