/** B2C 투어밸리 PG(나이스·네이버·카카오) 상품 표시명 구분용 접두사 */
export const B2C_PG_PRODUCT_PREFIX = 'b2c_';

/**
 * PG에 넘기는 상품명 앞에 접두사를 붙입니다. 이미 `b2c_`로 시작하면 중복하지 않습니다.
 */
export function withB2cPgProductPrefix(name: string): string {
  const s = String(name ?? '').trim();
  if (!s) return s;
  if (s.startsWith(B2C_PG_PRODUCT_PREFIX)) return s;
  return `${B2C_PG_PRODUCT_PREFIX}${s}`;
}
