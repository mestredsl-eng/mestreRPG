# Matriz de homologação E2E — Issue #155 (auto-update seguro no boot)

**Status:** matriz alinhada ao contrato congelado W0–W16 + registro de execução.
**Escopo:** documentação de homologação e implementação dos testes executáveis.
**Base de código de referência (N-1):** `7ce5b99bb20a0f951ffe5b70a96fe46ee5a157a0` (`feat/issue-155-startup-auto-update`, PR #176).

> **Contrato:** o Mestre congelou a revisão integral do contrato #155. As definições
> W0–W16 abaixo seguem o texto congelado recebido na coordenação. Itens cuja
> implementação não existe no código estão marcados **BLOCKED — dependência**,
> nunca PASS. Nenhum teste planejado é apresentado como aprovado.

---

## 1. Fontes e SHAs de referência

| Artefato | Referência |
|---|---|
| Updater / `.bat` legados (N-1) | `7ce5b99bb20a0f951ffe5b70a96fe46ee5a157a0` — PR #176 |
| `.bat` extraído para W0/W9/W10 | `git show 7ce5b99:iniciar-mestre-rpg.bat` — byte-a-byte, nunca cópia de trabalho nem simulação textual |
| Boot Lock (N candidato) | PR #189 head `7a68313f001b49a2c9d32a656cd9302b5b2dedd5`, base `fix/issue-155-status-hardening` @ `28e742d03752b68a88f3d7e4154cd168e978faad` — **Draft, não integrado**; bloqueios P1/P2 confirmados em #7068654416 (§4, B12) |
| Harness executável W0–W16 | PR #192 head `90ea092d9781310260987a8e99902664fa9ef700`; #207 `8413b5b` é ancestor; diff próprio limitado a harness+relatório; reauditoria independente **APROVADA** (#7068382489) |
| Hardening árvore suja / buffer | PR #188 (`fix/issue-155-status-hardening`) — **Draft** |
| Restauração pendente | `servidor/src/db/aplicar-restauracao.ts` — flag `restauracao_pendente` em `server_settings` **do próprio banco** |
| Trava de instância | `servidor/src/db/trava-instancia.ts` — SQLite `BEGIN EXCLUSIVE`, processo servidor, **não** substitui Boot Lock |
| Config de porta | `servidor/src/config.ts` — `configuracao/servidor.json:porta` prevalece sobre `MESTRE_PORTA` |
| Backup | `servidor/src/lib/backup.ts` — `manifesto.json` com sha256/tamanho dos arquivos de campanha; **sem** sha256 de banco/config |

## 2. Regras transversais de evidência

Nenhum W é PASS sem registrar na ata (§8): SHA efetivamente testado (head ou merge ref — declarar qual), SO+versão, `node --version`, comando exato, exit code, log integral/artifact, estado persistente antes/depois (HEAD, branch, `git status --porcelain`, estado externo, `__drizzle_migrations`, `restauracao_pendente`, `backups/`, locks, processos), decisão justificada e limpeza.

Exit code 0 sozinho **não** é prova. Smoke HTTP em cópia vazia **não** é prova de integridade do banco real. Teste estrutural/textual **não** é execução comportamental do `.bat`.

### Legenda

- **[HOJE]** — executável com código existente no SHA de referência.
- **[CORREÇÃO]** — exige alteração de produto/teste ainda não implementada.
- **[INTEGRAÇÃO]** — só após integração coordenada (#188 → #189 → branch #176) que forma N.
- **[CONTRATO]** — depende de decisão do contrato ainda não implementada.

---

## 3. Matriz W0–W16 (contrato congelado)

### W0 — `.bat` legado real e pull que altera o próprio `.bat`

- **Objetivo/risco:** observar o comportamento real do `cmd.exe` sobre o `.bat` extraído de `7ce5b99` quando o pull substitui o próprio script em execução — parsing/offset da cauda.
- **Classe:** [HOJE] para observação do legado; a versão N com handoff é [INTEGRAÇÃO].
- **Pré-condições:** Windows real; clone descartável; remote controlado (`file://`/bare) cujo HEAD contém commit que modifica `iniciar-mestre-rpg.bat`.
- **Fixture:** diretório temporário dedicado; `git clone`; `git show 7ce5b99:iniciar-mestre-rpg.bat` para garantir o arquivo da revisão; `configuracao/servidor.json` e `banco/` mínimos na fixture.
- **Preparação:** bare repo "origin" com N-1 + commit que altera o `.bat`; clone na revisão N-1; executar `cmd /c iniciar-mestre-rpg.bat` com log integral.
- **Injeção:** o próprio pull dentro de `node scripts\auto-update.mjs`.
- **Esperado:** documentar com evidência se o `cmd.exe` relê ou usa cauda em buffer; quais etapas pós-update executam sobre código novo; presença/ausência de corrupção de parsing. **Não presumir** recuperação garantida.
- **PASS:** comportamento capturado em log integral e descrito objetivamente. **FAIL:** resultado imprevisível não documentado como limitação aceita / boot sobre estado inconsistente sem abort. **BLOCKED:** versão N com handoff ainda não integrada (então o cenário fica restrito ao legado). **Estado atual no harness #192:** BLOQUEADO — o modo remoto GitHub/branch efêmera (`HOMOLOG_W_REMOTO_GITHUB=1`) está declarado mas **não implementado**; o único remoto usado é bare local `file:///` em `%TEMP%`, portanto o pull ff-only que alteraria o `.bat` nunca pode ser exercitado sem autorização explícita. O harness é estruturalmente incapaz de tocar o origin oficial — bloqueio por capacidade/autorização, **não** PASS nem FAIL.
- **Artefatos:** log integral do `.bat`, `git log`, diff do `.bat` entre revisões.
- **Limpeza:** remover diretório do fixture e bare repo.
- **CI/Windows:** Windows real obrigatório (parsing de batch não é fiel em Linux); job `windows-latest` pode automatizar a primeira prova, mas homologação inicial é manual.

### W1 — `.bat` N e handoff para fase 2 nova

- **Objetivo/risco:** provar o handoff `call "%~f0" :_fase2` do `.bat` N: fase 1 (até updater) → reentrada na fase 2 sem readquirir Boot Lock, com o mesmo owner até o servidor encerrar.
- **Classe:** [INTEGRAÇÃO] — o handoff não existe em `7ce5b99` (verificado).
- **Pré-condições:** versão N com `.bat` de duas fases + Boot Lock integrado (#189 corrigido: storage fora de tmpdir, porta efetiva espelhando `config.ts`).
- **Fixture:** clone descartável da versão N; remote controlado.
- **Injeção:** nenhuma falha — boot limpo observando a sequência de fases nos logs.
- **Esperado:** ordem executável real: Node → porta efetiva → Boot Lock único → recuperação externa → updater → handoff fase 2 → etapas restantes → servidor; lock adquirido uma única vez; `git rev-parse HEAD` e identidade de fase nos logs.
- **PASS:** sequência observada confere com a máquina de fases; sem dupla aquisição de lock. **FAIL:** readquirir lock, pular recuperação, ordem divergente. **BLOCKED:** enquanto N não existir.
- **CI/Windows:** Windows real.

### W2 — Interrupção entre updater e fase 2

- **Objetivo/risco:** crash/kill na janela entre o fim do updater (fase 1) e o início da fase 2 — estado persistido deve permitir retomada determinística.
- **Classe:** [INTEGRAÇÃO]+[CONTRATO].
- **Fixture:** clone da versão N; kill -9/`taskkill` entre o retorno do updater e a reentrada `:_fase2`.
- **Esperado:** estado externo registra fase "pós-updater"; próximo boot retoma na fase 2 sem repetir updater/pull; nenhuma etapa duplicada com efeito colateral.
- **PASS:** retomada converge ou aborta com instrução; estado persistente = fase real. **FAIL:** re-executa pull ou pula etapas. **BLOCKED:** depende de W1 implementado.
- **CI/Windows:** Windows real prioritário.

### W3 — Dois boots simultâneos em N

- **Objetivo/risco:** dois `iniciar-mestre-rpg.bat` concorrentes em N — provar exclusão mútua do Boot Lock corrigido (#189: `.recover` nunca reivindicado, storage persistente, porta efetiva).
- **Classe:** [INTEGRAÇÃO]. **Não declarar aprovado com o helper antigo** — a correção de storage/porta da #189 precisa estar integrada.
- **Fixture:** clone da versão N; script que dispara dois `cmd` juntos; log por processo.
- **Esperado:** exatamente um proprietário do lock; o segundo aguarda health até 120s ou aborta; nenhum Git/npm/build duplo.
- **PASS:** um único boot owner observado; locks e logs conferem. **FAIL:** dupla execução de etapas mutáveis. **BLOCKED:** #189 não integrada / storage ainda em tmpdir.
- **CI/Windows:** Windows real; `teste-boot-lock.mjs` cobre a lógica do helper, mas W3 é a prova E2E do `.bat` duplo.

### W4 — Retomada após pull limpo sem journal

- **Objetivo/risco:** pull fast-forward concluído com sucesso mas **sem** journal/estado por fase (simulando N-1 ou perda de estado): o próximo boot não pode presumir fase; deve reconstruir conservadoramente.
- **Classe:** [INTEGRAÇÃO]+[CONTRATO] (depende de como N trata estado ausente após ativação do protocolo — W13-related).
- **Contrato fail-closed exato:** ausência de state **sem prova independente de instalação nova** bloqueia operações mutáveis — o boot não pode distinguir "nunca houve estado" de "estado perdido" sem marcador persistido em local distinto (ver W13). A única exceção limitada admitida é a transição N-1→N documentada no protocolo, que **não** se generaliza a reconstrução de estado arbitrário.
- **Fixture:** clone N-1; forçar pull limpo e remover/omitir estado externo antes do próximo boot.
- **Esperado:** comportamento documentado do contrato para "estado inesperadamente ausente" — fail-closed ou reconstrução explícita; nunca presunção silenciosa de fase.
- **PASS:** comportamento conforme contrato, com evidência. **FAIL:** boot presume "tudo concluído" sem prova. **BLOCKED:** definição de estado-ausente no contrato.
- **CI/Windows:** Windows real para `.bat`; lógica em CI.

### W5 — Interrupções em cada fase do protocolo externo

- **Objetivo/risco:** kill em **cada** fase persistida do estado externo (não sóUpdater): pré-pull, pós-pull, pós-npm-ci, pós-builds, pós-restore, pós-migrate, pré-start — retomada ou abort determinístico por fase.
- **Classe:** [INTEGRAÇÃO]+[CONTRATO].
- **Fixture:** clone N; injeção de kill por fase (wrapper ou `taskkill` temporizado); estado externo legível entre execuções.
- **Esperado:** matriz fase×crash completa; `seguroIniciar`/`validado` só com prova de conclusão ou justificativa durável por dimensão.
- **PASS:** cada célula da matriz com resultado conforme contrato. **FAIL:** qualquer célula divergente. **BLOCKED:** máquina de fases não implementada.
- **CI/Windows:** Windows real prioritário (fsync/locks/SQLite WAL).

### W6 — Smoke HTTP em cópia vazia

- **Objetivo/risco:** provar que o smoke de validação funciona em **cópia descartável** com config e banco isolados — e delimitar o que ele **não** prova.
- **Fatores verificados:** `configuracao/servidor.json:porta` prevalece sobre `MESTRE_PORTA`; fixture precisa de config própria com porta livre ou override de teste; nunca editar config real.
- **Classe:** [HOJE] para a mecânica do smoke isolado.
- **Fixture:** `xcopy`/clone da instalação para `%TEMP%\w6-*`; `servidor.json` com porta livre; banco vazio do fixture.
- **Esperado:** servidor filho sobe, `/api/health` responde, processo encerrado limpo. **Registrar explicitamente:** smoke em cópia vazia prova disponibilidade HTTP do build, **não** integridade do banco real (isso é W12).
- **PASS:** health 200 + encerramento limpo + isolamento comprovado (porta/config/banco do fixture). **FAIL:** smoke toca instalação real ou é reportado como prova de dados.
- **Estado atual no harness #192 (`90ea092`):** isolamento **aprovado por leitura de código** na reauditoria I6-B (#7068382489) — app copiada em `%TEMP%`, `configuracao/servidor.json` próprio (ambos os caminhos efetivos), porta efêmera provada livre antes do spawn, posse HTTP do filho (vivo + porta morre com ele), snapshot completo de `banco/arquivos/backups/configuracao` da instalação real antes/depois, `MESTRE_HOME` dedicado. **Porém o harness integral NÃO foi reexecutado nesse SHA — execução atual: NÃO VALIDADA.** O PASS de 2026-11-20 (SHA `7ce5b99`) refere-se à versão anterior do harness e não é reutilizado aqui.
- **CI/Windows:** CI possível com config/porta efêmeras; homologação inicial Windows.

### W7 — State corrompido ou divergente

- **Objetivo/risco:** estado externo com JSON inválido, versão de schema desconhecida, `instalacaoId` divergente, repo canônico divergente, fase impossível.
- **Classe:** [CONTRATO]+[CORREÇÃO]. Contrato revisado: divergência de identidade = **estado inválido → quarentena + boot bloqueado para inspeção, sem reset** — não "ausente".
- **Fixture:** clone N; editar/remover campos do estado externo entre boots.
- **Esperado:** cada corrupção → comportamento documentado (quarentena/bloqueio/instrução); nunca reset cego.
- **PASS:** matriz corrupção×comportamento conforme contrato. **FAIL:** divergência tratada como ausente ou reset automático. **BLOCKED:** estado externo não implementado.
- **CI/Windows:** lógica em CI quando implementado.

### W8 — Ausência de proveniência backup↔migration no mecanismo legado

- **Objetivo/risco:** **demonstrar a lacuna**: no legado (N-1), migration concluída seguida de queda não deixa proveniência nem backup pré-migration recuperável. O resultado esperado é a **confirmação da lacuna como risco residual aceito pelo Mestre** — não é correção prometida nem comportamento a ser "consertado" neste teste; não inventar recuperação.
- **Classe:** [HOJE].
- **Fatores verificados:** `.bat` roda `node servidor\dist\db\aplicar-restauracao.js` e depois `call npm run db:migrate -w servidor` sem backup prévio; `backup.ts` tem `manifesto.json` (sha256 de arquivos de campanha, `criadoEm`, `versao`) **sem** sha256 de banco/config; `aplicar-restauracao` não revalida hashes do manifesto.
- **Fixture:** clone descartável do repo em `7ce5b99`; banco de teste com migration pendente; executar etapas equivalentes ao `.bat` (ou o `.bat` real com build prévio) até migrate.
- **Interrupção:** após `db:migrate` retornar e antes de `npm run start`.
- **Esperado:** ausência de marcador de sessão, de backup pré-migration e de journal externo; próximo boot não distingue "migration recém-aplicada" de estado normal. **PASS = lacuna reproduzida com evidência.**
- **Logs:** saída das duas execuções, `ls backups/`, `SELECT` em `__drizzle_migrations`, `PRAGMA integrity_check`.
- **CI/Windows:** inspeções em CI; `.bat` real em Windows.

### W9 — Queda real da cauda N-1 antes da migration

- **Objetivo/risco:** reprodução do ponto de queda real da transição legada: morte do processo **depois** do updater retornar e **antes** de `db:migrate` (cauda do `.bat`: npm ci restante, builds por timestamp, restore, migrate, start).
- **Distinção obrigatória:** ≠ queda durante o pull (W4/W5 do updater) e ≠ queda após migration (W10).
- **Classe:** [HOJE] para observação do legado.
- **Fixture:** clone descartável; `.bat` extraído de `7ce5b99`; remote controlado com update disponível.
- **Injeção:** `taskkill` no PID do `cmd.exe` (ou do node servidor se já iniciado) temporizado para a janela pós-updater/pré-migrate — ex.: wrapper que monitora o log do `.bat` e mata ao ver a linha "Aplicando migracoes" **antes** dela executar, ou kill após "Verificando restauracao pendente".
- **Esperado:** HEAD=N, updater concluído, etapas da cauda não executadas; próximo boot: updater "sem atualização", `.bat` reexecuta cauda — documentar idempotência real (build por timestamp, migrate idempotente, restore sem flag = no-op).
- **PASS:** próximo boot converge para servidor íntegro ou aborta com instrução; sem efeito colateral duplicado. **FAIL:** estado parcial silencioso.
- **Estado atual no harness #192 (`90ea092`):** barreiras determinísticas `.chegou`/`.liberar`/`.executou` (stub `npm.cmd` restrito à fixture, PATH dedicado) **herdadas de #207** — confirmadas por ancestry (#207 `8413b5b` é ancestor) e revisão estática; kill só após `.chegou`, prova = `.executou` ausente. A execução de W9/W10 registrada no commit `8413b5b` ("W9 e W10 aprovados com barreiras determinísticas") ocorreu **no contexto de #207**, não foi repetida no HEAD `90ea092` — tratar como evidência herdada, não execução nova. Remoto = bare local `file:///`; origin oficial intocado.
- **CI/Windows:** Windows real.

### W10 — Queda após migration legada e antes do servidor

- **Objetivo/risco:** ciclo completo com `.bat` legado (extraído de `7ce5b99`) até `db:migrate` concluída, kill antes de `npm run start`, e verificação do **próximo boot** — integrando a prova de lacuna de W8 em fluxo real.
- **Relação com W8:** W8 isola a ausência de proveniência; W10 executa o fluxo completo. Se a execução demonstrar equivalência material, recomendar consolidação **sem apagar cobertura silenciosamente** — registrar decisão no contrato.
- **Classe:** [HOJE].
- **Fixture/Preparação:** como W9.
- **Interrupção:** após `call npm run db:migrate` retornar 0 e antes de `call npm run start -w servidor`.
- **Esperado:** próximo boot executa updater (sem update), cauda do `.bat`, restore (sem flag → no-op), migrate (nada pendente), start; **sem** qualquer verificação de "estado deixado pela sessão anterior" — documentar.
- **PASS:** comportamento do próximo boot documentado com logs; lacuna W8 confirmada em contexto. **Estado atual no harness #192 (`90ea092`):** mesma herança de W9 — barreiras determinísticas confirmadas por ancestry/revisão estática; execução registrada em #207, **não repetida** neste SHA. Prova adicional `servidorNoArAposKill=false` no kill pré-start.
- **CI/Windows:** Windows real.

### W11 — Helper de Boot Lock ausente em N — **Gate 0**

- **Objetivo/risco:** provar fail-closed **de todo o fluxo mutável**: `scripts\boot-lock.mjs` ausente na versão N → npm, builds, restauração e migrations **não executam**; sem bypass silencioso. É um **Gate 0**: sem essa prova, nenhum outro W de N pode ser considerado homologado.
- **Base factual (#189):** `.bat` aborta se helper ausente ou retorno inesperado; exit 20 = outra instância assumiu → `exit /b 0`; demais ≠0 → abort.
- **Classe:** [INTEGRAÇÃO] — em `7ce5b99` não existe `boot-lock` no `.bat`.
- **Fixture:** clone da versão N; remover `scripts/boot-lock.mjs` após checkout (ou versão N sem o arquivo).
- **Injeção:** ausência do arquivo na chamada `node scripts\boot-lock.mjs adquirir`.
- **Esperado:** abort antes de **qualquer** etapa mutável — npm ci/install, `npm run build`, `aplicar-restauracao`, `db:migrate`, `npm run start`; log explícito; exit ≠0 e ≠20; nenhuma rota alternativa (`goto`) contorna a verificação; `errorlevel` lido corretamente em `cmd.exe` real.
- **PASS:** zero etapas mutáveis executadas — conferência por log **e** por ausência de efeitos em disco (`node_modules`/`dist/`/`banco/`/`backups/` intocados, `git status` limpo). **FAIL:** qualquer bypass, etapa parcial ou exit 0. **BLOCKED:** #189 não integrada.
- **CI/Windows:** Windows real obrigatório — o teste existente é estrutural/textual, W11 exige execução comportamental do `cmd.exe`.

### W12 — Comparação smoke isolado × integridade real × journal real

- **Objetivo/risco:** separar três provas que não podem ser confundidas:
  1. **Smoke HTTP isolado** (W6): disponibilidade do build em cópia vazia — prova HTTP, não dados.
  2. **Integridade real do banco:** `PRAGMA integrity_check` + `foreign_key_check` no banco restaurado/migrado do fixture; journal `__drizzle_migrations` real (lote pendente atômico — drizzle-orm 0.45.4).
  3. **Smoke em cópia consistente de dados reais:** **obrigatoriamente** sobre uma cópia consistente obtida após restauração/rollback (snapshot/bak da instalação real materializado em diretório descartável) — **nunca** iniciar servidor de smoke contra o banco real. Exige autorização e fixture de dados reais.
- **Classe:** itens 1–2 [HOJE] em fixture; item 3 [CONTRATO] (autorização/fixture de dados reais).
- **PASS:** cada prova com artefato próprio; smoke vazio **nunca** reportado como integridade de dados reais. **FAIL:** conflação das provas.
- **CI/Windows:** CI para 1–2; estação de homologação para 3.

### W13 — Instalação nova × perda inesperada de state externo

- **Objetivo/risco:** distinguir primeira instalação legítima (sem estado externo → inicializa) de instalação N que **perdeu** o diretório externo (estado existia e sumiu → ambíguo, deve bloquear). Exige marcador de "estado já inicializado" em local distinto.
- **Classe:** [CONTRATO]+[CORREÇÃO] — sem marcador persistente fora do diretório externo, os dois casos são indistinguíveis por construção.
- **Fixture:** (a) clone novo sem estado → boot normal; (b) instalação N com estado criado → remover diretório externo → próximo boot.
- **Esperado:** comportamentos diferentes e documentados; ambiguidade → bloqueio. **FAIL:** estado perdido tratado como instalação nova (reset silencioso) ou instalação nova bloqueada.
- **CI/Windows:** CI quando implementado; depende de decisão de design.

### W14 — Fail-open do detector de restauração pendente

- **Objetivo/risco:** **nenhum erro de consulta pode virar "nada a restaurar" com sucesso**. Distinguir rigorosamente: **instalação inicial comprovada** (banco inexistente → cria e segue, exit 0 legítimo) de **banco existente** com `server_settings` ausente, erro SQL em `prepare`/`get`, erro de I/O ou corrupção — todos estes últimos devem abortar com exit ≠0, nunca sucesso silencioso.
- **Fatores verificados:** `aplicar-restauracao.ts` retorna sucesso quando a linha `restauracao_pendente` está ausente; exceção de query é caminho distinto — a prova exige demonstrar que exceção/erro **aborta**, não segue. Execução real já evidenciou fail-open em banco sem `server_settings`, view quebrada e arquivo corrompido (relatório de execução, W14 reprovado).
- **Classe:** [HOJE] para observação do comportamento atual; [CORREÇÃO] enquanto erro for tratado como ausência.
- **Fixture:** bancos descartáveis: (a) sem `banco/mestre-rpg.db` (instalação inicial comprovada); (b) banco existente sem `server_settings`; (c) tabela corrompida/truncada; (d) permissão de leitura revogada / erro de I/O; (e) `-wal`/`-shm` inconsistentes.
- **Esperado:** (a) inexistente legítimo → cria e segue; (b)–(e) banco existente com qualquer falha → exit ≠0 e boot abortado com instrução.
- **PASS:** matriz cenário×exit conforme contrato — "instalação inicial" e "banco existente com erro" nunca compartilham o mesmo resultado. **FAIL:** erro de consulta retornando 0 com boot prosseguindo. Registrar achado se o código atual falhar.
- **CI/Windows:** executável em CI (node direto, sem `.bat`) — candidato a suíte automatizada.

### W15 — Restauração interrompida: aplicação e rollback por componente

- **Objetivo/risco:** kill durante `aplicar-restauracao` em **cada** fronteira — preservação (`pre_restore_*`), substituição do arquivo do banco, sidecars (`-wal`/`-shm`), arquivos da campanha, configuração, limpeza da flag — **e durante o rollback interno** do restaurador (não basta testar falha tratada: crash no meio do `reverter()` é cenário próprio). Componentes cobertos: banco, sidecars, arquivos, configuração e flag.
- **Fatores verificados:** flag `restauracao_pendente` vive **dentro do banco** (`server_settings`) e a aplicação troca o arquivo do banco — a flag pode estar no banco antigo ou no restaurado; remoção confirmada por re-leitura; **não existe journal externo de subetapas** hoje.
- **Classe:** **BLOCKED — dependência** até existir journal externo + protocolo de retomada. Não executar como PASS; homologar prontidão quando implementado.
- **Fixture (quando implementado):** clone com flag apontando para backup válido; kill em cada fronteira; reinvocar `node servidor\dist\db\aplicar-restauracao.js`.
- **Esperado:** retomada por journal converge para íntegro ou aborta com instrução; `PRAGMA integrity_check` + flag correta ao final.
- **CI/Windows:** Windows real prioritário.

### W16 — Manifesto obrigatório e proteção do backup transacional

- **Objetivo/risco:** **manifesto integral obrigatório** — ausente, incompleto ou inválido deve **falhar**; e **imunidade à retenção**: backup referenciado por journal/flag de restauração **ativa** não pode ser removido pela rotina de retenção antes da conclusão.
- **Fatores verificados:** `manifesto.json` tem sha256/tamanho dos arquivos de campanha — **sem** sha256 de banco/config; `verificarBackup` valida hashes dos arquivos do manifesto (online) mas **pula a validação quando o manifesto está ausente** (`if existsSync`) — fail-open já evidenciado em execução (W16 reprovado); `aplicar-restauracao` offline **não** revalida hashes; política de retenção (`aplicarRetencao`) precisa ser conferida se consulta flags/journal antes de remover.
- **Cenários:** manifesto ausente → falha; incompleto → falha; inválido/hash divergente → falha (documentar que restore offline não cobre); manifesto integral incluindo metadados de banco/config → [CORREÇÃO]; backup referenciado por journal/flag ativa → retenção não pode removê-lo → provar não-remoção.
- **Classe:** manifesto ausente/inválido [HOJE] — já reprovado em execução; metadados banco/config e imunidade à retenção [CORREÇÃO]+[CONTRATO].
- **PASS:** cada cenário conforme contrato. **FAIL:** backup inválido aceito ou remoção de backup referenciado por journal ativo. **BLOCKED:** metadados/retenção até implementação.
- **CI/Windows:** lógica em CI; `backups/` só em fixture.

---

## 4. Bloqueios e dependências

| # | Bloqueio | Afeta | Estado |
|---|---|---|---|
| B1 | Flag/journal de `aplicar-restauracao` retomável | W15 | Inexistente — flag existe, journal externo e retomada não |
| B2 | Estado externo: identidade, localização, escrita atômica, máquina de fases | W1–W5, W7, W13 | Contrato congelado; implementação pendente |
| B3 | Divergência de identidade = quarentena+bloqueio | W7, W13 | Regra definida; código pendente |
| B4 | Consentimento opt-in persistente + kill-switch | W1, W5 | `MESTRE_AUTO_UPDATE=0` existe; consentimento não implementado |
| B5 | `seguroIniciar` por dimensão | W5 | Conceito no contrato; implementação a confirmar |
| B6 | Boot Lock corrigido (#189: storage persistente + porta efetiva) integrado a N | W1–W3, W11 | #189 Draft; não integrada |
| B7 | Handoff `:_fase2` no `.bat` N | W1, W2 | Não existe em `7ce5b99` |
| B8 | Backup pré-migration + manifesto estendido (db/config sha256) + revalidação no restore | W8, W10, W16 | Parcional hoje |
| B9 | Journal externo de restauração | W15 | Inexistente |
| B10 | Versionamento provisório 1.0.6/0030/UUID…0107 | Todos | Realocar na sequência coordenada |
| B11 | Issue #156 / rollout | Todos | Kill-switch ≠ consentimento; auditoria #156 só vale para o banco local |
| B12 | Cadeia Boot Lock #189 — bloqueios independentes (#7068654416, I6-E) | W1–W3, W11 e toda a cadeia .9 | **P1:** nenhum produtor em produção para bootstrap/recibo; **P1:** `criarBackupPreUpdate()` sem caller no boot; **P1:** divergência versão/journal (1.0.6/0030 contra main 1.0.7/0031–0032); **P2:** nenhum dispatch de #190 contra `refs/pull/189/merge` (o dispatch conhecido testou #193). Bloqueia a cadeia .9 — CI verde de outra ref não fecha esses pontos |

## 5. CI × Windows real × intervenção

| Categoria | Itens |
|---|---|
| **CI hoje** | Lógica de `auto-update.mjs`, W14 (node direto), inspeções de artefatos/DB em fixtures, partes não-`.bat` de W6/W8/W9/W10/W12/W16 |
| **Windows real obrigatório** | W0, W1–W3, W5, W9–W11, W15 — qualquer execução de `cmd /c iniciar-mestre-rpg.bat`, locks, WAL, parsing de batch |
| **Intervenção humana** | Primeira homologação de W0/W11 com captura; W13 se exigir UX; W12.3 com dados reais |
| **BLOCKED até implementação** | W1–W5, W7, W11, W13, W15 e partes de W16 — agendar revisão de prontidão, não execução |

## 6. Divergências do contrato encontradas

1. **W8×W10** — sobreposição parcial; recomendação de consolidação condicionada à execução, sem apagar cobertura.
2. **Árvore suja na retomada** — fail-closed para qualquer sujeira (inclusive HEAD=shaAnterior); `diffNameOnly` não prova origem.
3. **Migration falha ≠ rollback Git** — `.bat` aborta sem reverter Git; updater só reverte em falhas internas de deps/build.
4. **Backup antes de migration mesmo sem state** — fase 2 detecta migrations pendentes (journal × aplicados) **antes** de migrar.
5. **`MESTRE_PORTA` ≠ `servidor.json:porta`** — smoke isolado exige config própria.
6. **`restauracao_pendente` dentro do banco** — flag viaja com o arquivo trocado; ambiguidade pós-crash parcial afeta W15.
7. **Boot Lock em tmpdir()** — cleaner externo pode remover lock ativo; porta customizada fora do check fixo 3001.

## 7. Ambiente de homologação local (esta estação)

- SO: Windows (verificar `winver` no registro da ata); Node observado: **v26.13.0** — projeto declara 20+; evidência em Node 20/22 pendente (CI ou instalação dedicada).
- Git: 2.55.0.windows.3.
- Regra: nenhum teste toca `banco/`, `backups/`, `configuracao/` ou `%TEMP%` fora de diretórios criados pelo próprio teste.

## 8. Ata de execução (template)

```
W__: ______  Data: ______  Executor: ______
SHA testado: ______ (head / merge ref / .bat legado extraído de 7ce5b99)
SO: ______  Node: ______  Comando: ______  Exit: ______
Logs/artefatos: ______
Estado antes: HEAD=___ branch=___ porcelain=<...> state=<...> db=<...> locks=<...>
Estado depois: HEAD=___ branch=___ porcelain=<...> state=<...> db=<...> locks=<...>
Observado: ______  Critério aplicado: ______
Decisão: aprovado / reprovado / bloqueado / não executado — justificativa: ______
Limpeza: ______
```

## 9. Declaração de honestidade

- Nenhum W é declarado executado **neste documento**; itens sem implementação estão BLOCKED/CORREÇÃO/INTEGRAÇÃO.
- **Escopo desta ata (#191, documental):** registrar contrato, evidência e classificação — **não** executa o harness. O harness executável vive na #192 (`homologacao-155-w.mjs`); execuções atribuídas a SHAs diferentes são marcadas como herdadas.
- Toda linha de §10 distingue: SHA testado, comando, exit code, artefato, **execução independente vs herdada**, SKIP, bloqueio e lacuna. PASS antigo nunca é reutilizado para SHA novo sem reexecução.
- Resultados de execução futura serão registrados em §10 com evidências verificáveis.

## 10. Registro de execuções

| W | Data | SHA | SO/Node | Comando | Exit | Decisão | Artefato |
|---|---|---|---|---|---|---|---|
| W14 | 2026-11-20 | 7ce5b99 | Win/Node 26.13.0 | `node homologacao-155-w.mjs w14` | — | **reprovado** (fail-open: 3 cenários exit 0) — mantido no #192 `90ea092` | relatório de execução na branch `test/issue-155-homologacao-w` |
| W8 | 2026-11-20 | 7ce5b99 | Win/Node 26.13.0 | `node homologacao-155-w.mjs w8` | migrate 0 | **aprovado** (lacuna demonstrada: 31 migrations, 0 backups, 0 marcadores) — mantido como demonstração de lacuna de proveniência, não prova de backup correto | idem |
| W6 | 2026-11-20 | 7ce5b99 | Win/Node 26.13.0 | `node homologacao-155-w.mjs w6` | — | **aprovado na época** (health 200 isolado) — **NÃO VALIDADO em `90ea092`**: isolamento novo aprovado só por leitura de código (I6-B); harness não reexecutado | idem |
| W16 | 2026-11-20 | 7ce5b99 | Win/Node 26.13.0 | `node homologacao-155-w.mjs w16` | — | **reprovado** (manifesto ausente → ok:true; adulteração de arquivo rejeitada) — FAILs mantidos no #192 `90ea092` | idem |
| W9/W10 | ~2026-11-20 | contexto #207 `8413b5b` | Win | `node homologacao-155-w.mjs w9` / `w10` | — | **aprovado herdado** (commit `8413b5b`: barreiras `migrate.chegou/execute=false`, retomada health=200, `servidorNoArAposKill=false`) — execução no SHA de #207, **não repetida** em `90ea092` | idem |
| W0 | — | — | — | — | — | **bloqueado** — modo remoto GitHub/branch efêmera não implementado; harness incapaz de tocar origin oficial (bare local apenas) | — |
| W1–W5/W7/W11/W12.3/W13/W15 | — | — | — | — | — | **bloqueado** — versão N não integrada; cadeia .9 com bloqueios P1/P2 da #189 (B12) | — |
