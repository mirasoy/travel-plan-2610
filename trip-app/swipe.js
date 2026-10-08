// 일정 카드의 "왼쪽으로 밀면 삭제 버튼" 제스처 판정. 순수 함수(DOM, 타이머 없음)라 테스트로 지킨다.
// DOM 쪽(app.js)은 포인터 이벤트 좌표와 시각만 넘기고, 돌려받은 offset 으로 카드를 움직인다.
//
// 설계 요점
// - 방향 판정: 처음 LOCK_PX 이상 움직였을 때 가로 이동이 세로의 1.5배를 넘어야 "가로 스와이프"로 잠근다.
//   그렇지 않으면 세로 스크롤로 보고 즉시 손을 뗀다(스크롤을 가로채지 않는다).
// - offset: -openPx(삭제 버튼이 다 보임) ~ 0(닫힘) 으로 제한.
// - 손을 뗄 때: 빠르게 튕기면(FLICK) 그 방향을 따르고, 아니면 닫힘에서는 40% 이상 끌었을 때 열리고
//   열림에서는 40% 이상 되돌렸을 때 닫힌다(양쪽 모두 같은 체감 거리).

export const OPEN_PX = 88;
export const LOCK_PX = 8;
export const X_BIAS = 1.5;          // 가로 이동이 세로의 몇 배여야 가로로 잠그는가
export const SNAP_RATIO = 0.4;
export const FLICK_PX_PER_MS = 0.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createSwipe(opts) {
  const openPx = (opts && opts.openPx) || OPEN_PX;
  let s = null;

  return {
    // 포인터를 눌렀을 때. isOpen: 이 카드가 이미 열려 있는가
    start(x, y, t, isOpen) {
      s = { x0: x, y0: y, base: isOpen ? -openPx : 0, startOpen: !!isOpen, lock: null, offset: isOpen ? -openPx : 0, lastX: x, lastT: t, v: 0 };
    },

    // 움직일 때. 반환: null(추적 중이 아님) | { lock: null | 'x' | 'y', offset }
    move(x, y, t) {
      if (!s || s.lock === 'y') return s ? { lock: 'y', offset: s.offset } : null;
      const dx = x - s.x0, dy = y - s.y0;
      if (!s.lock) {
        if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return { lock: null, offset: s.offset };
        s.lock = Math.abs(dx) > Math.abs(dy) * X_BIAS ? 'x' : 'y';
        if (s.lock === 'y') return { lock: 'y', offset: s.offset };
      }
      s.offset = clamp(s.base + dx, -openPx, 0);
      const dt = t - s.lastT;
      if (dt > 0) s.v = (x - s.lastX) / dt;   // px/ms, 음수가 왼쪽
      s.lastX = x; s.lastT = t;
      return { lock: 'x', offset: s.offset };
    },

    // 손을 뗐을 때. 반환: { swiped, open }  (swiped=false 면 탭이거나 세로 스크롤: 상태를 바꾸지 않는다)
    end() {
      if (!s) return { swiped: false, open: false };
      const r = s;
      s = null;
      if (r.lock !== 'x') return { swiped: false, open: r.startOpen };
      let open;
      if (r.v <= -FLICK_PX_PER_MS) open = true;
      else if (r.v >= FLICK_PX_PER_MS) open = false;
      else open = r.startOpen ? r.offset <= -openPx * (1 - SNAP_RATIO) : r.offset <= -openPx * SNAP_RATIO;
      return { swiped: true, open };
    },

    cancel() { s = null; }
  };
}
