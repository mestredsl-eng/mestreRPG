# Re-homologação W13/W14 — árvore corrigida (filho)

- **SHA auditado:** `b0f5f707c09ae957d0c567a04d1f70476e7a8b49` (`feat/issue-155-bootstrap-provenance`)
- **Branch:** `test/issue-155-w13w14-homolog-final` — testes transplantados de `4bb737d` (auditoria de `4daf8df`, preservada em `docs/AUDITORIA-W13W14.md` como histórico).
- **Ambiente:** Windows + Node v26.13.0, fixtures descartáveis em `%TEMP%`.
- **Teste novo:** `teste-bootstrap-w13w14-auditoria.mjs` — **36 ok / 5 falhas** (falhas = defeitos remanescentes reproduzidos).

## Matriz de casos

| Caso | SHA testado | Teste | Resultado | Evidência | Classe |
|---|---|---|---|---|---|
| Clone limpo sem node_modules | b0f5f70 | `scripts/` copiado p/ tmp sem node_modules; `node bootstrap-install.mjs` | banco ausente → exit 0 + autorização; banco existente não-inspecionável → exit≠0, sem autorização | seção A | **CONFIRMADO corrigido** |
| Banco sem dependência | b0f5f70 | arquivo não-sqlite como MESTRE_BANCO, sem node_modules | bloqueio `banco-inconclusivo`, nenhuma autorização | seção A | CONFIRMADO |
| Evidência inacessível | b0f5f70 | `decidirPortao` ×8 inconclusivos + FS hostil real | todos bloqueiam; `executarPortao` não emite | seção B | CONFIRMADO corrigido |
| Crash após `bootstrap-em-andamento` | b0f5f70 | processos reais: gate→restaurador→migrate→gate | retomada exit 0 sem reconsumir; adoção grava marcador+recibo | seção C1 | CONFIRMADO corrigido |
| Crash após consumo, antes do andamento | b0f5f70 | estado reproduzido: consumida-* sem andamento | gate e restaurador bloqueiam com segurança; recuperação via `assumir-reinstalacao` → ciclo completo exit 0 | seção C2 | CONFIRMADO — bloqueio fail-closed + caminho de recuperação explícito |
| Journal corrompido read-only | b0f5f70 | `verificarPortao` + snapshot FS | **quarentena criada** (`*.quarentena-json-*`) — rename real | seção D | **DEFEITO REMANESCENTE** |
| Journal incompatível/divergente | b0f5f70 | idem | **quarentena criada** (`*.quarentena-protocolo/identidade-*`) | seção D | **DEFEITO REMANESCENTE** |
| State dir com falha de leitura | b0f5f70 | path como arquivo | nenhum efeito + bloqueio | seção D | CONFIRMADO |
| Banco WAL com sidecars | b0f5f70 | journal_mode=WAL real | inspeção em cópia tmp; original intacto | seção D | CONFIRMADO corrigido |
| Recuperação state inconclusivo | b0f5f70 | `recuperarEstadoPerdido` com state path=arquivo | **exceção EEXIST não tratada** (sem `{ok:false}`); nenhum recibo escrito | seção E | **DEFEITO REMANESCENTE** |
| Reinstalação marcador corrompido | b0f5f70 | `assumir-reinstalacao --confirmar` | recusa sem emitir (exit≠0) | seção E | CONFIRMADO corrigido |
| Reinstalação banco inconclusivo | b0f5f70 | MESTRE_BANCO = diretório | **emite autorização** (só `valido` é recusado) | seção E | **DEFEITO REMANESCENTE** |
| Retry EPERM/EBUSY/EACCES | b0f5f70 | `renomearComRetry` injetado | sucesso pós-transitório; esgotamento propaga erro; ENOENT sem retry; tmp limpo | seção F | CONFIRMADO |

## Defeitos remanescentes (reprodução mínima em `teste-bootstrap-w13w14-auditoria.mjs`)

1. **`verificarPortao` não é livre de efeitos em journals ruins** — `sondarInstalacao` usa `lerJournal`→`lerEstado`→`colocarEmQuarentena` (rename). Correção sugerida: leitor não-destrutivo (`lerJsonEstado`-like) para journals na sonda, ou documentar que a avaliação pode quarentenar. Os bloqueios fail-closed estão corretos — o problema é só o efeito colateral.
2. **`recuperarEstadoPerdido` lança exceção** quando o state dir é inconclusivo (`stateProtocolo === null` passa no `=== true` e `gravarReciboInstalacao` quebra em `mkdirSync` EEXIST). Deveria retornar `{ok:false, motivo}`.
3. **`assumirReinstalacao` emite autorização com banco inconclusivo/ilegível** — só recusa `banco.estado === "valido"`. Banco `inconclusivo`/`ilegivel` deveria recusar como os demais sinais inconclusivos.

## Regressões executadas (SHA b0f5f70 + testes transplantados)

| Suíte | Resultado |
|---|---|
| `teste-bootstrap-proveniencia.mjs` (Pai) | **55 ok / 0 falhas** |
| `teste-bootstrap-w13w14-auditoria.mjs` | 36 ok / **5 falhas** (defeitos acima) |
| `teste-restauracao-journal.mjs` | 52 ok / 0 falhas (expectativa de replay atualizada p/ retomada W13) |
| `teste-estado-externo.mjs` | 58 ok / 0 falhas |
| `teste-restauracao-boot.mjs` | **236 ok / 0 falhas** (exit 0; run anterior 235/1 por expectativa de replay desatualizada — corrigida) |
| `teste-trava-instancia.mjs` | 49 ok / 0 falhas |
| `teste-atualizacao-instalacao.mjs` | 29 ok / 0 falhas |
| `teste-boot-lock.mjs` | 88/88 |
| `backup-contrato.test.ts` | 43/43 |
| `tsc -p servidor/tsconfig.json` | exit 0 |

## Classificação

**PARCIALMENTE HOMOLOGADA** — P0 e os fail-closed de evidência, retomada
dos dois pontos de crash e o retry EPERM estão comprovados. Restam 3
defeitos de menor severidade (efeito colateral de quarentena na
avaliação, exceção não tratada na recuperação, autorização emitida com
banco inconclusivo). Nenhum reabre o caminho fail-open do primeiro
boot, mas todos violam o contrato declarado e devem voltar ao Pai.
