// ══════════════════════════════════════════════════════════════
// sw.js — 戰術兵力識別系統 Service Worker
// 策略：Cache-First for shell，Network-First for tiles
// 版本號更新將觸發快取刷新
// ══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'tactical-iff-v10';
const SHELL_CACHE   = CACHE_VERSION + '-shell';
const TILE_CACHE    = CACHE_VERSION + '-tiles';

// ── 離線核心資源（App Shell）──────────────────────────────────
// 這些檔案在 install 階段全數預快取，確保離線可用
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  // Leaflet CDN（預先快取，離線地圖功能可用）
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

// ── 動態快取設定 ───────────────────────────────────────────────
const TILE_CACHE_MAX = 500;   // 最多快取 500 張地圖圖磚
const TILE_HOSTS = [
  'mt0.google.com', 'mt1.google.com',
  'mt2.google.com', 'mt3.google.com',
  'tile.openstreetmap.org',
];

// ══════════════════════════════════════════════════════════════
// Install — 預快取 App Shell
// ══════════════════════════════════════════════════════════════
self.addEventListener('install', function(event){
  console.log('[SW] Installing', CACHE_VERSION);
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function(cache){
      // 逐一加入，單筆失敗不中斷整體安裝
      return Promise.allSettled(
        SHELL_ASSETS.map(function(url){
          return cache.add(url).catch(function(err){
            console.warn('[SW] 預快取失敗（跳過）:', url, err.message);
          });
        })
      );
    }).then(function(){
      console.log('[SW] App Shell 快取完成');
      // 強制立即接管頁面，不等待舊 SW 失效
      return self.skipWaiting();
    })
  );
});

// ══════════════════════════════════════════════════════════════
// Activate — 清除舊版快取
// ══════════════════════════════════════════════════════════════
self.addEventListener('activate', function(event){
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(function(keyList){
      return Promise.all(
        keyList.map(function(key){
          // 刪除非當前版本的所有快取
          if(key !== SHELL_CACHE && key !== TILE_CACHE){
            console.log('[SW] 刪除舊快取:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(function(){
      // 立即控制所有 clients
      return self.clients.claim();
    })
  );
});

// ══════════════════════════════════════════════════════════════
// Fetch — 攔截所有網路請求
// ══════════════════════════════════════════════════════════════
self.addEventListener('fetch', function(event){
  var url = new URL(event.request.url);

  // ── 1. 地圖圖磚：Network-First，有網路就抓新的並快取
  if(isTileRequest(url)){
    event.respondWith(handleTile(event.request));
    return;
  }

  // ── 2. App Shell（HTML / manifest / Leaflet）：Cache-First
  if(isShellRequest(url, event.request)){
    event.respondWith(handleShell(event.request));
    return;
  }

  // ── 3. 其他請求（外部 API、CDN）：Network-Only，失敗靜默
  // 不攔截，讓瀏覽器自行處理
});

// ── 判斷是否為地圖圖磚請求 ────────────────────────────────────
function isTileRequest(url){
  return TILE_HOSTS.some(function(host){ return url.hostname === host; }) ||
         (url.pathname.match(/\/\d+\/\d+\/\d+\.(png|jpg|jpeg)/) !== null);
}

// ── 判斷是否為 App Shell 資源 ─────────────────────────────────
function isShellRequest(url, request){
  // 同源的 GET 請求
  if(url.origin !== self.location.origin) return false;
  if(request.method !== 'GET') return false;
  // HTML、manifest、js、css
  return true;
}

// ── 地圖圖磚處理：Network-First with Cache Fallback ───────────
function handleTile(request){
  return fetch(request.clone(), {mode:'no-cors'}).then(function(response){
    if(response && response.status === 0 /* opaque ok */ || response.ok){
      // 快取成功取得的圖磚（並限制快取數量）
      var responseClone = response.clone();
      caches.open(TILE_CACHE).then(function(cache){
        cache.put(request, responseClone);
        trimCache(cache, TILE_CACHE_MAX);
      });
    }
    return response;
  }).catch(function(){
    // 無網路：從快取讀取
    return caches.match(request).then(function(cached){
      if(cached) return cached;
      // 回傳 1x1 透明像素（避免地圖錯誤）
      return new Response(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
        { headers: { 'Content-Type': 'image/png' } }
      );
    });
  });
}

// ── App Shell 處理：Cache-First with Network Fallback ─────────
function handleShell(request){
  return caches.match(request).then(function(cached){
    if(cached){
      // 後台更新快取（Stale-While-Revalidate 模式）
      fetchAndUpdate(request);
      return cached;
    }
    // 快取未命中：從網路取得並快取
    return fetch(request).then(function(response){
      if(response && response.ok){
        var clone = response.clone();
        caches.open(SHELL_CACHE).then(function(cache){ cache.put(request, clone); });
      }
      return response;
    }).catch(function(){
      // 完全離線且無快取：回傳離線替代頁
      if(request.headers.get('Accept') && request.headers.get('Accept').includes('text/html')){
        return caches.match('./') || caches.match('./index.html');
      }
    });
  });
}

// ── 後台更新（不阻塞使用者）──────────────────────────────────
function fetchAndUpdate(request){
  fetch(request).then(function(response){
    if(response && response.ok){
      caches.open(SHELL_CACHE).then(function(cache){ cache.put(request, response); });
    }
  }).catch(function(){});  // 離線時靜默失敗
}

// ── 圖磚快取數量控制（LRU 裁剪）──────────────────────────────
function trimCache(cache, maxItems){
  cache.keys().then(function(keys){
    if(keys.length > maxItems){
      cache.delete(keys[0]).then(function(){
        trimCache(cache, maxItems);
      });
    }
  });
}

// ══════════════════════════════════════════════════════════════
// Message — 接收來自頁面的指令
// ══════════════════════════════════════════════════════════════
self.addEventListener('message', function(event){
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
  if(event.data && event.data.type === 'GET_VERSION'){
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});
