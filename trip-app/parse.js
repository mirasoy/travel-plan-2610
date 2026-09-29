// 구글맵 공유 텍스트 파서. DOM/Firebase 의존 없음(node 로도 테스트 가능).
// 이름/주소 자동 분리는 하지 않는다. URL 만 떼어내고 나머지는 그대로 둔다.

// 가정: 스킴(https://)이 붙은 URL 만 인식한다. 지시서의 두 형태 외에 goo.gl/maps, maps.google.* 도 허용.
const URL_RE = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)[^\s<>"']*/gi;

// 제거할 추적 파라미터. 그 외 파라미터(q, hl, data 등)는 지도 동작에 영향을 줄 수 있어 둔다.
const TRACK_RE = /^(entry|skid|coh|g_ep|g_st|shorturl|ved|ei|sa|opi|utm_[a-z]+)$/i;

export function cleanMapUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { return raw; }
  const drop = [];
  url.searchParams.forEach((_, k) => { if (TRACK_RE.test(k)) drop.push(k); });
  if (!drop.length) return raw; // 손대지 않으면 원본 인코딩 그대로 보존
  drop.forEach(k => url.searchParams.delete(k));
  return url.toString();
}

// 중복 비교용 키. 끝의 슬래시 차이만 무시한다. 단축 링크는 리다이렉트를 따라가지 않으므로 문자열 비교만 가능.
export function urlKey(u) {
  return String(u || '').replace(/\/+$/, '');
}

// 공유 파라미터(title, text, url)를 이어 붙인다. 셋에 같은 줄이 중복돼도 parseShare 에서 줄 단위로 제거된다.
export function joinShareParams(title, text, url) {
  return [title, text, url].filter(v => v && String(v).trim()).join('\n');
}

export function parseShare(input) {
  const src = String(input == null ? '' : input);
  const found = src.match(URL_RE) || [];
  let mapUrl = '';
  if (found.length) {
    // 끝에 붙은 문장부호는 URL 이 아니라고 본다.
    mapUrl = cleanMapUrl(found[0].replace(/[)\]}.,;:!?]+$/, ''));
  }
  const rest = src.replace(URL_RE, ' ');
  const seen = new Set();
  const lines = [];
  rest.split(/\r?\n/).forEach(l => {
    const t = l.replace(/\s+/g, ' ').trim();
    if (t && !seen.has(t)) { seen.add(t); lines.push(t); }
  });
  return {
    mapUrl,
    rawTitle: lines.join('\n'),
    name: lines.join(' ')
  };
}

// 풀 URL 에서 장소 이름만 뽑는다. 이름/주소 분리 같은 가공은 하지 않고 URL 에 든 문자열을 그대로 디코딩한다.
// 지원: /maps/place/<이름>/..., /maps/search/<이름>/..., ?q=<이름>. 좌표뿐이면 빈 문자열.
export function placeNameFromUrl(full) {
  let u;
  try { u = new URL(full); } catch (e) { return ''; }
  if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return '';
  const m = /\/maps\/(?:place|search)\/([^/@?]+)/.exec(u.pathname);
  let raw = m ? m[1] : (u.pathname.startsWith('/maps') ? (u.searchParams.get('q') || '') : '');
  raw = raw.replace(/\+/g, ' ');
  try { raw = decodeURIComponent(raw); } catch (e) { /* 그대로 사용 */ }
  raw = raw.replace(/\s+/g, ' ').trim();
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(raw)) return '';
  return raw;
}
