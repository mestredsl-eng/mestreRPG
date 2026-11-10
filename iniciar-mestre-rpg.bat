@echo off
title Mestre RPG - Servidor
cd /d "%~dp0"

echo ============================================
echo   MESTRE RPG - Iniciando servidor...
echo ============================================
echo.

rem ---------- Node.js: verifica e tenta instalar automaticamente ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [INFO] Node.js nao encontrado. Tentando instalar automaticamente...
    echo.

    where winget >nul 2>nul
    if errorlevel 1 (
        echo [ERRO] Node.js nao encontrado e o winget nao esta disponivel.
        echo        Instale o Node.js 20+ manualmente em https://nodejs.org e tente novamente.
        pause
        exit /b 1
    )

    echo [INFO] Instalando Node.js LTS via winget - pode pedir permissao de administrador.
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar o Node.js automaticamente.
        echo        Instale manualmente em https://nodejs.org e tente novamente.
        pause
        exit /b 1
    )

    rem O PATH do Windows nao e atualizado nesta janela - adiciona os locais padrao
    set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files (x86)\nodejs;%LOCALAPPDATA%\Programs\nodejs"

    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERRO] Node.js instalado, mas nao encontrado nesta sessao.
        echo        Feche esta janela e execute iniciar-mestre-rpg.bat novamente.
        pause
        exit /b 1
    )
    echo [OK] Node.js instalado com sucesso.
    echo.
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERRO] npm nao encontrado. Reinstale o Node.js 20+ e tente novamente.
    pause
    exit /b 1
)

rem Impede segunda instancia: verifica se a porta 3001 ja responde
rem (127.0.0.1 evita ambiguidade de IPv6/localhost; -Proxy $null ignora proxy do sistema)
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Proxy $null http://127.0.0.1:3001/api/health).StatusCode } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
    echo [AVISO] Ja existe um servidor respondendo em http://localhost:3001
    echo         Se desejar reiniciar, feche a janela anterior ou use parar-mestre-rpg.bat
    pause
    exit /b 0
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

rem Se o Node foi atualizado, o modulo nativo pode ter ficado incompativel
node -e "require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
    echo [AVISO] Modulo nativo incompativel com esta versao do Node - recompilando...
    call npm rebuild better-sqlite3
    if errorlevel 1 (
        echo [ERRO] Falha ao recompilar dependencias nativas. Tente 'npm install' manualmente.
        pause
        exit /b 1
    )
)

if not exist banco\mestre-rpg.db (
    echo [INFO] Banco de dados nao encontrado - sera criado na primeira execucao.
)

echo [INFO] Compilando servidor...
call npm run build -w servidor
if errorlevel 1 (
    echo [ERRO] Falha na compilacao.
    pause
    exit /b 1
)

rem O backend serve o frontend pronto (site/dist) na mesma porta.
rem Recompila o site quando o fonte e mais novo que o build — evita
rem servir frontend desatualizado apos atualizacao do codigo, sem
rem deixar toda inicializacao lenta (~1s de verificacao).
powershell -NoProfile -Command "$d='site\dist\index.html'; if(-not (Test-Path $d)){exit 1}; $s=Get-ChildItem site\src -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if(-not $s -or $s.LastWriteTime -gt (Get-Item $d).LastWriteTime){exit 1}; exit 0"
if errorlevel 1 (
    echo [INFO] Compilando frontend (primeira vez ou codigo mais novo que o build)...
    call npm run build -w site
    if errorlevel 1 (
        echo [ERRO] Falha ao compilar o frontend.
        pause
        exit /b 1
    )
)

echo [INFO] Aplicando migracoes...
call npm run db:migrate -w servidor
if errorlevel 1 (
    echo [ERRO] Falha ao migrar banco de dados.
    pause
    exit /b 1
)

rem Se houver restauracao de backup pendente, aplica ANTES de subir o servidor
echo [INFO] Verificando restauracao pendente...
node servidor\dist\db\aplicar-restauracao.js
if errorlevel 1 (
    echo [AVISO] Restauracao falhou ou foi revertida. Verifique logs\servidor.log
)

echo.
echo [OK] Servidor iniciado.
echo      App:     http://localhost:3001  (API + frontend na mesma porta)
echo      Health:  http://localhost:3001/api/health
echo      LAN:     http://SEU-IP-LOCAL:3001  (ex.: ipconfig)
echo.
echo Para encerrar com seguranca, feche esta janela ou pressione Ctrl+C.
echo Para acesso externo HTTPS, veja a secao "Acesso externo" no README.md.
echo.

call npm run start -w servidor
pause
