@echo off
title TypeQuest Local
echo Installing dependencies (first run may take a moment)...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Make sure Node.js LTS is installed.
  pause
  exit /b 1
)
echo.
echo Starting TypeQuest...
call npm run dev
pause
