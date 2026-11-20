/* sw.js - 静态资源秒开；页面在线取新版，断网回退缓存 */
var CACHE = 'wensmile-score-v12';
var SHARECODE = 'CHZSSC6P7N';
var Q = '?sharecode=' + SHARECODE;
var V = '?v=110&sharecode=' + SHARECODE;

var ASSETS = [
  './index.html' + V,
  './styles.css' + V,
  './app.js' + V,
  './projects.js' + V,
  './quota.js' + V,
  './local-auth.js' + V,
  './config.js' + V,
  './manifest.json' + Q,
  './icon-192.png' + Q,
  './icon-512.png' + Q,
  './apple-touch-icon.png' + Q,
  './splash.jpg' + Q,
  './vendor/workbuddy-cloud-sdk.js' + Q
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
          if (res && res.ok) return c.put(u, res);
        }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function putCopy(req, res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return res;
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
  return res;
}

function networkFirst(req) {
  return fetch(req, { cache: 'no-store' }).then(function (res) {
    return putCopy(req, res);
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      return hit || caches.match('./index.html' + Q) || caches.match('./index.html' + V);
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate' &&
      (url.pathname === '/' || url.pathname === '/index.html') &&
      !url.searchParams.get('sharecode')) {
    e.respondWith(Response.redirect(location.origin + '/' + Q, 302));
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req));
    return;
  }

  var staticAsset = req.destination === 'script' || req.destination === 'style' ||
    req.destination === 'image' || req.destination === 'font' ||
    /\.(?:css|js|json|png|jpe?g|webp|svg|woff2?)$/i.test(url.pathname);

  if (staticAsset) {
    e.respondWith(caches.match(req).then(function (hit) {
      if (hit) {
        fetch(req, { cache: 'reload' }).then(function (res) { putCopy(req, res); }).catch(function () {});
        return hit;
      }
      return fetch(req, { cache: 'reload' }).then(function (res) { return putCopy(req, res); });
    }));
    return;
  }

  e.respondWith(networkFirst(req));
});
