# Auditoria adversarial W13/W14 — bootstrap e proveniência (filho)

- **SHA auditado:** `4daf8dfb26c3d5c3b09fada808ae9a00e9b4bb0d` (`feat/issue-155-bootstrap-provenance`)
- **Branch de auditoria:** `test/issue-155-w13w14-homolog`
- **Ambiente:** Windows + Node v26.13.0, execução local, fixtures em `%TEMP%`.
- **Teste novo:** `teste-bootstrap-w13w14-auditoria.mjs` — 17 ok / 10 falhas (as falhas são defeitos de produção confirmados, não erros de teste).

## Matriz de bloqueadores

| Item | Local | Teste | Resultado | Classificação |
|---|---|---|---|---|
| Clone limpo sem node_modules | `scripts/bootstrap-install.mjs:35` (`import Database from "better-sqlite3"` estático); `.bat` Gate 0 ~L92 antes de `npm ci` ~L130 | reprodução manual: `node scripts/bootstrap-install.mjs` em worktree sem node_modules | `ERR_MODULE_NOT_FOUND`, exit 1 | **CONFIRMADO — P0** |
| Evidência ilegível = ausência | `dirTemConteudo()`→null (L70); `temEvidenciaLegado()` só `===true` (L150); `stateDirTemProtocolo()`→null; `autorizacoesConsumidas`→null | `decidirPortao` unit ×4 + `sondarInstalacao`/`executarPortao` com FS hostil | `autorizar-bootstrap` emitido em todos os cenários inconclusivos | **CONFIRMADO — P1 fail-open** |
| Retomada bootstrap-em-andamento | `aplicar-restauracao.ts:290-296` chama `consumirAutorizacaoBootstrap` sem checar andamento | integração real: gate→restaurador→crash→gate→restaurador | 2ª execução do restaurador: exit 2 "sem autorização (bootstrap-em-andamento)" | **CONFIRMADO — P1 deadlock de primeiro boot** |
| Reinstalação + marcador corrompido | `assumirReinstalacao()` L341 só recusa `status==="ok"` | CLI real com marcador JSON corrompido | emite autorização (exit 0); boot seguinte bloqueia `marcador-corrompido` | **CONFIRMADO — incoerente** |
| verificarPortao "100% read-only" | `sondarInstalacao`→`lerJournal`→`lerEstado`→`colocarEmQuarentena` (rename) | fixture com journal corrompido + verificarPortao | quarentena criada (`restauracao-externa.json.quarentena-json-*`) | **CONFIRMADO — escrita real** |
| Sidecars SQLite no sondarBanco | `sondarBanco` abre sem `readonly` (L82) | verificarPortao em banco migrado | nenhum `-wal`/`-shm` criado neste fixture (journal_mode=delete) — risco residual em bancos WAL | RISCO RESIDUAL |
| Fixtures manifesto v2 (boot) | `teste-restauracao-boot.mjs` | suíte portada da branch de homologação | ver resultados abaixo | — |
| EPERM renameSync | `gravarJsonAtomico` (`estado-externo.mjs:122`) via `aplicar-restauracao.js:466` | gates `rollback-*` | 2 falhas transitórias em 2 runs; recuperação sempre correta | RISCO RESIDUAL (recomendado retry c/ backoff) |

## Reprodução P0

`` camex Sequência real do .bat:
  L92:  node scripts\bootstrap-install.mjs   ← Gate 0 (import estático de better-sqlite3)
  L130: call npm ci                          ← dependências DEPOIS

Clone limpo (sem node_modules):
  $ node scripts/bootstrap-install.mjs
  Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3'
      imported from ...\scripts\bootstrap-install.mjs
  exit 1 → .bat aborta com "verificacao de proveniencia FALHOU"

