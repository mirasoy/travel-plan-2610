// 장소 대표 사진(위키미디어 커먼즈). Worker 의 GET {resolverUrl}/wiki 만 부른다. 순수 모듈: DOM, 저장소, 콘솔을 직접 쓰지 않는다
// (네트워크, 타이머, h 는 주입). 앱 카드 표시 전용이며 영상 합성 등에는 쓰지 않는다(CC BY-SA 조건).
//
// 규칙
// - 보내는 것: 장소 이름, 그리고 config.destinationCenter(여행지 중심, 직접 입력한 값)와 반경. 장소의 구글 좌표나 GPS 는 보내지 않는다.
// - 실패(400, 403, 502, 503, 네트워크, 25초 타임아웃, 형식 이상)는 전부 "사진 없음"으로 조용히 처리한다. 로그도 오류 화면도 자동 재시도도 없다.
// - 저장하는 것은 메타데이터와 URL 뿐이다(이미지 파일, base64 금지). 표시할 때 thumbUrl 을 위키미디어에서 직접 불러온다.
// - artist, credit, license 는 태그를 걷어낸 평문으로만 저장하고 textContent 로만 화면에 넣는다.

// 대표 사진이 같은 브랜드의 다른 지점 사진일 수 있음을 알리는 글자 태그(이모지 금지)
export const BRAND_TAG = '브랜드 대표 사진(다른 지점일 수 있음)';

export const WIKI_TIMEOUT_MS = 25 * 1000;   // Worker 내부 예산이 20초라 클라이언트는 25초. 사진은 저장 뒤 백그라운드로 불러오므로 사용자는 기다리지 않는다
export const NAME_MAX = 200;
const TEXT_MAX = { file: 200, license: 200, artist: 160, credit: 300 };   // license 는 응답 그대로 보여 주므로(버전이 다른 정식 명칭도 있다) 넉넉히
const THUMB_HOSTS = ['thumb.wikimedia.org', 'upload.wikimedia.org'];   // 응답의 thumbUrl 호스트(둘 중 하나)

// 화면에 쓸 평문. 마크업 기호(< 또는 &)가 없는 값("User:이름" 같은 사용자명 포함)은 앞뒤 공백만 다듬고 그대로 둔다(변형하지 않음).
// 마크업이 섞여 온 경우에만(Commons 의 <a href=...>이름</a> 등) script/style 은 내용째 버리고, 태그를 걷고, 기본 엔티티를 풀고, 공백을 정리한다.
export function plainText(v, max) {
  if (typeof v !== 'string') return '';
  if (!/[<&]/.test(v)) { const t = v.trim(); return t.length > max ? t.slice(0, max).trim() : t; }
  let s = v.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  s = s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }[e.toLowerCase()]));
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

// https 이고 허용 호스트인 URL 만 통과(javascript:, data:, http, 계정정보 포함 URL, 다른 도메인 차단). 아니면 ''.
// 검증에만 URL 파서를 쓰고 값은 응답이 준 문자열 그대로 돌려준다: 쿼리스트링(utm_... 등)을 지우거나 정규화하지 않는다.
function safeUrl(u, hostOk) {
  if (typeof u !== 'string') return '';
  const raw = u.trim();
  if (!raw || raw.length > 2000) return '';
  let p;
  try { p = new URL(raw); } catch (e) { return ''; }
  if (p.protocol !== 'https:' || p.username || p.password || !hostOk(p.hostname)) return '';
  return raw;
}
const thumbHost = h => THUMB_HOSTS.includes(h);
const pageHost = h => h === 'commons.wikimedia.org' || h.endsWith('.wikimedia.org') || h.endsWith('.wikipedia.org');
const anyHost = () => true;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// 저장 형태(photo 맵)로 정리. 필수(thumbUrl, pageUrl, match)가 틀리면 null. 저장된 값을 다시 검증할 때도 쓴다.
function build(src, match, fetchedAt) {
  const thumbUrl = safeUrl(src.thumbUrl, thumbHost), pageUrl = safeUrl(src.pageUrl, pageHost);
  if (!thumbUrl || !pageUrl || (match !== 'exact' && match !== 'brand')) return null;
  return {
    source: 'wikimedia',
    file: plainText(src.file, TEXT_MAX.file),
    pageUrl, thumbUrl,
    license: plainText(src.license, TEXT_MAX.license),
    licenseUrl: safeUrl(src.licenseUrl, anyHost),
    artist: plainText(src.artist, TEXT_MAX.artist),
    credit: plainText(src.credit, TEXT_MAX.credit),
    attributionRequired: src.attributionRequired !== false,   // 명시적으로 false 가 아니면 표기 필요로 본다
    match,
    fetchedAt
  };
}

