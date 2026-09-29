// 앱 셸 캐시. 모든 경로는 서비스워커 위치 기준 상대경로라 레포 하위 경로 배포에서도 깨지지 않는다.
const CACHE = 'trip-shell-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'parse.js', 'trip-calc.js', 'legs.js', 'config.js', 'firebase.js',
  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 버전이 박힌 Firebase SDK 는 불변이므로 캐시 우선.
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  if (url.origin !== location.origin) return; // Firestore 등 다른 오리진은 건드리지 않는다.

  // 공유로 열릴 때 쿼리(?title=&text=&url=)가 붙으므로 네비게이션은 셸로 대체한다. 네트워크 우선.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('index.html')));
    return;
  }

  // 그 외 같은 오리진 파일은 네트워크 우선, 실패 시 캐시. 배포 즉시 새 코드가 반영된다.
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req))
  );
});
