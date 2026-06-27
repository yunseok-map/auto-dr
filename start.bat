@echo off
chcp 65001 >nul
cd /d "%~dp0"
title auto-dr 대시보드

echo ============================================
echo   auto-dr - 자율 리뷰·개선 대시보드
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 설치 후 다시 실행하세요.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [설치] 최초 실행 - 의존성을 설치합니다. 잠시만 기다려 주세요...
  call npm install
  if errorlevel 1 (
    echo [오류] 의존성 설치 실패.
    pause
    exit /b 1
  )
)

echo [실행] 대시보드를 시작합니다. 브라우저가 자동으로 열립니다.
echo        종료하려면 이 창에서 Ctrl+C 를 누르세요.
echo.
call npm start

pause