// Worker 응답 -> photo 맵 또는 null(찾지 못함, 형식 이상)
export function photoFromResponse(body, now) {
  if (!isObj(body) || body.success !== true || body.found !== true || !isObj(body.image)) return null;
  return build(body.image, body.match, now);
}

// Firestore 에 저장된 photo 맵을 화면에 쓰기 전에 다시 검증(키를 아는 누구나 문서를 쓸 수 있으므로). hidden 이면 null.
export function validStoredPhoto(p) {
  if (!isObj(p) || p.source !== 'wikimedia' || p.hidden === true) return null;
  return build(p, p.match, typeof p.fetchedAt === 'number' ? p.fetchedAt : 0);
}
export const hasVisiblePhoto = p => validStoredPhoto(p) !== null;

// 가져오기용: hidden 값은 보존하고 나머지는 정리. 틀리면 null
export function sanitizeStoredPhoto(p) {
  if (!isObj(p) || p.source !== 'wikimedia') return null;
  const clean = build(p, p.match, typeof p.fetchedAt === 'number' ? p.fetchedAt : 0);
  if (!clean) return null;
  if (p.hidden === true) clean.hidden = true;
  return clean;
}

// 조회해도 되는지 판정하고, 해도 되면 정리된 이름을 돌려준다(아니면 null). tried(Map: 장소 ID -> 마지막 조회 이름)를 갱신한다.
// 막는 경우: 빈 이름, 사용자가 숨긴 사진, 같은 이름으로 이미 조회한 장소(성공, 실패, 타임아웃 모두 같은 이름으로는 다시 부르지 않는다).
export function shouldLookup(tried, poolId, name, photo) {
  const nm = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!nm) return null;
  if (photo && photo.hidden === true) return null;
  if (tried.get(poolId) === nm) return null;
  tried.set(poolId, nm);
  return nm;
}

// ---- 장소 이름 다국어 보강 ----
// 링크 해석 응답의 names(언어 코드 -> 이름)는 사진 검색의 alt 로 "그 자리에서 잠깐" 쓰고 버린다. 저장하지 않고, 화면에 보여 주지도 않는다
// (구글 콘텐츠 캐시 금지). 저장되는 이름은 사용자가 확정한 name 뿐이다.
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
export const ALT_MAX = 4;

// config.nameLangs -> 형식이 맞는 언어 코드 배열(중복 제거). 배열이 아니면 [].
export function cleanLangs(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) if (typeof x === 'string' && LANG_RE.test(x.trim()) && !out.includes(x.trim())) out.push(x.trim());
  return out;
}

// 링크 해석 호출에 붙일 쿼리 조각: "&langs=zh-TW,en" (없으면 '')
export function langsParam(langs) {
  const l = cleanLangs(langs);
  return l.length ? '&langs=' + l.join(',') : '';
}

const fold = s => s.replace(/\s+/g, ' ').trim().toLowerCase();

// 응답(names, names_status) -> 사진 검색에 넘길 alt 배열. 언어 순서대로 names[언어]를 쓰고,
// 값이 없거나 문자열이 아니거나 name 과(대소문자 무시) 같거나 이미 담은 것과 같으면 뺀다.
// names_status 가 'partial' 이거나 names 가 없으면 [](name 만으로 호출).
export function altNamesFrom(resp, langs, name) {
  if (!isObj(resp) || resp.names_status === 'partial' || !isObj(resp.names)) return [];
  const base = fold(String(name || ''));
  const out = [], seen = new Set([base]);
  for (const lang of cleanLangs(langs)) {
    const v = resp.names[lang];
    if (typeof v !== 'string') continue;
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t || t.length > NAME_MAX || seen.has(fold(t))) continue;
    seen.add(fold(t));
    out.push(t);
    if (out.length >= ALT_MAX) break;
  }
  return out;
}

