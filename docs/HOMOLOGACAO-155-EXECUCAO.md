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
| W6 | **APROVADO — revalidado com isolamento total** | Cópia completa da aplicação em `%TEMP%` (`servidor/dist` + `servidor/migrations` + `site/dist` + `configuracao/servidor.json` com porta dedicada livre + `node_modules` junction + `MESTRE_HOME` próprio com banco/arquivos/backups): filho subiu, `/api/health` **200** na porta efêmera dedicada (provada livre antes), processo filho vivo durante a resposta e porta morta após kill. Snapshot antes/depois de `banco/`, `arquivos/`, `backups/` **e `configuracao/`** da instalação real: **zero alterações**. Execução anterior (dist da worktree + porta 3001) estava **NÃO VALIDADA** até este reteste isolado. |
| W7 | BLOQUEADO | Estado externo de N não implementado. |
| W8 | **APROVADO (lacuna demonstrada)** | Sequência real do `.bat` N-1 em fixture (`aplicar-restauracao` sem flag → `db:migrate`): migrate exit 0 aplicou **31 migrations**; `backups/` vazio; **zero** marcadores externos (state/fase/journal/pendente) no diretório da instalação. Confirmado: nada permite ao próximo boot distinguir "migration recém-aplicada" de estado normal — não existe proveniência backup↔migration no legado. |
| W9 | **APROVADO — executado em 26/11/2026 no SHA `8353ed7` (PR #376)** | Windows: teste E2E com `MESTRE_*` hostis no processo pai apontando para sentinelas em `%TEMP%\\mestre-sentinel-205`. Kill determinístico pré-migrate: `migrate.chegou=true`, `migrate.executou=false`; segundo boot retomou com `health=200`. Logs confinados a `dados-fixture`; sentinelas externas intactas. Evidência: [PR #376, comentário 7199467613](https://github.com/mestredsl-eng/mestreRPG/pull/376#issuecomment-7199467613). |
| W10 | **APROVADO — executado em 26/11/2026 no SHA `8353ed7` (PR #376)** | Windows: kill determinístico pré-start: `start.chegou=true`, `start.executou=false`, `servidorNoArAposKill=false`; segundo boot retomou com `health=200`. O pai manteve `MESTRE_HOME/BANCO/ARQUIVOS/BACKUPS` apontando para sentinelas; `sentinel.db` e `marco.txt` permaneceram intactos, `arquivos/` e `backups/` externos vazios. Evidência: [PR #376, comentário 7199467613](https://github.com/mestredsl-eng/mestreRPG/pull/376#issuecomment-7199467613). |
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
2. **W9/W10** foram executados em Windows em 26/11/2026 no SHA `8353ed7` da PR #376, depois da correção da allowlist de ambiente. A prova negativa injetou `MESTRE_HOME`, `MESTRE_BANCO`, `MESTRE_ARQUIVOS` e `MESTRE_BACKUPS` hostis no processo pai, apontando para sentinelas externas; ambos os boots usaram apenas `dados-fixture`, as interrupções ocorreram nas barreiras determinísticas e as retomadas retornaram `health=200`. Os arquivos externos permaneceram intactos. **Esses runs foram locais em Windows, não fazem parte da CI atual.** O harness usa remoto bare local em `%TEMP%`; nenhum push foi feito ao GitHub oficial. **W0 literal permanece bloqueado por contrato** e depende de autorização explícita para mutação remota temporária. Evidência W9/W10: [PR #376, comentário 7199467613](https://github.com/mestredsl-eng/mestreRPG/pull/376#issuecomment-7199467613).
3. **W16** cobriu `verificarBackup` (verificação online); a ausência de revalidação de hashes no `aplicar-restauracao` offline já era conhecida por auditoria e permanece documentada, não re-executada aqui.
4. Junction `node_modules` na fixture `.bat` evita `npm ci` — os cenários W0/W9/W10 testarão builds reais (tsc/vite) mas não reinstalação de dependências; se o contrato exigir `npm ci` real na fixture, rodar sem junction em estação dedicada.
5. W14 cenário (e) usou flag apontando para backup inexistente — cobriu o caminho já tratado (exit 2); os fail-open estão em (b)(c)(d).

## Achados que alimentam correções (não implementadas aqui)

- **F1 (W14):** `aplicar-restauracao.ts` ~l.186: `catch` genérico em volta de `prepare/get` retorna "nada a restaurar" com exit 0 para qualquer erro — inclusive corrupção e I/O. Severidade alta: boot prossegue sobre bancopotentialmente inconsistente.
- **F2 (W16):** `backup.ts` `verificarBackup`: `manifesto.json` ausente → validação pulada → `ok:true`. Contrato exige manifesto obrigatório → falhar.
- **F3 (W16):** manifesto não cobre sha256 do banco nem da config; `aplicar-restauracao` offline não revalida hashes — lacuna já auditada, confirmada.

## Pendências

- **W9/W10: concluídos** em Windows local no SHA `8353ed7` da PR #376; ver evidência vinculada acima. Não confundir com cobertura CI.
- W0: decidir separadamente se a cobertura funcional por fixture bare local é suficiente ou se haverá autorização explícita para um teste remoto efêmero. Não executar mutação remota sem autorização.
- W0: autorizar branch efêmera no GitHub (`HOMOLOG_W_REMOTO_GITHUB=1`) ou aceitar classificação permanente de bloqueado por contrato do `auto-update`.
- Node 20/22 para evidência de versão mínima.
- W1–W5/W7/W11/W13/W15 aguardam versão N integrada.


## Adendo — 26/11/2026 — W9/W10 após sanitização do ambiente

**Código/harness:** PR #376, branch `fix/205-env-harness`, SHA testado `8353ed7381c8f40c292115a14636326195f8a770` (prefixo `8353ed7`). Correção revisada pelo INTERMEDIÁRIO antes da execução.

**Teste negativo de contenção:** o processo pai recebeu `MESTRE_HOME`, `MESTRE_BANCO`, `MESTRE_ARQUIVOS` e `MESTRE_BACKUPS` apontando para `%TEMP%\\mestre-sentinel-205`, com `sentinel.db`, `marco.txt` e diretórios externos preparados antes da execução.

| Verificação | Resultado observado |
|---|---|
| W9 — interrupção pré-migrate | `migrate.chegou=true`; `migrate.executou=false`; retomada no boot seguinte com `health=200` |
| W10 — interrupção pré-start | `start.chegou=true`; `start.executou=false`; `servidorNoArAposKill=false`; retomada no boot seguinte com `health=200` |
| Contenção | logs dos dois boots apontam somente para `dados-fixture\\banco\\mestre-rpg.db`; nenhuma referência ao caminho sentinela |
| Integridade externa | `sentinel.db` e `marco.txt` preservados; `arquivos/` e `backups/` externos permaneceram vazios |

**Classificação:** W9 e W10 = **PASS local Windows no SHA acima**. A evidência fecha o P1 de vazamento de ambiente do harness. **Não significa cobertura de CI**: os cenários não estão wired no workflow. Nenhuma alteração em `.github/workflows/ci.yml` foi feita.

**Fonte primária:** [PR #376 — comentário com logs e prova de sentinelas](https://github.com/mestredsl-eng/mestreRPG/pull/376#issuecomment-7199467613).
