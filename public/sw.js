// MyNote 오프라인 앱 셸 캐싱용 서비스 워커
// - Vite 해시 에셋(/assets/*): Cache-First (불변 파일이므로 즉시 응답)
// - HTML/기타 동일 출처 요청: Network-First + 오프라인 캐시 폴백
const CACHE_NAME = 'mynote-shell-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 동일 출처의 앱 셸/정적 에셋만 캐싱 (Firebase, Gemini API 등 외부 요청은 통과)
  if (url.origin !== self.location.origin) return;

  // Vite 빌드 해시 에셋은 내용이 불변이므로 Cache-First로 즉시 로드
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
