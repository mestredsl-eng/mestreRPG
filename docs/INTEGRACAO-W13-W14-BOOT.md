# Integração do boot — Boot Lock × Gate 0 (W13/W14) × auto-update × restauração × migrations × servidor

**Branch:** `integracao/w13-w14-boot` (derivada de `feat/issue-155-bootstrap-provenance @ 2900109`)
**Escopo:** encadeamento do processo de inicialização — não é auditoria do estado nem correção de produção.
**Suíte:** `teste-bootstrap-launcher-integracao.mjs` — executa `cmd.exe /d /c iniciar-mestre-rpg.bat` real em raízes descartáveis (LOCALAPPDATA/MESTRE_STATE_DIR/MESTRE_PROVENIENCIA_DIR isolados, npm/auto-update/restaurador stubados com registro de ordem).

## Sequência real verificada

```
node/npm check → boot-lock.mjs adquirir (sonda health porta efetiva;
exit 20 = servidor no ar, sai 0 sem tocar em nada)
→ bootstrap-install.mjs (Gate 0; ausente+protocolo tracked = bloqueio;
   ausente sem protocolo = fixture mínima tolerada)
→ auto-update.mjs → npm ci/install → rebuild nativo → build servidor
→ build site (condicional) → aplicar-restauracao.js → db:migrate
→ npm run start → boot-lock.mjs liberar → pause
```

Todo caminho de erro após a aquisição chama `boot-lock.mjs liberar` antes de `exit /b 1` — verificado em Gate 0, auto-update, npm ci, rebuild, build servidor, build site, restauração e migrate.

## Resultados — 32/32 PASS (Windows, Node v26.13.0)

| Grupo | Evidência |
|---|---|
| Ordem estrutural | adquirir < Gate 0 < auto-update < npm ci < build < restauração < migrate < start; exit 20 antes do Gate |
| B — clone novo | exit 0; ordem restauracao < migrate < start registrada; lock liberado; autorização de bootstrap emitida |
| C — banco perdido c/ marcador | exit 1; auto-update e todas as etapas mutáveis NÃO rodaram; lock liberado |
| D — Gate ausente + protocolo tracked | exit 1; updater não rodou; lock liberado |
| E — Gate ausente sem protocolo | tolerado (fixture mínima); boot prosseguiu |
| F — servidor já no ar | exit 0; nenhuma etapa mutável; nenhum arquivo no state dir (o helper pode criar o diretório `<state>/<id>/` vazio antes da sonda — sem lock/journal/autorização) |
| G/H — falha updater / restauração | exit 1; migrate não roda após restauração falha; lock liberado nos dois |
| I — somente-leitura | `verificarPortao` bloqueia banco-perdido; `index.ts` e `migrate.ts` chamam `verificarPortao` e `process.exit(2)` — sem bypass |

## Compatibilidade entre camadas

- **Boot Lock ↔ estado externo:** mesma convenção (`MESTRE_STATE_DIR`/LOCALAPPDATA + `instalacaoId` SHA-256); paridade já coberta por `teste-estado-externo.mjs`.
- **Gate 0 ↔ state dir:** marcador de proveniência fica FORA do state dir (`MESTRE_PROVENIENCIA_DIR`/`install`), recibo/autorização dentro — distinção W13 implementada.
- **Gate 0 ↔ restaurador:** autorização de bootstrap é one-shot e consumida pelo restaurador; journal de restauração pendente não bloqueia o gate (retomada no mesmo boot).
- **N-1 → N:** marcador ausente + banco válido = adoção (`banco-valido-sem-marcador`); decisão Opção A preservada.

## Cobertura de CI

`ci.yml` (job `auto_update_windows`, windows-latest, Node 22) executa `teste-boot-lock.mjs` (88/88 em Node 22 e Node 20 via #190). **A nova suíte `teste-bootstrap-launcher-integracao.mjs` ainda não está registrada em nenhum workflow** — a registrar na frente de CI (PR #190/derivada) se o Mestre quiser cobertura contínua; requer Windows.

## Pendências objetivas

1. Produtor real do bootstrap ponta a ponta depende do `.bat` em instalação real (a suíte cobre fixtures; clone real não executado).
2. `teste-servidor.mjs`/`migrate` real não exercitados contra banco populado (fixtures stubadas por desenho).
3. EPERM transitório em `renameSync` (Windows) — decisão de retry pendente com o Pai.
4. CI não cobre esta suíte nem as suítes T1–T4 de estado externo.
5. Etapas 4–6 (updater consumindo journal externo, etc.) fora de escopo.
