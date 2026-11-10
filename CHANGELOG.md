# Changelog - Mestre RPG

## [1.0.0] - Data de lançamento a definir

### Novidades

- **Sistema de convites** — mestre cria convites com código; jogadores se registram pelo fluxo público (preview → registro → aceite)
- **Fichas de personagem configuráveis** — modelos de ficha publicáveis, versões, campos dinâmicos
- **Fluxo de aprovação de fichas** — jogadores enviam fichas para aprovação; mestre aprova ou rejeita
- **Patrimônio (inventário e equipamentos)** — gestão de itens no inventário, equipamento/desequipamento, permissões granulares (`jogadorAdicionaItens`, `jogadorRemoveItens`, `transferable`)
- **Financeiro** — contas por personagem, saldo inicial configurável, movimentações (entrada, saída, compra, venda, PIX fictício), suporte a 0–4 casas decimais configuráveis por campanha
- **HP e Vitalidade** — alterações de HP e Vitalidade com histórico completo de transições (`nivelAnterior → nivelNovo`, motivo)
- **Bônus individual de pontos** — o mestre concede/remove pontos extras do pool principal de um personagem com motivo e histórico auditável (`POST /characters/:id/pontos`)
- **Mesa multiplayer** — presença em tempo real, chat público/privado/secreto, rolagens compartilhadas (D4, D6, D8, D10, D20), testes de habilidade D10 com cálculo de sucessos/falhas no servidor, turnos, ampulheta/timer
- **Diário de campanha** — anotações do mestre, visibilidade pública para jogadores
- **Snapshots de campanha** — criação manual de snapshots, restauração com snapshot automático pré-restauração de segurança
- **Acervo global** — biblioteca de livros de regras com itens, múltiplas edições, backups automáticos, export/import com envelope oficial, prévia sem persistência, conflitos, decisões de merge (`manter_campanha`, `usar_livro`), soft delete e restauração
- **Aplicação de livros às campanhas** — acervo global aplicável a campanhas específicas, rastreamento de versão aplicada, atualizações disponíveis, resolução de conflitos, aplicação atômica
- **Permissões e papéis** — `mestre`, `jogador`, `espectador` com controle granular de acesso

### Melhorias

- **Atomicidade e concorrência**
  - HP/Vitalidade: leitura, cálculo e gravação dentro da mesma transação para evitar lost updates
  - Aplicação de livro do acervo: decisão e escrita em transação única síncrona
  - Validação de redução de inventário com releitura do estado atual dentro da transação
  - Bônus de pontos (`/pontos`): releitura da ficha, cálculo e gravação dentro de `db.transaction` síncrona; auditoria e Socket.IO somente após o commit — concessões e remoções simultâneas não se perdem
- **Decimais configuráveis** — `moneyTransactions.amount` e `amountCents` respeitam `casasDecimais` da campanha em todos os fluxos financeiros
- **Teardown rigoroso** — `encerrarServidor` aguarda evento `exit` real (SIGTERM → timeout → SIGKILL → aguarda exit novamente)
- **Limpeza resiliente** — `limparDir` com retentativas e relatório explícito de falha; falhas de cleanup são fatais em testes
- **Suítes de teste** — infraestrutura de banco sintético com migrations, cleanup garantido de processos e diretórios temporários

### Correções

- **Inventário** — redução de quantidade exigia permissão `jogadorRemoveItens`; antes era possível reduzir 10→1 mesmo com remoção bloqueada
- **Financeiro** — saldo inicial e movimentações usavam divisão fixa por 100; agora usam conversão baseada em `casasDecimais`
- **Acervo** — `campaign_rule_books.appliedAt` estava mapeado para `created_at`; corrigido para a coluna `applied_at` (feature inteira quebrada)
- **Acervo** — restauração de backup relê estado atual antes de aplicar para evitar sobrescrever estado mais recente
- **Acervo** — importação recalcula destino e diff dentro da transação para evitar validação com estado obsoleto
- **Homologação** — cenário de teste (criarCenario) gerava modelo não-default, bloqueando criação de fichas em campanhas novas
- **Homologação** — asserts fixos substituídos por verificações reais de estado pós-restart
- **Homologação** — validação D10 agora exige campos calculados do servidor (`minimo`, `lancados`, `sucessos`, `falhas`) e não apenas array de dados
- **Acessibilidade** — campos dinâmicos de ficha, filtros de acervo/arquivos/regras/patrimônio, papéis/status de participantes e formulário de bônus de pontos ganharam `aria-label`; auditoria visual em 3 viewports sem achados
- **Inicialização e restauração** — `iniciar-mestre-rpg.bat` agora aplica restauração pendente **antes** das migrations (schema do backup nunca fica desatualizado) e **interrompe o boot** se a restauração falhar/cancelar; `npm ci` com fallback para `npm install`; frontend recompilado quando `site/src` é mais novo que o build
- **Restaurador** — respeita `MESTRE_BANCO`/`MESTRE_ARQUIVOS`/`MESTRE_BACKUPS` (mesmos overrides do servidor); cria `banco/` na primeira instalação (até com `MESTRE_HOME` inexistente); preserva estado anterior (banco+sidecars, arquivos, config) em `pre_restore_*` **somente com cópias**; aplicação substitui arquivos/config por completo (sem mistura); **sidecars `-wal`/`-shm` removidos antes de trocar o banco e no rollback** — nenhum WAL de um banco fica associado a outro; **rollback transacional** desfaz banco, arquivos e config em qualquer falha — inclusive falha na limpeza da flag, que agora é confirmada e aborta com erro se não concluir; backup corrompido/ausente sai com código de erro e limpa a flag; **restauração é snapshot fiel** — backup sem `arquivos/` deixa o vivo sem arquivos e backup sem `configuracao/servidor.json` remove a config viva (servidor volta aos defaults), com rollback integral se a aplicação falhar; **validação estrutural do backup antes de qualquer alteração** — `configuracao/` como arquivo, `servidor.json` como diretório ou `arquivos` como link simbólico rejeitam a restauração sem tocar em nada
- **Backups** — pasta padrão `"backups"` agora resolve para `MESTRE_BACKUPS`/`MESTRE_HOME` (antes caía sempre em `<repo>/backups`, poluindo o diretório real em testes com overrides)
- **Documentação** — `docs/PRIMEIRA-PARTIDA.md`: roteiro não técnico do zero à mesa (instalação, mestre, convites, fichas, patrimônio, mesa, persistência, backup e recuperação), complementando `docs/GUIA-OPERACAO.md`. Instalação validada em checkout limpo (`npm ci` + build + migrate + boot + health)

