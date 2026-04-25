@echo off
set "APP_DIR=%~dp0"
set "NODE_EXE=C:\Users\Aditya\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
start "Forecaster Server" cmd /k ""%NODE_EXE%" "%APP_DIR%server.js""
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"
