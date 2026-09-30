// "내 정보" 금고 조회 코어. Worker 의 POST {resolverUrl}/vault 만 부른다.
// 네트워크, 저장소, 타이머는 전부 주입받는다. 응답 데이터는 반환값으로만 넘기고 어디에도 쓰지 않는다
// (저장소, 캐시, 콘솔, Firestore 모두 금지). 저장하는 것은 사용자가 "기억"을 켰을 때의 토큰 하나뿐이다.

export const TOKEN_KEY = 'vaultToken';
export const REVEAL_MS = 10 * 1000;   // 값 보기 유지 시간
export const IDLE_MS = 60 * 1000;     // 무조작 시 데이터 제거
const TIMEOUT_MS = 15 * 1000;

// 오류 문구에는 토큰도 응답 내용도 넣지 않는다.
export const MESSAGES = {
  empty: '토큰을 입력해 주세요',
  noResolver: 'Worker 주소가 설정되지 않았어요',
  unauthorized: '토큰이 달라요',
  serverConfig: '서버 설정을 확인해 주세요',
  network: '연결을 확인해 주세요',
  unknown: '조회하지 못했어요'
};

// Retry-After(초) -> 분 단위로 올림. 헤더가 없거나 숫자가 아니면 시간 없이 안내한다.
export function tooManyMessage(retryAfter) {
  const sec = Number(retryAfter);
  const base = '잠시 뒤에 다시 시도해 주세요';
  if (!isFinite(sec) || sec <= 0) return base;
  return base + '(' + Math.ceil(sec / 60) + '분 뒤)';
}

// 계약된 구조만 골라 문자열로 정규화한다. 그 밖의 필드는 버린다.
// 반환: { updatedAt, groups: [{ title, items: [{ label, value }] }] } 또는 null(구조가 맞지 않음)
export function normalizeVault(body) {
  const d = body && body.success === true ? body.data : null;
  if (!d || !Array.isArray(d.groups)) return null;
  const str = v => (v == null ? '' : String(v));
  return {
    updatedAt: str(d.updatedAt),
    groups: d.groups.map(g => ({
      title: str(g && g.title),
      items: (g && Array.isArray(g.items) ? g.items : []).map(it => ({ label: str(it && it.label), value: str(it && it.value) }))
    }))
  };
}

const failure = (kind, message) => ({ ok: false, kind, message });

// deps: { getBaseUrl(), fetchFn, storage: {getItem,setItem,removeItem}, timers: {setTimeout, clearTimeout} }
export function createVault(deps) {
  const { getBaseUrl, fetchFn, storage, timers } = deps;

  return {
    // 저장소 접근이 막힌 환경(시크릿 모드 등)에서도 앱이 죽지 않게 전부 감싼다.
    getRememberedToken() {
      try { return (storage && storage.getItem(TOKEN_KEY)) || null; } catch (e) { return null; }
    },
    rememberToken(token) {
      try { storage.setItem(TOKEN_KEY, token); return true; } catch (e) { return false; }
    },
    forgetToken() {
      try { storage.removeItem(TOKEN_KEY); } catch (e) { /* 무시 */ }
    },

    // 성공: { ok: true, data } / 실패: { ok: false, kind, message }
    // 토큰은 Authorization 헤더로만 보낸다(URL, 쿼리, 본문에 넣지 않는다). 실패 응답의 본문은 읽지 않는다.
    async fetchVault(token) {
      const base = getBaseUrl && getBaseUrl();
      if (!base) return failure('noResolver', MESSAGES.noResolver);
      const t = String(token || '').trim();
      if (!t) return failure('empty', MESSAGES.empty);

      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = timers.setTimeout(() => { if (ctl) ctl.abort(); }, TIMEOUT_MS);
      try {
        const res = await fetchFn(String(base).replace(/\/+$/, '') + '/vault', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + t },
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: ctl ? ctl.signal : undefined
        });
        if (res.status === 200) {
          let body = null;
          try { body = await res.json(); } catch (e) { return failure('unknown', MESSAGES.unknown); }
          const data = normalizeVault(body);
          return data ? { ok: true, data } : failure('unknown', MESSAGES.unknown);
        }
        if (res.status === 401) return failure('unauthorized', MESSAGES.unauthorized);
        if (res.status === 429) return failure('tooMany', tooManyMessage(res.headers && res.headers.get('Retry-After')));
        if (res.status === 503 || res.status === 500 || res.status === 403) return failure('serverConfig', MESSAGES.serverConfig);
        return failure('unknown', MESSAGES.unknown);
      } catch (e) {
        // 예외 객체에는 아무것도 싣지 않는다(로그도 남기지 않는다).
        return failure('network', MESSAGES.network);
      } finally {
        timers.clearTimeout(timer);
      }
    }
  };
}
