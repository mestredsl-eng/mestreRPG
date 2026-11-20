# Mestre IA — Mundo Vivo

> Épico de planejamento: [Issue #180](https://github.com/mestredsl-eng/mestreRPG/issues/180)

## Visão

Adicionar ao Mestre RPG uma modalidade opcional em que a IA possa criar campanhas, atuar como mestre, interpretar NPCs, coordenar grupos autônomos e contribuir para um mundo persistente com PVE, PVP, NPC vs NPC e conflitos entre grupos.

**Princípio obrigatório: construir sobre o Mestre RPG existente.** Não criar uma aplicação paralela, uma segunda mesa, um segundo motor de regras ou cadastros duplicados de campanhas, fichas e personagens.

Este documento registra uma direção de longo prazo. Não inicia implementação nem muda a prioridade das correções atuais do jogo.

## Regra central de integração

A IA deverá operar pelos serviços, comandos e contratos internos já usados pelo Mestre RPG. Antes de qualquer implementação, auditar o código e identificar o que pode ser reutilizado.

| Área existente | Como a Mestre IA deve integrar |
|---|---|
| Campanhas, sessões, membros e permissões | Usar as mesmas campanhas, participantes, papéis e verificações de acesso. |
| Personagens e fichas | Usar o modelo atual de personagens/NPCs e os modelos de ficha da campanha; ampliar apenas quando comprovadamente necessário. |
| Regras e dados | Reutilizar o motor autoritativo: testes D10, sucessos, dados D4/D6/D8/D10/D20, combate, HP, Vitalidade, atributos, habilidades e configurações da campanha. |
| Mesa multiplayer | Usar a sessão, chat, turnos, ampulheta, histórico, eventos, sincronização Socket.IO e ferramentas atuais. |
| Patrimônio | Usar inventário, equipamentos, veículos, dinheiro e transações existentes. |
| Conteúdo | Reutilizar Acervo, conteúdo versionado, diário, anotações e histórico da campanha. |
| Arquivos e persistência | Reutilizar biblioteca, snapshots, autosave, backups e mecanismos atuais de persistência. |
| Voz | Integrar ao Mestre Voice e à narração já planejada, sem criar um segundo sistema de voz. |

### IA propõe; o Mestre RPG valida e executa

A IA pode propor que um NPC ataque, fuja, negocie ou investigue. Ela não pode inventar o resultado de um teste, calcular dano fora das regras, alterar ficha diretamente ou gravar estado por conta própria.

Toda ação deverá passar pelo mesmo fluxo de validação, permissões, motor de regras, persistência e histórico usado pelos jogadores e pelo mestre humano. O servidor continua sendo a fonte oficial do estado da campanha.

A saída do modelo deve ser tratada como dado não confiável. Não permitir SQL livre, execução arbitrária de código, acesso direto ao banco, exposição de chaves ou bypass de permissões. Respeitar informações privadas e ocultas por campanha e personagem.

## Experiência desejada

### Criação de campanha

A pessoa informa premissa, gênero, época, tom e parâmetros. A IA propõe cenário, regiões, locais, organizações, conflitos, missões, NPCs e grupos. O mestre humano revisa, edita, aprova ou rejeita. Só conteúdo aprovado é incorporado à campanha, usando os registros atuais.

### Três modalidades de condução

- **Mestre humano:** a experiência atual permanece como está.
- **Mestre IA:** a IA conduz cenas, interpreta NPCs e solicita ações/rolagens pelos fluxos existentes.
- **Mestre híbrido:** IA e pessoa dividem a condução; o humano pode intervir, pausar ou assumir a qualquer momento.

### NPCs persistentes

NPCs poderão ter personalidade, objetivos, conhecimentos, relações, recursos, memórias e histórico. Eles devem agir apenas com base no que sabem e no que as regras permitem — sem onisciência artificial.

### Grupos e mundo compartilhado

Uma campanha poderá conter vários grupos de jogadores e grupos controlados pela IA. Organizações podem investigar, negociar, competir, formar alianças, trair e entrar em conflito. Ações de um grupo poderão gerar consequências para outros grupos e regiões.

O avanço fora da sessão deve ocorrer em ciclos/eventos configuráveis, não em simulação contínua e ilimitada. O mestre define autonomia, frequência, limites e consequências. O sistema evita atualizar agentes que não precisam agir.

### Tipos de conflito

- **PVE:** jogadores contra NPCs, grupos ou organizações controlados pela IA.
- **PVP:** jogadores ou grupos de jogadores em conflito, conforme as regras e o consentimento configurado.
- **NPC vs NPC:** personagens/grupos autônomos resolvem conflitos usando o motor de regras existente.
- **Grupo vs grupo:** combinações de jogadores reais e personagens/grupos controlados pela IA.

O mestre poderá configurar limites de PVP, mortes, consequências permanentes, guerras, autonomia dos NPCs e avanço do mundo.

## Roadmap incremental

| Fase | Objetivo | Estado |
|---|---|---|
| 0. Auditoria e arquitetura | Mapear modelos, serviços, eventos, permissões, custos e limites; propor integração sem alterar o jogo. | Não iniciada |
| 1. Criador de campanhas | Geração assistida e revisão/aprovação de conteúdo antes de salvar na campanha atual. | Não iniciada |
| 2. Mestre IA em uma mesa | Conduzir uma sessão, interpretar NPCs e solicitar ações pelo motor existente. | Não iniciada |
| 3. NPCs persistentes | Memórias, objetivos, personalidade e relações vinculados aos personagens/campanha atuais. | Não iniciada |
| 4. Grupos autônomos | Facções e grupos com agendas e decisões em ciclos controlados. | Não iniciada |
| 5. Mundo vivo | Consequências entre regiões/grupos e linha do tempo compartilhada. | Não iniciada |
| 6. Conflitos mistos | PVE, PVP, NPC vs NPC e grupo vs grupo no mesmo fluxo autoritativo. | Não iniciada |
| 7. Escala e polimento | Observabilidade, controle de custos, limites, recuperação e testes de abuso. | Não iniciada |

Cada fase deverá ser quebrada em Issues menores e PRs revisáveis. Não desenvolver tudo em paralelo.

## Restrições de qualidade e operação

- Nenhuma duplicação de campanhas, personagens, fichas, inventário, rolagens, chat, sessões ou histórico sem justificativa técnica aprovada.
- Não duplicar regras executáveis em prompts; o motor do servidor permanece autoritativo.
- Segredos de provedores ficam somente no servidor.
- Isolamento rigoroso por campanha e respeito às permissões e informações privadas atuais.
- Mestre pode revisar, pausar, aprovar e limitar autonomia; ações relevantes são auditáveis.
- Definir orçamento, frequência, contexto, retentativas e limites de chamadas de IA.
- Persistência e migrations incrementais, compatíveis com os dados existentes.
- Testes comprovam que IA e jogadores passam pelas mesmas validações e geram eventos autoritativos.
- Campanhas sem IA continuam funcionando sem mudanças.

## Fora do escopo inicial

- Aplicação separada ou segundo banco/motor de RPG.
- Dezenas de agentes chamando IA continuamente.
- Simulação de todos os NPCs em tempo real.
- Modelo executando SQL, código arbitrário ou mudanças diretas de estado.
- Autonomia irrestrita sem controles do mestre.
- Substituir ou interromper o modo de mestre humano.

## Dependências e governança

1. O fluxo principal de jogo e, especialmente, o teste D10 precisam estar funcionais antes de começar a implementação da IA. A prioridade operacional atual permanece à frente deste roadmap.
2. A Fase 0 só começa quando a coordenação liberar capacidade.
3. Toda etapa começa com auditoria do que já existe e uma decisão explícita sobre reutilização/ampliação dos serviços, tabelas, eventos e componentes.
4. Não alterar `main` diretamente; usar branch e PR Draft conforme o padrão do repositório.
5. Cada PR deve provar que não criou um caminho paralelo e incluir regressões para campanhas sem IA.

## Definição de sucesso

Uma pessoa entra em uma campanha normal do Mestre RPG e joga com a IA sem usar uma aplicação paralela. Suas fichas, dados, regras, permissões, mesa, chat, patrimônio e histórico continuam sendo os mesmos. A IA acrescenta criação, narração e autonomia ao mundo, mas o Mestre RPG continua sendo a fonte oficial das regras e do estado da campanha.


## Auditoria de integração dos subsistemas existentes — decisões pendentes da Fase 0

Esta seção registra descobertas da leitura do código atual. Ela **não autoriza implementação**: serve para impedir que as fases futuras pressuponham capacidades que ainda não existem.

### Economia, lojas e comércio entre agentes

Há componentes reutilizáveis: NPCs são personagens existentes (characters.isNpc) e hoje são criados vinculados à membership do mestre; personagens podem possuir contas financeiras (financial_accounts), inventário (inventory_entries) e transações (money_transactions); o catálogo de itens é por campanha (item_templates). Transações já possuem requestId único por campanha, valor em centavos e campos de contraparte.

**Limite confirmado:** o endpoint /financeiro/operacao opera sobre um único personagem autorizado. Compra adiciona o item ao inventário desse personagem e debita uma das suas contas; venda baixa do inventário desse mesmo personagem e credita uma das suas contas. Embora o schema tenha counterpartyCharacterId, o fluxo atual não o preenche nem realiza transferência atômica de dinheiro e estoque entre dois personagens. Portanto, esses componentes são a base, mas ainda não constituem um comércio NPC↔jogador.

Antes das fases de economia, decidir e testar:
- Serviço de comércio de duas pontas: transferência atômica de saldo e estoque entre comprador e vendedor, mesma campanha/moeda, concorrência, idempotência e estorno.
- Identidade do estabelecimento: NPC pode ser o vendedor inicial; só criar entidade própria de loja se houver dados de negócio que não pertençam ao personagem (região, horário, serviços, múltiplos estoques, filial etc.).
- Preço: item_templates.data é JSON de dados padrão, não um contrato tipado de preço. Definir preço fixo por campanha, tabela por região ou preço dinâmico; não inferir essa semântica dos campos livres.
- Moeda e câmbio: definir se a moeda é global da campanha, por região ou por conta e como conversões são auditadas.
- Recompensas e inflação: recompensas geradas pela IA devem ter origem, limite por ciclo e aprovação configurável; não criar saldo/dinheiro fora dos fluxos autoritativos.

Como characters.membershipId é obrigatório, NPCs atuais usam a membership do mestre que os cria; não há necessidade comprovada de membership fictícia para esse caso. A identidade de execução do agente de IA, entretanto, deve ser separada da propriedade/controle humano do NPC.

### Guildas e facções

O modelo atual de guildas é orientado a usuários: guild_members vincula guildId a userId, e uma campanha pode apontar para uma guilda. Isso é útil para organização social de contas/campanhas, mas não representa diretamente uma facção autônoma composta por NPCs dentro de uma campanha. A Fase 0 deverá decidir se o modelo pode ser generalizado sem quebrar o domínio atual ou se facções precisam de uma entidade própria, sempre vinculada à campanha e reutilizando personagens/NPCs existentes.

### Snapshots, contexto e memória

O exportador de campanha já reúne personagens, fichas, regras, catálogo, inventários, contas, transações, sessões, chat, rolagens, testes, notas e arquivos. Isso é útil para backup e recuperação, mas **não deve ser enviado integralmente ao modelo de IA**: inclui conteúdo privado e dados fora do escopo de conhecimento de cada agente. A IA precisa de um projetor de contexto que monte somente fatos autorizados para aquele NPC/agente, campanha, cena e momento.

Notas e diário existentes são recursos de jogadores/mestres com suas próprias regras de visibilidade; não equivalem automaticamente à memória epistemológica de um NPC. Definir memória por campanha/personagem, com fatos conhecidos, origem, momento de aquisição, confiança/validade e escopo público/privado/segredo. Reutilizar as políticas de visibilidade como referência, sem criar ACL paralela ou vazar informações.

### Ciclos do mundo e agendamento

O autosave atual usa debounce por campanha e setTimeout para criar snapshots após alterações; ele **não é um scheduler de simulação**, não mantém tarefas de mundo duráveis nem recupera ciclos pendentes após reinício. Antes de NPCs e facções agirem fora da sessão, decidir entre ciclo iniciado pelo mestre, fila persistente de eventos ou worker agendado. A solução deverá ser idempotente, retomável após falha, limitada por campanha e orçamento, pausável e auditável. Não acoplar simulação de mundo ao timer de autosave.

### Acervo, progressão e auditoria

- O Acervo/biblioteca tem versionamento e backups; as definições de regras e o catálogo de itens também têm escopo de campanha. A Fase 0 deve definir onde o conteúdo gerado será revisado, aprovado e versionado, sem gravá-lo diretamente numa biblioteca global ou substituir regras publicadas.
- O projeto já possui fluxos de XP/progressão com concessão pelo mestre, compra validada pelo servidor e exigência de ficha selada. A IA deve propor uma concessão/compra; nunca alterar ledger ou personagem diretamente. A execução precisa continuar sujeita às permissões, limites e trilha de auditoria existentes.
- A trilha de auditoria precisa distinguir ações propostas por IA, ações aprovadas por humano e ações efetivamente aplicadas pelo servidor, vinculando-as a agente/personagem, campanha, ciclo e requestId. Não registrar chaves, prompts sensíveis ou contexto privado desnecessário.
- O rate limit atual de Socket.IO é por usuário/ação e em memória; ele protege eventos da mesa, mas não é orçamento de tokens/custos nem controle durável de chamadas de IA. O orçamento da IA precisa ser próprio, por campanha/agente/ciclo.

### Dependências de planejamento

As decisões acima devem ser resolvidas na Fase 0, antes de implementar grupos autônomos, comércio NPC↔jogador, economia regional ou avanço fora de sessão. A ordem mínima de dependências fica:
1. Identidade/autorização do agente e projeção de contexto privada.
2. Contratos de intenção → aprovação → execução autoritativa e auditoria.
3. Modelo de facções e memória NPC.
4. Comércio de duas pontas, preços, moeda e limites econômicos.
5. Scheduler/ciclos duráveis com idempotência, pausa e orçamento.
6. Só então simulação ampliada de grupos, regiões e conflitos mistos.

Essas decisões não alteram a prioridade da linha 1.x: o D10 e a estabilidade da mesa continuam à frente. O Mundo Vivo permanece como trilha planejada da versão 2.0, com implementação somente após liberação explícita da coordenação.