# Runbook — cutover seguro 1.0.8 → 1.0.9 na instalação real

> **ESTADO: PROCEDIMENTO PRONTO — NÃO EXECUTAR sem autorização expressa do proprietário.**
>
> Documento de preparação para o cutover da instalação real do proprietário (hoje em 1.0.8/`main@7e17c9b`) para a v1.0.9 publicada (tag `v1.0.9`, merge `b196197c53`). Cobre a adoção assistida homologada em fixture (`adotar-legado.mjs`, E2E `teste-bat-adocao-legado-boot` 13/13, suíte 22/22) — **nenhuma etapa deste documento foi executada contra a instalação real**.
>
> Escopo: somente o caminho Windows com `iniciar-mestre-rpg.bat`. Não cobre instalação limpa (primeiro bootstrap) nem outras plataformas.

## 1. Pré-condições — todas obrigatórias

Abortar antes de qualquer ação se **qualquer** item falhar:

- [ ] **Autorização explícita do proprietário** para executar o cutover nesta data/janela — registrada em comentário na Issue #274 ou #272.
- [ ] **SHA/tag conferidos:** `git -C <instalacao> rev-parse HEAD` e `git describe --tags` — a tag `v1.0.9` deve existir no remoto e apontar para `b196197c53d35ae6b36561ab17b33c686c7a37ba` (ou o SHA final aprovado se a tag for recriada).
- [ ] **CI verde no SHA exato:** CI natural 6/6 SUCCESS em `84dadcb`/`4db7ca2c` (conteúdo idêntico ao mergeado — delta docs-only). Se a tag for movida, exigir novo CI 6/6 no SHA da tag.
- [ ] **Release e pacote conferidos:** GitHub Release `v1.0.9` publicada; se houver artefato/ZIP, hash e conteúdo revisados (hoje a distribuição é código-fonte + `npm ci`).
- [ ] **Janela de manutenção combinada:** ninguém usando a instalação; backup externo do diretório inteiro agendado.
- [ ] **Working tree da instalação limpa:** `git status --porcelain` vazio e `git rev-parse HEAD` em commit conhecido (1.0.8 = `7e17c9b` ou descendente limpo). Qualquer arquivo modificado/não-rastreado relevante ⇒ **NÃO EXECUTAR** (§6).

## 2. Inventário do que precisa ser preservado

| Item | Local padrão | Observação |
|---|---|---|
| Banco SQLite | `banco/mestre-rpg.db` (+ `-wal`/`-shm`/`-journal` se existirem) | Caminho pode ser customizado via `MESTRE_BANCO`/`configuracao/servidor.json` — confirmar antes |
| Arquivos de campanha/anexos | `arquivos/campanhas/` (ou `MESTRE_ARQUIVOS`) | Inclui uploads de fichas/mídia |
| Configuração | `configuracao/servidor.json` e demais arquivos de `configuracao/` | Porta, caminhos customizados |
| Estado externo do protocolo | `%LOCALAPPDATA%\MestreRPG\state\<instalacaoId>\` (Windows) — journals, recibos, lock, autorizações | **Não apagar**; o protocolo depende dele |
| Dependências/build | `node_modules/`, `servidor/dist/`, `site/dist/` | Regeneráveis; o boot recompila |
| Versão/Node | `node -v` ≥ 20.19 | Registrar antes/depois; `better-sqlite3@12.9.0` exige rebuild se Node mudou |

**Regra:** o backup pré-adoção (`backups/pre_adocao_*`) cobre banco + sidecars + `configuracao/` + `arquivos/campanhas`, mas **não** cobre o state dir externo nem o próprio diretório `.git`. O backup externo do passo 1.6 cobre a árvore inteira.

## 3. Sequência do cutover

### 3.1 Preparação (sem mutação)

1. Fechar o servidor se estiver no ar (`parar-mestre-rpg.bat` — encerramento gracioso; **evitar `taskkill /F`**, pode corromper WAL).
2. Confirmar nenhuma janela `iniciar-mestre-rpg.bat`/`cmd.exe` aberta e nenhum processo `node` do projeto.
3. `cd` no diretório da instalação; registrar `git rev-parse HEAD`, `git status --porcelain`, `node -v`, `npm -v`.
4. Verificar espaço em disco (banco + WAL + arquivos + dois backups).

### 3.2 Backup externo validado (obrigatório, independente do protocolo)

5. Com o servidor **parado**, copiar o diretório inteiro da instalação para destino externo seguro (ex.: `backups-externos\mestre-rpg-pre-109-<timestamp>\` em outro disco/pasta). Inclui `.git`, `banco/`, `arquivos/`, `configuracao/`, `backups/` e o state dir externo (`%LOCALAPPDATA%\MestreRPG\state\`).
6. **Validar o backup:** conferir contagem de arquivos, tamanho do banco e abrir o `.db` copiado com SQLite (`PRAGMA integrity_check`) ou simplesmente comparar `sha256` do banco original × cópia. Backup não validado ⇒ abortar (§6).

### 3.3 Atualização do código para v1.0.9

7. `git fetch origin` e atualizar para a tag/commit da release. Caminho preferido (instalação clonada do repo):
   - `git status` limpo ⇒ `git checkout v1.0.9` (ou `git merge --ff-only v1.0.9` se a branch local permitir).
   - Se a working tree tiver modificações locais intencionais, **parar** — não fazer stash/clean automático.
8. `npm ci` (reproduzível via lockfile; a 1.0.9 fixa `better-sqlite3@12.9.0`). Se o Node mudou de versão, `npm rebuild better-sqlite3`.

### 3.4 Primeiro boot — adoção assistida (o momento crítico)

9. Executar `iniciar-mestre-rpg.bat`. O fluxo real é:
   - Probe de health na porta (se servidor antigo ainda responde, o boot sai sem tocar em nada — codigo 20);
   - **Boot Lock** adquirido (`scripts/boot-lock.mjs`);
   - `avaliar-boot.mjs preflight` ⇒ instalação 1.0.8 sem artefatos do protocolo retorna **exit 11**;
   - BAT pergunta **"Adotar esta instalacao existente? [S/N]"** — responder **S** somente após confirmar que o backup do passo 3.2 está validado;
   - `adotar-legado.mjs --confirmar` executa, nesta ordem e tudo fail-closed:
     a. revalida candidato (banco regular, state dir sem quarentena/arquivos estranhos);
     b. `integrity_check` + `foreign_key_check` + schema exato 1.0.8 (34 migrations, idx 0..33) ou 1.0.9;
     c. backup completo em `backups/pre_adocao_<ts>/` com manifest sha256, revalidado (hash + integrity da cópia);
     d. grava journal durável `adocao-legado.json` e recibo permanente;
   - `avaliar-boot.mjs validar` (segundo gate) ⇒ `bootstrap_autorizado`;
   - auto-update (nesta versão já é a tag — deve reportar "já atualizado" ou skip conservador);
   - `npm ci`/build servidor/site se necessário;
   - `aplicar-restauracao.js` (só age se houver restauração pendente);
   - `npm run db:migrate` — aplica migrations 0034/0035 sobre o banco adotado;
   - servidor sobe em `http://localhost:3001`.
