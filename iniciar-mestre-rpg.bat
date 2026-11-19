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

rem ---------- Atualizacao automatica via Git (Issue #155) ----------
rem Executa SOMENTE depois da checagem da porta 3001 acima: se ja ha
rem um servidor no ar, nenhuma operacao Git/npm de atualizacao acontece.
rem O script e conservador: sem git, sem .git (instalacao ZIP), remoto
rem diferente do oficial, arvore suja, sem upstream, sem rede, branch
rem divergente ou falha de build/dependencias, ele apenas avisa e o
rem boot segue com a versao local. So retorna erro quando nem um
rem rollback seguro pode ser garantido — nesse caso nada e executado
rem alem do reset --hard verificado (arvore limpa + HEAD no commit do
rem pull). Nunca usa stash, clean, merge, rebase ou force.
rem Documentacao: docs/GUIA-OPERACAO.md e README.md ("Atualizacao").
if not exist scripts\auto-update.mjs goto :sem_auto_update
node scripts\auto-update.mjs
if errorlevel 1 (
    echo [ERRO] A atualizacao automatica falhou de forma irrecuperavel.
    echo        Nenhuma alteracao local foi descartada. Siga as
    echo        instrucoes exibidas acima e a secao "Atualizacao
    echo        automatica" do docs\GUIA-OPERACAO.md.
    pause
    exit /b 1
)
:sem_auto_update

if not exist node_modules (
    echo [INFO] Instalando dependencias pela primeira vez...
    rem npm ci e reproduzivel - respeita package-lock; se falhar, tenta npm install
    call npm ci
    if errorlevel 1 (
        echo [AVISO] npm ci falhou - tentando npm install...
        call npm install
    )
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
rem Compara o arquivo MAIS RECENTE de site\src com o mais recente de
rem site\dist inteiro (index.html + assets) — um index.html isolado mais
rem novo nao garante bundle atualizado.
powershell -NoProfile -Command "$d=Get-ChildItem site\dist -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if(-not $d){exit 1}; $s=Get-ChildItem site\src -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if(-not $s -or $s.LastWriteTime -gt $d.LastWriteTime){exit 1}; exit 0"
if errorlevel 1 (
    echo [INFO] Compilando frontend - primeira vez ou codigo mais novo que o build...
    call npm run build -w site
    if errorlevel 1 (
        echo [ERRO] Falha ao compilar o frontend.
        pause
        exit /b 1
    )
)

rem ORDEM OBRIGATORIA: restauracao pendente ANTES das migrations —
rem o restaurador troca o arquivo do banco, entao as migrations devem
rem rodar sobre o banco efetivamente restaurado, nunca o contrario.
echo [INFO] Verificando restauracao pendente...
node servidor\dist\db\aplicar-restauracao.js
if errorlevel 1 (
    echo.
    echo [ERRO] A restauracao de backup FALHOU ou foi cancelada.
    echo        O servidor NAO sera iniciado sobre estado incerto.
    echo        Verifique o detalhe acima e o arquivo logs\servidor.log.
    echo        O banco anterior foi preservado em backups\pre_restore_*.
    echo        Corrija o problema e execute este script novamente.
    pause
    exit /b 1
)

echo [INFO] Aplicando migracoes...
call npm run db:migrate -w servidor
if errorlevel 1 (
    echo [ERRO] Falha ao migrar banco de dados.
    pause
    exit /b 1
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
