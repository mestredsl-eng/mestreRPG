# Changelog - Mestre RPG

## [1.0.0] - Data de lançamento a definir

### Novidades

- **Sistema de convites** — mestre cria convites com código; jogadores se registram pelo fluxo público (preview → registro → aceite)
- **Fichas de personagem configuráveis** — modelos de ficha publicáveis, versões, campos dinâmicos
- **Fluxo de aprovação de fichas** — jogadores enviam fichas para aprovação; mestre aprova ou rejeita
- **Patrimônio (inventário e equipamentos)** — gestão de itens no inventário, equipamento/desequipamento, permissões granulares (`jogadorAdicionaItens`, `jogadorRemoveItens`, `transferable`)
- **Financeiro** — contas por personagem, saldo inicial configurável, movimentações (entrada, saída, compra, venda, PIX fictício), suporte a 0–4 casas decimais configuráveis por campanha
- **HP e Vitalidade** — alterações de HP e Vitalidade com histórico completo de transições (`nivelAnterior → nivelNovo`, motivo)
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

### Notas de migração

- Configurações existentes de `casasDecimais` continuam funcionando; novos defaults podem ser definidos por campanha
- Livros do acervo existentes funcionam; backups são criados automaticamente em mutações futuras
- Snapshots de campanha anteriores continuam legíveis; o snapshot automático pré-restauração é novo

### Testes

- Suítes principais:
  - `homologacao-final-v1.mjs`: 73/73 — cenário E2E completo (mestre + 2 jogadores, convite, fichas, aprovação, patrimônio, mesa, restart, retorno)
  - `teste-regressao-revisao.mjs`: 31/31 — bloqueios da revisão (inventário, HP/Vitalidade, decimais)
  - `teste-acervo-campanha.mjs`: 36/36 — aplicação atômica de livros, conflitos, permissões
  - `homologacao-acervo.mjs`: 123/123 — biblioteca global, import/export, backups, soft delete
  - `homologacao-mesa.mjs`: 29/29 — multiplayer, chat, rolagens, turnos, ampulheta, persistência
  - `homologacao-etapa2.mjs`: 38/38 — patrimônio, financeiro, diário, snapshots
  - `teste-equipamentos.mjs`: 79/79 — equipamento/desequipamento
  - `teste-financeiro-atomico.mjs`: 35/35 — movimentações financeiras atômicas
  - `teste-moedas-regressao.mjs`: 30/30 — decimais configuráveis
  - `teste-vitalidade-historico.mjs`: 24/24 — histórico de vitalidade
  - `homologacao-hp-historico.mjs`: 16/16 — histórico de HP
  - `teste-venda-estoque.mjs`: 29/29 — venda de itens
  - `homologacao-equipamentos.mjs`: 25/25 — equipamentos
