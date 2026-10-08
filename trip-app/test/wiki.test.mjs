import test from 'node:test';
import assert from 'node:assert/strict';
import { createWiki, shouldLookup, photoFromResponse, validStoredPhoto, sanitizeStoredPhoto, hasVisiblePhoto, plainText, parseCenter, creditText, renderPhoto, WIKI_TIMEOUT_MS } from '../wiki.js';
import { parseExport } from '../trip-import.js';
import { fakeTimers, fakeFetch, fakeResponse, FakeDocument, FakeElement, loadAppHelpers, byTag, byClass, walk, readApp } from './helpers.mjs';

const BASE = 'https://resolver.example.test';
const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/FAKE.jpg/640px-FAKE.jpg';
const PAGE = 'https://commons.wikimedia.org/wiki/File:FAKE.jpg';
const okBody = (over, imgOver) => Object.assign({
  success: true, found: true, match: 'exact', entityId: 'Q1', label: 'FAKE',
  image: Object.assign({ file: 'FAKE.jpg', pageUrl: PAGE, thumbUrl: THUMB, thumbWidth: 640, thumbHeight: 480, fullUrl: 'https://upload.wikimedia.org/x.jpg',
    license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', artist: 'FAKE Artist', credit: 'Own work', attributionRequired: true }, imgOver)
}, over);

function make(handler, extra) {
  const fetchFn = fakeFetch(handler), timers = fakeTimers();
  const wiki = createWiki(Object.assign({ getBaseUrl: () => BASE, getCenter: () => '25.0,121.5', getRadiusKm: () => 80, fetchFn, timers, now: () => 1234 }, extra));
  return { wiki, fetchFn, timers };
}

test('요청: GET /wiki?name&near&radiusKm. 이름은 공백 정리, 좌표는 여행지 중심만, 자격증명/리퍼러 없음', async () => {
  const { wiki, fetchFn } = make(() => fakeResponse(200, okBody()));
  const r = await wiki.lookup('  딘타이펑   본점 ');
  assert.equal(r.ok, true);
  const { url, init } = fetchFn.calls[0];
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, BASE + '/wiki');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['name', 'near', 'radiusKm']);
  assert.equal(u.searchParams.get('name'), '딘타이펑 본점');
  assert.equal(u.searchParams.get('near'), '25,121.5');
  assert.equal(u.searchParams.get('radiusKm'), '80');
  assert.deepEqual([init.method, init.credentials, init.referrerPolicy], ['GET', 'omit', 'no-referrer']);
  assert.ok(!('body' in init) && !('headers' in init), '본문, 커스텀 헤더 없음(사전 요청이 필요 없는 단순 요청)');
});

test('near/radiusKm 은 선택: 중심 좌표가 비었거나 형식이 틀리면 둘 다 보내지 않는다. 반경이 이상하면 near 만', async () => {
  for (const center of ['', null, undefined, 'abc', '91,0', '0,181', '25.0', '25.0,121.5,3']) {
    const { wiki, fetchFn } = make(() => fakeResponse(200, okBody()), { getCenter: () => center });
    await wiki.lookup('x');
    assert.deepEqual([...new URL(fetchFn.calls[0].url).searchParams.keys()], ['name'], String(center));
  }
  for (const radius of [0, -5, NaN, 'x', null]) {
    const { wiki, fetchFn } = make(() => fakeResponse(200, okBody()), { getCenter: () => '25.0,121.5', getRadiusKm: () => radius });
    await wiki.lookup('x');
    assert.deepEqual([...new URL(fetchFn.calls[0].url).searchParams.keys()].sort(), ['name', 'near'], String(radius));
  }
  assert.equal(parseCenter(' 25.03 , 121.56 '), '25.03,121.56');
  assert.equal(parseCenter('-33.8,151.2'), '-33.8,151.2');
});

