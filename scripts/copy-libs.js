// Tarayici kutuphanelerini node_modules'tan www/ icine kopyalar (npm run sync calistirir)
const fs = require('fs');
const path = require('path');
const files = [
  ['node_modules/@capacitor/core/dist/capacitor.js', 'www/capacitor-core.js'],
  ['node_modules/mqtt/dist/mqtt.min.js', 'www/mqtt.min.js'],
  // Kamerayla yazi cevirme (OCR): Tesseract.js ve WebAssembly cekirdegi (yalniz LSTM surumleri)
  ['node_modules/tesseract.js/dist/tesseract.min.js', 'www/tesseract/tesseract.min.js'],
  ['node_modules/tesseract.js/dist/worker.min.js', 'www/tesseract/worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'www/tesseract/core/tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'www/tesseract/core/tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'www/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js'],
];
for (const [from, to] of files) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`${from} -> ${to}`);
}
