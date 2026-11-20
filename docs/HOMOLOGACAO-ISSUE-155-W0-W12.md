# Matriz de homologação E2E — Issue #155 (auto-update seguro no boot)

**Status:** esqueleto operacional — documento de planejamento de homologação.
**Escopo:** somente documentação. Nenhum procedimento aqui foi executado; nenhum resultado é declarado.
**Data de referência do código:** SHA `7ce5b99bb20a0f951ffe5b70a96fe46ee5a157a0` (`feat/issue-155-startup-auto-update`, HEAD da PR #176 em 2026-11-20).

> **Nota de proveniência:** este documento foi produzido a partir das descrições do contrato consolidado
> recebidas na coordenação (W0–W12) e do adendo W13–W16. O texto integral do contrato W0–W12 **não estava
> acessível** nas PRs/issues/branches no momento da redação; os cenários W1–W7 estão estruturados como
> procedimentos provisórios a confirmar contra o contrato antes da execução. Itens cuja pré-condição de
> implementação não existe no código estão marcados **BLOCKED — dependência**, nunca PASS.

---

## 1. Fontes e SHAs de referência

| Artefato | Referência |
|---|---|
| Updater / `.bat` legados (N-1) | `7ce5b99bb20a0f951ffe5b70a96fe46ee5a157a0` — PR #176 |
| Boot Lock (N candidato) | PR #189 head `f22effdd8904711a9be728f631b645239ebef727`, base `28e742d03752b68a88f3d7e4154cd168e978faad` — **Draft, não integrado** |
| Hardening árvore suja / buffer | PR #188, base `fix/issue-155-status-hardening` — **Draft** |
| CI da suíte | `.github/workflows/ci.yml` @ `7ce5b99` + PR #190 (Draft, somente CI) |
| Restauração pendente | `servidor/src/db/aplicar-restauracao.ts` — flag `restauracao_pendente` na tabela `server_settings` **do próprio banco** |
| Trava de instância | `servidor/src/db/trava-instancia.ts` — SQLite `BEGIN EXCLUSIVE`, pertence ao processo servidor, **não** substitui o Boot Lock do `.bat` |
| Config de porta | `servidor/src/config.ts` — `configuracao/servidor.json:porta` prevalece sobre `MESTRE_PORTA` |

## 2. Regras transversais de evidência

Nenhum W pode ser declarado PASS sem registrar, na ata de execução (§7):

1. **SHA efetivamente testado** — saída de `git rev-parse HEAD` colada no log; se o checkout foi de merge ref (`refs/pull/N/merge`), declarar explicitamente que se testou o merge, nunca o head.
2. **SO e versão** — `winver`/`[System.Environment]::OSVersion` no Windows; `lsb_release -a` no Ubuntu.
3. **Versão do Node** — `node --version` (projeto declara 20+; CI usa 22; evidência local anterior foi Node 26 — repetir em 20 e 22).
4. **Comando exato** executado e **código de saída**.
5. **Logs integrais relevantes** — saída do `.bat`/helper, `git log --oneline -3`, `git status --porcelain`, `PRAGMA integrity_check`, `SELECT` no journal `__drizzle_migrations`, listagem de `backups/`.
6. **Conferência de estado persistente** — HEAD, branch, arquivos externos, banco, locks, logs. Exit code 0 sozinho **não** é prova.
7. **Limpeza** — todo fixture em diretório descartável criado pelo teste (`mkdtemp`/pasta dedicada); nunca apontar testes destrutivos para `banco/`, `backups/` ou `configuracao/` da instalação real.

### Legenda de classificação por teste

- **[HOJE]** — executável com o código existente no SHA de referência.
- **[CORREÇÃO]** — exige alteração de produto/teste ainda não implementada; homologar só depois do merge da correção.
- **[INTEGRAÇÃO]** — só pode ser homologado após a integração coordenada (#188 → #189 → branch #176) que forma a versão N.
- **[CONTRATO]** — depende de decisão/contrato do Pai ainda não congelado.

### Estado persistente a conferir em toda interrupção/retomada

Antes e depois de cada crash simulado, registrar: `git rev-parse HEAD`, `git branch --show-current`, `git status --porcelain`, conteúdo do estado externo (caminho, identidade, fase), `server_settings`/`__drizzle_migrations` do banco, existência de `restauracao_pendente`, `backups/pre_restore_*`, locks (`boot-lock`, `trava-instancia`), e processos node/cmd remanescentes.

---

## 3. Matriz W0–W16

### W0 — `.bat` legado real na primeira transição (N-1 → N)

- **Objetivo/risco:** provar o comportamento real do `cmd.exe` executando o `.bat` **extraído do SHA N-1**, inclusive quando a atualização remota modifica o próprio `iniciar-mestre-rpg.bat` no meio da execução (cauda do batch já foi lida/parcialmente interpretada). Risco: a versão nova do `.bat` entrar em vigor com parsing/offset inconsistente, ou a cauda legada continuar executando etapas sobre código novo.
- **Classificação:** [HOJE] para a parte de observação do `.bat` N-1; [INTEGRAÇÃO] para a versão N com handoff `:_fase2` (que não existe em `7ce5b99` — verificado: o `.bat` nessa revisão não contém handoff, despacho de fase nem boot lock).
- **Pré-condições:** Windows real; clone descartável do repo; remote "origin" controlado pelo teste (clone local ou `file://`) na revisão N-1 `7ce5b99`; remoto contém commit N que altera `iniciar-mestre-rpg.bat`.
- **Fixture:** `mktemp`-style dir (ex.: `%TEMP%\w0-<ts>`); `git clone` do fixture; `configuracao/servidor.json` e `banco/` mínimos; `MESTRE_AUTO_UPDATE` ausente (comportamento default) e depois `=0` como controle.
- **Preparação/comandos:**
  1. Extrair o `.bat` legado: `git show 7ce5b99:iniciar-mestre-rpg.bat > iniciar-mestre-rpg.bat` no clone descartável (garante byte-a-byte o arquivo da revisão, não uma cópia de trabalho).
  2. Configurar `origin` do clone para um bare repo cujo HEAD inclui o commit N que modifica o `.bat`.
  3. Executar `cmd /c iniciar-mestre-rpg.bat` com log em arquivo (`> w0.log 2>&1`) e marcar timestamps por linha se possível.
- **Ponto de interrupção/injeção:** a atualização acontece dentro de `node scripts\auto-update.mjs` (após a checagem de porta 3001 e antes de npm/build/restore/migrate). A "injeção" é o próprio conteúdo do commit N — o `.bat` em disco é substituído pelo pull enquanto o `cmd.exe` já o está interpretando.
- **Resultado esperado (a confirmar na execução — não presumir):** documentar se o `cmd.exe` continua a cauda do arquivo antigo (bytes já lidos em buffer) ou relê o arquivo; se etapas pós-update (npm ci, builds, `aplicar-restauracao`, `db:migrate`, `npm run start`) executam sobre código N; se há linha de cauda corrompida/duplicada.
- **PASS:** log completo capturado e comportamento descrito com evidência; nenhuma alegação de "recuperação garantida" sem prova. **FAIL:** `.bat` novo executado com offset errado de forma imprevisível **sem** que isso esteja documentado como limitação aceita; boot sobre estado inconsistente sem abort. **BLOCKED:** se a versão N com handoff não estiver integrada — W0 passa a observar apenas o legado e o cenário "handoff" fica [INTEGRAÇÃO].
- **Logs/artefatos:** `w0.log` integral; `git log --oneline` antes/depois; diff do `.bat` entre revisões; lista de processos ao final.
- **Limpeza:** apagar o diretório do fixture inteiro; o bare repo de teste pode ser reutilizado entre execuções se desejado.
- **CI ou Windows real:** **Windows real obrigatório** — `cmd.exe` batch parsing não é reproduzível em CI Linux de forma fiel; o job `windows-latest` pode hospedar uma versão automatizada, mas a primeira homologação deve ser manual com captura de tela/log.

### W1–W7 — handoffs, concorrência, interrupções, retomada e integridade (procedimentos provisórios)

> **[PENDENTE — CONTRATO]** O rótulo e o cenário exato de cada W1–W7 devem ser conferidos no contrato consolidado antes da execução. Os itens abaixo são a estrutura mínima derivada das descrições recebidas ("handoffs, concorrência, interrupções, retomada, estado externo corrompido e integridade") e das correções exigidas nas revisões do contrato (itens A–H do comentário de consistência final da PR #176). Não executar como se fossem o contrato literal.

**W1 — Handoff N-1 → N (primeira transição, estado externo).**
- Objetivo: provar o que acontece na janela entre o pull que instala N e o primeiro boot que executa o código N (estado externo, consentimento, fases).
- Pré-condições: N-1 = `7ce5b99`; N = branch com consentimento + estado durável + Boot Lock integrado [INTEGRAÇÃO].
- Fixture: clone descartável com remote controlado; forçar pull N-1→N.
- Interrupção: kill -9 / fechamento de janela em cada fronteira: pós-pull/pré-persistência de estado, pós-npm-ci, pós-build, pré-restore, pós-restore, pré-migrate, pós-migrate, pré-start.
- Esperado: estado externo persistido identifica fase e identidade (`instalacaoId`/repo canônico — contrato [CONTRATO]); retomada N+1 obedece à máquina de estados; nada de fase presumida.
- PASS: retomada converge para boot íntegro ou aborta com instrução; estado persistente confere com a fase real. FAIL: boot silencioso sobre estado parcial. BLOCKED: sem implementação do estado durável/consentimento.
- Classificação: [INTEGRAÇÃO]+[CONTRATO].

**W2 — Concorrência de boots na transição N-1→N.**
- Objetivo: dois `iniciar-mestre-rpg.bat` simultâneos antes de qualquer servidor no ar. N-1 não tem Boot Lock — o check de porta 3001 não protege a janela pré-servidor.
- Fixture: clone descartável; dois processos `cmd` iniciados juntos (script de spawn duplo).
- Esperado: documentar a corrida real (dois updates Git/npm concorrentes?) — o contrato assume Boot Lock só em N; a transição N-1→N está explicitamente sobdescrita e deve ser reportada como risco residual se não houver mitigação.
- PASS/FAIL: conforme contrato definir "vitória única" ou "risco aceito documentado". BLOCKED se exigir Boot Lock em N-1 (impossível sem reescrever o legado).
- Classificação: [INTEGRAÇÃO]+[CONTRATO].

**W3 — Interrupção durante o pull / janela pull→state.**
- Objetivo: kill entre `git pull --ff-only` retornar e a persistência do estado (best-effort em N-1). HEAD=N sem marcador → indistinguível de "update completo".
- Fixture: clone com remote controlado; injeção de kill via wrapper do `node scripts/auto-update.mjs` ou `taskkill` temporizado.
- Esperado: documentar que N-1 não tem como distinguir; em N, o protocolo deve gravar intenção **antes** do pull (fase pré-pull persistida).
- PASS: N retoma/aborta conforme fase persistida; N-1: risco residual declarado. FAIL: estado parcial silencioso. BLOCKED: depende de W1.
- Classificação: [CORREÇÃO]+[INTEGRAÇÃO].

**W4 — Retomada e rollback Git (falhas pós-pull de deps/build).**
- Objetivo: cobrir os três resultados do rollback: sucesso comprovado (árvore limpa + HEAD=shaNovo + ancestralidade + mesma branch + rebuild concluído), falha comprovada → exit 1 com instruções, e exceção inesperada → nunca exit 0.
- Fixture: clone descartável; injetar falha de `npm ci`/build via PATH fake ou pacote quebrado no commit N; `stateFile` isolado por cenário.
- Interrupção: falhas determinísticas (não crash) + kill durante `executarRollback`.
- Esperado: rollback só retorna sucesso após rebuild servidor+site na revisão restaurada; falha de diagnóstico de deps = estado desconhecido → rollback; `reverterAtualizacao` manual via arquivo de estado.
- PASS: `git rev-parse HEAD`=shaAnterior, árvore limpa, `site/dist` reconstruído, exit 0 somente com rollback comprovado; exit 1 com instruções caso contrário. FAIL: exit 0 sem rollback ou reset em branch/árvore errada. Reuso: `teste-auto-update.mjs` cobre a lógica unitária [REUSO]; este W é a prova E2E no `.bat` real.
- Classificação: [HOJE] para N-1 (rollback interno já existe); [INTEGRAÇÃO] para o fluxo completo N.

**W5 — Estado externo corrompido / identidade divergente.**
- Objetivo: state file/consentimento com JSON inválido, `instalacaoId` divergente, repo canônico divergente, versão de schema desconhecida.
- Fixture: editar o arquivo de estado/consentimento externo entre boots (caminho TBD pelo contrato — fora do worktree).
- Esperado (contrato revisado, comentário "Auditoria de consistência final"): divergência de identidade = **estado inválido → quarentena + boot bloqueado para inspeção, sem reset** — não "ausente".
- PASS: comportamento documentado e fail-closed conforme contrato; FAIL: tratar divergência como ausente e seguir. BLOCKED: [CONTRATO] — localização/escrita atômica do estado externo indefinidas.
- Classificação: [CONTRATO].

**W6 — Integridade do banco na transição.**
- Objetivo: provar separação rollback-Git × proteção-dados: falha em `aplicar-restauracao` ou `db:migrate` no `.bat` **aborta o boot sem presumir rollback Git**; o updater N-1 só faz rollback Git/rebuild nas falhas internas de deps/build.
- Fixture: clone descartável; forçar `db:migrate` falho (migration inválida em banco de teste) e `aplicar-restauracao` com flag pendente corrompida.
- Esperado: exit ≠0, banco preservado, `pre_restore_*` intacto, nenhuma reversão Git automática. PASS: abort com instrução correta. FAIL: boot prossegue sobre estado incerto ou Git revertido indevidamente.
- Classificação: [HOJE] — comportamento do `.bat` N-1 observável hoje.

**W7 — Retomada pós-crash com estado persistido (máquina de fases N).**
- Objetivo: cada fase durável (pré-pull, pós-pull, pós-npm-ci, pós-builds, pós-restore, pós-migrate) tem marcador; crash em cada fronteira retoma ou aborta deterministicamente.
- Fixture: clone descartável; kill -9 em cada fronteira; reiniciar `.bat`.
- Esperado: fase persistida = fase real; nunca duas execuções da mesma etapa sem idempotência comprovada; `seguroIniciar` só marca `validado` quando **todas** as dimensões tiverem prova de conclusão ou justificativa durável de não aplicabilidade.
- PASS: matriz fase×crash executada com ata por célula. FAIL: qualquer célula com resultado divergente do contrato. BLOCKED: [CONTRATO]+[CORREÇÃO] — máquina de fases e `seguroIniciar` não implementados.
- Classificação: [INTEGRAÇÃO]+[CONTRATO].

### W8 — Migration legada concluída + ausência de proveniência/backup (mecanismo legado)

- **Objetivo/risco:** demonstrar que, no mecanismo **legado** (N-1), uma migration concluída seguida de queda **não deixa** proveniência nem backup pré-migration recuperável — ou seja, provar a **lacuna**, não inventar recuperação.
- **Classificação:** [HOJE] — observável no código atual.
- **Fatores verificados no código:** `aplicar-restauracao.ts` só age sobre flag `restauracao_pendente`; `db:migrate` roda direto no `.bat` sem backup prévio; `backup.ts` gera `manifesto.json` com sha256/tamanho dos arquivos de campanha + `criadoEm` + `versao`, mas **sem** SHA-256 do banco nem da config; `aplicar-restauracao` faz `integrity_check` + checks estruturais, **sem** revalidar hashes do manifesto.
- **Fixture:** clone descartável; banco de teste com migration pendente; kill após `db:migrate` retornar e antes de `npm run start`.
- **Interrupção:** entre o fim de `call npm run db:migrate -w servidor` e `call npm run start -w servidor` (linhas finais do `.bat` N-1).
- **Resultado esperado:** documentar que não existe marcador de "migration aplicada nesta sessão", nem backup automático pré-migration, nem journal externo de fases — o próximo boot não tem como distinguir "migration concluída na sessão anterior" de estado normal. **A lacuna confirmada é o resultado PASS deste teste.**
- **PASS:** lacuna reproduzida e descrita com evidência (ausência de artefatos + comportamento do próximo boot). **FAIL:** se o teste "provar" recuperação automática que o código não tem — isso seria fabricação. **BLOCKED:** não aplicável.
- **Logs:** saída do `.bat` nas duas execuções; `ls backups/`; `SELECT` em `__drizzle_migrations`; `PRAGMA integrity_check`.
- **Limpeza:** fixture descartável.
- **CI/Windows:** lógica pode rodar em Ubuntu para a parte de inspeção de artefatos; a execução do `.bat` real exige Windows.

### W9 — Queda depois do pull e antes da cauda do `.bat`

- **Objetivo/risco:** janela específica entre o retorno de `node scripts\auto-update.mjs` (pull+builds internos concluídos ou rollback feito) e a continuação do `.bat` legado (npm ci do `.bat`, rebuild servidor/site do `.bat`, restore, migrate, start). **Distinto** de queda durante o pull (W3) e de queda após migration (W8/W10).
- **Classificação:** [HOJE] para observação; [INTEGRAÇÃO] para a versão com fases.
- **Fixture:** clone descartável; injeção de kill logo após o step do auto-update (ex.: wrapper que encerra o `cmd` quando o updater retorna, ou `taskkill` no PID do cmd).
- **Interrupção:** imediatamente após `node scripts\auto-update.mjs` retornar 0 e antes do primeiro `call npm`/`node` seguinte.
- **Esperado:** HEAD=N, builds do updater concluídos, mas etapas do `.bat` (npm ci se node_modules ausente, build servidor, build site por timestamp, restore, migrate, start) **não executadas**. Próximo boot: updater vê "sem atualização" (HEAD já em N), `.bat` reexecuta suas etapas — documentar se a reexecução é idempotente (build por timestamp, migrate idempotente, restore sem flag = no-op).
- **PASS:** próximo boot converge para servidor íntegro **ou** aborta com instrução; nenhuma etapa duplicada com efeito colateral. FAIL: estado parcial silencioso. BLOCKED: se a idempotência não puder ser verificada sem implementação nova.
- **CI/Windows:** Windows real para o `.bat`; inspeções podem ser Ubuntu.

### W10 — Fluxo completo com `.bat` legado e comportamento do próximo boot

- **Objetivo/risco:** reproduzir o ciclo completo N-1 (update → cauda legada → migrate → queda antes do servidor) e verificar o que o **próximo boot** faz — cobrindo a proveniência/ausência de backup do mecanismo legado de forma integrada.
- **Relação com W8:** W8 isola a **prova da lacuna** (migration concluída sem proveniência); W10 executa o **fluxo completo** com o `.bat` extraído de `7ce5b99` e observa o boot seguinte. Se a execução demonstrar que ambos são materialmente o mesmo teste, **recomenda-se consolidá-los** — registrar a decisão no contrato em vez de apagar cobertura silenciosamente.
- **Classificação:** [HOJE].
- **Fixture/Preparação:** como W8, com `.bat` extraído via `git show 7ce5b99:iniciar-mestre-rpg.bat`.
- **Interrupção:** kill antes de `npm run start` (após migrate).
- **Esperado:** próximo boot executa updater (sem update → segue), etapas do `.bat`, restore (sem flag → no-op), migrate (nada pendente → no-op), start. Documentar ausência de qualquer verificação de "estado deixado pela sessão anterior".
- **PASS:** comportamento do próximo boot documentado com logs; lacuna W8 confirmada em contexto real. **CI/Windows:** Windows real.

### W11 — Helper ausente na versão N (fail-closed do Boot Lock)

- **Objetivo/risco:** provar que, quando `scripts\boot-lock.mjs` está ausente na versão instalada, **npm, builds, restauração e migrations não são executados** — e que não existe bypass silencioso.
- **Base factual (PR #189):** o `.bat` da #189 aborta se `scripts/boot-lock.mjs` não existir ou se o helper retornar código inesperado; exit 20 = "outra instância assumiu" → `exit /b 0` limpo; demais não-zero → abort.
- **Classificação:** [INTEGRAÇÃO] — exige a versão N com Boot Lock; em `7ce5b99` o `.bat` **não** tem essa verificação (não existe `boot-lock` na árvore).
- **Fixture:** clone descartável da versão N; remover `scripts/boot-lock.mjs` do worktree **depois** do pull (simulando versão que perdeu o helper) — ou montar a versão N sem o arquivo.
- **Interrupção/injeção:** ausência do arquivo no momento da chamada `node scripts\boot-lock.mjs adquirir`.
- **Esperado:** abort antes de qualquer `npm`/build/restore/migrate; log explícito; exit code conforme contrato (não-zero, distinto de 20). **Verificar também**: não há caminho `goto` alternativo que pule a verificação; `errorlevel` é lido corretamente em `cmd.exe` real.
- **PASS:** nenhuma etapa proibida executada (conferir por log e por ausência de efeitos: `node_modules` não criado, `dist/` não tocado, banco não migrado). FAIL: qualquer bypass ou execução parcial. BLOCKED: [INTEGRAÇÃO].
- **CI/Windows:** Windows real obrigatório para `cmd.exe`; o teste estrutural existente (`teste-boot-lock.mjs`) é só textual — este W exige execução comportamental.

### W12 — Smoke isolado, integridade real e journal de migrations

- **Objetivo/risco:** separar três provas que não podem ser confundidas:
  1. **Smoke HTTP em diretório descartável** — subir o servidor filho em cópia isolada (config e banco próprios), bater em `/api/health`, encerrar. `MESTRE_PORTA` **não basta**: `configuracao/servidor.json:porta` prevalece sobre a env (verificado em `servidor/src/config.ts`) — a fixture precisa de config própria com porta livre ou override explícito de teste. Nunca editar o config real do usuário.
  2. **Integridade real do banco** — `PRAGMA integrity_check` + `PRAGMA foreign_key_check` no banco restaurado/migrado da fixture, não no banco de produção.
  3. **Journal de migrations real** — `SELECT` em `__drizzle_migrations` conferindo IDs aplicados vs. journal do código; prova de que o lote pendente foi aplicado atomicamente (drizzle-orm 0.45.4 executa o lote pendente em transação única).
  4. **Smoke em cópia consistente dos dados reais** — somente se autorizado, sobre snapshot/bak da instalação real copiado para diretório descartável; banco vazio **não** prova integridade de dados reais.
- **Classificação:** itens 1–3 [HOJE] em fixture; item 4 depende de autorização/fixture de dados reais [CONTRATO].
- **PASS:** cada prova com seu próprio artefato; o smoke HTTP nunca é apresentado como prova de integridade do banco. FAIL: smoke com banco vazio reportado como "dados reais íntegros".
- **CI/Windows:** itens 1–3 podem rodar em CI (ubuntu + windows-latest); item 4 exige estação de homologação.

### W13 — Sentinela: instalação nova × instalação N que perdeu o diretório externo

- **Objetivo/risco:** distinguir "primeira instalação legítima" (nunca teve estado externo — deve inicializar normalmente) de "instalação N que **perdeu inesperadamente** o diretório externo" (estado sumiu depois de existir — pode indicar perda/corrupção e deve bloquear). A ambiguidade entre os dois casos não pode ser resolvida silenciosamente.
- **Classificação:** [CONTRATO]+[CORREÇÃO] — exige marcador de "estado externo já foi inicializado" persistido em local distinto do diretório externo (ex.: flag no banco ou no worktree), senão os dois casos são indistinguíveis por construção.
- **Fixture:** (a) clone novo sem estado externo → boot deve prosseguir criando estado; (b) instalação N com estado criado, depois diretório externo removido → boot deve bloquear ou exigir confirmação conforme contrato.
- **PASS:** os dois cenários produzem comportamentos **diferentes e documentados**; ambiguidade → bloqueio. FAIL: instalação N com estado perdido tratado como nova (reset silencioso) ou instalação nova bloqueada injustamente.
- **CI/Windows:** lógica testável em CI quando implementada; depende de decisão de design [CONTRATO].

### W14 — Fail-open do detector de restauração pendente

- **Objetivo/risco:** provar que **nenhum erro de consulta pode virar "nada a restaurar" com sucesso**. Cenários: banco inexistente legítimo (primeiro boot — deve criar); banco existente **sem** `server_settings`; falha de `prepare`/`get`; corrupção que permite abertura parcial; erro de I/O na leitura.
- **Fatores verificados:** `aplicar-restauracao.ts` lê `select value from server_settings where key='restauracao_pendente'`; ausência de linha → "Nenhuma restauração pendente" e return 0. A questão é se **erro** (não ausência) também retorna sucesso — hoje o código distingue `row` ausente de exceção, mas o contrato exige prova de que exceção/erro de I/O **aborta**, não segue.
- **Fixture:** clones/bancos descartáveis manipulados: (a) sem `banco/mestre-rpg.db`; (b) banco criado sem a tabela `server_settings`; (c) `server_settings` corrompida/truncada; (d) permissão de leitura revogada no arquivo; (e) `-wal`/`-shm` em estado inconsistente.
- **Esperado:** banco inexistente legítimo → cria e segue; banco existente com qualquer falha de consulta → **exit ≠0 e boot abortado**; nunca "nada a restaurar" por erro.
- **PASS:** matriz de cenários × exit codes conforme tabela do contrato; FAIL: qualquer erro de consulta retornando 0 com boot prosseguindo. **Nota:** se o código atual tratar exceção como ausência, W14 é [CORREÇÃO] até o fix; registrar como achado.
- **CI/Windows:** executável em CI (script node direto, sem `.bat`) — candidato a suíte automatizada.

### W15 — Restauração interrompida em cada subetapa

- **Objetivo/risco:** queda durante `aplicar-restauracao` em cada fronteira: preservação (`pre_restore_*`), substituição do arquivo do banco, sidecars (`-wal`/`-shm`), arquivos da campanha, configuração, limpeza da flag `restauracao_pendente` e rollback interno do restaurador.
- **Verificado no código:** a flag vive **dentro do banco** (`server_settings`), e a aplicação troca o arquivo do banco — ou seja, a flag pode estar no banco **antigo** ou no **restaurado** conforme o ponto do crash; a remoção é confirmada por re-leitura. Não existe journal externo de subetapas hoje.
- **Classificação:** **BLOCKED — dependência** enquanto não existir journal externo de restauração e protocolo de retomada. Marcar o teste inteiro BLOCKED, não FAIL.
- **Fixture (quando implementado):** clone descartável com flag `restauracao_pendente` apontando para backup válido; kill -9/`taskkill` em cada fronteira; reiniciar `node servidor\dist\db\aplicar-restauracao.js`.
- **Esperado:** retomada por journal externo converge para estado íntegro ou aborta com instrução; integridade final conferida por `PRAGMA integrity_check` + presença/ausência correta da flag.
- **PASS:** matriz fronteira×resultado completa. FAIL: dupla aplicação, flag órfã, banco híbrido. **Hoje:** documentar como lacuna — crash no meio da restauração deixa estado indeterminado sem retomada automática.
- **CI/Windows:** Windows real prioritário (semântica de arquivo aberto/lock do SQLite no Windows); parte da lógica em CI.

### W16 — Backup crítico: manifesto e retenção transacional

- **Objetivo/risco:** provar que backup inválido **falha** e que retenção não remove backups em uso.
- **Fatores verificados:** `backup.ts` gera `manifesto.json` com `arquivos{rel:{size,sha256}}`, `criadoEm`, `versao`; `verificarBackup` valida hashes dos arquivos do manifesto (verificação online separada); `aplicar-restauracao` **não** revalida hashes do manifesto — manifesto **sem** SHA-256 do banco e da config; `pre_restore_*` é estado anterior à intenção, não backup pós-restore.
- **Cenários:**
  1. Manifesto ausente → deve falhar.
  2. Manifesto incompleto (faltam entradas) → deve falhar.
  3. Manifesto inválido (hash divergente de arquivo do manifesto) → `verificarBackup` falha; documentar que `aplicar-restauracao` offline **não** cobre isso hoje [lacuna].
  4. Metadados de banco/config: **inexistentes hoje** → [CONTRATO/CORREÇÃO] — o contrato exige `db.sha256`/`config.sha256` (ou equivalente) validados antes de aceitar o backup.
  5. Retenção: backups transacionais (em uso por restauração pendente ou marcados como críticos) **não podem** ser removidos pela rotina de retenção antes da conclusão — verificar política de retenção existente e se ela consulta flags/manifestos.
- **Classificação:** cenários 1–3 parcialmente [HOJE] (verificar comportamento real); 4–5 [CORREÇÃO]+[CONTRATO].
- **PASS:** cada cenário com resultado conforme contrato; FAIL: backup inválido aceito ou remoção de backup transacional. BLOCKED: enquanto metadados de banco/config e política de retenção não existirem.
- **CI/Windows:** lógica em CI; manipulação de `backups/` só em fixture.

---

## 4. Bloqueios e dependências (obrigatório)

| # | Bloqueio | Afeta | Estado |
|---|---|---|---|
| B1 | Flag `aplicar-restauracao` = retomada após crash | W15 | **Não implementada** — flag existe (`server_settings.restauracao_pendente`), mas não há journal externo nem retomada por subetapa; não afirmar retomada sem código |
| B2 | Identidade/localização/escrita atômica do estado externo | W1, W5, W13 | **Contrato pendente** — caminho, schema, `instalacaoId`, repo canônico e atomicidade indefinidos |
| B3 | Estado corrompido/divergente/ausente-pós-ativação | W5, W13 | Contrato exige quarentena+bloqueio para divergência; não tratar como ausente |
| B4 | Consentimento persistente por instalação + kill-switch | W1, W7 | `MESTRE_AUTO_UPDATE=0` existe (kill-switch); consentimento opt-in **não implementado**; `=1` não força update |
| B5 | `seguroIniciar` — prova por dimensão | W7 | Conceito citado no contrato; implementação e dimensões a confirmar |
| B6 | Boot Lock na versão N | W2, W7, W11 | #189 Draft, não integrada; pré-condição de release: storage fora de tmpdir + porta efetiva espelhando `config.ts` + CI verde |
| B7 | Máquina de fases durável (state por fase) | W1–W4, W7 | Não implementada; N-1 só tem state best-effort pós-pull |
| B8 | Backup pré-migration + manifesto estendido (db/config sha256) + verificação de hashes no restore offline | W8, W10, W16 | Parcial: `backup.ts` tem manifesto de arquivos; db/config sem hash; restore offline não revalida |
| B9 | Journal externo de restauração | W15 | Inexistente |
| B10 | Versão/artefatos provisórios 1.0.6/0030/UUID…0107 | Todos | Realocar conforme sequência coordenada (#172 1.0.6, #176 1.0.7, #177 1.0.8, #178 1.0.9, #179 1.0.10) — reconfirmar antes de cada UP |
| B11 | Issue #156 / rollout | W0–W16 | Kill-switch é freio de incidente, não consentimento nem staged rollout; auditoria #156 vale só para o banco local examinado |

## 5. O que pode rodar em CI × o que exige Windows/intervenção real

| Categoria | Itens |
|---|---|
| **CI hoje (ubuntu/windows-latest)** | Lógica de `auto-update.mjs` (`teste-auto-update.mjs`), inspeções de artefatos/DB em fixtures, W14 (script node direto), partes não-`.bat` de W8/W9/W10/W16 |
| **Windows real obrigatório** | W0 (`.bat` legado + cauda), W9/W10 (interrupção do `.bat`), W11 (execução comportamental do `.bat` + `cmd.exe`), W15 (locks/arquivos SQLite no Windows), qualquer cenário com `cmd /c iniciar-mestre-rpg.bat` |
| **Intervenção humana** | Primeira homologação de W0/W11 com captura de tela; W13 se exigir decisão de UX; smoke em cópia de dados reais (W12.4) |
| **BLOCKED até implementação** | W5, W7, W13, W15, partes de W16 — não agendar execução, agendar **revisão de prontidão** |

## 6. Divergências e lacunas do contrato encontradas

1. **W8 × W10** — sobreposição parcial: W8 prova a lacuna (sem proveniência/backup no legado); W10 reproduz o fluxo completo. Recomendação: manter ambos se W10 agregar observação do próximo boot; consolidar se a execução mostrar equivalência — registrar no contrato, não apagar cobertura.
2. **Reset de árvore suja na retomada** — o contrato revisado exige fail-closed para qualquer árvore suja (inclusive HEAD=shaAnterior); pertinência ao `diffNameOnly` não prova origem. Qualquer procedimento de W que presuma reset automático em árvore suja está **divergente** e deve ser corrigido.
3. **Falha de migration ≠ rollback Git** — `.bat` N-1 aborta em `aplicar-restauracao`/`db:migrate` sem rollback Git; updater só reverte em falhas internas de deps/build. W4/W6 devem refletir essa separação.
4. **Backup antes de migration mesmo sem state** — fase 2 deve detectar migrations pendentes (journal × aplicados) **antes** de migrar; descobrir delta depois é tarde.
5. **Smoke `/api/health`** — exige servidor ativo; contrato exige smoke temporário controlado ou outra validação executável; `MESTRE_PORTA` não prevalece sobre `servidor.json:porta` — fixture precisa de config isolada.
6. **Boot Lock em tmpdir()** — cleaner externo pode remover lock ativo; porta customizada não coberta pelo check fixo 3001; condição de release documentada no contrato.
7. **`restauracao_pendente` dentro do banco** — a flag viaja com o arquivo de banco trocado; a semântica "flag pendente" após crash parcial é ambígua (flag pode estar no banco antigo ou no restaurado). W15 precisa tratar isso explicitamente.

## 7. Ata de execução (template obrigatório por W)

```
W__: ____________________   Data: ________  Executor: ________
SHA testado: ____________________  (ref: head / merge / legado extraído)
SO: ____________________  Node: ________  Comando: ____________________
Exit code: ________
Logs/artefatos anexados: ____________________
Estado persistente antes: HEAD=___ branch=___ porcelain=<vazio|...> state=<...> db=<...> locks=<...>
Estado persistente depois: HEAD=___ branch=___ porcelain=<...> state=<...> db=<...> locks=<...>
Resultado observado: ____________________
Critério de aceite aplicado: ____________________
Decisão: PASS / FAIL / BLOCKED — justificativa: ____________________
Limpeza executada: ____________________
```

## 8. Declaração de honestidade

- Este documento **não declara nenhum W executado**. Todos os procedimentos são planejamento.
- Onde o código atual não oferece a capacidade testada, o item está marcado BLOCKED/CORREÇÃO/INTEGRAÇÃO — não PASS.
- Qualquer execução futura deve anexar SHA, SO, Node, comando, exit code e logs conforme §2 e §7.
- Dúvidas de mapeamento W1–W7 devem ser resolvidas contra o contrato consolidado **antes** da execução; este esqueleto não substitui o contrato.
