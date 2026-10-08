// JSON 가져오기(내보내기의 역방향). 파일은 신뢰하지 않는다: 형식, 크기, 필드를 검증해서 안전한 것만 쓸 문서 목록으로 만든다.
// 이 모듈은 순수 함수만 둔다(Firestore, DOM 접근 없음). 실제 쓰기는 app.js 가 한다.
// 쓰는 것: 이 앱이 내보낸 컬렉션(pool, items, expenses, members, flights, lodgings)과 여행 문서의 일부 필드뿐.
// 같은 ID 의 문서는 가져온 필드만 바뀌고(merge) 나머지 필드는 유지되며, 파일에 없는 문서는 건드리지 않고, 아무것도 삭제하지 않는다.

import { sanitizeStoredPhoto } from './wiki.js';

export const COLLECTIONS = ['pool', 'items', 'expenses', 'members', 'flights', 'lodgings'];
export const LABELS = { pool: '장소', items: '일정', expenses: '경비', members: '멤버', flights: '항공편', lodgings: '숙소' };
export const LIMITS = { fileBytes: 5 * 1024 * 1024, docs: 3000, docBytes: 900 * 1024, depth: 20 };
export const BATCH_SIZE = 400; // Firestore 배치 한도 500 보다 작게

// 지도 링크는 구글맵 https 주소만 인정한다(javascript: 등 차단). parse.js 의 URL_RE 와 같은 호스트 목록.
export const MAP_URL_RE = /^https:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps|google\.com\/maps|maps\.google\.com)(?:[/?#]|$)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESERVED_KEY_RE = /^__.*__$/; // Firestore 예약 필드 이름. 과거 오염 키(__proto__ 포함)도 걸러진다.

// 카드에 보여 줄 부가 정보 행: [{ label, value }]. 형식이 틀리면 null, 비어 있으면 [].
// 너무 많거나 긴 값은 잘라서 버린다(화면과 문서 크기 보호).
export const ROW_LIMITS = { rows: 20, label: 40, value: 300 };
export function cleanRows(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v) {
    if (!isPlain(r) || typeof r.label !== 'string' || typeof r.value !== 'string') return null;
    const label = r.label.trim(), value = r.value.trim();
    if (!label || !value || label.length > ROW_LIMITS.label || value.length > ROW_LIMITS.value) return null;
    out.push({ label, value });
    if (out.length > ROW_LIMITS.rows) return null;
  }
  return out;
}

// 카드의 링크 버튼: { label, url }. 구글맵 https 주소만 인정, 아니면 null.
export function cleanLink(v) {
  if (!isPlain(v) || typeof v.label !== 'string' || typeof v.url !== 'string') return null;
  const label = v.label.trim();
  if (!label || label.length > ROW_LIMITS.label || !MAP_URL_RE.test(v.url)) return null;
  return { label, url: v.url };
}

export function isValidId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 &&
    !/[/\\\u0000-\u001f\u007f]/.test(id) && id !== '.' && id !== '..' && !RESERVED_KEY_RE.test(id);
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// 값 하나를 검사. 문제가 있으면 false (Firestore 가 거부하는 중첩 배열, 예약 키, 너무 깊은 구조, 유한하지 않은 숫자)
function validValue(v, depth) {
  if (depth > LIMITS.depth) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(x => !Array.isArray(x) && validValue(x, depth + 1));
  if (isPlain(v)) {
    return Object.keys(v).every(k => k.length > 0 && !RESERVED_KEY_RE.test(k) && validValue(v[k], depth + 1));
  }
  return false;
}

// 앱이 쓰는 필드의 타입(app.js 가 문서를 만드는 곳과 같다). 타입이 틀린 값이 DB 에 들어가면 화면 렌더링이 깨질 수 있어서
// 가져올 때 그 필드만 버린다. s: 문자열, sn: 문자열|null, n: 숫자, nn: 숫자|null, on: 객체|null
const FIELD_TYPES = {
  pool: { name: 's', rawTitle: 's', placeId: 'sn', fid: 'sn', cid: 'sn', category: 'sn', memo: 's', confirmedAt: 'nn', createdAt: 'n' },
  items: { day: 'n', order: 'n', poolId: 'sn', title: 's', time: 'sn', memo: 's' },
  lodgings: { name: 's', rawTitle: 's', placeId: 'sn', fid: 'sn', cid: 'sn', checkIn: 's', checkOut: 's', memo: 's', createdAt: 'n' },
  flights: { flightNo: 's', depIata: 's', arrIata: 's', depLocal: 's', arrLocal: 's', memo: 's', destAirport: 'on' }
};
function typeOk(v, t) {
  switch (t) {
    case 's': return typeof v === 'string';
    case 'sn': return v === null || typeof v === 'string';
    case 'n': return typeof v === 'number';
    case 'nn': return v === null || typeof v === 'number';
    case 'on': return v === null || isPlain(v);
    default: return true;
  }
}

// 문서 하나 정리. 반환: { id, data, sanitized } 또는 null(버림). col 을 주면 그 컬렉션의 필드 타입도 검사한다.
export function sanitizeDoc(raw, col) {
  if (!isPlain(raw) || !isValidId(raw.id)) return null;
  const data = {};
  let sanitized = false;
  for (const k of Object.keys(raw)) {
    if (k === 'id') continue;
    if (RESERVED_KEY_RE.test(k) || k.length === 0) return null;
    data[k] = raw[k];
  }
  if (!validValue(data, 1)) return null;
  // 렌더링 쪽에서 링크로 쓰이는 필드: 구글맵 https 가 아니면 비운다(문서는 살린다).
  if (typeof data.mapUrl === 'string' && data.mapUrl !== '' && !MAP_URL_RE.test(data.mapUrl)) { data.mapUrl = ''; sanitized = true; }
  else if (data.mapUrl != null && typeof data.mapUrl !== 'string') { data.mapUrl = ''; sanitized = true; }
  const types = FIELD_TYPES[col];
  if (types) {
    for (const k of Object.keys(types)) {
      if (k in data && !typeOk(data[k], types[k])) { delete data[k]; sanitized = true; }
    }
  }
  // 장소 사진(위키미디어 메타데이터): 검증을 통과한 것만 남긴다(출처, URL 호스트, 평문 정리, 이미지 데이터 금지).
  if (col === 'pool' && 'photo' in data) {
    const photo = sanitizeStoredPhoto(data.photo);
    if (photo === null) { delete data.photo; sanitized = true; } else data.photo = photo;
  }
  // 카드용 부가 필드: 형식이 틀리면 그 필드만 버린다(문서는 살린다).
  if ('details' in data) {
    const rows = cleanRows(data.details);
    if (rows === null) { delete data.details; sanitized = true; } else data.details = rows;
  }
  if ('link' in data) {
    const link = cleanLink(data.link);
    if (link === null) { delete data.link; sanitized = true; } else data.link = link;
  }
  if (JSON.stringify(data).length > LIMITS.docBytes) return null;
  return { id: raw.id, data, sanitized };
}

// 여행 문서는 알려진 필드만 가져온다.
function sanitizeTrip(t) {
  if (!isPlain(t)) return null;
  const out = {};
  if (typeof t.name === 'string' && t.name.length <= 200) out.name = t.name;
  for (const k of ['startDate', 'endDate']) {
    if (t[k] === null || (typeof t[k] === 'string' && DATE_RE.test(t[k]))) out[k] = t[k];
  }
  if (Array.isArray(t.currencies) && t.currencies.every(c => typeof c === 'string' && c.length <= 10)) out.currencies = t.currencies.slice(0, 50);
  return Object.keys(out).length ? out : null;
}

// 파일 내용(문자열) -> { ok: true, trip, docs: [{col,id,data}], counts, skipped, sanitized } | { ok: false, message }
export function parseExport(text) {
  if (typeof text !== 'string' || text.length > LIMITS.fileBytes) return { ok: false, message: '파일이 너무 커요 (최대 5MB)' };
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, message: '올바른 JSON 파일이 아니에요' }; }
  if (!isPlain(obj) || !(COLLECTIONS.some(c => Array.isArray(obj[c])) || isPlain(obj.trip))) {
    return { ok: false, message: '이 앱에서 내보낸 여행 파일이 아니에요' };
  }
  const docs = [];
  const counts = {};
  let skipped = 0, sanitizedCount = 0;
  for (const col of COLLECTIONS) {
    counts[col] = 0;
    if (obj[col] == null) continue;
    if (!Array.isArray(obj[col])) return { ok: false, message: LABELS[col] + ' 항목의 형식이 달라요' };
    const seen = new Set();
    for (const raw of obj[col]) {
      const d = sanitizeDoc(raw, col);
      if (!d || seen.has(d.id)) { skipped += 1; continue; }
      seen.add(d.id);
      if (d.sanitized) sanitizedCount += 1;
      docs.push({ col, id: d.id, data: d.data });
      counts[col] += 1;
      if (docs.length > LIMITS.docs) return { ok: false, message: '문서가 너무 많아요 (최대 ' + LIMITS.docs + '건)' };
    }
  }
  const trip = sanitizeTrip(obj.trip);
  if (!trip && docs.length === 0) return { ok: false, message: '가져올 데이터가 없어요' };
  return { ok: true, trip, docs, counts, skipped, sanitized: sanitizedCount };
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 화면에 보여 줄 요약. 예: "장소 12건, 일정 30건"
export function summarize(counts) {
  return COLLECTIONS.filter(c => counts[c] > 0).map(c => LABELS[c] + ' ' + counts[c] + '건').join(', ') || '없음';
}