// "위도,경도" 문자열 -> 정규화된 문자열 또는 null
export function parseCenter(v) {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(v == null ? '' : v));
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? lat + ',' + lon : null;
}

// deps: { getBaseUrl(), getCenter(), getRadiusKm(), fetchFn, timers: {setTimeout, clearTimeout}, now() }
export function createWiki(deps) {
  const { getBaseUrl, getCenter, getRadiusKm, fetchFn, timers, now } = deps;
  const none = { ok: false };

  return {
    // 이름으로 사진을 한 번 조회한다. 절대 던지지 않는다. 반환: { ok: true, photo } | { ok: false }
    // alts: 다른 언어 이름(선택). name 과 같은 것, 중복, 너무 긴 것은 보내지 않는다. 저장하지 않는다.
    async lookup(name, alts) {
      const base = getBaseUrl && getBaseUrl();
      const nm = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
      if (!base || !nm || nm.length > NAME_MAX) return none;

      const q = new URLSearchParams({ name: nm });
      const sent = new Set([fold(nm)]);
      for (const a of Array.isArray(alts) ? alts : []) {
        const t = typeof a === 'string' ? a.replace(/\s+/g, ' ').trim() : '';
        if (!t || t.length > NAME_MAX || sent.has(fold(t)) || sent.size > ALT_MAX) continue;
        sent.add(fold(t));
        q.append('alt', t);
      }
      const center = parseCenter(getCenter && getCenter());
      if (center) {
        q.set('near', center);
        const r = Number(getRadiusKm && getRadiusKm());
        if (isFinite(r) && r > 0) q.set('radiusKm', String(r));
      }

      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = timers.setTimeout(() => { if (ctl) ctl.abort(); }, WIKI_TIMEOUT_MS);
      try {
        const res = await fetchFn(String(base).replace(/\/+$/, '') + '/wiki?' + q.toString(), {
          method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined
        });
        if (res.status !== 200) return none;
        const photo = photoFromResponse(await res.json(), now());
        return photo ? { ok: true, photo } : none;
      } catch (e) {
        return none; // 네트워크, 타임아웃, 깨진 JSON: 조용히 사진 없음
      } finally {
        timers.clearTimeout(timer);
      }
    }
  };
}

// 이미지 아래 한 줄의 글자: "사진: {artist}, {license}, Wikimedia Commons" (비어 있는 항목은 건너뜀)
export function creditText(p) {
  return '사진: ' + [p.artist, p.license, 'Wikimedia Commons'].filter(Boolean).join(', ');
}

// 출처 한 줄 노드. license 글자는 licenseUrl 로, "Wikimedia Commons" 글자는 pageUrl 로 각각 링크한다(새 탭, noopener noreferrer).
// 링크 대상은 응답이 준 값만 쓰고, licenseUrl 이 없거나 틀리면 license 는 링크 없이 글자만 둔다. artist 는 링크 없이 그대로 표시한다.
function creditLine(h, p) {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const parts = [];
  if (p.artist) parts.push(p.artist);
  if (p.license) parts.push(p.licenseUrl ? link(p.licenseUrl, p.license) : p.license);
  parts.push(link(p.pageUrl, 'Wikimedia Commons'));
  const kids = ['사진: '];
  parts.forEach((part, i) => { if (i) kids.push(', '); kids.push(part); });
  return h('div', { class: 'photo-credit' }, kids);
}

// 카드에 넣을 사진 노드. h 는 app.js 의 h(tag, attrs, ...kids)(textContent 기반). 보여 줄 게 없으면 null.
// 썸네일 로드에 실패하면 사진 영역(figure)만 숨긴다.
export function renderPhoto(h, raw) {
  const p = validStoredPhoto(raw);
  if (!p) return null;
  const fig = h('figure', { class: 'place-photo' });
  const img = h('img', { src: p.thumbUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
  img.addEventListener('error', () => { fig.hidden = true; });
  fig.append(
    h('div', { class: 'photo-frame' }, img, p.match === 'brand' ? h('span', { class: 'photo-tag' }, BRAND_TAG) : null),
    creditLine(h, p));
  return fig;
}