10. **Se responder N ou o prompt falhar:** nada é escrito, lock liberado, boot aborta — seguro repetir depois de corrigir a causa.

### 3.5 Verificação pós-boot (evidência obrigatória)

11. `GET /api/health` → 200; registrar corpo (versão esperada 1.0.9).
12. Login admin + login jogador; listar campanhas, abrir ficha de personagem, conferir inventário/Dinheiro/Sangue.
13. Conferências pontuais de integridade: contagens de `users`, `campaigns`, `characters`, lançamentos do ledger e anexos batem com o inventário pré-cutover; `PRAGMA integrity_check` = ok no banco migrado.
14. Registrar evidências: SHA antes/depois, nome do `pre_adocao_*`, timestamp do recibo, logs do BAT e de `logs/servidor.log`.

## 4. Critérios de abortar e restaurar

**Abortar imediatamente (antes do boot ou durante a espera) se:** working tree suja inesperada, state dir com arquivos desconhecidos/quarentena, `integrity_check` falhar, esquema do banco não for 1.0.8/1.0.9 exato, backup externo não validado, ou qualquer gate retornar código ≠ 0/10/11/20.

**Rollback durante/depois da adoção:**

- **Antes do recibo ser gravado:** a adoção é atômica — se `adotar-legado.mjs` falhar, nenhum recibo é emitido e o banco não é tocado (backup pode ser apagado). Corrigir causa e repetir o boot.
- **Interrupção no meio (queda de energia/janela fechada):** o journal `adocao-legado.json` permite retomada — reexecutar o BAT retoma da fase concluída (`backup-ok` reutiliza backup atestado; nunca repete etapas).
- **Após migração, se dados parecerem errados:** usar o fluxo oficial de restauração (Administração → Backups → restaurar `pre_adocao_*` ou o backup externo do passo 3.2) — restauração é fail-closed e preserva `pre_restore_*`.
- **Último recurso:** parar tudo e restaurar o diretório inteiro a partir do backup externo do passo 3.2 (inclui `.git`, state dir e banco no estado 1.0.8).

## 5. Checklist de evidência

- [ ] SHA/versão antes (`git rev-parse HEAD`) e depois (`git describe --tags` → `v1.0.9`)
- [ ] `git status --porcelain` vazio antes e depois
- [ ] Node/npm versions registradas
- [ ] Caminho e manifest do `backups/pre_adocao_*` (sha256 de cada arquivo)
- [ ] Recibo `instalacao-recibo.json` presente no state dir com `origem: adocao-legado`
- [ ] Journal `adocao-legado.json` em fase `concluida`
- [ ] `PRAGMA integrity_check`/`foreign_key_check` ok no banco migrado
- [ ] Contagens semânticas: usuários, campanhas, personagens, itens de inventário, lançamentos de ledger, anexos
- [ ] `/api/health` 200 + versão 1.0.9; login admin/jogador ok; ficha/patrimônio/sangue visíveis
- [ ] `logs/servidor.log` sem erros de boot/migration
- [ ] Registro do procedimento na Issue #272 com timestamp e operador

## 6. Gatilhos de NÃO EXECUÇÃO

**Não executar o cutover se qualquer um for verdadeiro:**

- Working tree suja (`git status` não vazio) ou HEAD divergente do esperado;
- State dir externo com quarentena, journal corrompido ou arquivos desconhecidos;
- Backup externo não validado (hash/integrity);
- `integrity_check`/`foreign_key_check` falhar no banco atual;
- Esquema do banco não corresponder exatamente a 1.0.8 (34 migrations) ou 1.0.9;
- SHA da tag `v1.0.9` divergente do aprovado ou CI do SHA não verde;
- Servidor ainda respondendo em `/api/health` após tentativa de parada;
- Qualquer gate de boot (`avaliar-boot.mjs`) retornando código não previsto;
- Autorização explícita do proprietário ausente.

Em caso de dúvida: **abortar é sempre seguro** — antes do recibo nada é escrito; depois, rollback pelos backups.