test('요청하지 않는 경우: 주소 없음, 빈 이름, 너무 긴 이름', async () => {
  const a = make(() => fakeResponse(200, okBody()), { getBaseUrl: () => '' });
  assert.deepEqual(await a.wiki.lookup('x'), { ok: false });
  const b = make(() => fakeResponse(200, okBody()));
  for (const bad of ['', '   ', null, undefined, 5, 'x'.repeat(201)]) assert.deepEqual(await b.wiki.lookup(bad), { ok: false });
  assert.equal(b.fetchFn.calls.length + a.fetchFn.calls.length, 0);
});

test('found true: 저장 필드는 정해진 것뿐이고 이미지 데이터가 없다', async () => {
  const { wiki } = make(() => fakeResponse(200, okBody({ match: 'brand' })));
  const { photo } = await wiki.lookup('x');
  assert.deepEqual(Object.keys(photo).sort(), ['artist', 'attributionRequired', 'credit', 'fetchedAt', 'file', 'license', 'licenseUrl', 'match', 'pageUrl', 'source', 'thumbUrl']);
  assert.deepEqual([photo.source, photo.match, photo.fetchedAt, photo.attributionRequired], ['wikimedia', 'brand', 1234, true]);
  assert.equal(photo.thumbUrl, THUMB);
  const s = JSON.stringify(photo);
  assert.ok(!/data:|base64|;base64,/i.test(s) && s.length < 1500, '이미지 본문/base64 없음, 문서가 작다: ' + s.length);
  assert.ok(!('fullUrl' in photo) && !('thumbWidth' in photo) && !('entityId' in photo), '응답의 나머지 필드는 저장하지 않는다');
});

test('found false, success false, 이미지 없음, match 이상: 사진 없음', () => {
  assert.equal(photoFromResponse({ success: true, found: false, reason: 'no_match' }, 1), null);
  assert.equal(photoFromResponse({ success: false, found: true, match: 'exact', image: okBody().image }, 1), null);
  // found 가 false 인데 Worker 가 image 를 같이 보내더라도 사진으로 취급하지 않는다(찾지 못했다는 신호가 우선)
  assert.equal(photoFromResponse({ success: true, found: false, match: 'exact', image: okBody().image }, 1), null);
  assert.equal(photoFromResponse({ success: true, found: 'true', match: 'exact', image: okBody().image }, 1), null, 'found 는 정확히 true 일 때만');
  assert.equal(photoFromResponse({ success: 'true', found: true, match: 'exact', image: okBody().image }, 1), null, 'success 도 정확히 true 일 때만');
  assert.equal(photoFromResponse({ success: true, found: true, match: 'exact' }, 1), null);
  assert.equal(photoFromResponse({ success: true, found: true, match: 'exact', image: 'x' }, 1), null);
  for (const m of [undefined, null, 'fuzzy', 'EXACT', 5]) assert.equal(photoFromResponse(okBody({ match: m }), 1), null, String(m));
  for (const b of [null, undefined, 'x', 5, [], {}]) assert.equal(photoFromResponse(b, 1), null);
});

