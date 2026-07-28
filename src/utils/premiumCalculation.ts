/**
 * 제휴 보험사 Excel 수식과 동일:
 * ROUNDDOWN(ROUND(연간보험료 × 요율%, 0) + 추가금액, -1)
 */
export function calculateFinalPremium(
  annualPremium: number,
  shortTermRatePercent: number,
  additionalFee = 0
): number {
  const ratePremium = Math.round(annualPremium * (shortTermRatePercent / 100));
  return Math.floor((ratePremium + additionalFee) / 10) * 10;
}