Primeira instalação legítima NUNCA chega ao npm ci. Fail-closed correto
em intenção, mas o gate não consegue nem classificar o clone novo.
```

Opções para o Pai (não implementar aqui — código de produção é do Pai):
1. Import dinâmico de `better-sqlite3` somente dentro de `sondarBanco()`;
   sem a dependência, banco não pode ser sondado → classificar como
   "não-inspecionável" e bloquear de forma fail-closed explícita
   (não autorizar). Clone novo sem banco poderia ter caminho alternativo,
   mas isso exige decisão de contrato — a opção conservadora é bloquear
   com instrução "execute npm ci primeiro" se a sonda for impossível.
2. Reordenar o .bat: `npm ci` antes do Gate 0. Atenção: npm ci executa
   scripts de dependência — mover instalação para antes do gate muda a
   superfície de confiança do Gate 0 (depende da decisão do Mestre/Pai).

## Reprodução P1 — fail-open por evidência inconclusiva

`decidirPortao()` trata `null` (inegível) como "sem evidência":
- `stateProtocolo === true` é a única checagem de state dir — `null` passa;
- `autorizacoesConsumidas > 0` — `null > 0` é false;
- `temEvidenciaLegado()` exige `=== true` — `null` vira "sem legado".

Resultado: qualquer `readdirSync` falho (permissão, caminho hostil,
antivírus, FS remota) em `backups/`, `arquivos/` ou no state dir faz o
Gate 0 **emitir `bootstrap-autorizacao.json`** num cenário que pode ser
uma instalação anterior — exatamente o que o contrato proíbe.

Correção esperada do Pai: tratar `null` como inconclusivo bloqueante em
`decidirPortao` (e idealmente propagar um status `"inconclusivo"`
explícito em vez de `null`).

## Reprodução P1c — deadlock de primeiro boot

Sequência real executada (processos reais, fixture isolada):
1. `node scripts/bootstrap-install.mjs` → autorização emitida (exit 0);
2. `node servidor/dist/db/aplicar-restauracao.js` → consome autorização,
   grava `bootstrap-em-andamento.json`, exit 0;
3. **crash antes do migrate** (banco segue ausente);
4. `node scripts/bootstrap-install.mjs` → exit 0 (`bootstrap-em-andamento`);
5. `node servidor/dist/db/aplicar-restauracao.js` → **exit 2**:
   "banco inexistente, sem journal e sem autorização de primeiro
   bootstrap (bootstrap-em-andamento)".

`consumirAutorizacaoBootstrap()` retorna `autorizado:false` porque o
arquivo já foi renomeado; o restaurador não consulta
`bootstrap-em-andamento.json`/`diagnosticarBootstrap` antes de exigir
nova autorização. O primeiro boot fica **permanentemente travado**:
gate libera, restaurador bloqueia, migrate nunca roda, marcador nunca é
gravado. Correção esperada: o restaurador deve aceitar o estado
`bootstrap-em-andamento` (diagnóstico) como continuação válida do mesmo
ciclo — sem reutilizar a autorização.

## Reprodução P4 — assumir-reinstalacao incoerente

`assumirReinstalacao()` recusa apenas `marcador.status === "ok"`.
Com marcador **corrompido**: emite `bootstrap-autorizacao.json`
("decisão explícita do operador", exit 0), mas o próximo boot bloqueia
em `marcador-corrompido` — a autorização fica órfã e a operação parece
ter sucesso sem efeito. Comportamento coerente esperado: recusar antes
de emitir (marcador corrompido exige investigação, não bypass) ou
implementar recuperação que preserve a evidência.

## Reprodução P5 — verificarPortao não é somente-leitura

O contrato/documentação afirmam avaliação "SOMENTE-LEITURA" para
servidor/migrador. Fixture real: journal `restauracao-externa.json`
corrompido no state dir + `verificarPortao()` → o arquivo foi
**renomeado para quarentena** (`lerEstado`→`colocarEmQuarentena`).
Além disso `sondarBanco()` abre SQLite sem `readonly` — neste fixture
(journal_mode=delete) não criou sidecars, mas em bancos WAL a abertura
pode criar `-wal`/`-shm`. Ou o mecanismo muda (leituras via `lerJsonCru`),
ou a documentação deve parar de alegar 100% read-only.

## Suítes de regressão na branch de auditoria

| Suíte | Resultado |
|---|---|
| `teste-bootstrap-w13w14-auditoria.mjs` | 17 ok / **10 falhas** (defeitos acima) |
| `teste-estado-externo.mjs` | 58 ok / 0 falhas |
| `teste-restauracao-journal.mjs` | 51 ok / 0 falhas (1 expectativa atualizada p/ `bootstrap-em-andamento`) |
| `backup-contrato.test.ts` | 43/43 |
| `teste-boot-lock.mjs` | 88/88 |
| `teste-restauracao-boot.mjs` | 1ª run 234 ok / 2 falhas (EPERM ambiental); ver rerun |
| Regressões tsx | 4+38+7+5 pass |
| `tsc -p servidor/tsconfig.json` | exit 0 |

## Classificação

**W13/W14 NÃO HOMOLOGADA** — P0 (clone limpo) e três P1 confirmados por
reprodução real. A intenção fail-closed é correta, mas três caminhos
fail-open/inconclusivos e um deadlock de retomada precisam de correção
do Pai antes da homologação do primeiro boot.
