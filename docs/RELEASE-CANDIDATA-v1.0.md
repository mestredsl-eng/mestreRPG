# Release Candidate v1.0 — Mestre RPG

> **Atualização de estado — 2026-11-14:** as cinco etapas do roteiro mestre da Issue #33 foram concluídas. A candidata continua sem tag/publicação, aguardando autorização explícita. A `main` de referência após a PR #77 é `9046ae3071f99022595ee2b7ea592454755c0b55`. A homologação histórica abaixo não deve ser interpretada como CI executado nesse SHA: a validação final da candidata deve usar o HEAD efetivo após a integração das PRs pendentes.

Documento de preparação da candidata. **Não é uma release publicada**: a
tag `v1.0.0` e a publicação da release estão pendentes de autorização
explícita do responsável.

- **Branch de referência:** `main`
- **SHAs da candidata (três momentos distintos):**
  - *Base funcional validada:* `33090407e354cbd4ac369225a0142b920d5af2a9`
    (merge da PR #46 — Central de Novidades). Todo o código funcional e
    os resultados de CI documentados abaixo referem-se a esta base e aos
    merges posteriores de documentação/CI que não alteram funcionalidades.
  - *Revisão documental final:* merge da PR #47
    (`2edae410c862330b04d202cf7e18e222806089bd`), que incorporou este
    documento e a correção do workflow de CI da PR #48
    (`1bb129f1222685ebb7f6fa2cf1da6eec119fb5b7`).
  - *SHA efetivo da tag:* a tag `v1.0.0` deverá apontar para o HEAD da
    `main` conferido imediatamente antes da publicação — **não** para um
    SHA registrado antecipadamente neste documento.
- **PRs integradas:** #37 (Etapa 2), #43 (Acervo/suplementos/restauração), #44 (financeiro com compras e vendas), #45 (conversão de ferimentos em Vitalidade), #46 (Central de Novidades) e entregas posteriores registradas no histórico, incluindo #72 (hierarquia), #75 (rate limit Socket.IO) e #77 (mesa compartilhada de dados 3D).
- **Pendências de estabilização em 2026-11-14:** PR #74 (correções de guildas), PR #78 (integração do pool D10 à mesa compartilhada) e PR #79 (propagação de eventos de guilda em tempo real) ainda exigem conclusão/revisão/CI antes da validação final da candidata. A Issue #65 permanece aberta para acompanhar pontos residuais da hierarquia de guildas.
- As cinco etapas da Issue #33 foram concluídas; a Issue permanece como roteiro/histórico do projeto. A criação da tag `v1.0.0` e a publicação da release continuam pendentes de autorização explícita do responsável.
- **Última migration:** `0024_guildas_hierarquia` (tabelas `guilds` e
  `guild_members`, colunas `guild_id` em `campaigns`/`audit_logs` e
  trigger de proteção do privilégio de ADMIN principal).

## Funcionalidades

- Contas, login, primeiro acesso/admin e campanhas com papéis
  mestre/jogador/espectador e aprovações.
- Convites por link com aprovação opcional.
- Modelos de ficha configuráveis, versionados e publicados; fichas com
  seções/campos arbitrários (texto, inteiro, decimal, moeda, data, listas,
  bolinhas, carteira), envio, aprovação, devolução e reabertura.
- HP e Vitalidade com histórico, transações e permissões por papel;
  conversão configurável de ferimentos de HP em níveis de Vitalidade por
  limiares percentuais (desligada por padrão).
- Patrimônio: inventário com estoque, equipamentos, veículos e financeiro
  (contas, entradas, saídas, ajustes do mestre, transferências, saldo
  após cada movimento, casas decimais configuráveis) integrado a compras
  e vendas do inventário.
- Mesa multiplayer em tempo real: presença, chat público/privado/secreto,
  rolagens livres d4/d6/d8/d10/d20, testes de habilidade D10, turnos,
  ampulheta com pausa/retomada/expiração, modo espectador, reconexão.
- **Dados 3D**: física de corpo rígido, poliedros reais, cores externa e
  de números independentes por usuário (persistidas no servidor),
  atualização imediata; resultado autoritativo do servidor.
- Acervo global: livros/suplementos, itens, importação/exportação JSON,
  backups e restauração, aplicação explícita às regras da campanha com
  resolução de conflitos e snapshots.
- **Central de Novidades** (Issue #42): CRUD administrativo de
  publicações com título, resumo, conteúdo, versão, data, categoria
  (`novidade`/`melhoria`/`correcao`) e estado (rascunho/publicada);
  rascunhos nunca expostos a usuários comuns; leitura individual
  persistida por usuário com marcação somente ao abrir; badge de
  publicações não lidas no menu; token de revisão do conteúdo que
  rejeita marcação de versão desatualizada (409); invalidação de
  leituras na mesma transação quando campos visíveis mudam de fato;
  administração responsiva (tabela no desktop, cartões no celular).
- Diário, snapshots de campanha, histórico e exportação.
- Backup e restauração completos (banco + sidecars WAL/SHM + arquivos +
  configuração), com rollback transacional e validação estrutural.
- Inicialização Windows (`iniciar-mestre-rpg.bat`) com detecção de
  frontend desatualizado.

## CI

O repositório possui workflow `.github/workflows/ci.yml` executado em
pull requests para `main` e pushes na branch de integração histórica.
O job Navegador foi corrigido na PR #48 (instalação do Chromium sem
`apt`, com verificação de `launch` real antes das suítes).

Evidência de CI no HEAD da PR #47 (`5fece91`, workflow já corrigido):

- Run [43061103557](https://github.com/mestredsl-eng/mestreRPG/actions/runs/43061103557):
  job **Servidor** (typecheck, build e 23 suítes sem navegador) ✅ e
  job **Navegador** (`chromium launch ok` + 11 suítes Playwright) ✅.
- Resultados comprovados nos logs: Servidor 1.238 verificações,
  Navegador 217 verificações — **34 suítes, 1.455 verificações,
  0 falhas**.

## Testes (resultados reais do CI — run 43061103557, HEAD `5fece91` da PR #47)

34 suítes somando **1.455 verificações, 0 falhas**:

- E2E navegador (Playwright, 11 suítes): primeira partida 26/26,
  cobertura v1 12/12, dados 3D 22/22, patrimônio 11/11, compras/vendas
  26/26, conversão ferimentos 22/22, novidades 46/46, homologação
  Acervo-corridas 14/14, acessibilidade 22/22, HP-histórico 16/16,
  homologação visual 0 achados.
- Backend/concorrência (23 suítes): Acervo 123/123, Acervo-campanha
  43/43, diff Acervo 2/2, física-dados 48/48, restauração-boot 111/111
  (inclui casos POSIX exclusivos do CI Linux), trava-instância 56/56,
  atualização-instalação 29/29, docs-operação 12/12, Etapa 2 46/46,
  homologação final v1 73/73, mesa 37/37, mesa-segurança 18/18,
  equipamentos 31/31 + 79/79, financeiro atômico 40/40,
  financeiro-compras 175/175, moedas 30/30, vitalidade 24/24,
  vida-conversão 85/85, venda-estoque 29/29, regressão 31/31,
  pontos-concorrência 22/22, novidades 94/94.
- `tsc --noEmit` (servidor e site, strict): exit 0 — executado no CI.
- Builds servidor/site: OK — executados no CI.

Observação: `teste-restauracao-boot` imprime contagens diferentes por
plataforma (109 no Windows local, 111 no CI Linux, que cobre casos de
symlink/permissão POSIX).

## Instalação e atualização

- Instalação limpa: `iniciar-mestre-rpg.bat` (instala dependências,
  compila, migra e sobe em `http://localhost:3001`).
- Atualização: baixar a `main`, `git pull`, executar o mesmo `.bat` —
  as migrations pendentes são aplicadas automaticamente.
- Homologado pelo CI: atualização de instalação 29/29 e restauração de
  boot 111/111, incluindo rebaixamento de schema com dados preservados.

## Backup e restauração

- Pelo painel (Histórico/Acervo) ou manualmente copiando `banco/`,
  `arquivos/` e `configuracao/`.
- Restauração: copiar o backup para `backups/<nome>/` no formato
  documentado em `docs/GUIA-OPERACAO.md` §9 e seguir o procedimento de
  flag do restaurador; rollback transacional comprovado em 111/111 no
  CI (109/109 na execução local Windows).

## Limitações conhecidas

- Novidades não possuem notificação em tempo real: o badge atualiza ao
  carregar a sessão e após ações do próprio usuário (sem polling).
- Homologado no Windows; acesso externo depende de proxy/túnel do usuário.
- Chunk do frontend >500 kB (warning do Vite, não funcional).
- As cinco etapas da Issue #33 foram concluídas; a Issue permanece como roteiro/histórico. A tag `v1.0.0` e a publicação da release continuam pendentes de autorização explícita — esta candidata ainda não é uma release.
- Antes da publicação, atualizar as evidências de CI para o HEAD final da `main` e executar homologação integrada após concluir as PRs pendentes.
