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

rem ---------- Versao minima do Node (engines.node >=20.19) ----------
rem Falha cedo se Node existir mas for antigo: antes de npm, Git updater,
rem lock de boot, estado externo, restauracao ou migrations.
set "NODE_MIN=20.19"
set "NODE_VER="
for /f "usebackq delims=" %%v in (`node -p "process.versions.node" 2^>nul`) do set "NODE_VER=%%v"
if not defined NODE_VER (
    echo [ERRO] Nao foi possivel ler a versao do Node.js instalado.
    echo        Versao minima exigida: %NODE_MIN% ou superior.
    echo        Reinstale o Node.js em https://nodejs.org e tente novamente.
    pause
    exit /b 1
)
node -e "const p=process.versions.node.split('.').map(Number);process.exit(p[0]>20||(p[0]===20&&p[1]>=19)?0:1)" >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js %NODE_VER% detectado - versao minima exigida: %NODE_MIN% ou superior.
    echo        Atualize o Node.js em https://nodejs.org e tente novamente.
    pause
    exit /b 1
)
echo [OK] Node.js %NODE_VER% (minimo %NODE_MIN%).
echo.

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERRO] npm nao encontrado. Reinstale o Node.js 20+ e tente novamente.
    pause
    exit /b 1
)

rem ---------- Lock de boot (Issue #155) ----------
rem Garante que apenas UM processo execute auto-update, npm ci, builds,
rem restauracao, migrations e o servidor neste diretorio. O helper
rem resolve a porta efetiva do servidor (mesma precedencia de
rem servidor/src/config.ts: configuracao/servidor.json > MESTRE_PORTA
rem > 3001), sonda /api/health ANTES de adquirir o lock — se ja ha
rem servidor no ar, sai com codigo 20 sem tocar em nada — e so depois
rem adquire o lock pelo cmd.exe deste script, cobrindo TODO o ciclo.
rem Se outra instancia valida estiver subindo, aguardamos o health
rem por ate 120s — se o servidor responder, este boot encerra sem
rem duplicar. Codigo 20 = servidor de outra instancia respondeu
rem (sai sem erro); codigo 1 = aborta; 0 = lock adquirido e boot
rem prossegue. O lock e OBRIGATORIO: sem o arquivo ou sem codigo
rem 0/20, o boot aborta — nenhuma etapa mutavel roda sem exclusividade.
if not exist scripts\boot-lock.mjs (
    echo [ERRO] scripts\boot-lock.mjs ausente — inicializacao abortada.
    echo        Restaure o arquivo ou use uma versao completa do projeto.
    pause
    exit /b 1
)
node scripts\boot-lock.mjs adquirir
if %errorlevel%==20 exit /b 0
if not %errorlevel%==0 (
    echo [ERRO] Nao foi possivel adquirir o lock de inicializacao.
    echo        Outra instancia pode estar em recuperacao ou o lock
    echo        esta invalido. Verifique janelas do iniciar-mestre-rpg
    echo        e processos node/cmd abertos antes de tentar de novo.
    pause
    exit /b 1
)

rem ---------- Autorizacao explicita de primeiro bootstrap (P10-C) ----------
rem Executa depois do Boot Lock e ANTES de qualquer atualizacao, npm,
rem restore, migration ou start. Exit 10 = instalacao nova e limpa:
rem perguntar ao operador. Exit 0 = instalacao conhecida/autorizada.
rem Qualquer outro codigo = estado ambiguo/corrompido: abortar fail-closed.
if not exist scripts\avaliar-boot.mjs (
    echo [ERRO] scripts\avaliar-boot.mjs ausente — inicializacao abortada.
    node scripts\boot-lock.mjs liberar >nul 2>nul
    pause
    exit /b 1
)
node scripts\avaliar-boot.mjs preflight
if errorlevel 10 goto :perguntar_primeiro_bootstrap
if errorlevel 1 goto :falha_preflight_bootstrap
goto :bootstrap_autorizado

:perguntar_primeiro_bootstrap
echo.
echo [ATENCAO] Esta instalacao parece ser um primeiro uso limpo.
echo O Mestre RPG precisara criar um banco de dados novo.
echo Confirme somente se esta e realmente uma instalacao nova.
:perguntar_primeiro_bootstrap_novamente
set "MESTRE_BOOT_RESPOSTA="
set /p "MESTRE_BOOT_RESPOSTA=Autorizar primeiro bootstrap? [S/N]: "
if errorlevel 1 goto :bootstrap_eof
if /i "%MESTRE_BOOT_RESPOSTA%"=="S" goto :confirmar_primeiro_bootstrap
if /i "%MESTRE_BOOT_RESPOSTA%"=="N" goto :recusar_primeiro_bootstrap
if not defined MESTRE_BOOT_RESPOSTA goto :perguntar_primeiro_bootstrap_novamente
echo [AVISO] Resposta invalida. Digite S ou N.
goto :perguntar_primeiro_bootstrap_novamente

:confirmar_primeiro_bootstrap
if not exist scripts\autorizar-bootstrap.mjs goto :falha_autorizacao_bootstrap
node scripts\autorizar-bootstrap.mjs --confirmar-provisionamento
if errorlevel 1 goto :falha_autorizacao_bootstrap
node scripts\avaliar-boot.mjs validar
if errorlevel 1 goto :falha_preflight_bootstrap
goto :bootstrap_autorizado

:recusar_primeiro_bootstrap
echo [AVISO] Primeiro bootstrap recusado. Nenhuma atualizacao, restauracao,
echo         migration ou inicializacao sera executada.
node scripts\boot-lock.mjs liberar >nul 2>nul
exit /b 1

:bootstrap_eof
echo [ERRO] Entrada terminou antes da confirmacao. Boot abortado por seguranca.
node scripts\boot-lock.mjs liberar >nul 2>nul
exit /b 1

:falha_autorizacao_bootstrap
echo [ERRO] Nao foi possivel emitir a autorizacao de primeiro bootstrap.
echo        Nenhuma etapa de banco sera executada.
node scripts\boot-lock.mjs liberar >nul 2>nul
pause
exit /b 1

:falha_preflight_bootstrap
echo [ERRO] Estado de instalacao desconhecido, corrompido ou com recuperacao pendente.
echo        Nenhuma atualizacao, restauracao, migration ou inicializacao sera executada.
node scripts\boot-lock.mjs liberar >nul 2>nul
pause
exit /b 1

:bootstrap_autorizado

rem ---------- Atualizacao automatica via Git (Issue #155) ----------
rem Executa SOMENTE depois da sonda de health do lock acima: se ja ha
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
    node scripts\boot-lock.mjs liberar >nul 2>nul
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
        node scripts\boot-lock.mjs liberar >nul 2>nul
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
        node scripts\boot-lock.mjs liberar >nul 2>nul
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
    node scripts\boot-lock.mjs liberar >nul 2>nul
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
        node scripts\boot-lock.mjs liberar >nul 2>nul
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
    node scripts\boot-lock.mjs liberar >nul 2>nul
    exit /b 1
)

echo [INFO] Aplicando migracoes...
call npm run db:migrate -w servidor
if errorlevel 1 (
    echo [ERRO] Falha ao migrar banco de dados.
    pause
    node scripts\boot-lock.mjs liberar >nul 2>nul
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
rem Servidor encerrou — libera o lock antes do pause final. Se a janela
rem for fechada com o servidor no ar, o cmd.exe morre e o lock fica
rem obsoleto: a proxima inicializacao o recupera com prova de pid morto.
node scripts\boot-lock.mjs liberar >nul 2>nul
pause
