/**
 * API 응답용 날짜/시간을 한국시간(KST) 문자열로 통일.
 * 보험기간 등 입력값을 KST로 해석하기 위한 파서 포함.
 */

/** "YYYY-MM-DD HH:mm:ss" 형태 문자열을 한국시간(KST) 기준 Date로 파싱 (서버 타임존과 무관) */
export function parseDateTimeAsKst(value: string | undefined | null): Date | null {
  if (value == null || typeof value !== 'string') return null;
  const trimmed = value.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, y, mon, d, h, min, s] = m;
    const iso = `${y}-${mon}-${d}T${h}:${min}:${s}+09:00`;
    const date = new Date(iso);
    return isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(trimmed);
  return isNaN(date.getTime()) ? null : date;
}

const KST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Date 또는 문자열을 KST 기준 "YYYY-MM-DD HH:mm:ss"로 반환 (타임존 통일) */
export function toKstDateTimeStringForApi(value?: Date | string | null): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  const parts = KST_DATE_TIME_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const y = get('year');
  const m = get('month');
  const d = get('day');
  const h = get('hour');
  const min = get('minute');
  const s = get('second');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * 출발 시각(KST 달력)에 달력 개월수를 더한 시각.
 * 프론트 `addInsuranceCalendarMonthsToPickedInstant`와 동일 규칙(말일 클램프, KST 고정).
 */
export function addInsuranceCalendarMonthsFromKstInstant(departure: Date, monthsToAdd: number): Date | null {
  const s = toKstDateTimeStringForApi(departure);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const y0 = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mi = parseInt(m[5], 10);
  const ss = parseInt(m[6], 10);
  if ([y0, mo, day, hh, mi, ss].some((n) => Number.isNaN(n))) return null;

  const totalMonths = y0 * 12 + (mo - 1) + monthsToAdd;
  const y1 = Math.floor(totalMonths / 12);
  const m1 = (totalMonths % 12) + 1;
  const lastDayInTargetMonth = new Date(y1, m1, 0).getDate();
  const dayClamped = Math.min(day, lastDayInTargetMonth);

  const out = `${y1}-${String(m1).padStart(2, '0')}-${String(dayClamped).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return parseDateTimeAsKst(out);
}

/**
 * 보험나이 15세일 때 성인/어린이(만 나이) 판단용 기준일.
 * 서버/클라이언트 타임존과 무관하게 KST 달력의 '오늘' 날짜를 나타내는 Date (정오 KST 고정).
 */
export function getKstCalendarDateNow(): Date {
  const s = toKstDateTimeStringForApi(new Date());
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(5, 7), 10);
  const d = parseInt(s.slice(8, 10), 10);
  return new Date(
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00+09:00`
  );
}
