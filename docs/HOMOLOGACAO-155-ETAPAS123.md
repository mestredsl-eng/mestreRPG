# Homologação independente — Issue #155, Etapas 1–3 (PR #193)

- **Produção testada (atual):** `2d814cabc60123c77df6a675ffad6382622574d8` (HEAD de `fix/issue-155-pr193-fail-closed`), que contém `fc219f1b5b0dc687a4050fd8ff5357ae1d939c8d` e `d822f0e1b9aa9030534716bb4a665fc8042c3293` — merges `11d9247` e `5884113` nesta branch. `2d814ca` altera apenas fixtures de teste do próprio Pai (`teste-atualizacao-instalacao.mjs`, `teste-trava-instancia.mjs`); nenhum código de produção mudou desde `fc219f1`.
- **Base histórica:** `30c348f1f19c2996fbb237d467ec5113c9cc81ab` — os 2 FAILs de recibo encontrados nela foram corrigidos pelo Pai em d822f0e e revalidados.
- **Ambiente:** Windows (MINGW64/NT 10.0), Node v26.13.0. Sem runner Linux nem Node 20/22 → Fase 7 NOT EXECUTED.
- **Execução:** LOCAL. Fixtures 100% descartáveis em `%TEMP%`; banco/instalação reais nunca tocados. State dir isolado por fixture (`MESTRE_STATE_DIR=<raiz>/state`).

## O que mudou na produção e cobertura de teste

| Correção do Pai | Teste que prova |
|---|---|
| Recibo = "instalação concluída"; nunca autoriza banco ausente/vazio | `teste-restauracao-journal.mjs` T1/T1b; `teste-restauracao-boot.mjs` §1 e §14 |
| `bootstrap-autorizacao.json` uso único, consumo durável (rename antes de validar) | T1b: válida→exit 0, replay→bloqueia, corrompida→bloqueia+consumida, divergente→bloqueia, recibo+autorização→bloqueia sem consumir |
| `diagnosticarBootstrap`/`estadoInstalacaoConhecido`/`avaliarBoot` | `teste-estado-externo.mjs` (58 asserções) |
| State dir ausente/ilegível → null inconclusivo | backup-contrato T2 + T3 |
| Quarentena `*.quarentena-*` bloqueia varredura | T2 (state dir e `protecao/`) |
| Identidade obrigatória (`protocoloVersao`+`instalacaoId`+`repoCanon`) em todo registro | T2 (divergente, ausente, protocolo incompatível) |
| `referenciadoPorJournal()` varre estado principal **e** `protecao/`; corrupção/quarentena/identidade ausente → null (fail-closed) — **novo em fc219f1** | T3 dedicado a `protecao/` corrompido/em quarentena/sem identidade |
| Marker sem expiração por idade; desproteção exige não-referência provada | T3 (marker vencido protege; desproteção inconclusiva preserva marker) |
| SHA-256 streaming 1 MiB, sempre verificado | T4 (>2 GiB esparso com hash errado → rejeita por sha256) |
| Raiz do backup symlink/junction rejeitada (lstat) | T4 |
| `dirEstado` sem `MESTRE_HOME` — paridade exata com boot-lock | T5 paridade (9 casos de env, resolvedores reais importados) |
| Gates de teste por componente `aplicar-*`/`rollback-*` em `MESTRE_TRAVA_GATE_DIR` — **novo em fc219f1** | Classe B real abaixo |

## Arquivos de teste alterados (somente testes)

| Arquivo | Mudança |
|---|---|
| `teste-fixture-backup.mjs` | helper — manifesto v2 de fixture |
| `teste-estado-externo.mjs` | APIs novas (diagnosticarBootstrap/consumirAutorizacaoBootstrap/estadoInstalacaoConhecido), paridade T5, falha de bootstrap |
| `teste-restauracao-journal.mjs` | W14 fail-closed + T1 recibo + T1b autorização uso único/replay |
| `teste-restauracao-boot.mjs` | state dir isolado por fixture, autorização de bootstrap, **Classe B completa: apos-trava, apos-rollback e 10 gates por componente** |
| `servidor/testes/backup-contrato.test.ts` | T2/T3/T4 alinhados ao contrato fail-closed (43 testes) |
| `docs/HOMOLOGACAO-155-ETAPAS123.md` | este relatório |

`teste-estado-externo.mjs` e `teste-restauracao-journal.mjs` também receberam ajustes do próprio Pai — merges preservaram ambas as frentes.

## Resultados atuais (reexecução pós-merge)