### Notas de migração

- Configurações existentes de `casasDecimais` continuam funcionando; novos defaults podem ser definidos por campanha
- Livros do acervo existentes funcionam; backups são criados automaticamente em mutações futuras
- Snapshots de campanha anteriores continuam legíveis; o snapshot automático pré-restauração é novo

### Testes

- **`homologacao-primeira-partida.mjs`: 26/26** — primeira partida real via navegador (Playwright, 3 sessões independentes): setup admin → campanha → convite com aprovação → jogadores cadastram/entram → mestre aprova entradas → fichas criadas e enviadas → mestre aprova fichas → mesa com mestre+2 jogadores → chat → rolagens d4/d6/d8/d10/d20 → desafio D10 rolado pelo jogador → ordem de turno → item de inventário → restart do servidor com persistência de campanha, personagens, sessão e chat

- Suítes principais:
  - `homologacao-final-v1.mjs`: 73/73 — cenário E2E completo (mestre + 2 jogadores, convite, fichas, aprovação, patrimônio, mesa, restart, retorno)
  - `teste-regressao-revisao.mjs`: 31/31 — bloqueios da revisão (inventário, HP/Vitalidade, decimais)
  - `teste-acervo-campanha.mjs`: 43/43 — aplicação atômica de livros, conflitos, rollback 409, decisões manter_campanha/usar_livro
  - `homologacao-acervo.mjs`: 123/123 — biblioteca global, import/export, backups, soft delete
  - `teste-acervo-diff.mjs`: 2/2 — diff de livros
  - `homologacao-mesa.mjs`: 36/36 — multiplayer, chat, rolagens, turnos, ampulheta (pausa/retomada/encerrar/expiração explícita), persistência
  - `teste-mesa-seguranca.mjs`: 18/18 — permissões Socket.IO, privacidade, reconexão, idempotência
  - `homologacao-etapa2.mjs`: 46/46 — patrimônio, financeiro, diário, snapshots, concorrência PATCH×HP
  - `homologacao-equipamentos.mjs`: 31/31 — equipamentos, concorrência, persistência
  - `teste-equipamentos.mjs`: 79/79 — equipamento/desequipamento
  - `teste-financeiro-atomico.mjs`: 40/40 — movimentações financeiras atômicas
  - `teste-moedas-regressao.mjs`: 30/30 — decimais configuráveis
  - `teste-vitalidade-historico.mjs`: 24/24 — histórico de vitalidade
  - `homologacao-hp-historico.mjs`: 16/16 — histórico de HP
  - `teste-venda-estoque.mjs`: 29/29 — venda de itens
  - `teste-pontos-concorrencia.mjs`: 22/22 — concessões/remoções simultâneas de pontos, corrida com PATCH, autorização, ausência de escrita parcial, TOCTOU com barreira determinística (gate restrito a `NODE_ENV=test`) e negativo de produção
  - `teste-acervo-corridas.mjs`: 14/14 — corridas assíncronas do Acervo com respostas atrasadas (Playwright)
  - `teste-docs-operacao.mjs`: 12/12 — guia operacional validado em ambiente isolado (backup/restauração)
  - `teste-restauracao-boot.mjs`: 100/100 — raiz vazia/inexistente→migrate→boot real, restore de schema antigo, corrompido/ausente, falhas com rollback, sidecars WAL/SHM, snapshot fiel sem arquivos/config, validação estrutural (config como arquivo, json como dir, symlink), overrides MESTRE_*
- Auditoria visual/acessibilidade: `auditoria-visual.mjs` percorre login, painel, campanhas, todas as abas da campanha, detalhe de personagem, acervo, administração e conta em desktop (1366×768), tablet (768×1024) e celular (390×844) — 0 achados de rolagem horizontal, elementos cortados, botões sem nome ou campos sem label após as correções de `aria-label`.
