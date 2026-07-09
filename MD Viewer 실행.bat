@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem === 소스에서 실행 시: 의존성(node_modules)이 없으면 자동 설치 ===
if not exist "node_modules\electron\dist\electron.exe" (
  echo [MD Viewer] 최초 실행 준비 - 필요한 파일을 설치합니다. 잠시만 기다려 주세요...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [오류] Node.js가 필요합니다. https://nodejs.org 에서 설치 후 다시 실행하세요.
    echo  ^(그냥 쓰실 거면 Releases 의 "MD Viewer Setup.exe" 를 받아 설치하는 게 더 간단합니다^)
    pause
    exit /b 1
  )
  call npm install
  if errorlevel 1 ( echo [오류] 설치 실패. & pause & exit /b 1 )
  call npm run build
)

rem === 렌더러 번들이 없으면 빌드 ===
if not exist "renderer\bundle.js" call npm run build

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit
