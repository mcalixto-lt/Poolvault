@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ nao encontrado.&pause&exit /b 1)
if not exist data mkdir data
start "Poolvault Server" cmd /k "node server.js"
timeout /t 2 >nul
start "Poolvault" http://localhost:10000
