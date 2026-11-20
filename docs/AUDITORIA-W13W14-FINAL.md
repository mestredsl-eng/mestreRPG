# Re-homologação W13/W14 — árvore final cc8acb1 (filho)

- **SHA auditado:** `cc8acb173bc2d256d24a6946a61d8a4854870930` (`feat/issue-155-bootstrap-provenance`, HEAD remoto no momento da execução)
- **Branch:** `test/issue-155-w13w14-homolog-final-v2` — continuação de `test/issue-155-w13w14-homolog-final` (auditoria intermediária de `b0f5f70`, preservada como histórico).
- **Auditoria anterior:** `4daf8df` → 4 defeitos (`docs/AUDITORIA-W13W14.md`); `b0f5f70` → corrigidos, restavam 3 (`docs/AUDITORIA-W13W14-FINAL.md` no branch anterior).
- **Ambiente:** Windows + Node v26.13.0, fixtures descartáveis em `%TEMP%`.

## Matriz de casos — cc8acb1

| Caso | Teste | Resultado | Evidência | Classe |
|---|---|---|---|---|
| Clone limpo sem node_modules | `scripts/` em tmp sem deps; gate real | banco ausente → exit 0 + autorização; banco não-inspecionável → bloqueio sem autorização | seção A | **CONFIRMADO** |
| Banco sem dependência | arquivo não-sqlite como db, sem node_modules | `banco-inconclusivo` → bloqueio | seção A | CONFIRMADO |
| Evidência inacessível (8 cenários) | `decidirPortao` + FS hostil real | state/legado/banco/marcador/auth inconclusivos → nenhum autoriza | seção B | CONFIRMADO |
| Crash após `bootstrap-em-andamento` | processos reais C1 | retomada exit 0, adoção marcador+recibo | seção C1 | CONFIRMADO |
| **Crash após consumo, antes de "autorizada"** | `MESTRE_BOOTSTRAP_CRASH_AFTER=consumida` — crash REAL exit 42 | retomada prova `validarAutorizacoesConsumidas` → exit 0, sem reconsumo | seção C2b | **CONFIRMADO — janela eliminada** |
| Crash após "autorizacao-pendente" | `MESTRE_BOOTSTRAP_CRASH_AFTER=pendente` — crash REAL | autorização segue válida; retomada consome normalmente | seção C2a | CONFIRMADO |
| Estado impossível (consumida sem andamento) | estado sintético | gate + restaurador bloqueiam | seção C2c | CONFIRMADO fail-closed |
| Journal corrompido read-only | `verificarPortao` + snapshot FS | **zero arquivos criados/removidos** + bloqueio | seção D | CONFIRMADO corrigido |
| Journal incompatível/divergente | idem | zero efeitos + bloqueio | seção D | CONFIRMADO corrigido |
| State dir falha de leitura | path como arquivo | zero efeitos + bloqueio | seção D | CONFIRMADO |
| Banco WAL com sidecars | journal_mode=WAL real | inspeção em cópia tmp; original intacto | seção D | CONFIRMADO |
| Recuperação state inconclusivo | `recuperarEstadoPerdido` | recusa limpa `{ok:false}`, sem exceção, sem recibo | seção E | CONFIRMADO corrigido |
| Reinstalação marcador corrompido | `assumir-reinstalacao --confirmar` | recusa sem emitir | seção E | CONFIRMADO |
| Reinstalação banco inconclusivo | MESTRE_BANCO=diretório | recusa sem emitir | seção E | CONFIRMADO corrigido |
| Retry EPERM/EBUSY/EACCES | `renomearComRetry` injetado | transitório→sucesso; esgotamento→erro original; ENOENT→sem retry; tmp limpo | seção F | CONFIRMADO |

## Auditoria: 47 ok / 0 falhas

## Regressões executadas (SHA cc8acb1 + testes transplantados)

| Suíte | Resultado |
|---|---|
| `teste-bootstrap-proveniencia.mjs` (Pai) | **94 ok / 0 falhas** |
| `teste-bootstrap-w13w14-auditoria.mjs` | **47 ok / 0 falhas** |
| `teste-restauracao-journal.mjs` | 52 ok / 0 falhas (2 expectativas atualizadas p/ duas fases) |
| `teste-estado-externo.mjs` | 58 ok / 0 falhas |
| `teste-restauracao-boot.mjs` | **236 ok / 0 falhas** (exit 0) |
| `teste-trava-instancia.mjs` | 49 ok / 0 falhas |
| `teste-atualizacao-instalacao.mjs` | 29 ok / 0 falhas |
| `teste-boot-lock.mjs` | 88/88 |
| `backup-contrato.test.ts` | 43/43 |
| `tsc -p servidor/tsconfig.json` | exit 0 |

## Observações

- `consumirAutorizacaoBootstrap` agora recusa em sandbox sem `MESTRE_STATE_DIR` — protege o state dir real.
- `avaliarBoot`/`sondarInstalacao` migraram para `lerJournalSemEfeitos`/`lerEstadoSemEfeitos` — classificação idêntica, zero quarentena.
- Expectativas de "replay bloqueia" nas suítes portadas foram atualizadas para a semântica correta de retomada (uso único cumprido ≠ proibição de continuação do mesmo ciclo); a garantia de one-shot foi reforçada com asserção de contagem de `consumida-*`.

## Classificação

**W13/W14 HOMOLOGADA (escopo local)** — primeiro boot em clone limpo,
interrupção em TODOS os pontos do ciclo de autorização (pendente e
pós-consumo), evidência fail-closed, avaliação read-only e retry
transitório comprovados com processos reais em `cc8acb1`. Ressalvas
ambientais: Windows/Node 26 apenas; CI Linux/Node 20-22 pendente;
`teste-servidor.mjs` não executado.
