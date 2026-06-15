/** 국내여행보험 나이 구간 — 실손·비실손 공통 (3구간) */

export const DOMESTIC_SILSOK_AGE = {
  adultMin: 15,
  adultMax: 79,
  seniorMin: 80,
  seniorMax: 100,
} as const;

export function isDomesticMedicalExpenseOn(hasMedicalExpense?: unknown): boolean {
  return hasMedicalExpense !== 0 && hasMedicalExpense !== false && hasMedicalExpense !== '0';
}

export function getDomesticSeniorAgeThreshold(_hasMedicalExpense?: unknown): number {
  return DOMESTIC_SILSOK_AGE.seniorMin;
}
