@echo off
title Mestre RPG - Encerrar servidor
cd /d "%~dp0"

echo Encerrando Mestre RPG com seguranca...

rem 1) Tenta SIGINT-equivalente via taskkill sem /F (permite tratamento)
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Host ('Processo encontrado: PID ' + $p.Id + ' - ' + $p.ProcessName); Stop-Process -Id $p.Id -ErrorAction SilentlyContinue } } else { Write-Host 'Nenhum processo ouvindo na porta 3001.' }"

echo.
echo Se o processo ainda estiver ativo em alguns segundos, execute:
echo   taskkill /PID ^<pid^> /T
echo (ou feche a janela do iniciar-mestre-rpg.bat e pressione Ctrl+C)
pause
