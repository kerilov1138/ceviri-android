#!/usr/bin/env node
/*
 * CEVIRI - Bilgisayar surumu (Windows / macOS / Linux)
 *
 * Uygulamanin (APK ile ayni) web dosyalarini "app" klasorunden yalnizca bu
 * bilgisayara (127.0.0.1) sunar ve tarayiciyi acar. Ek paket gerekmez,
 * yalnizca Node.js yeterlidir.
 *
 * Ceviri, ses tanima, online oda (sifreli), kamera ve dosya paylasimi
 * dogrudan tarayicida calisir; davet linki herkesin acabildigi web
 * surumune (GitHub Pages) gider.
 *
 * Kullanim: node sunucu.js [--port=3456] [--mode=online] [--no-open]
 *          CEVIRI.exe [--mode=online]   (Node.js gerekmez)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, 'app');

// Tek dosyalik CEVIRI.exe (Node SEA): uygulama dosyalari exe'nin icindedir,
// Node.js kurulu olmasi gerekmez. Normal "node sunucu.js" ile app klasorunden okunur.
let sea = null;
try {
  const s = require('node:sea');
  if (s.isSea()) sea = s;
} catch {
  sea = null;
}
const seaFiles = sea ? new Set(JSON.parse(sea.getAsset('__list.json', 'utf8'))) : null;
const args = process.argv.slice(2);
const argValue = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const START_PORT = Number(argValue('port', process.env.PORT || 3456)) || 3456;
const MODE = argValue('mode', '');
const OPEN = !args.includes('--no-open');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

if (!sea && !fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('[HATA] "app" klasoru bulunamadi. Bu dosya CEVIRI_WIN klasorunun icinde olmali.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  if (sea) {
    const key = path.posix.normalize(urlPath).replace(/^\/+/, '');
    if (!seaFiles.has(key)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bulunamadi');
      return;
    }
    const body = Buffer.from(sea.getRawAsset(key));
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  const file = path.normalize(path.join(ROOT, urlPath));
  // Klasor disina cikma engeli
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bulunamadi');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
});

// Ses tanima en iyi Chrome / Edge'de calisir: varsa onlarla ac
function openBrowser(url) {
  const tryRun = (cmd, cmdArgs) => {
    try {
      const p = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => {});
      p.unref();
      return true;
    } catch {
      return false;
    }
  };
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    const candidates = [];
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    const exe = candidates.find((c) => fs.existsSync(c));
    if (exe && tryRun(exe, [url])) return;
    tryRun('cmd', ['/c', 'start', '""', url]);
  } else if (process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app';
    if (fs.existsSync(chrome)) tryRun('open', ['-a', 'Google Chrome', url]);
    else tryRun('open', [url]);
  } else {
    tryRun('xdg-open', [url]);
  }
}

function listen(port, attempt) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('[HATA] Sunucu baslatilamadi:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/${MODE ? `?mode=${encodeURIComponent(MODE)}` : ''}`;
    console.log('========================================================');
    console.log('  CEVIRI - Bilgisayar Surumu');
    console.log(`  Adres: ${url}`);
    console.log('  Online odada "Davet Linkini Kopyala" ile alinan link');
    console.log('  herkesin telefonunda / bilgisayarinda acilir.');
    console.log('  Kapatmak icin bu pencereyi kapatin veya Ctrl+C');
    console.log('========================================================');
    if (OPEN) openBrowser(url);
  });
}

listen(START_PORT, 0);
