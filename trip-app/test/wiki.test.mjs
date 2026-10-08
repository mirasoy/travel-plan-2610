import test from 'node:test';
import assert from 'node:assert/strict';
import { createWiki, shouldLookup, BRAND_TAG, photoFromResponse, validStoredPhoto, sanitizeStoredPhoto, hasVisiblePhoto, plainText, parseCenter, creditText, renderPhoto, WIKI_TIMEOUT_MS } from '../wiki.js';
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

test('URL 검증: 썸네일은 thumb/upload.wikimedia.org https 만, 페이지는 위키 https. 그 밖은 사진 없음. 쿼리스트링은 응답 그대로 보존', () => {
  const bad = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://upload.wikimedia.org/a.jpg', 'https://evil.example/a.jpg',
    'https://upload.wikimedia.org.evil.example/a.jpg', 'https://user:pw@upload.wikimedia.org/a.jpg', '//upload.wikimedia.org/a.jpg', '', null, 5, 'x'.repeat(2100),
    'https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg?width=640', 'https://sub.upload.wikimedia.org/a.jpg', 'https://wikimedia.org/a.jpg'];
  for (const u of bad) assert.equal(photoFromResponse(okBody({}, { thumbUrl: u }), 1), null, 'thumb ' + String(u).slice(0, 40));
  for (const u of ['javascript:alert(1)', 'http://commons.wikimedia.org/x', 'https://evil.example/', 'https://commons.wikimedia.org.evil.example/x', null]) assert.equal(photoFromResponse(okBody({}, { pageUrl: u }), 1), null, 'page ' + String(u));
  assert.ok(photoFromResponse(okBody({}, { pageUrl: 'https://ko.wikipedia.org/wiki/File:X.jpg' }), 1), '위키백과 호스트 허용');
  // 쿼리스트링(utm_...)을 지우거나 정규화하지 않고 그대로 저장, 표시한다
  for (const u of ['https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/FAKE.jpg/640px-FAKE.jpg?utm_source=app&utm_medium=card&utm_campaign=x%20y',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/FAKE.jpg/640px-FAKE.jpg?utm_source=app',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/FAKE.jpg/640px-FAKE.jpg?a=1&a=2&b=%ED%95%9C#frag']) {
    assert.equal(photoFromResponse(okBody({}, { thumbUrl: u }), 1).thumbUrl, u, '원본 그대로: ' + u);
  }
  assert.equal(photoFromResponse(okBody({}, { thumbUrl: '  ' + THUMB + '?utm_source=x  ' }), 1).thumbUrl, THUMB + '?utm_source=x', '앞뒤 공백만 다듬는다');
  // URL 파서가 정규화하면 값이 바뀌는 입력(한글, 공백, 대문자 호스트, 기본 포트, 소문자 %2f, 경로 없음)도 응답 그대로 보존한다
  for (const u of ['https://upload.wikimedia.org/a.jpg?utm_term=한글 검색&u=A%2fb', 'HTTPS://UPLOAD.WIKIMEDIA.ORG/a.jpg?utm_source=X', 'https://upload.wikimedia.org:443/a.jpg?q=1',
    'https://thumb.wikimedia.org/a/../b.jpg?utm_source=x', 'https://thumb.wikimedia.org?utm_source=x']) {
    assert.notEqual(new URL(u).href, u, '이 입력은 정규화하면 달라진다(테스트가 정규화 변이를 구분할 수 있다): ' + u);
    assert.equal(photoFromResponse(okBody({}, { thumbUrl: u }), 1).thumbUrl, u, '정규화하지 않고 그대로: ' + u);
  }
  assert.equal(photoFromResponse(okBody({}, { pageUrl: PAGE + '?utm_source=x' }), 1).pageUrl, PAGE + '?utm_source=x');
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

test('25초 타임아웃(Worker 내부 예산 20초): 응답이 없으면 중단하고 사진 없음, 타이머는 정리, 자동 재시도 없음', async () => {
  assert.equal(WIKI_TIMEOUT_MS, 25000);
  const hang = make((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const p = hang.wiki.lookup('x');
  hang.timers.advance(20000); assert.equal(hang.timers.pending(), 1, 'Worker 예산 20초가 지나도 클라이언트는 아직 대기(20초에 끊지 않는다)');
  hang.timers.advance(WIKI_TIMEOUT_MS - 20000 - 1); assert.equal(hang.timers.pending(), 1, '24.999초에도 대기');
  hang.timers.advance(1);
  assert.deepEqual(await p, { ok: false });
  assert.equal(hang.timers.pending(), 0);
  hang.timers.advance(120000);
  assert.equal(hang.fetchFn.calls.length, 1, '재시도 없음');
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

test('카드 렌더링(app.js 의 실제 h 사용): 썸네일, 출처 한 줄(license, Wikimedia Commons 각각 링크), brand 태그, 숨김/오류 처리', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const exact = photoFromResponse(okBody(), 1);
  const fig = renderPhoto(h, exact);
  const img = byTag(fig, 'img')[0];
  assert.equal(img.attrs.src, THUMB);
  assert.equal(img.attrs.alt, '');
  assert.equal(img.attrs.referrerpolicy, 'no-referrer');
  const credit = byClass(fig, 'photo-credit')[0];
  assert.equal(credit.textContent, '사진: FAKE Artist, CC BY-SA 4.0, Wikimedia Commons');
  const links = byTag(credit, 'a');
  assert.deepEqual(links.map(a => a.textContent), ['CC BY-SA 4.0', 'Wikimedia Commons'], 'license 글자와 Wikimedia Commons 글자가 각각 링크, artist 는 링크 아님');
  assert.deepEqual(links.map(a => a.attrs.href), ['https://creativecommons.org/licenses/by-sa/4.0', PAGE], '링크 대상은 응답이 준 licenseUrl, pageUrl 그대로');
  for (const a of links) assert.deepEqual([a.attrs.target, a.attrs.rel], ['_blank', 'noopener noreferrer']);
  assert.equal(byClass(fig, 'photo-tag').length, 0, 'exact 는 브랜드 태그 없음');
  const brand = renderPhoto(h, photoFromResponse(okBody({ match: 'brand' }), 1));
  assert.deepEqual(byClass(brand, 'photo-tag').map(n => n.textContent), ['브랜드 대표 사진(다른 지점일 수 있음)']);
  assert.equal(BRAND_TAG, '브랜드 대표 사진(다른 지점일 수 있음)');
  img.dispatch('error');
  assert.equal(fig.hidden, true, '썸네일 로드 실패: 사진 영역만 숨김');
  assert.equal(renderPhoto(h, { ...exact, hidden: true }), null);
  assert.equal(renderPhoto(h, null), null);
});

test('출처 줄 변형: licenseUrl 이 없으면 license 는 글자만, license/artist 가 비면 건너뜀, Wikimedia Commons 링크는 항상', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const line = over => { const f = renderPhoto(h, photoFromResponse(okBody({}, over), 1)); const c = byClass(f, 'photo-credit')[0]; return [c.textContent, byTag(c, 'a').map(a => a.textContent)]; };
  assert.deepEqual(line({ licenseUrl: '' }), ['사진: FAKE Artist, CC BY-SA 4.0, Wikimedia Commons', ['Wikimedia Commons']], 'licenseUrl 이 없으면 license 링크를 만들어 내지 않는다');
  assert.deepEqual(line({ licenseUrl: 'javascript:alert(1)' }), ['사진: FAKE Artist, CC BY-SA 4.0, Wikimedia Commons', ['Wikimedia Commons']]);
  assert.deepEqual(line({ artist: '' }), ['사진: CC BY-SA 4.0, Wikimedia Commons', ['CC BY-SA 4.0', 'Wikimedia Commons']]);
  assert.deepEqual(line({ license: '', licenseUrl: '' }), ['사진: FAKE Artist, Wikimedia Commons', ['Wikimedia Commons']]);
  assert.deepEqual(line({ artist: '', license: '', licenseUrl: '' }), ['사진: Wikimedia Commons', ['Wikimedia Commons']]);
  assert.equal(creditText({ artist: '', license: '' }), '사진: Wikimedia Commons');
});

test('artist 는 변형하지 않는다: "User:이름" 형태 그대로 표시, 링크 아님', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  for (const name of ['User:이름', 'User:Foo_Bar', 'User:A  B', 'User:Name (talk)', 'Name/Sub', '이름 · Name']) {
    const p = photoFromResponse(okBody({}, { artist: name }), 1);
    assert.equal(p.artist, name, '저장값이 원본과 같다: ' + name);
    const c = byClass(renderPhoto(h, p), 'photo-credit')[0];
    assert.ok(c.textContent.startsWith('사진: ' + name + ', '), '표시도 그대로: ' + name);
    assert.ok(!byTag(c, 'a').some(a => a.textContent === name), 'artist 는 링크로 만들지 않는다');
  }
  assert.equal(photoFromResponse(okBody({}, { artist: '  User:이름  ' }), 1).artist, 'User:이름', '앞뒤 공백만 다듬는다');
  assert.equal(plainText('User:이름', 100), 'User:이름');
});

test('응답의 추가 필드(version, trace 등)는 무시한다: 저장하지도 표시하지도 않는다', async () => {
  const body = okBody({ version: 3, trace: { id: 'FAKE-TRACE', steps: ['a', 'b'] }, debug: 'x' }, { trace: 'FAKE-IMG-TRACE', version: 2, extra: { a: 1 } });
  const { wiki } = make(() => fakeResponse(200, body));
  const { photo } = await wiki.lookup('x');
  assert.deepEqual(Object.keys(photo).sort(), ['artist', 'attributionRequired', 'credit', 'fetchedAt', 'file', 'license', 'licenseUrl', 'match', 'pageUrl', 'source', 'thumbUrl']);
  const saved = JSON.stringify(photo);
  assert.ok(!/trace|version|FAKE-TRACE|FAKE-IMG-TRACE|debug|extra/i.test(saved), '저장 값에 없다: ' + saved.slice(0, 80));
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const shown = renderPhoto(h, photo);
  let all = ''; walk(shown, n => { if (n.nodeType === 3) all += n.text; else all += Object.values(n.attrs).join(' '); });
  assert.ok(!/trace|version|FAKE-/i.test(all), '화면(글자, 속성)에도 없다');
  const r = parseExport(JSON.stringify({ pool: [{ id: 'a', name: 'n', photo: { ...photo, trace: 'FAKE-TRACE', version: 9 } }] }));
  assert.ok(!JSON.stringify(r.docs[0].data).match(/trace|version/i), '가져오기도 걸러낸다');
});

test('저장 문서가 HTML 을 품어도 화면에서 태그가 실행되지 않는다(요소 생성 0), 평문은 건드리지 않는다', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  // 정리를 우회해 Firestore 에 직접 쓴 위조 문서
  const forged = { ...photoFromResponse(okBody(), 1), artist: '<img src=x onerror=alert(1)>', license: '<b>CC</b>', hidden: false };
  const fig = renderPhoto(h, forged);
  let bad = 0; walk(fig, n => { if (n.nodeType === 1 && ['FIGURE', 'DIV', 'IMG', 'A', 'SPAN'].indexOf(n.tagName) === -1) bad += 1; });
  assert.equal(bad, 0, '허용된 요소(figure, div, img, a, span)만 존재');
  assert.equal(byTag(fig, 'img').length, 1, '썸네일 img 하나뿐(artist 의 img 태그가 요소가 되지 않음)');
  // 렌더러가 저장된 값도 한 번 더 정리한다: 태그만 있던 artist 는 사라지고 <b>CC</b> 는 CC 가 된다
  assert.equal(byClass(fig, 'photo-credit')[0].textContent, '사진: CC, Wikimedia Commons');
  // 정리 없이 값이 그대로 들어간다 해도 textContent 라 요소가 되지 않음을 h 단에서 확인
  const raw = h('a', null, '<img src=x onerror=alert(1)>');
  assert.equal(byTag(raw, 'img').length, 0);
  assert.equal(raw.textContent, '<img src=x onerror=alert(1)>');
  // 마크업 기호가 없는 평문(사용자명)은 그대로
  assert.equal(plainText('User:<이름', 50), 'User:<이름', '닫는 > 가 없는 < 는 태그가 아니므로 그대로(textContent 라 안전)');
  assert.equal(plainText('User:<b>이름</b>', 50), 'User: 이름', '실제 태그만 걷는다');
  assert.equal(plainText('A & B', 50), 'A & B', '단독 & 는 엔티티가 아니므로 그대로');
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

test('license 는 응답 그대로 저장하고 표시한다(버전이 다른 CC BY-SA 3.0, 4.0 등), 글자수 제한으로 잘리지 않는다', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const licenses = ['CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC BY-SA 2.5', 'CC BY 2.0', 'CC BY-SA 3.0 de', 'CC0', 'Public domain', 'GFDL 1.2',
    'Creative Commons Attribution-Share Alike 4.0 International', 'GNU Free Documentation License 1.2 or later', 'L'.repeat(150)];
  for (const lic of licenses) {
    const p = photoFromResponse(okBody({}, { license: lic }), 1);
    assert.equal(p.license, lic, '저장값이 응답과 같다: ' + lic.slice(0, 40));
    const credit = byClass(renderPhoto(h, p), 'photo-credit')[0];
    assert.ok(credit.textContent.includes(', ' + lic + ', Wikimedia Commons'), '표시도 그대로: ' + lic.slice(0, 40));
    assert.equal(byTag(credit, 'a')[0].textContent, lic, 'license 링크 글자가 응답 그대로');
  }
  assert.equal(photoFromResponse(okBody({}, { license: '  CC BY-SA 4.0  ' }), 1).license, 'CC BY-SA 4.0', '앞뒤 공백만 다듬는다');
});

test('출처 표기는 이미지 바로 아래에 항상 보인다: 접거나 숨기는 요소 없음, 순서(이미지 영역 다음), 스타일에 숨김/말줄임 없음', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const fig = renderPhoto(h, photoFromResponse(okBody({ match: 'brand' }), 1));
  assert.deepEqual(fig.children.map(c => c.className), ['photo-frame', 'photo-credit'], '이미지 영역 바로 다음이 출처 줄');
  const credit = fig.children[1];
  assert.ok(!credit.hidden && !('hidden' in credit.attrs) && !/hidden|collapsed/.test(credit.className));
  let tags = []; walk(fig, n => { if (n.nodeType === 1) tags.push(n.tagName); });
  assert.ok(!tags.includes('DETAILS') && !tags.includes('SUMMARY'), '접는 요소(details, summary)를 쓰지 않는다');
  assert.ok(!('title' in credit.attrs), '툴팁에만 있는 표기가 아니다');
  // 출처 줄은 사진 영역의 자식이 아니라 형제여서 이미지 오버레이(태그)에 가려지지 않는다
  assert.ok(!byClass(fig.children[0], 'photo-credit').length);
  const css = readApp('style.css');
  const block = (css.match(/\.photo-credit[^{]*\{[^}]*\}/g) || []).join('\n');
  assert.ok(block.includes('.photo-credit'), 'photo-credit 스타일을 찾지 못함');
  assert.ok(!/display\s*:\s*none|visibility\s*:\s*hidden|overflow\s*:\s*hidden|text-overflow|line-clamp|max-height|opacity\s*:\s*0|font-size\s*:\s*0|height\s*:\s*0/.test(block), '출처 줄을 숨기거나 자르는 스타일이 없다');
  // 사진이 로드 실패해 영역이 숨겨질 때는 figure 전체가 숨는다(출처만 홀로 남지 않는다)
  byTag(fig, 'img')[0].dispatch('error');
  assert.equal(fig.hidden, true);
});

test('화면 문구에 이모지가 없다(브랜드 태그, 출처 줄)', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const fig = renderPhoto(h, photoFromResponse(okBody({ match: 'brand' }), 1));
  assert.ok(!/\p{Extended_Pictographic}/u.test(fig.textContent + BRAND_TAG));
});
