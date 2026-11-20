# Re-homologação W13/W14 — árvore db49214 (filho)

- **SHA auditado:** `db49214239e8bf512c14df8f8a59d4bacba62982` (`feat/issue-155-bootstrap-provenance`)
- **Branch:** `test/issue-155-w13w14-homolog-final-v3`
- **Contexto:** `cc8acb1` havia sido homologada localmente; a auditoria
  independente posterior expôs 8 defeitos (autorização antiga valida
  ciclo novo, andamento sem validação semântica no Gate 0, hook de crash
  ativo em produção). `db49214` corrige todos — e introduz 1 regressão P1.

## Matriz de casos — db49214

| Caso | Reprodução | Resultado | Classe |
|---|---|---|---|
| Autorização antiga reutilizada | ciclo A completa → perda simulada → ciclo B com auth ausente/corrompida/consumida inválida | **BLOQUEIA em todos** — `autorizacaoId` vincula ciclo | CONFIRMADO corrigido |
| Crash após consumo de B | `MESTRE_BOOTSTRAP_CRASH_AFTER=consumida` + `NODE_ENV=test` | retomada aceita somente consumida do mesmo id | CONFIRMADO |
| Tipo/etapa/autorizacaoId inválidos | 5 registros com envelope válido, conteúdo inválido | **Gate 0 recusa antes do fluxo mutável** (`executarPortao` código≠0) | CONFIRMADO corrigido |
| Recibo inconclusivo | corrompido/diretório/divergente/tipo inválido | bloqueia sem emitir nem consumir | CONFIRMADO |
| Hook em produção | `NODE_ENV=production` + `MESTRE_BOOTSTRAP_CRASH_AFTER` | **inerte (exit 0)**; `NODE_ENV=test` → exit 42 | CONFIRMADO corrigido |
| Read-only com hash integral | snapshot SHA-256+tamanho+mtime+tipo recursivo | idêntico antes/depois de `verificarPortao` | CONFIRMADO |

## REGRESSÃO P1 introduzida por db49214 — andamento envenenado

`autorizarBootstrap()` (`aplicar-restauracao.ts:248-277`) grava
`bootstrap-em-andamento` em etapa `autorizacao-pendente` **antes** de
consumir, incondicionalmente — inclusive quando NÃO existe autorização
válida (`authId=undefined`). Se o consumo falha (sem auth, auth
inválida, recibo presente, sandbox), o processo sai deixando um
andamento `pendente` sem `autorizacaoId` → `avaliarBootstrapAndamento`
retorna `invalido` → **Gate 0, migrador, servidor e restaurador
bloqueiam permanentemente** (`bootstrap-andamento-invalido`).

Reprodução mínima (executada, processos reais):
1. fixture limpa, `node servidor/dist/db/aplicar-restauracao.js` sem
   autorização → exit 2, mas `bootstrap-em-andamento.json` é gravado;
2. `node scripts/bootstrap-install.mjs` → exit 2
   "bootstrap-andamento-invalido";
3. autorização legítima emitida + restaurador → exit 2 para sempre.

O primeiro boot legítimo após QUALQUER tentativa de bootstrap sem
autorização válida torna-se impossível sem intervenção manual no
state dir. Em `cc8acb1` o andamento só era gravado após consumo
bem-sucedido — a janela foi eliminada, mas o efeito colateral do
pendente prematuro não foi tratado (falta limpar/invalidar o pendente
quando o consumo não acontece, ou só gravá-lo com `authId` válido).

Impacto observado: `teste-restauracao-boot.mjs` = **226 ok / 10 falhas**,
todas em cascata deste defeito nas seções §1 e §14 (fixture executa um
restaurador bloqueado por recibo antes do bootstrap legítimo — sequência
realista de operador).

## Regressões executadas (SHA db49214)

| Suíte | Resultado |
|---|---|
| `teste-bootstrap-w13w14-adversarial.mjs` | **28 ok / 0 falhas** |
| `teste-bootstrap-w13w14-auditoria.mjs` | **47 ok / 0 falhas** |
| `teste-bootstrap-proveniencia.mjs` (Pai) | **116 ok / 0 falhas** |
| `teste-restauracao-journal.mjs` | 52 ok / 0 falhas |
| `teste-estado-externo.mjs` | 58 ok / 0 falhas |
| `teste-restauracao-boot.mjs` | **226 ok / 10 falhas** (regressão P1 acima) |
| `teste-trava-instancia.mjs` | 49 ok / 0 falhas |
| `teste-atualizacao-instalacao.mjs` | 29 ok / 0 falhas |
| `teste-boot-lock.mjs` | 88/88 |
| `backup-contrato.test.ts` | 43/43 |
| `tsc -p tsconfig.json` | exit 0 |

## Classificação

**PARCIALMENTE HOMOLOGADA** — todos os 8 defeitos da rodada anterior
estão corrigidos e comprovados, mas `db49214` introduz regressão P1
(andamento envenenado em consumo falho) que bloqueia o primeiro boot
legítimo. Aguarda correção do Pai; a suíte adversarial já cobre o
cenário e deve passar a verde na próxima árvore.
