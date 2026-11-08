@echo off
title Mestre RPG - Exposicao NetBird
cd /d "%~dp0"
if not exist logs mkdir logs
:reiniciar
echo [%date% %time%] iniciando expose >> logs\netbird-expose.log
netbird expose --with-name-prefix mestre-rpg 3001 >> logs\netbird-expose.log 2>&1
echo [%date% %time%] expose encerrado - reiniciando em 5s >> logs\netbird-expose.log
timeout /t 5 /nobreak >nul
goto reiniciar
