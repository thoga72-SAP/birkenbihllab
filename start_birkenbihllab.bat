@echo off
title Birkenbihllab Starter
color 0A
echo ============================================
echo     Starte Birkenbihllab (Server + Client)
echo ============================================

REM ---- SERVER STARTEN ----
echo [1/3] Server wird gestartet...
start "birkenbihllab-server" cmd /K ^
  "cd /D D:\Englisch\Programm_HTML\birkenbihllab_release\server && npm run dev"

REM ---- KURZE WARTEZEIT ----
echo [2/3] Warte auf Serverstart (Port 3001)...
timeout /t 3 /nobreak >nul

REM ---- CLIENT STARTEN ----
echo [3/3] Client wird gestartet...
start "birkenbihllab-client" cmd /K ^
  "cd /D D:\Englisch\Programm_HTML\birkenbihllab_release\client && npm run dev"

REM ---- WARTEN BIS VITE LAEUFT ----
echo Warte bis Port 5173 aktiv ist...
setlocal enabledelayedexpansion
set "count=0"
:WAITLOOP
timeout /t 1 >nul
powershell -Command "$p=Test-NetConnection -ComputerName localhost -Port 5173; if($p.TcpTestSucceeded){exit 0}else{exit 1}"
if %errorlevel%==0 goto :OPEN
set /a count+=1
if !count! lss 20 goto :WAITLOOP

echo [!] Port 5173 wurde nicht innerhalb von 20 Sekunden gefunden.
goto :END

:OPEN
echo [OK] Port 5173 aktiv – Browser wird geöffnet...
start "" "http://localhost:5173/"

:END
echo ============================================
echo Birkenbihllab wurde gestartet.
echo Server: http://localhost:3001
echo Client: http://localhost:5173
echo ============================================
pause
exit /b
