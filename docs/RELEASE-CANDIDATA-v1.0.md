# Release Candidate v1.0 — Mestre RPG

Documento de preparação da candidata. **Não é uma release publicada**: sem
tag, sem merge adicional, sem novas funcionalidades nesta etapa.

- **Branch de referência:** `main`
- **SHA da candidata:** `33090407e354cbd4ac369225a0142b920d5af2a9`
  (merge da PR #46 — Central de Novidades).
- **PRs integradas:** #37 (Etapa 2), #43 (Acervo/suplementos/restauração/
  dados 3D), #44 (financeiro com compras e vendas), #45 (conversão de
  ferimentos em Vitalidade) e #46 (Central de Novidades). Issues #33 e
  #42 concluídas; #33 permanece registrada para referência histórica.
- **Última migration:** `0018_striped_firedrake` (tabelas `novidades` e
  `novidade_leituras`).

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
No SHA da candidata, a árvore é idêntica ao HEAD revisado da PR #46
(`0b0d5d5`), cujo CI completo passou:

- Run [42962742162](https://github.com/mestredsl-eng/mestreRPG/actions/runs/42962742162):
  job **Servidor** (typecheck, build e suítes sem navegador) ✅ e job
  **Navegador** (homologações Playwright) ✅.

## Testes (resultados reais do CI no SHA da candidata)

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

- Mesa virtual (mapas/tokens/névoa) não incluída — pós-v1.
- Novidades não possuem notificação em tempo real: o badge atualiza ao
  carregar a sessão e após ações do próprio usuário (sem polling).
- Homologado no Windows; acesso externo depende de proxy/túnel do usuário.
- Chunk do frontend >500 kB (warning do Vite, não funcional).
- A Issue #33 permanece aberta como registro histórico; a conversão de
  ferimentos foi entregue na PR #45 e a Issue #42 fechada na PR #46.
