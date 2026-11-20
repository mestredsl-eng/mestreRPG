# Relatório de execução — Homologação Issue #155 (W0–W16)

**Data:** 2026-11-20 · **Executor:** homologação automatizada local
**SHA testado:** `7ce5b99bb20a0f951ffe5b70a96fe46ee5a157a0` (N-1, PR #176) + working tree da branch `test/issue-155-homologacao-w` (somente `homologacao-155-w.mjs` e este relatório — nenhum código de produto alterado)
**SO:** Windows (Git Bash / cmd.exe real) · **Node:** v26.13.0 · **Git:** 2.55.0.windows.3
**Harness:** `homologacao-155-w.mjs` — fixtures 100% em `%TEMP%\homolog-155-w-*`, removidas ao final; nenhum teste tocou `banco/`, `backups/`, `configuracao/` ou a instalação real.

## Resultado por caso

| W | Decisão | Evidência |
|---|---|---|
| W0 | **NÃO EXECUTADO — bloqueado por ambiente** | Servidor real do usuário ativo em `127.0.0.1:3001` (`node dist/index.js`, pid 23312, `/api/health` 200). O `.bat` N-1 verifica a porta 3001 **antes** do updater e aborta com "já existe um servidor" — o cenário não pode iniciar sem derrubar a instalação real. Pré-requisito: executar com o servidor parado ou em estação dedicada. |
| W1 | BLOQUEADO | Handoff `:_fase2` não existe em N-1; requer versão N integrada (#188→#189→#176). |
| W2 | BLOQUEADO | Depende de W1/máquina de fases — não implementada. |
| W3 | BLOQUEADO | Dois boots em N requerem Boot Lock corrigido (#189) integrado; helper atual não cobre storage/porta. |
| W4 | BLOQUEADO | Estado externo/journal de fases de N não implementado. |
| W5 | BLOQUEADO | Máquina de fases do protocolo externo não implementada. |
| W6 | **APROVADO** | Smoke isolado real: `node servidor/dist/index.js` com `MESTRE_BANCO/ARQUIVOS/BACKUPS` em fixture temp → `/api/health` **200 em 534 ms**; conferência pós-execução: nenhum arquivo de `banco/`, `arquivos/`, `backups/` da worktree tocado. Prova de disponibilidade HTTP do build — **não** de integridade de dados. |
| W7 | BLOQUEADO | Estado externo de N não implementado. |
| W8 | **APROVADO (lacuna demonstrada)** | Sequência real do `.bat` N-1 em fixture (`aplicar-restauracao` sem flag → `db:migrate`): migrate exit 0 aplicou **31 migrations**; `backups/` vazio; **zero** marcadores externos (state/fase/journal/pendente) no diretório da instalação. Confirmado: nada permite ao próximo boot distinguir "migration recém-aplicada" de estado normal — não existe proveniência backup↔migration no legado. |
| W9 | **NÃO EXECUTADO — bloqueado por ambiente** | Mesmo bloqueio de W0 (porta 3001 ocupada pelo servidor real). Harness pronto: `killOn: /Aplicando migra/` + segunda execução de retomada. |
| W10 | **NÃO EXECUTADO — bloqueado por ambiente** | Mesmo bloqueio. Harness pronto: `killOn: /\[OK\] Servidor iniciado/` + verificação `servidorNoArAposKill` + próximo boot completo. |
| W11 | BLOQUEADO | `scripts/boot-lock.mjs` ausente em N-1; cenário só existe em N (#189 Draft). |
| W12 | PARCIAL | Itens 1–2 cobertos por W6/W8. Item 3 (smoke em cópia de dados reais) exige autorização/fixture de produção — não executado. |
| W13 | BLOQUEADO | Marcador "estado já inicializado" não implementado — casos indistinguíveis por construção. |
| W14 | **REPROVADO — fail-open confirmado** | 5 cenários executados contra `servidor/dist/db/aplicar-restauracao.js` real com `MESTRE_HOME` isolado: (a) banco inexistente → exit 0 correto; (b) banco sem `server_settings` → **exit 0** "nada a restaurar"; (c) `server_settings` como view quebrada (erro de consulta real) → **exit 0**; (d) arquivo corrompido (não-SQLite) → **exit 0**; (e) flag com backup inexistente → exit 2 correto. **Achado:** `aplicar-restauracao.ts` trata qualquer exceção de `prepare/get` como "nada a restaurar" e retorna sucesso — banco existente corrompido ou com erro de I/O pode subir sem restauração e sem aviso de erro. Viola o critério W14 ("nenhum erro de consulta pode virar 'nada a restaurar' com sucesso"). Candidato a correção: distinguir `SQLITE_ERROR` de schema ausente de erros de I/corrupção e abortar. |
| W15 | BLOQUEADO | Journal externo de restauração não existe; flag `restauracao_pendente` vive dentro do banco — sem retomada por subetapa. |
| W16 | **REPROVADO — fail-open parcial confirmado** | Contra `verificarBackup` real com fixture migrada: backup válido → ok; arquivo adulterado coberto pelo manifesto → **rejeitado corretamente** ("arquivos: 0 ok, 1 com problema"); **manifesto ausente → `ok:true`** — o código só valida `manifesto.json` `if (existsSync(manPath))`, ou seja, backup sem manifesto passa como íntegro. Viola W16 ("manifesto ausente deve falhar"). Metadados sha256 de banco/config e proteção de backup transacional por retenção: **não existem no código** — permanecem CORREÇÃO/CONTRATO. |

## Comandos executados (reproduzíveis)

```bat
node --check homologacao-155-w.mjs
node homologacao-155-w.mjs w14   :: 5 cenarios, exit codes acima
node homologacao-155-w.mjs w8    :: migrate real em MESTRE_HOME isolado
node homologacao-155-w.mjs w16   :: criarBackup/verificarBackup reais
node homologacao-155-w.mjs w6    :: servidor real isolado por MESTRE_*
node homologacao-155-w.mjs w0    :: aborta no pre-flight: porta 3001 ocupada
```

## Limitações declaradas

1. **Node v26.13.0** — acima do mínimo declarado (20+) e diferente do CI (22). Resultados de W14/W16/W8 são de lógica SQLite/Node estável entre versões, mas a evidência formal em Node 20/22 fica para CI ou estação dedicada.
2. **W0/W9/W10** não executados: servidor real ocupa a porta que o `.bat` verifica. O harness está pronto e foi revisado; basta rodar com o servidor parado. O pull de fixture usa a branch remota `homolog/w-fixture-155` (commit que só adiciona `echo` marcador após `:sem_auto_update`) — **branch scratch no origin, remover após homologação**.
3. **W16** cobriu `verificarBackup` (verificação online); a ausência de revalidação de hashes no `aplicar-restauracao` offline já era conhecida por auditoria e permanece documentada, não re-executada aqui.
4. Junction `node_modules` na fixture `.bat` evita `npm ci` — os cenários W0/W9/W10 testarão builds reais (tsc/vite) mas não reinstalação de dependências; se o contrato exigir `npm ci` real na fixture, rodar sem junction em estação dedicada.
5. W14 cenário (e) usou flag apontando para backup inexistente — cobriu o caminho já tratado (exit 2); os fail-open estão em (b)(c)(d).

## Achados que alimentam correções (não implementadas aqui)

- **F1 (W14):** `aplicar-restauracao.ts` ~l.186: `catch` genérico em volta de `prepare/get` retorna "nada a restaurar" com exit 0 para qualquer erro — inclusive corrupção e I/O. Severidade alta: boot prossegue sobre bancopotentialmente inconsistente.
- **F2 (W16):** `backup.ts` `verificarBackup`: `manifesto.json` ausente → validação pulada → `ok:true`. Contrato exige manifesto obrigatório → falhar.
- **F3 (W16):** manifesto não cobre sha256 do banco nem da config; `aplicar-restauracao` offline não revalida hashes — lacuna já auditada, confirmada.

## Pendências

- Executar W0/W9/W10 com servidor real parado (janela combinada com o usuário).
- Node 20/22 para evidência de versão mínima.
- W1–W5/W7/W11/W13/W15 aguardam versão N integrada.
