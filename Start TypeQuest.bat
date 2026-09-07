@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -ArgumentList '/c npm install' -Wait"
  if errorlevel 1 (
    powershell -NoProfile -Command "[System.Windows.Forms.MessageBox]::Show('Node.js/npm is required. Install Node.js LTS first.','TypeQuest')"
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
  "$p = Start-Process cmd.exe -ArgumentList '/c npm run dev -- --host 127.0.0.1' -WorkingDirectory '%~dp0' -WindowStyle Hidden -PassThru; Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5173';"
exit
