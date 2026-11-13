// Tarayici kutuphanelerini node_modules'tan www/ icine kopyalar (npm run sync calistirir)
const fs = require('fs');
const files = [
  ['node_modules/@capacitor/core/dist/capacitor.js', 'www/capacitor-core.js'],
  ['node_modules/mqtt/dist/mqtt.min.js', 'www/mqtt.min.js'],
];
for (const [from, to] of files) {
  fs.copyFileSync(from, to);
  console.log(`${from} -> ${to}`);
}