- **Árvore sob teste:** `5884113` (merge de `2d814ca` sobre `dbe7965`) — working tree idêntica à do merge; os comandos rodaram antes do commit documental.
- **SHA de produção efetivo:** `2d814cabc60123c77df6a675ffad6382622574d8`.
- **SHA final da branch (documental):** commit deste arquivo, posterior às execuções — não foi ele o SHA testado.
- **Ambiente:** Windows + Node v26.13.0, execução local em `%TEMP%`.

| Suíte | Comando | Exit | Resultado |
|---|---|---|---|
| Estado externo | `node teste-estado-externo.mjs` | 0 | **58 ok / 0 falhas** |
| Journal/restauração | `node teste-restauracao-journal.mjs` | 0 | **51 ok / 0 falhas** |
| Boot/restauração real | `node teste-restauracao-boot.mjs` | 0 | **236 ok / 0 falhas** |
| Contrato de backup | `npx tsx --test testes/backup-contrato.test.ts` | 0 | **43/43 pass** |
| Boot Lock | `node teste-boot-lock.mjs` | 0 | **88 passaram / 0 falharam** |
| Regressão | tsx iniciativa/regua/d10/guildas-guarda | 0 | 4 + 38 + 7 + 5 pass |
| Build | `npm run build -w servidor` (tsc -p tsconfig.json) | 0 | ok |

### Histórico (não é homologação atual)

Contra `30c348f` (commit `3382f41`): estado 48/0, journal 35/2 (FAIL-1 recibo+DB ausente, FAIL-2 recibo+DB vazio — ambos corrigidos pelo Pai), boot 121/0, backup-contrato 40/40. Contra `d822f0e` (commit `0f75826`): estado 58/0, journal 51/0, boot 136/0, backup-contrato 42/42. Contra `fc219f1` (commit `dbe7965`): estado 58/0, journal 51/0, boot 236/0, backup-contrato 43/43, boot-lock 88/88. Nenhum desses números deve ser lido como resultado da árvore final `5884113`+.

## Classe B — interrupção real (processo filho + SIGKILL)

| Gate | Resultado |
|---|---|
| `apos-trava` | **PASS** — kill antes de qualquer escrita; sem journal/pre_restore; retomada completa |
| `apos-rollback` | **PASS** — rollback real executado, kill no gate com trava segurada; retomada aplicou a restauração original até `concluido` |
| `aplicar-{sidecars,banco,arquivos,configuracao,flag}` | **PASS (5/5)** — kill real com componente `em-andamento` no journal; estado vivo correto; retomada concluiu |
| `rollback-{sidecars,banco,arquivos,configuracao,flag}` | **PASS (5/5)** — kill real com `rollback-em-andamento`; retomada do rollback → restore original → `concluido` |

## FAIL / BLOCKED / NOT EXECUTED

- **FAIL:** nenhum na execução verde final. Observação: uma execução intermediária de `backup-contrato` registrou 1 falha transitória não identificada (provável timing Windows); reexecução imediata → 43/43, exit 0.
- **Instabilidade ambiental (não é defeito de contrato):** `gravarJsonAtomico` usa `renameSync` sem retry; em Windows, rename transitório `EPERM` (provável scanner de arquivos) já derrubou o filho restaurador em ~1 de cada 12 cenários Classe B em 2 de 4 execuções. Experimento isolado: 200.000 renames com 180k leituras concorrentes → 0 falhas, logo leituras do teste não são a causa. **Recomendação ao Pai:** retry com backoff em EPERM/EBUSY/EACCES dentro de `gravarJsonAtomico`. Todas as asserções de recuperação passaram mesmo nas execuções com crash — o journal `rollback-*` retomou corretamente.
- **BLOCKED:** produtor confiável de `bootstrap-autorizacao.json` (instalador/.bat/updater) — integração pendente (Etapa 5); testes usam o writer do formato, provando o contrato mas **sem** declarar bootstrap real homologado ponta a ponta.
- **NOT EXECUTED:** ramos Linux (XDG_STATE_HOME, `~/.local/state`) — sem runner Linux. Node 20/22 — indisponíveis. `teste-servidor.mjs` — sem cópia consistente descartável de banco.

## Limitações residuais

- `MESTRE_HOME` não participa do state dir (correto por contrato); fixtures isolam estado via `MESTRE_STATE_DIR`.
- Polling de journal usa intervalo de 1s com estabilidade (2 leituras iguais) para evitar corrida com rename atômico no Windows.
- Homologação final das Etapas 1–3 não é declarada por esta frente — decisão do Intermediário/Mestre/auditoria.

## Confirmação

Somente arquivos de teste e este documento foram alterados. Nenhum arquivo de produção, `.bat`, `auto-update.mjs`, `boot-lock.mjs`, `teste-boot-lock.mjs`, `ci.yml` ou doc protegido foi modificado.
