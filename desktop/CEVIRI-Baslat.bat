@echo off
chcp 65001 >nul
title CEVIRI - Bilgisayar Surumu
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [HATA] Node.js bulunamadi. Lutfen Node.js yukleyin: https://nodejs.org
    pause
    exit /b 1
)

node "%~dp0sunucu.js" --mode=online

echo.
echo CEVIRI kapandi.
pause
