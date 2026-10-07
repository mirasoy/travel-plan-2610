// JSON 가져오기(내보내기의 역방향). 파일은 신뢰하지 않는다: 형식, 크기, 필드를 검증해서 안전한 것만 쓸 문서 목록으로 만든다.
// 이 모듈은 순수 함수만 둔다(Firestore, DOM 접근 없음). 실제 쓰기는 app.js 가 한다.
// 쓰는 것: 이 앱이 내보낸 컬렉션(pool, items, expenses, members, flights, lodgings)과 여행 문서의 일부 필드뿐.
// 같은 ID 의 문서는 가져온 내용으로 바뀌고, 파일에 없는 문서는 건드리지 않으며, 아무것도 삭제하지 않는다.

export const COLLECTIONS = ['pool', 'items', 'expenses', 'members', 'flights', 'lodgings'];
export const LABELS = { pool: '장소', items: '일정', expenses: '경비', members: '멤버', flights: '항공편', lodgings: '숙소' };
export const LIMITS = { fileBytes: 5 * 1024 * 1024, docs: 3000, docBytes: 900 * 1024, depth: 20 };
export const BATCH_SIZE = 400; // Firestore 배치 한도 500 보다 작게

// 지도 링크는 구글맵 https 주소만 인정한다(javascript: 등 차단). parse.js 의 URL_RE 와 같은 호스트 목록.
const MAP_URL_RE = /^https:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps|google\.com\/maps|maps\.google\.com)(?:[/?#]|$)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESERVED_KEY_RE = /^__.*__$/; // Firestore 예약 필드 이름. 과거 오염 키(__proto__ 포함)도 걸러진다.

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

// 문서 하나 정리. 반환: { id, data, sanitized } 또는 null(버림)
export function sanitizeDoc(raw) {
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
      const d = sanitizeDoc(raw);
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
