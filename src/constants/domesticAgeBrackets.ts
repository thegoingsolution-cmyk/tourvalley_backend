/** 국내여행보험 나이 구간 — 실손(has_medical_expense=1) vs 비실손(=0) */

export const DOMESTIC_SILSOK_AGE = {
  adultMin: 15,
  adultMax: 79,
  seniorMin: 80,
  seniorMax: 100,
} as const;

export const DOMESTIC_BISILSOK_AGE = {
  adultMin: 15,
  adultMax: 70,
  senior1Min: 71,
  senior1Max: 90,
  senior2Min: 91,
  senior2Max: 100,
} as const;

export function isDomesticMedicalExpenseOn(hasMedicalExpense?: unknown): boolean {
  return hasMedicalExpense !== 0 && hasMedicalExpense !== false && hasMedicalExpense !== '0';
}

export function getDomesticSeniorAgeThreshold(hasMedicalExpense?: unknown): number {
  return isDomesticMedicalExpenseOn(hasMedicalExpense)
    ? DOMESTIC_SILSOK_AGE.seniorMin
    : DOMESTIC_BISILSOK_AGE.senior1Min;
}