test('URL 검증: 썸네일은 위키미디어 https, 페이지는 위키 https. 그 밖(javascript:, data:, http, 외부 도메인, 계정정보)은 사진 없음', () => {
  const bad = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://upload.wikimedia.org/a.jpg', 'https://evil.example/a.jpg',
    'https://upload.wikimedia.org.evil.example/a.jpg', 'https://user:pw@upload.wikimedia.org/a.jpg', '//upload.wikimedia.org/a.jpg', '', null, 5, 'x'.repeat(1100)];
  for (const u of bad) assert.equal(photoFromResponse(okBody({}, { thumbUrl: u }), 1), null, 'thumb ' + String(u).slice(0, 30));
  for (const u of ['javascript:alert(1)', 'http://commons.wikimedia.org/x', 'https://evil.example/', 'https://commons.wikimedia.org.evil.example/x', null]) assert.equal(photoFromResponse(okBody({}, { pageUrl: u }), 1), null, 'page ' + String(u));
  assert.ok(photoFromResponse(okBody({}, { pageUrl: 'https://ko.wikipedia.org/wiki/File:X.jpg' }), 1), '위키백과 호스트 허용');
  assert.ok(photoFromResponse(okBody({}, { thumbUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg?width=640' }), 1), 'Special:FilePath 허용');
  assert.equal(photoFromResponse(okBody({}, { licenseUrl: 'javascript:alert(1)' }), 1).licenseUrl, '', '라이선스 링크가 틀려도 사진은 살리고 링크만 비움');
});

test('실패는 전부 조용히 사진 없음: 400, 403, 404, 500, 502, 503, 네트워크, 깨진 JSON. 던지지도 로그도 남기지도 않는다', async () => {
  const logged = []; const orig = ['log', 'info', 'warn', 'error', 'debug'].map(k => [k, console[k]]);
  orig.forEach(([k]) => { console[k] = (...a) => logged.push([k, a]); });
  try {
    for (const status of [400, 403, 404, 500, 502, 503]) {
      const { wiki } = make(() => fakeResponse(status, { success: false, error: 'FAKE-ERR' }));
      assert.deepEqual(await wiki.lookup('x'), { ok: false }, String(status));
    }
    assert.deepEqual(await make(() => { throw new Error('offline'); }).wiki.lookup('x'), { ok: false });
    assert.deepEqual(await make(() => ({ status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad json'); } })).wiki.lookup('x'), { ok: false });
    assert.deepEqual(await make(() => fakeResponse(200, 'not an object')).wiki.lookup('x'), { ok: false });
  } finally { orig.forEach(([k, f]) => { console[k] = f; }); }
  assert.deepEqual(logged, [], '콘솔 출력 없음');
});

test('10초 타임아웃: 응답이 없으면 중단하고 사진 없음, 타이머는 정리, 자동 재시도 없음', async () => {
  const hang = make((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const p = hang.wiki.lookup('x');
  hang.timers.advance(WIKI_TIMEOUT_MS - 1); assert.equal(hang.timers.pending(), 1, '9.999초에는 아직 대기');
  hang.timers.advance(1);
  assert.deepEqual(await p, { ok: false });
  assert.equal(hang.timers.pending(), 0);
  hang.timers.advance(60000);
  assert.equal(hang.fetchFn.calls.length, 1, '재시도 없음');
  assert.equal(WIKI_TIMEOUT_MS, 10000);
  const fast = make(() => fakeResponse(200, okBody())); await fast.wiki.lookup('x');
  assert.equal(fast.timers.pending(), 0, '성공해도 타이머가 남지 않는다');
});

test('평문 변환: 태그, script, 엔티티, 공백, 길이. HTML 이 들어와도 화면용 문자열에 태그가 남지 않는다', () => {
  assert.equal(plainText('<a href="https://x">FAKE Name</a>', 100), 'FAKE Name');
  assert.equal(plainText('A &amp; B &lt;3 &quot;q&quot;', 100), 'A & B <3 "q"');
  assert.equal(plainText('<script>alert(1)</script>Safe', 100), 'Safe', 'script 는 내용째 제거');
  assert.equal(plainText('<style>.x{}</style><b>Bold</b>\n  text', 100), 'Bold text');
  assert.equal(plainText('x'.repeat(300), 160).length, 160);
  assert.equal(plainText(5, 10), '');
  const p = photoFromResponse(okBody({}, { artist: '<img src=x onerror=alert(1)>FAKE <b>Artist</b>', credit: '<svg onload=alert(2)>c', license: '<script>x</script>CC BY' }), 1);
  assert.deepEqual([p.artist, p.credit, p.license], ['FAKE Artist', 'c', 'CC BY']);
});

test('저장된 photo 를 다시 검증: 숨김이면 안 보임, 출처가 틀리거나 URL 이 위조되면 안 보임, 숨김 플래그는 가져오기에서 보존', () => {
  const good = photoFromResponse(okBody(), 5);
  assert.ok(validStoredPhoto(good) && hasVisiblePhoto(good));
  assert.equal(validStoredPhoto({ ...good, hidden: true }), null);
  assert.equal(hasVisiblePhoto({ ...good, hidden: true }), false);
  assert.equal(validStoredPhoto({ ...good, source: 'google' }), null, '구글 출처는 받지 않는다');
  assert.equal(validStoredPhoto({ ...good, thumbUrl: 'javascript:alert(1)' }), null);
  assert.equal(validStoredPhoto({ ...good, match: 'x' }), null);
  for (const bad of [null, undefined, 'x', [], 5]) assert.equal(validStoredPhoto(bad), null);
  assert.equal(sanitizeStoredPhoto({ ...good, hidden: true }).hidden, true);
  assert.equal(sanitizeStoredPhoto({ ...good, hidden: 'yes' }).hidden, undefined);
  assert.equal(sanitizeStoredPhoto({ ...good, thumbUrl: 'http://x' }), null);
  assert.deepEqual(Object.keys(sanitizeStoredPhoto({ ...good, extra: 'x', image: 'AAAA', base64: 'AAAA' })).sort(), Object.keys(good).sort(), '알 수 없는 필드(이미지 데이터 포함)는 버린다');
});

test('가져오기: pool 의 photo 는 검증, 틀리면 그 필드만 버림(문서는 유지, 건수에 반영)', () => {
  const good = photoFromResponse(okBody(), 5);
  const r = parseExport(JSON.stringify({ pool: [
    { id: 'a', name: 'n', photo: { ...good, hidden: true, blob: 'AAAA' } },
    { id: 'b', name: 'n', photo: { ...good, thumbUrl: 'javascript:alert(1)' } },
    { id: 'c', name: 'n', photo: 'oops' },
    { id: 'd', name: 'n' }
  ] }));
  const d = id => r.docs.find(x => x.id === id).data;
  assert.equal(d('a').photo.hidden, true);
  assert.ok(!('blob' in d('a').photo));
  assert.ok(!('photo' in d('b')) && !('photo' in d('c')));
  assert.equal(d('b').name, 'n');
  assert.equal(r.sanitized, 2);
});

test('카드 렌더링(app.js 의 실제 h 사용): 썸네일, 출처 한 줄, 링크 속성, brand 태그, 숨김/오류 처리', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const exact = photoFromResponse(okBody(), 1);
  const fig = renderPhoto(h, exact);
  const img = byTag(fig, 'img')[0], a = byTag(fig, 'a')[0];
  assert.equal(img.attrs.src, THUMB);
  assert.equal(img.attrs.alt, '');
  assert.equal(img.attrs.referrerpolicy, 'no-referrer');
  assert.equal(a.textContent, '사진: FAKE Artist, CC BY-SA 4.0, Wikimedia Commons');
  assert.deepEqual([a.attrs.href, a.attrs.target, a.attrs.rel], [PAGE, '_blank', 'noopener noreferrer']);
  assert.equal(byClass(fig, 'photo-tag').length, 0, 'exact 는 브랜드 태그 없음');
  assert.deepEqual(renderPhoto(h, photoFromResponse(okBody({ match: 'brand' }), 1)) && byClass(renderPhoto(h, photoFromResponse(okBody({ match: 'brand' }), 1)), 'photo-tag').map(n => n.textContent), ['브랜드 대표 사진']);
  img.dispatch('error');
  assert.equal(fig.hidden, true, '썸네일 로드 실패: 사진 영역만 숨김');
  assert.equal(renderPhoto(h, { ...exact, hidden: true }), null);
  assert.equal(renderPhoto(h, null), null);
  assert.equal(creditText({ artist: '', license: '', }), '사진: Wikimedia Commons');
  assert.equal(creditText({ artist: '', license: 'CC0' }), '사진: CC0, Wikimedia Commons');
});

test('저장 문서가 HTML 을 품어도 화면에서 태그가 실행되지 않는다(요소 생성 0, 글자 그대로 평문)', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  // 정상 경로(정리됨)와, 정리를 우회해 Firestore 에 직접 쓴 위조 문서 모두
  const forged = { ...photoFromResponse(okBody(), 1), artist: '<img src=x onerror=alert(1)>', license: '<b>CC</b>', hidden: false };
  const fig = renderPhoto(h, forged);
  let bad = 0; walk(fig, n => { if (n.nodeType === 1 && ['FIGURE', 'DIV', 'IMG', 'A', 'SPAN'].indexOf(n.tagName) === -1) bad += 1; });
  assert.equal(bad, 0, '허용된 요소(figure, div, img, a, span)만 존재');
  assert.equal(byTag(fig, 'img').length, 1, '썸네일 img 하나뿐(artist 의 img 태그가 요소가 되지 않음)');
  // 렌더러가 저장된 값도 한 번 더 평문으로 정리한다: 태그만 있던 artist 는 사라지고 <b>CC</b> 는 CC 가 된다
  assert.equal(byTag(fig, 'a')[0].textContent, '사진: CC, Wikimedia Commons');
  // 정리 없이 값이 그대로 들어간다 해도 textContent 라 요소가 되지 않음을 h 단에서 확인
  const raw = h('a', null, '<img src=x onerror=alert(1)>');
  assert.equal(byTag(raw, 'img').length, 0);
  assert.equal(raw.textContent, '<img src=x onerror=alert(1)>');
});

test('소스 규칙: 순수 모듈(DOM, 저장소, 콘솔, innerHTML 없음), 구글 사진 필드/이미지 데이터 저장 코드 없음', () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const code = strip(readApp('wiki.js'));
  for (const re of [/document\./, /window\./, /localStorage|sessionStorage|indexedDB|caches/, /console\s*\./, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /FileReader|readAsDataURL|toDataURL|Blob\b|btoa\(/, /eval\(|new Function/]) assert.ok(!re.test(code), String(re));
  for (const f of ['app.js', 'wiki.js', 'trip-import.js']) {
    const c = strip(readApp(f));
    assert.ok(!/photoReference|photo_reference|maps\/api\/place\/photo|places\.googleapis\.com\/v1\/.*photos|googleusercontent/.test(c), f + ' 에 구글 사진 참조가 있다');
  }
});

test('중복 호출 방지: 같은 이름은 다시 부르지 않고, 이름이 바뀌면 다시 부른다. 숨긴 사진과 빈 이름은 부르지 않는다', () => {
  const tried = new Map();
  assert.equal(shouldLookup(tried, 'p1', '  딘타이펑   본점 ', null), '딘타이펑 본점', '공백 정리된 이름을 돌려준다');
  assert.equal(shouldLookup(tried, 'p1', '딘타이펑 본점', null), null, '같은 이름은 중복 호출하지 않는다(성공, 실패와 무관)');
  assert.equal(shouldLookup(tried, 'p1', '딘타이펑   본점', null), null, '공백만 다른 같은 이름도 동일 취급');
  assert.equal(shouldLookup(tried, 'p1', '딘타이펑 신이점', null), '딘타이펑 신이점', '이름이 바뀌면 다시 부른다');
  assert.equal(shouldLookup(tried, 'p1', '딘타이펑 본점', null), '딘타이펑 본점', '바뀐 뒤에는 이전 이름도 다시 허용(연속 중복만 막는다)');
  assert.equal(shouldLookup(tried, 'p2', '딘타이펑 본점', null), '딘타이펑 본점', '장소별로 따로 센다');
  const t2 = new Map();
  assert.equal(shouldLookup(t2, 'p1', '이름', { hidden: true }), null, '숨긴 사진은 다시 적용하지 않는다');
  assert.equal(t2.size, 0, '숨김으로 막힌 호출은 기록하지 않는다');
  assert.equal(shouldLookup(t2, 'p1', '이름', { hidden: false }), '이름');
  for (const bad of ['', '   ', null, undefined, 5]) assert.equal(shouldLookup(new Map(), 'p', bad, null), null);
});
