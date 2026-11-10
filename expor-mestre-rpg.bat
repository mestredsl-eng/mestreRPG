@echo off
title Mestre RPG - Exposicao NetBird
cd /d "%~dp0"
rem Porta 3001 = backend (API + frontend na mesma porta).
rem ATENCAO: cada execucao do "netbird expose" gera um sufixo aleatorio
rem no dominio (mestre-rpg-XXXX...). A URL efetiva esta SEMPRE na ultima
rem linha "URL:" de logs\netbird-expose.log - nao ha URL fixa.
rem O loop abaixo reinicia o expose se ele cair; o dominio muda a cada
rem reinicio, entao consulte o log apos qualquer reinicializacao.
if not exist logs mkdir logs
:reiniciar
echo [%date% %time%] iniciando expose >> logs\netbird-expose.log
netbird expose --with-name-prefix mestre-rpg 3001 >> logs\netbird-expose.log 2>&1
echo [%date% %time%] expose encerrado - reiniciando em 5s >> logs\netbird-expose.log
timeout /t 5 /nobreak >nul
goto reiniciar
