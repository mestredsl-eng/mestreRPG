# Homologação independente — Issue #155, Etapas 1–3 (PR #193)

- **SHA de produção testado:** `d822f0e1b9aa9030534716bb4a665fc8042c3293` (`fix/issue-155-pr193-fail-closed`, merge na branch de testes).
- **Base anterior homologada:** `30c348f1f19c2996fbb237d467ec5113c9cc81ab` — os 2 FAILs de recibo encontrados nela foram **corrigidos** pelo Pai em d822f0e e revalidados aqui.
- **Ambiente:** Windows (MINGW64/NT 10.0), Node v26.13.0. Sem runner Linux nem Node 20/22 → Fase 7 NOT EXECUTED.
- **Execução:** LOCAL. Fixtures 100% descartáveis em `%TEMP%`; banco/instalação reais nunca tocados. State dir isolado por fixture (`MESTRE_STATE_DIR=<raiz>/state`).

## O que mudou na produção (d822f0e) e cobertura de teste

| Correção do Pai | Teste que prova |
|---|---|
| Recibo = "instalação concluída"; nunca autoriza banco ausente/vazio | `teste-restauracao-journal.mjs` T1 + T1b; `teste-restauracao-boot.mjs` §1 e §14 |
| `bootstrap-autorizacao.json` uso único, consumo durável (rename antes de validar) | T1b: autorização válida→exit 0, replay→bloqueia, corrompida→bloqueia+consumida, divergente→bloqueia, recibo+autorização→bloqueia sem consumir |
| `diagnosticarBootstrap`/`estadoInstalacaoConhecido`/`avaliarBoot` | `teste-estado-externo.mjs` (diagnóstico por estado, avaliarBoot com manifesto) |
| State dir ausente/ilegível → null inconclusivo | backup-contrato T2 (2 casos) + T3 referenciadoPorJournal |
| Quarentena `*.quarentena-*` bloqueia varredura | T2 (state dir e protecao/) |
| Identidade obrigatória em todo registro do protocolo | T2 (divergente, protocoloVersao, ausente total) |
| Marker sem expiração por idade; desproteção exige não-referência provada | T3 (marker `ate` no passado protege e não é removido; desproteção inconclusiva retorna false e preserva marker) |
| SHA-256 streaming 1 MiB, sempre verificado | T4 (>2 GiB esparso com hash errado → rejeita por sha256, prova de verificação) |
| Raiz do backup symlink/não-diretório rejeitada (lstat/TOCTOU) | T4 (junction → rejeita) |
| `dirEstado` sem `MESTRE_HOME` — paridade exata com boot-lock | T5 paridade (9 casos de env, todos iguais) |

## Arquivos de teste alterados (somente testes)

| Arquivo | Mudança |
|---|---|
| `teste-fixture-backup.mjs` | helper — manifesto v2 de fixture |
| `teste-estado-externo.mjs` | APIs novas (diagnosticarBootstrap/consumirAutorizacaoBootstrap/estadoInstalacaoConhecido), paridade T5, falha de bootstrap |
| `teste-restauracao-journal.mjs` | W14 fail-closed + T1 recibo (agora PASS) + T1b autorização uso único/replay |
| `teste-restauracao-boot.mjs` | state dir isolado por fixture, autorização de bootstrap (recibo não é autorização), **2 kills reais Classe B** |
| `servidor/testes/backup-contrato.test.ts` | T2/T3/T4 alinhados ao contrato fail-closed (42 testes) |
| `docs/HOMOLOGACAO-155-ETAPAS123.md` | este relatório |

`teste-estado-externo.mjs` e `teste-restauracao-journal.mjs` também receberam ajustes do próprio Pai em d822f0e — o merge preservou ambas as frentes sem conflito.

## Resultados (todos executados nesta sessão, exit codes reais)

| Suíte | Comando | Exit | Resultado |
|---|---|---|---|
| Estado externo | `node teste-estado-externo.mjs` | 0 | **58 ok / 0 falhas** |
| Journal/restauração | `node teste-restauracao-journal.mjs` | 0 | **51 ok / 0 falhas** |
| Boot/restauração real | `node teste-restauracao-boot.mjs` | 0 | **136 ok / 0 falhas** |
| Contrato de backup | `tsx --test testes/backup-contrato.test.ts` | 0 | **42/42 pass** |
| Regressão | `tsx --test` iniciativa/regua/d10/guildas-guarda | 0 | 4 + 38 + 7 + 5 pass |
| Build | `npm run build -w servidor` (tsc) | 0 | ok |

## Classe B — interrupção real (processo filho + SIGKILL)

| Gate | Resultado |
|---|---|
| `apos-trava` (antes de qualquer escrita) | **PASS** — kill real; sem journal/pre_restore; flag intacta; retomada completa |
| `apos-rollback` (rollback concluído, trava segurada) | **PASS** — journal pré-montado `rollback-em-andamento`; processo executou rollback real, parou no gate, kill; estado vivo = preservado; retomada aplicou a restauração original até `concluido` |
| Gates por componente (sidecars/banco/arquivos/config/flag) | **NOT EXECUTED** — `aguardarGateTrava` só existe em `apos-trava` e `apos-rollback`; sem hooks de produção o Filho não pode criar pontos intermediários. Dependência do Pai se quiserem cobertura total. |

## FAIL / BLOCKED / NOT EXECUTED

- **FAIL:** nenhum nesta execução.
- **BLOCKED:** produtor confiável de `bootstrap-autorizacao.json` (instalador/.bat/updater) — integração pendente (Etapa 5); testes usam o writer do formato, o que prova o contrato mas **não** declara o bootstrap real homologado ponta a ponta.
- **NOT EXECUTED:** ramos Linux (XDG_STATE_HOME, `~/.local/state`) — sem runner Linux; convenção alinhada por paridade de código e `process.platform` fixo. Node 20/22 — indisponíveis localmente. `teste-servidor.mjs` — sem cópia consistente descartável de banco.
- Gates por componente do restaurador (ver Classe B).

## Limitações residuais

- `MESTRE_HOME` não participa do state dir (correto por contrato); fixtures isolam estado via `MESTRE_STATE_DIR`.
- O teste `apos-rollback` usa journal pré-montado para a ENTRADA (Classe A) mas a interrupção é real (Classe B); a primeira execução falhou por timeout de polling de 30s — ampliado para 60s, passou de forma determinística.
- Homologação final das Etapas 1–3 não é declarada por esta frente — decisão do Intermediário/Mestre/auditoria.

## Confirmação

Somente arquivos de teste e este documento foram alterados. Nenhum arquivo de produção, `.bat`, `auto-update.mjs`, `boot-lock.mjs`, `teste-boot-lock.mjs`, `ci.yml` ou doc protegido foi modificado.
