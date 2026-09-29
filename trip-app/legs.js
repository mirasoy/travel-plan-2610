// 구간 이동시간 서비스. Worker POST /legs 호출, 메모리 캐시, 20쌍 분할.
// 저장 금지: 이동시간과 거리는 구글 약관의 캐싱 제한 때문에 localStorage, IndexedDB, Firestore, 내보내기 어디에도 두지 않는다.
// 캐시는 이 모듈의 메모리 Map 뿐이며 새로고침하면 사라진다.

export const MAX_PAIRS = 20;
const TIMEOUT_MS = 15000;

export function legKey(p) { return p.from + '|' + p.to + '|' + (p.at || ''); }

export function chunkPairs(pairs, size) {
  const n = size || MAX_PAIRS;
  const out = [];
  for (let i = 0; i < pairs.length; i += n) out.push(pairs.slice(i, i + n));
  return out;
}

export function createLegsService({ getResolverUrl, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const cache = new Map();     // key -> leg (응답 그대로)
  const failures = new Map();  // key -> reason (전체 실패 등). 자동 재시도하지 않는다.
  const inflight = new Map();  // key -> Promise
  const stats = { requests: 0, pairsSent: 0, log: [] }; // 테스트/디버그용 카운터(이동시간 값은 담지 않는다)

  const uniq = pairs => {
    const seen = new Set();
    return pairs.filter(p => { const k = legKey(p); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  // 응답의 legs 를 요청 쌍에 대응시킨다. 길이가 같으면 순서대로, 아니면 from|to 로 찾는다.
  function match(chunk, legs) {
    if (!Array.isArray(legs)) return chunk.map(() => null);
    if (legs.length === chunk.length && chunk.every((p, i) => legs[i] && legs[i].from === p.from && legs[i].to === p.to)) return legs.slice();
    const used = new Set();
    return chunk.map(p => {
      const i = legs.findIndex((l, idx) => !used.has(idx) && l && l.from === p.from && l.to === p.to);
      if (i < 0) return null;
      used.add(i);
      return legs[i];
    });
  }

  // 한 번의 POST. 반환: { fatal: boolean } (403/503 처럼 이후 호출도 소용없는 경우 true)
  async function post(chunk) {
    const base = getResolverUrl();
    const failAll = reason => chunk.forEach(p => failures.set(legKey(p), reason));
    if (!base) { failAll('off'); return { fatal: true }; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    stats.requests++;
    stats.pairsSent += chunk.length;
    stats.log.push(chunk.length);
    try {
      const res = await doFetch(base + '/legs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs: chunk.map(p => (p.at ? { from: p.from, to: p.to, at: p.at } : { from: p.from, to: p.to })) }),
        signal: ctl.signal
      });
      let j = null;
      try { j = await res.json(); } catch (e) { failAll('not_json'); return { fatal: false }; }
      if (res.status === 403) {
        console.error('[legs] 403 origin_not_allowed: resolver의 ALLOWED_ORIGINS를 확인하세요', j);
        failAll('origin_not_allowed'); return { fatal: true };
      }
      if (res.status === 503) {
        console.error('[legs] 503 no_key: Worker 의 GOOGLE_PLACES_KEY 를 확인하세요', j);
        failAll('no_key'); return { fatal: true };
      }
      if (!res.ok || !j || j.success === false) {
        console.error('[legs] http ' + res.status, j && j.error, j && j.detail);
        failAll((j && j.error) || 'http_' + res.status); return { fatal: false };
      }
      const legs = match(chunk, j.legs);
      chunk.forEach((p, i) => {
        if (legs[i]) cache.set(legKey(p), legs[i]); else failures.set(legKey(p), 'missing_leg');
      });
      return { fatal: false };
    } catch (e) {
      failAll(e && e.name === 'AbortError' ? 'timeout' : 'network');
      return { fatal: false };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    stats,
    // 조회. 결과: { leg } | { failed: reason } | { pending: true } | null(아직 요청 전)
    get(key) {
      if (cache.has(key)) return { leg: cache.get(key) };
      if (failures.has(key)) return { failed: failures.get(key) };
      if (inflight.has(key)) return { pending: true };
      return null;
    },
    // 캐시, 실패 기록, 진행 중 어디에도 없는 쌍만 (자동 재시도 없음)
    missing(pairs) {
      return uniq(pairs).filter(p => { const k = legKey(p); return !cache.has(k) && !failures.has(k) && !inflight.has(k); });
    },
    // 없는 쌍만 모아 20쌍씩 순차 POST. 끝나면 resolve.
    async ensure(pairs) {
      const need = this.missing(pairs);
      let run = null;
      if (need.length) {
        run = (async () => {
          const chunks = chunkPairs(need, MAX_PAIRS);
          let fatal = null;
          for (const c of chunks) {
            if (fatal) { c.forEach(p => failures.set(legKey(p), fatal)); continue; }
            const r = await post(c);
            if (r.fatal) fatal = failures.get(legKey(c[0])) || 'failed';
          }
        })().finally(() => { need.forEach(p => inflight.delete(legKey(p))); });
        need.forEach(p => inflight.set(legKey(p), run));
      }
      // 다른 호출이 이미 요청 중인 쌍도 기다린다.
      const waits = new Set();
      uniq(pairs).forEach(p => { const w = inflight.get(legKey(p)); if (w) waits.add(w); });
      await Promise.all([...waits]);
    },
    // 사용자가 배지를 탭했을 때만: 실패 기록과 캐시를 지우고 다시 요청한다.
    // (모드 하나만 실패한 구간은 응답 자체는 성공이라 캐시에 남아 있으므로 캐시도 비워야 재요청된다.)
    async retry(pairs) {
      uniq(pairs).forEach(p => { failures.delete(legKey(p)); cache.delete(legKey(p)); });
      await this.ensure(pairs);
    },
    size() { return cache.size; }
  };
}
