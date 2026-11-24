#!/usr/bin/env node
// CEVIRI.exe (tek dosya, Node.js gerektirmez) uretir: Node SEA + postject.
// Windows'ta calistirilir (GitHub Actions windows-latest). Once "npm run copy-core".
// Kullanim: node desktop/build-exe.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out-desktop');
const APP = path.join(OUT, 'app');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'www'), APP, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'web-url.js'), path.join(APP, 'web-url.js'));

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (!e.name.startsWith('.')) files.push(path.relative(APP, full).split(path.sep).join('/'));
  }
})(APP);
fs.writeFileSync(path.join(OUT, '__list.json'), JSON.stringify(files));
const assets = { '__list.json': path.join(OUT, '__list.json') };
for (const f of files) assets[f] = path.join(APP, f);

fs.copyFileSync(path.join(__dirname, 'sunucu.js'), path.join(OUT, 'sunucu.js'));
const cfg = {
  main: path.join(OUT, 'sunucu.js'),
  output: path.join(OUT, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets,
};
fs.writeFileSync(path.join(OUT, 'sea-config.json'), JSON.stringify(cfg, null, 2));
console.log(files.length, 'dosya gomuluyor');
execFileSync(process.execPath, ['--experimental-sea-config', path.join(OUT, 'sea-config.json')], { stdio: 'inherit' });

const exe = path.join(OUT, process.platform === 'win32' ? 'CEVIRI.exe' : 'CEVIRI');
fs.copyFileSync(process.execPath, exe);
// postject: once "npm i --no-save postject@1.0.0-alpha.6" ile kurulur
const cli = require.resolve('postject/dist/cli.js', { paths: [ROOT, process.env.POSTJECT_DIR || ROOT] });
const pjArgs = [cli, exe, 'NODE_SEA_BLOB', path.join(OUT, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') pjArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, pjArgs, { stdio: 'inherit' });
console.log('Hazir:', exe, Math.round(fs.statSync(exe).size / 1e6), 'MB');
