// 사용자가 직접 넣는 장소 사진. 순수 모듈(DOM, 저장소, 네트워크 접근 없음, h 는 주입).
// 두 가지 방식:
//   url    : 사진 주소(https)를 붙여넣는다. 장소 문서의 userPhoto = { kind: 'url', url }
//   upload : 폰에서 고른 사진을 줄여서(JPEG) Firestore 의 images/{장소ID} 문서에 data URL 로 저장한다.
//            장소 문서에는 userPhoto = { kind: 'upload', updatedAt } 표시만 남기고, 이미지 데이터는 카드가 보일 때만 따로 읽는다.
// 이미지는 앱이 다시 인코딩한 JPEG 이므로 위치 정보(EXIF)가 남지 않는다. 키를 아는 사람만 읽을 수 있는 데이터다(공개 저장소에 올라가지 않음).

export const URL_MAX = 2000;
export const DATA_MAX = 150 * 1000;                 // data URL 글자 수 상한. Firestore 문서 1MB 한도보다 한참 아래
export const SIZE_STEPS = [800, 640, 480, 360];     // 긴 변 픽셀. 위에서부터 시도
export const QUALITY_STEPS = [0.8, 0.65, 0.5];
export const CAPTION = '내가 올린 사진';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// https 이고 계정정보가 없는 주소만. 값은 파서가 아니라 입력 문자열(앞뒤 공백만 제거) 그대로 돌려준다. 아니면 ''.
export function cleanPhotoUrl(u) {
  if (typeof u !== 'string') return '';
  const raw = u.trim();
  if (!raw || raw.length > URL_MAX || /\s/.test(raw)) return '';
  let p;
  try { p = new URL(raw); } catch (e) { return ''; }
  if (p.protocol !== 'https:' || p.username || p.password || !p.hostname) return '';
  return raw;
}

// 우리가 만든 JPEG data URL 만 인정
const DATA_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
export function cleanDataUrl(s) {
  return typeof s === 'string' && s.length <= DATA_MAX && DATA_RE.test(s) ? s : '';
}

// 장소 문서에 저장된 userPhoto 를 검증. 틀리면 null
export function cleanUserPhoto(v) {
  if (!isObj(v)) return null;
  if (v.kind === 'url') { const url = cleanPhotoUrl(v.url); return url ? { kind: 'url', url } : null; }
  if (v.kind === 'upload') return { kind: 'upload', updatedAt: typeof v.updatedAt === 'number' && isFinite(v.updatedAt) ? v.updatedAt : 0 };
  return null;
}

// 가져오기용: 이미지 데이터(images 컬렉션)는 내보내기에 들어 있지 않으므로 주소 방식만 남긴다.
export function importableUserPhoto(v) {
  const c = cleanUserPhoto(v);
  return c && c.kind === 'url' ? c : null;
}

// 긴 변이 max 를 넘으면 비율을 유지해 줄인다(키우지 않는다). 반환: { w, h }
export function fitSize(w, h, max) {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// encode(w, h, quality) -> data URL. 크기와 화질을 단계적으로 낮춰 DATA_MAX 안에 들어가는 첫 결과를 돌려준다. 못 맞추면 null.
export function shrinkToLimit(srcW, srcH, encode) {
  for (const max of SIZE_STEPS) {
    const { w, h } = fitSize(srcW, srcH, max);
    if (!w) return null;
    for (const q of QUALITY_STEPS) {
      const out = cleanDataUrl(encode(w, h, q));
      if (out) return { dataUrl: out, w, h };
    }
  }
  return null;
}

// 카드에 넣을 사진 노드. src 는 이미 검증된 주소/데이터 URL. 로드에 실패하면 사진 영역만 숨긴다.
export function renderUserPhoto(h, src) {
  if (!src) return null;
  const fig = h('figure', { class: 'place-photo' });
  const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
  img.addEventListener('error', () => { fig.hidden = true; });
  fig.append(h('div', { class: 'photo-frame' }, img), h('div', { class: 'photo-credit' }, CAPTION));
  return fig;
}
