import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readApp, APP_DIR } from './helpers.mjs';

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

// 금고 모듈이 응답 데이터를 밖으로 내보낼 수 있는 통로를 소스 수준에서도 막아 둔다(동작 테스트와 이중 안전장치).
test('금고 모듈(vault.js, vault-ui.js)은 저장, 캐시, 로그, 전송 API 를 아예 쓰지 않는다', () => {
  const forbidden = [
    ['sessionStorage', /sessionStorage/], ['localStorage(직접 접근은 app.js 어댑터만)', /localStorage/],
    ['indexedDB', /indexedDB/], ['Cache Storage', /\bcaches\b/], ['console', /console\s*\./],
    ['Firestore/Firebase', /setDoc|updateDoc|addDoc|getDoc|firebase/i], ['파일 내보내기', /\bBlob\b|createObjectURL|download/],
    ['직렬화', /JSON\.stringify/], ['외부 전송', /sendBeacon|postMessage|BroadcastChannel|XMLHttpRequest|WebSocket/],
    ['쿠키', /document\.cookie/], ['주소창', /location\.|history\./], ['eval', /\beval\(|new Function/]
  ];
  for (const file of ['vault.js', 'vault-ui.js']) {
    const code = stripComments(readApp(file));
    for (const [name, re] of forbidden) assert.ok(!re.test(code), file + ' 에서 금지 항목 발견: ' + name);
  }
});

test('JSON 내보내기(exportJson)는 금고를 건드리지 않는다', () => {
  const m = readApp('app.js').match(/^async function exportJson\(\) \{[\s\S]*?^\}/m);
  assert.ok(m, 'exportJson 을 찾지 못함');
  assert.ok(!/vault/i.test(m[0]));
});

test('app.js 의 금고 연결부는 localStorage 어댑터 한 곳뿐이고 sessionStorage 를 새로 쓰지 않는다', () => {
  const app = readApp('app.js');
  const block = app.match(/\/\* ---------- 내 정보\(금고\) ---------- \*\/[\s\S]*?\/\* ---------- 초대 링크\(여행 키\)/)[0];
  assert.ok(!/sessionStorage|indexedDB|caches|console\./.test(block));
  assert.equal((block.match(/localStorage\./g) || []).length, 3, 'getItem, setItem, removeItem 어댑터 3줄만');
  assert.ok(!/vaultToken/.test(app), '키 이름은 vault.js 한 곳에서만 정의한다');
});

test('Worker 코드는 레포에 두지 않는다: worker/ 폴더 없음, .gitignore 에 worker/ 와 .secret-patterns', () => {
  const root = path.join(APP_DIR, '..');
  assert.ok(!fs.existsSync(path.join(root, 'worker')));
  const ig = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ig.includes('worker/') && ig.includes('.secret-patterns'));
  const readme = readApp('README.md');
  assert.ok(!/```/.test(readme.split('## Worker 사용 계약')[1] || ''), 'README 의 Worker 계약 절에는 코드 블록을 넣지 않는다');
});

test('위키 사진 조회는 장소 저장/이름 변경 지점에서만 시작된다(목록을 열 때마다 부르지 않는다)', () => {
  const app = readApp('app.js');
  assert.equal((app.match(/\bwiki\.lookup\(/g) || []).length, 1, 'lookup 호출은 requestPhoto 안의 한 곳');
  assert.equal((app.match(/\brequestPhoto\(/g) || []).length, 5, '정의 1 + 호출 4(새 장소 저장, 이름 정해짐, 일정 카드 이름 수정, 장소 목록 이름 수정)');
  const fn = name => { const m = app.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm')); assert.ok(m, name + ' 를 찾지 못함'); return m[0]; };
  assert.equal((fn('registerAndAdd').match(/requestPhoto\(/g) || []).length, 2);
  // 이름 수정 저장 핸들러(itemCard 안): 이름을 실제로 바꾸는 쓰기 바로 뒤의 한 곳만
  const card = fn('itemCard');
  assert.equal((card.match(/requestPhoto\(/g) || []).length, 1);
  assert.match(card, /updateDoc\(doc\(poolCol, p\.id\), \{ name: t \}\)[^\n]*\n\s*requestPhoto\(p\.id, t\);/, '이름이 실제로 바뀔 때만 호출');
  assert.ok(!/wiki\./.test(card));
  const places = fn('openPlacesSheet');
  assert.equal((places.match(/requestPhoto\(/g) || []).length, 1);
  assert.match(places, /if \(patch\.name\) requestPhoto\(p\.id, t\);/, '이름이 실제로 바뀔 때만 호출');
  assert.ok(!/wiki\./.test(places));
  for (const name of ['renderPlanBody', 'renderPlan', 'renderSettings', 'renderSummary', 'showTab', 'renderAll', 'subscribe', 'init']) {
    assert.ok(!/requestPhoto|wiki\./.test(fn(name)), name + ' 에서 사진 조회를 시작하면 안 된다');
  }
  // 내가 올린 사진 데이터(data URL)는 images 컬렉션에만, 한 함수(commitUserPhoto)에서만 쓴다. 장소 문서(pool)에는 표시(userPhoto)만 들어간다.
  const commit = fn('commitUserPhoto');
  assert.equal((app.match(/imagesCol/g) || []).length, 5, 'imagesCol 은 정의 1 + 읽기 1 + commit 쓰기/삭제 2 + 장소 삭제 1');
  assert.match(commit, /batch\.set\(doc\(imagesCol, p\.id\), image\)/);
  assert.match(commit, /batch\.update\(doc\(poolCol, p\.id\), \{ userPhoto \}\)/);
  assert.ok(!/dataUrl/.test(app.replace(commit, '').match(/updateDoc\([^\n]*poolCol[^\n]*\)/g)?.join('\n') || ''), 'pool 문서 갱신에 이미지 데이터가 섞이면 안 된다');
  assert.ok(!/localStorage[^\n]*(dataUrl|userImgs)|sessionStorage[^\n]*(dataUrl|userImgs)/.test(app), '올린 사진을 브라우저 저장소에 따로 넣지 않는다');
  const photoWrites = app.match(/photo[^\n]*updateDoc|updateDoc[^\n]*photo|setDoc[^\n]*photo/g) || [];
  assert.ok(photoWrites.every(l => !/base64|dataUrl|toDataURL/.test(l)));
});
