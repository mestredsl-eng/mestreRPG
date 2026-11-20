# Homologação independente — Issue #155, Etapas 1–3 (PR #193)

- **SHA de produção testado:** `30c348f1f19c2996fbb237d467ec5113c9cc81ab` (contém `a65a6d3` e `88e03bc` — verificado via `git merge-base`).
- **Ambiente:** Windows (win32), Node v26.13.0, npm 11.20.0, Git 2.55.
- **Execução:** LOCAL (não é CI). Fixtures 100% descartáveis em `%TEMP%`; banco/instalação reais nunca tocados.
- **Escopo:** correção de `teste-restauracao-boot.mjs` para o novo contrato + regressão dos bloqueadores da auditoria (T1–T5 desta missão).

## Arquivos alterados (somente testes)

| Arquivo | Mudança |
|---|---|
| `teste-fixture-backup.mjs` | **novo** — helper de fixture: gera `manifesto.json` v2 íntegro para backups montados à mão (mesmo formato de `backup.ts`/`validar-backup.ts`) |
| `teste-restauracao-boot.mjs` | compatibilizado com o novo contrato (manifesto obrigatório, recibo para instalação vazia, sidecars em backup rejeitados, sabotagem antes do hash) + **novo cenário Classe B** (kill real no gate `apos-trava`) |
| `teste-restauracao-journal.mjs` | +T1 ciclo de vida do recibo (4 cenários) + segunda execução idempotente pós-conclusão |
| `teste-estado-externo.mjs` | +T5 paridade de resolvedores com Boot Lock (8 casos de env) + falha de bootstrap do recibo |
| `servidor/testes/backup-contrato.test.ts` | +T2 varredura fail-closed (10), +T3 markers (5), +T4 integridade (18) — 40 testes no total |

Nenhum arquivo de produção alterado.

## Resultados

| Suíte | Resultado |
|---|---|
| `node teste-estado-externo.mjs` | **48 ok, 0 falhas** |
| `node teste-restauracao-journal.mjs` | **35 ok, 2 falhas** (ver FAIL-1/FAIL-2) |
| `node teste-restauracao-boot.mjs` | **121 ok, 0 falhas** |
| `tsx --test testes/backup-contrato.test.ts` | **40/40 pass** |
| `tsx --test testes/iniciativa.test.ts` | 38/38 |
| `tsx --test testes/regua.test.ts` | 38/38 |
| `tsx --test testes/d10.test.ts` | 7/7 |
| `tsx --test testes/guildas-guarda.test.ts` | 5/5 |
| `tsc -p servidor/tsconfig.json` | exit 0 |

## FAIL — defeitos de produção a encaminhar ao Pai

### FAIL-1 — recibo + banco ausente retorna sucesso (exit 0)
`aplicar-restauracao`: com `instalacao-recibo.json` válido e `mestre-rpg.db` inexistente, o restaurador loga "instalação inicial comprovada por recibo; nada a restaurar" e sai **0**. Contrato T1: recibo prova inicialização *concluída*; banco que some depois é estado ambíguo → deve bloquear. Reprodução: `teste-restauracao-journal.mjs` seção "T1" (fixture: `gravarReciboInstalacao` + sem `banco/mestre-rpg.db`).

### FAIL-2 — recibo + banco vazio (0 tabelas) retorna sucesso (exit 0)
Mesma classe: banco truncado/criado-vazio após instalação com recibo → exit 0. Esperado: bloqueio. Mesma seção do teste.

## Gaps observados (registrados, classificação no relatório)

| # | Observado | Avaliação |
|---|---|---|
| G1 | Journal/marker **sem** `instalacaoId`/`repoCanon` é aceito pela varredura de proteção (`problemaIdentidade` só rejeita strings divergentes; campos ausentes passam) e seu `backupDir` protege normalmente | Provável FAIL vs. "identidade ausente bloqueia" — confirmar contrato |
| G2 | Arquivo **> 2 GiB** tem SHA-256 **pulado** (`st.size <= TAM_MAX` guarda o hash); manifesto com hash falso passa se tamanho confere | Contrato pede hash em streaming **ou** rejeição explícita — gap real |
| G3 | Raiz do backup como junction/symlink → `validarBackup` retorna `ok=true` (segue o link) | Registrar; contrato deve dizer se raiz-link é proibida |
| G4 | `MESTRE_HOME` diverge do Boot Lock **por desenho** (extensão documentada de sandbox) — paridade vale apenas sem `MESTRE_HOME` | Documentado, não é defeito |
| G5 | Ramos Linux (`XDG_STATE_HOME`, `~/.local/state`) **NOT EXECUTED** em win32 — `process.platform` fixo; convenção alinhada por inspeção | Verificar em CI Linux |

## Classe A × Classe B (W15)

- **Classe A** (journal/checkpoints pré-montados): W15a–e + segunda execução — coberta em `teste-restauracao-journal.mjs` (37 asserções ok).
- **Classe B** (interrupção real): **1 ponto executado** — kill SIGKILL no gate `apos-trava` (`MESTRE_TRAVA_GATE_DIR`), antes de qualquer escrita: sem journal, sem `pre_restore`, flag intacta, retomada posterior completa (9 asserções ok em `teste-restauracao-boot.mjs` §22). Gates `apos-rollback` e por-componente **não existem** → interrupções entre componentes seguem **NOT EXECUTED** (sem hooks de produção permitidos ao Filho).

## Correções de fixture (fidelidade, não afrouxamento)

1. `fazerBackup` agora emite `manifesto.json` v2 — o restaurador rejeita backup sem manifesto (novo contrato).
2. `fazerBackup` consolida o banco do backup (`wal_checkpoint`+`journal_mode=DELETE`, remove sidecars) — espelha `copiarBanco`; sem isso a `integrity_check` criava `-wal/-shm` no backup e o manifesto os rejeitava (comportamento correto do validador).
3. Sabotagens que devem preceder o hash (drop `server_settings`) migraram para `opts.sabotagem`, executada antes do manifesto.
4. Backup com `-wal/-shm` residuais agora é cenário de **rejeição** (snapshot real nunca os contém).

## Pendências / limitações

- FAIL-1/FAIL-2 aguardam correção do Pai; reexecutar `teste-restauracao-journal.mjs` após o SHA corrigido.
- G1–G3 aguardam decisão de contrato/correção do Pai.
- Classe B entre componentes: depende de gates adicionais (`aguardarGateTrava` por checkpoint) — solicitação ao Pai via Intermediário.
- `teste-servidor.mjs` não executado (exige banco populado; sem cópia consistente preparada — NOT EXECUTED).
- Node 26 local ≠ mínimo declarado (20) nem CI (22) — evidência de versão pendente.
- Estado externo não está integrado ao updater/`.bat` (Etapa 5 pendente) — escopo esperado das Etapas 1–3.

## Confirmação

`git status`: somente os 5 arquivos de teste listados. Nenhum arquivo de produção, `.bat`, `auto-update.mjs`, `boot-lock.mjs`, `teste-boot-lock.mjs`, `ci.yml` ou doc protegido foi alterado.
