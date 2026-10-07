// 여행 키(= Firestore 의 trips/{키} 문서 ID). 코드와 저장소에 박아 두지 않고 "초대 링크"로만 전달한다.
//   초대 링크:  https://사이트/trip-app/#k=<uuid>
// 주소의 # 뒤쪽은 서버(GitHub Pages)와 Referer 로 전송되지 않는다. 앱이 처음 열릴 때 키를 localStorage 에 옮겨 담고
// 주소창에서는 지운다. 이 키가 곧 접근 권한이므로 로그, 에러 메시지, 내보내기 파일에 넣지 않는다.
// 모든 외부 의존(location, history, storage)은 주입받는다.

export const KEY_STORAGE = 'tripKey';

// UUID(대시 있음/없음 모두). 무작위 키는 crypto.randomUUID() 로 만든다.
const KEY_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// 형식이 맞으면 소문자 키, 아니면 null
export function normalizeKey(v) {
  const s = String(v == null ? '' : v).trim();
  return KEY_RE.test(s) ? s.toLowerCase() : null;
}

// 붙여넣은 값에서 키를 뽑는다: 키만 / 전체 링크(#k=…, ?k=…) 모두 허용. 못 찾으면 null
export function extractKey(text) {
  const s = String(text == null ? '' : text).trim();
  const bare = normalizeKey(s);
  if (bare) return bare;
  const m = s.match(/[#?&]k=([^&#\s]+)/);
  if (!m) return null;
  try { return normalizeKey(decodeURIComponent(m[1])); } catch (e) { return null; } // 깨진 % 인코딩
}

function readStored(storage) {
  try { return normalizeKey(storage && storage.getItem(KEY_STORAGE)); } catch (e) { return null; }
}

export function saveKey(storage, key) {
  try {
    storage.setItem(KEY_STORAGE, key);
    return storage.getItem(KEY_STORAGE) === key; // 실제로 읽히는지까지 확인(저장이 조용히 막힌 환경 대비)
  } catch (e) { return false; }
}

export function clearKey(storage) {
  try { storage.removeItem(KEY_STORAGE); } catch (e) { /* 무시 */ }
}

// 주소의 #k=… 에서 k 만 제거한 해시(나머지 파라미터는 보존). 비면 ''
function hashWithoutKey(params) {
  params.delete('k');
  const rest = params.toString();
  return rest ? '#' + rest : '';
}

// 우선순위: 주소의 #k= (새 키로 갈아타기 포함) > localStorage. 반환: { key, source: 'url' | 'storage' | null }
// 주소에서 읽은 키는 저장에 성공했을 때만 주소창에서 지운다(저장이 막힌 브라우저에서 새로고침 시 접근을 잃지 않게).
export function resolveKey({ location, history, storage }) {
  const hash = String(location.hash || '');
  const params = new URLSearchParams(hash.charAt(0) === '#' ? hash.slice(1) : hash);
  if (params.has('k')) {
    const fromUrl = normalizeKey(params.get('k'));
    const stored = fromUrl ? saveKey(storage, fromUrl) : false;
    if (!fromUrl || stored) {
      // 형식이 틀린 k 는 남겨 둘 이유가 없으니 같이 지운다.
      try { history.replaceState(null, '', location.pathname + (location.search || '') + hashWithoutKey(params)); } catch (e) { /* 무시 */ }
    }
    if (fromUrl) return { key: fromUrl, source: 'url' };
  }
  const key = readStored(storage);
  return { key, source: key ? 'storage' : null };
}

// 복사해서 보낼 초대 링크. 현재 페이지 주소에서 쿼리와 기존 해시는 버리고 키만 붙인다.
export function inviteLink(location, key) {
  return location.origin + location.pathname + '#k=' + key;
}
