// 링크 처리 유틸. DOM/Firebase 의존 없음(node 로도 테스트 가능).
// 이름 결정은 여기서 하지 않는다. 이름은 Worker 응답을 사용자가 화면에서 확인한 값만 저장한다.

// 입력 텍스트에서 URL 하나만 뽑는다. https 로 시작하는 지정 호스트만 인정, 공백 전까지.
const URL_RE = /https:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps|google\.com\/maps|maps\.google\.com)[^\s<>"']*/i;

// 제거할 추적 파라미터. 그 외 파라미터(q, hl, data 등)는 지도 동작에 영향을 줄 수 있어 둔다.
const TRACK_RE = /^(entry|skid|coh|g_ep|g_st|shorturl|ved|ei|sa|opi|utm_[a-z]+)$/i;

export function extractMapUrl(text) {
  const m = String(text == null ? '' : text).match(URL_RE);
  // 문장부호가 URL 끝에 붙어 온 경우(괄호, 마침표 등)만 잘라낸다.
  return m ? m[0].replace(/[)\]}.,;:!?]+$/, '') : '';
}

export function cleanMapUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { return raw; }
  const drop = [];
  url.searchParams.forEach((_, k) => { if (TRACK_RE.test(k)) drop.push(k); });
  if (!drop.length) return raw; // 손대지 않으면 원본 인코딩 그대로 보존
  drop.forEach(k => url.searchParams.delete(k));
  return url.toString();
}

// 중복 비교용 키(fid 가 없을 때). 끝의 슬래시 차이만 무시한다. 단축 링크는 리다이렉트를 따라가지 않으므로 문자열 비교만 가능.
export function urlKey(u) {
  return String(u || '').replace(/\/+$/, '');
}

// 공유 파라미터(title, text, url)를 이어 붙인다. 이름 후보로는 쓰지 않고, 여기서 URL 만 추출된다.
export function joinShareParams(title, text, url) {
  return [title, text, url].filter(v => v && String(v).trim()).join('\n');
}

// 지도 열기 주소. 우선순위: mapUrl > placeId > cid > 이름+도시 검색. 아무것도 없으면 ''.
export function mapOpenUrl(p, destinationCity) {
  if (p.mapUrl) return p.mapUrl;
  if (p.placeId) {
    const q = encodeURIComponent(p.rawTitle || p.name || '');
    return 'https://www.google.com/maps/search/?api=1&query=' + q + '&query_place_id=' + encodeURIComponent(p.placeId);
  }
  if (p.cid) return 'https://maps.google.com/?cid=' + encodeURIComponent(p.cid);
  const name = String(p.name || '').trim();
  if (name) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((name + ' ' + (destinationCity || '')).trim());
  }
  return '';
}
