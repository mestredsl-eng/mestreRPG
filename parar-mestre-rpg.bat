@echo off
title Mestre RPG - Encerrar servidor
cd /d "%~dp0"

echo Encerrando Mestre RPG com seguranca...
echo.

rem Delega ao script PowerShell: pede encerramento gracioso ao servidor,
rem pausa ate confirmar a queda e so recorre a forcar o processo se
rem o encerramento normal nao concluir dentro do tempo limite.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0parar-mestre-rpg.ps1"

echo.
pause
