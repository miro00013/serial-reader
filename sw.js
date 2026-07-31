// Service Worker: 初回アクセス時に全ファイルをキャッシュし、以降は完全オフラインで動作します。
// （機内モードでも読み取りできる＝外部にデータを送信していないことを、誰でも確認できます）
const CACHE = 'serial-reader-v1';
const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './terms.html',
  './sample.jpg',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './vendor/tesseract-core.wasm.js',
  './vendor/tesseract-core-simd.wasm.js',
  './vendor/tesseract-core-lstm.wasm.js',
  './vendor/tesseract-core-simd-lstm.wasm.js',
  './vendor/lang/eng.traineddata.gz'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isApp = url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname.endsWith('app.js');
  if (isApp) {
    // アプリ本体はネットワーク優先（更新を反映）、オフライン時はキャッシュ
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // OCRエンジン等はキャッシュ優先（大きく、変わらないため）
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
