// "내 정보" 모달. h, openSheet, toast 와 vault(코어), 타이머, document, clipboard 를 주입받아
// 앱 밖(테스트)에서도 돌아간다. 응답 데이터는 클로저 변수와 화면 노드에만 있고, 어떤 저장소에도 쓰지 않는다.
// 값은 가려진 동안 DOM 에 텍스트로 존재하지 않는다(눌러서 보는 10초 동안만 노드에 들어간다).
import { REVEAL_MS, IDLE_MS } from './vault.js';

export const MASK = '••••••••';
const NOTE_IDLE = '60초 동안 조작이 없어서 화면의 정보를 지웠어요';
const NOTE_BG = '화면이 백그라운드로 가서 정보를 지웠어요';

let active = false; // 모달 중복 오픈 방지(설정 화면과 항공편 섹션 버튼이 같은 모달을 연다)

export function openVaultModal(deps) {
  if (active) return null;
  active = true;
  const { h, openSheet, toast, vault, timers, doc, clipboard } = deps;

  let token = null;            // 메모리에만. 모달을 닫으면 지운다. (기억 옵션은 vault 코어가 localStorage 에 따로 처리)
  let data = null;             // 화면에 그릴 응답. 잠금, 닫기 때 지운다.
  let phase = 'input';         // input | loading | data | locked
  let note = '';               // 안내/오류 문구. 토큰도 응답 내용도 담지 않는다.
  let rememberOn = false;
  let closed = false;
  let idleTimer = null;
  const revealTimers = new Set();
  const body = h('div', { class: 'vault-body' });

  const clearIdle = () => { if (idleTimer != null) { timers.clearTimeout(idleTimer); idleTimer = null; } };

  function wipeScreen() {
    clearIdle();
    revealTimers.forEach(t => timers.clearTimeout(t));
    revealTimers.clear();
    data = null;
    body.textContent = ''; // 그려 둔 그룹, 항목, 보이는 값 노드를 전부 떼어낸다
  }

  function lock(message) {
    if (closed || phase !== 'data') return;
    wipeScreen();
    phase = 'locked';
    note = message;
    render();
  }

  // 조작이 있을 때마다 무조작 타이머를 다시 건다(데이터가 떠 있을 때만).
  function poke() {
    if (closed || phase !== 'data') return;
    clearIdle();
    idleTimer = timers.setTimeout(() => lock(NOTE_IDLE), IDLE_MS);
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') lock(NOTE_BG);
  }

  function itemRow(it) {
    let timer = null;
    let shown = false;
    const val = h('button', { type: 'button', class: 'vault-val', 'aria-label': it.label + ' 값 보기' }, MASK);
    const hide = () => {
      if (timer != null) { timers.clearTimeout(timer); revealTimers.delete(timer); timer = null; }
      shown = false;
      val.textContent = MASK;
      val.className = 'vault-val';
    };
    val.addEventListener('click', () => {
      poke();
      if (shown) { hide(); return; }
      shown = true;
      val.textContent = it.value;
      val.className = 'vault-val shown';
      timer = timers.setTimeout(hide, REVEAL_MS);
      revealTimers.add(timer);
    });
    const copy = h('button', { type: 'button', class: 'btn small', 'aria-label': it.label + ' 복사' }, '복사');
    copy.addEventListener('click', () => {
      poke();
      if (!clipboard || typeof clipboard.writeText !== 'function') { toast('복사하지 못했어요'); return; }
      Promise.resolve().then(() => clipboard.writeText(it.value))
        .then(() => toast('복사했어요'), () => toast('복사하지 못했어요'));
    });
    return h('div', { class: 'vault-item' },
      h('div', { class: 'vault-label' }, it.label),
      h('div', { class: 'vault-line' }, val, copy));
  }

  async function submit(t, remember) {
    if (closed || phase === 'loading') return;
    rememberOn = remember;
    phase = 'loading';
    note = '';
    render();
    const r = await vault.fetchVault(t);
    if (closed) return; // 조회 중에 모달이 닫히면 결과를 버린다
    if (r.ok) {
      token = t.trim();
      if (remember) vault.rememberToken(token); else vault.forgetToken();
      if (doc.visibilityState === 'hidden') {
        phase = 'locked';
        note = NOTE_BG;
      } else {
        data = r.data;
        phase = 'data';
        note = '';
        poke();
      }
    } else {
      // 저장돼 있던 토큰이 틀린 것으로 판명되면 지운다(429, 네트워크 오류는 토큰 탓이 아니므로 남긴다).
      if (r.kind === 'unauthorized') { vault.forgetToken(); token = null; }
      phase = 'input';
      note = r.message;
    }
    render();
  }

  function inputView() {
    const input = h('input', {
      class: 'input', type: 'password', name: 'vault-token', autocomplete: 'current-password',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: '토큰'
    });
    const chk = h('input', { type: 'checkbox', id: 'vault-remember' });
    chk.checked = rememberOn;
    const saved = vault.getRememberedToken();
    const form = h('form', {
      class: 'vault-form',
      onsubmit: e => { e.preventDefault(); const v = input.value; input.value = ''; submit(v, chk.checked); }
    },
      input,
      h('label', { class: 'vault-remember', for: 'vault-remember' }, chk, ' 이 기기에서 기억'),
      h('button', { type: 'submit', class: 'btn primary block' }, '조회'));
    return h('div', null,
      note && h('div', { class: 'notice', role: 'alert' }, note),
      form,
      saved && h('button', { type: 'button', class: 'btn small block', onclick: () => submit(saved, true) }, '저장된 토큰으로 다시 조회'));
  }

  function dataView() {
    const groups = data.groups.length
      ? data.groups.map(g => h('section', { class: 'vault-group' },
          h('h4', null, g.title),
          g.items.length ? g.items.map(itemRow) : h('div', { class: 'notice info' }, '항목이 없어요')))
      : h('div', { class: 'notice info' }, '표시할 정보가 없어요');
    return h('div', null,
      data.updatedAt && h('div', { class: 'vault-updated' }, '갱신 ' + data.updatedAt),
      groups,
      h('div', { class: 'vault-hint' }, '값을 누르면 10초 동안 보여요. 60초 동안 조작이 없으면 지워져요.'),
      rememberOn && h('button', {
        type: 'button', class: 'btn small block',
        onclick: () => { poke(); vault.forgetToken(); rememberOn = false; toast('이 기기에서 토큰을 지웠어요'); render(); }
      }, '이 기기에서 토큰 잊기'));
  }

  function lockedView() {
    return h('div', null,
      note && h('div', { class: 'notice info', role: 'status' }, note),
      h('button', { type: 'button', class: 'btn primary block', onclick: () => submit(token, rememberOn) }, '다시 조회'));
  }

  function render() {
    if (closed) return;
    body.textContent = '';
    if (phase === 'loading') body.append(h('p', null, '조회 중...'));
    else if (phase === 'data') body.append(dataView());
    else if (phase === 'locked') body.append(lockedView());
    else body.append(inputView());
  }

  function cleanup() {
    if (closed) return; // 두 번 불려도 다른 모달의 active 플래그를 건드리지 않게
    closed = true;
    wipeScreen();
    token = null;
    doc.removeEventListener('visibilitychange', onVisibility);
    active = false;
  }

  const close = openSheet(closeSheet => {
    const root = h('div', { class: 'vault' },
      h('h3', null, '내 정보'),
      body,
      h('button', { type: 'button', class: 'btn block', onclick: () => closeSheet() }, '닫기'));
    root.addEventListener('pointerdown', poke);
    root.addEventListener('keydown', poke);
    root.addEventListener('scroll', poke, true);
    return root;
  }, cleanup);

  doc.addEventListener('visibilitychange', onVisibility);

  const saved = vault.getRememberedToken();
  if (saved) submit(saved, true); // 기억해 둔 토큰이 있으면 열자마자 조회
  else render();
  return close;
}
