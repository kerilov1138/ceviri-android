#!/bin/bash
# CEVIRI - Bilgisayar surumu (macOS / Linux)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "[HATA] Node.js bulunamadi. Lutfen Node.js yukleyin: https://nodejs.org"
  read -r -p "Kapatmak icin Enter'a basin..." _
  exit 1
fi
node sunucu.js --mode=online
