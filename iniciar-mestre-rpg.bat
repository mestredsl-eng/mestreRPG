@echo off
title Mestre RPG - Servidor
cd /d "%~dp0"

echo ============================================
echo   MESTRE RPG - Iniciando servidor...
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado. Instale o Node.js 20+ e tente novamente.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Instalando dependencias pela primeira vez...
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias.
        pause
        exit /b 1
    )
)

echo [INFO] Compilando servidor...
call npm run build -w servidor
if errorlevel 1 (
    echo [ERRO] Falha na compilacao.
    pause
    exit /b 1
)

echo [INFO] Preparando banco de dados...
call npm run db:migrate -w servidor

echo.
echo [OK] Servidor iniciado.
echo      API:     http://localhost:3001
echo      Painel:  http://localhost:5173  (rode 'npm run dev:site' em outro terminal para desenvolvimento)
echo      Health:  http://localhost:3001/api/health
echo.
echo Pressione Ctrl+C para encerrar.
echo.

call npm run start -w servidor
pause
