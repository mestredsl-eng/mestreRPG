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

As intenções produzidas pelo parser e pelo motor de comportamento são dados não confiáveis até a validação do servidor. Não permitir SQL livre, execução arbitrária de código, acesso direto ao banco, exposição de segredos internos ou bypass de permissões. Respeitar informações privadas e ocultas por campanha e personagem.

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
- Não duplicar regras executáveis em agentes, árvores de comportamento ou parser; o motor de regras do servidor permanece autoritativo.
- Não haverá provedor de LLM, SDK de modelo, serviço externo de inferência ou chave de IA: a inteligência será implementada em TypeScript e executada pelo servidor atual.
- Isolamento rigoroso por campanha e respeito às permissões e informações privadas atuais.
- Mestre pode revisar, pausar, aprovar e limitar autonomia; ações relevantes são auditáveis.
- Definir orçamento de processamento por campanha/agente/ciclo: frequência, operações, concorrência, memória, filas e retentativas idempotentes.
- Persistência e migrations incrementais, compatíveis com os dados existentes.
- Testes comprovam que IA e jogadores passam pelas mesmas validações e geram eventos autoritativos.
- Campanhas sem IA continuam funcionando sem mudanças.

## Fora do escopo inicial

- Aplicação separada ou segundo banco/motor de RPG.
- Dezenas ou centenas de agentes executando ciclos continuamente sem limites.
- Simulação de todos os NPCs em tempo real.
- Agentes, parsers ou rotinas executando SQL livre, código arbitrário ou mudanças diretas de estado.
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

O exportador de campanha já reúne personagens, fichas, regras, catálogo, inventários, contas, transações, sessões, chat, rolagens, testes, notas e arquivos. Isso é útil para backup e recuperação, mas **não deve ser disponibilizado integralmente a nenhum agente ou rotina de simulação**: inclui conteúdo privado e dados fora do escopo de conhecimento de cada agente. O servidor deve montar uma projeção de contexto com apenas os fatos autorizados para aquele NPC/agente, campanha, cena e momento.

Notas e diário existentes são recursos de jogadores/mestres com suas próprias regras de visibilidade; não equivalem automaticamente à memória epistemológica de um NPC. Definir memória por campanha/personagem, com fatos conhecidos, origem, momento de aquisição, confiança/validade e escopo público/privado/segredo. Reutilizar as políticas de visibilidade como referência, sem criar ACL paralela ou vazar informações.

### Ciclos do mundo e agendamento

O autosave atual usa debounce por campanha e setTimeout para criar snapshots após alterações; ele **não é um scheduler de simulação**, não mantém tarefas de mundo duráveis nem recupera ciclos pendentes após reinício. Antes de NPCs e facções agirem fora da sessão, decidir entre ciclo iniciado pelo mestre, fila persistente de eventos ou worker agendado. A solução deverá ser idempotente, retomável após falha, limitada por campanha e orçamento, pausável e auditável. Não acoplar simulação de mundo ao timer de autosave.

### Acervo, progressão e auditoria

- O Acervo/biblioteca tem versionamento e backups; as definições de regras e o catálogo de itens também têm escopo de campanha. A Fase 0 deve definir onde o conteúdo gerado será revisado, aprovado e versionado, sem gravá-lo diretamente numa biblioteca global ou substituir regras publicadas.
- O projeto já possui fluxos de XP/progressão com concessão pelo mestre, compra validada pelo servidor e exigência de ficha selada. A IA deve propor uma concessão/compra; nunca alterar ledger ou personagem diretamente. A execução precisa continuar sujeita às permissões, limites e trilha de auditoria existentes.
- A trilha de auditoria precisa distinguir decisões/intencões propostas pelo agente, ações aprovadas quando exigido e efeitos efetivamente aplicados pelo servidor, vinculando agente/personagem, campanha, ciclo e requestId. Não registrar segredos nem conteúdo privado desnecessário.
- O rate limit atual de Socket.IO é por usuário/ação e em memória; ele protege eventos da mesa, mas não é um orçamento de ciclos, decisões ou operações da simulação. O orçamento de processamento precisa ser próprio, por campanha/agente/ciclo.

### Dependências de planejamento

As decisões acima devem ser resolvidas na Fase 0, antes de implementar grupos autônomos, comércio NPC↔jogador, economia regional ou avanço fora de sessão. A ordem mínima de dependências fica:
1. Identidade/autorização do agente e projeção de contexto privada.
2. Contratos de intenção → aprovação → execução autoritativa e auditoria.
3. Modelo de facções e memória NPC.
4. Comércio de duas pontas, preços, moeda e limites econômicos.
5. Scheduler/ciclos duráveis com idempotência, pausa e orçamento.
6. Só então simulação ampliada de grupos, regiões e conflitos mistos.

Essas decisões não alteram a prioridade da linha 1.x: o D10 e a estabilidade da mesa continuam à frente. O Mundo Vivo permanece como trilha planejada da versão 2.0, com implementação somente após liberação explícita da coordenação.

## Complemento da Fase 0 — identidade de serviço, execução e motor determinístico

A auditoria do código confirmou que a IA ainda não tem identidade técnica para agir na mesa. O fluxo Socket.IO resolve usuário autenticado, membership e papel por sessão (resolverCtx em sockets/mesa.ts). Uma IA não é um usuário humano e não deve receber uma conta-mestre compartilhada nem simular silenciosamente o mestre.

### Identidade de serviço e autorização

- Definir um principal interno não humano, com escopo explícito de campanha, agente/personagem e capacidades permitidas. A autorização deve ser verificada no servidor em cada ação e nunca depender apenas da intenção produzida pelo agente ou parser.
- Diferenciar quatro identidades: usuário humano responsável/aprovador, agente de IA que propôs, NPC que aparece como autor/falante e principal de serviço que executa o comando autorizado.
- A tabela audit_logs atual tem actor_id como FK para users.id; não representa diretamente um ator não humano. A Fase 0 deve propor uma extensão aditiva (por exemplo actor_type/agent_id/request_id), mantendo o usuário humano responsável quando existir, sem criar usuário fake nem perder a autoria da aprovação.
- Snapshots também exigem createdBy ligado a users. Ações autônomas não devem criar snapshots fingindo autoria humana; definir a política de proprietário/aprovador para snapshots e ciclos.
- A execução de serviço deve ser capability-based e least-privilege. Não dar à IA papel mestre geral. O mestre humano precisa pausar, aprovar, rejeitar e retomar a autonomia.

### Separação entre handlers Socket.IO e serviços de aplicação

Hoje autenticação, papel e lógica de ações estão acoplados aos handlers Socket.IO. Antes da IA, extrair funções de aplicação testáveis para chat, pedido/rolagem de teste D10 e aplicação de HP/dano. Os handlers de socket e as rotas REST devem chamar os mesmos serviços. A extração não pode alterar contratos, permissões, emissão de eventos, idempotência nem resultados; a suíte de regressão existente precisa provar paridade.

### Motor determinístico, telemetria e orçamento de processamento

A decisão de produto do épico #180 é implementar toda a inteligência em TypeScript no servidor Mestre RPG, sem LLM, provedor comercial, modelo local de terceiros como dependência, SDK ou API externa de inferência. A Fase 0 deve definir contratos internos do motor de comportamento e do parser determinístico de intenções, com estados, objetivos, regras, árvores de comportamento, pontuação de ações, agendas e memória estruturada. Testes devem usar entradas/estados controlados e resultados reproduzíveis; não criar abstração de provedor nem fake de LLM.

O texto livre será interpretado por vocabulário, padrões, sinônimos, contexto e catálogo de intenções programados. Quando a intenção não for reconhecida ou for ambígua, o sistema deve pedir esclarecimento ou apresentar opções; nunca inventar compreensão ou executar por aproximação.

A telemetria deve registrar metadados mínimos por ciclo/decisão (campanha, agente, requestId, ciclo, tipo de decisão/ação, resultado, duração, operações processadas, tamanho de fila e status), sem armazenar contexto privado desnecessário. O orçamento deve limitar processamento por campanha/agente/ciclo, incluindo concorrência, decisões, operações, memória e duração; não há tokens, custo por chamada ou provedor a contabilizar.

### Scheduler, mundo entre sessões e PVP

O autosave existente é um debounce de snapshot, não um worker nem uma fila durável. Ciclos do mundo exigem mecanismo persistente, idempotente, retomável após reinício, pausável por campanha e limitado por orçamento. A escolha entre ciclo disparado pelo mestre, fila persistente ou worker deve anteceder simulação autônoma.

O motor atual tem rolagens, testes, iniciativa e aplicação de HP, mas não um resolvedor completo de combate automático. PVP entre grupos também exige política explícita de consentimento, limites, permissões e consequências permanentes; não pode ser decidido apenas por heurísticas narrativas do agente.

### Backlog sequenciado da Fase 0 (planejamento; execução depende de liberação)

A sequência inicial proposta é:
1. Identidade de serviço, capacidades e projeção de contexto privado ([#182](https://github.com/mestredsl-eng/mestreRPG/issues/182)).
2. Extração dos serviços internos de chat, D10 e HP com paridade dos handlers atuais ([#183](https://github.com/mestredsl-eng/mestreRPG/issues/183)).
3. Contratos do motor determinístico, parser de intenções, telemetria de ciclos/decisões e limites de processamento ([#184](https://github.com/mestredsl-eng/mestreRPG/issues/184)).
4. Depois da fundação, detalhar o Criador de Campanhas revisável e aprovado por humano.

A Fase 0 continua sem autorização para começar implementação até liberação explícita da coordenação. D10 e estabilização da linha 1.x permanecem prioritários; a versão 2.0 evoluirá lentamente, sem ser esquecida e sem competir com a entrega jogável atual.

## Especificação complementar — configuração da campanha e mundo inicial

### Configuração obrigatória de início

A campanha no modo IA terá uma etapa obrigatória de configuração antes de iniciar qualquer simulação. O mestre revisa e confirma as regras que governarão o mundo. A configuração é salva junto à campanha existente, com histórico e auditoria de alterações.

Parâmetros mínimos:

- **Dinheiro/economia:** taxas ou multiplicadores separados para rendimentos, salários, recompensas, preços, serviços, comércio e recursos encontrados. Cada taxa deve indicar claramente quais operações afeta.
- **XP/progressão:** ritmo de concessão e recompensas, limites por sessão/ciclo e velocidade de progressão. Concessões e compras deverão passar pelos serviços de XP e motor de regras já existentes; a IA não escreve saldo nem níveis diretamente.
- **Dificuldade:** presets editáveis e parâmetros separados para investigação, testes, sobrevivência, combate/conflitos e comportamento tático. A dificuldade ajusta preparação, informação, recursos e desafios, sem duplicar regras de domínio na lógica dos agentes.
- **Mundo/localidades:** recursos, serviços, pontos de interesse, zonas seguras/perigosas, clima/eventos, rotas, transporte, densidade de população, facções e locais secretos.
- **População e NPCs:** densidade e quantidade de NPCs, incluindo civis, serviços, figuras importantes e ameaças; definir limites de memória e simulação.
- **Squads IA:** quantidade de squads no início, número de personagens por squad, composição/arquetipos, papel, facção, recursos/equipamentos, objetivo, autonomia e localização inicial. Configurar limites máximos, squads de reserva e regras para criar novos grupos.
- **Conflitos e consequências:** habilitar/configurar PVP, NPC vs NPC, guerras, mortes, ferimentos permanentes, roubo e efeitos econômicos.
- **Conteúdo 18+:** temas, intensidade, proibições e limites dos participantes.

A interface apresentará um resumo e uma prévia do mundo, mapa, localidades, população e squads, além de estimativa de carga de processamento e consumo de recursos do servidor. Presets serão apenas ponto de partida, sempre editável. Mudanças pós-início deverão gerar histórico e não poderão alterar retroativamente eventos ocorridos.

### Mapa inicial deliberadamente compacto

A primeira campanha do Mundo Vivo começa com uma área fixa e limitada:

- Uma grande cidade fictícia, inspirada na escala/densidade/variedade de Nova York, sem copiar sua geografia ou identidade.
- Quatro ilhas pequenas.
- Uma ilha média.
- Rotas de transporte e conexões coerentes entre cidade e ilhas.

A cidade terá distritos e bairros com funções distintas (residencial, comercial, industrial, institucional, portuária, entretenimento, áreas degradadas e locais secretos). As ilhas terão identidades, recursos, serviços e ganchos próprios. Continentes e outras cidades ficam fora do primeiro escopo.

### Tokens apenas em batalha; cenas sem turnos

No modo Mestre IA, tokens serão utilizados somente quando houver batalha/conflito com necessidade de posicionamento tático. Exploração, viagens, investigação, conversas, cotidiano e demais cenas usam localização narrativa, descrições e estado do personagem, sem tokens obrigatórios.

O modo IA não usará a fila de turnos, passagem de turno ou ampulheta da Mesa como estrutura geral. O fluxo é contínuo, orientado a cenas e intenções dos jogadores. A batalha precisará de um modelo de resolução fluida (como janelas de ação simultâneas ou sequência narrativa) sem depender da fila tradicional. Apesar disso, rolagens, dano, HP, Vitalidade e efeitos continuam passando pelo servidor e pelas regras autoritativas existentes. A forma exata da resolução de batalha será definida em proposta técnica antes de codificar.

### Congelamento e retomada do mundo

Deve existir um estado operacional explícito **Congelado/Ativo** para o mundo.

Congelar:
1. Bloqueia o início de novas simulações/ciclos.
2. Finaliza ou cancela ações em andamento com consistência transacional.
3. Persiste eventos, estado de NPCs e squads, economia, inventário, missões, localizações, relógio lógico e filas pendentes.
4. Grava checkpoint consistente e mantém ledger/event log para recuperação.
5. Pausa workers e agendamentos; nada avança enquanto congelado.
6. Só então autoriza o desligamento controlado do servidor.

Descongelar:
1. Recupera o último checkpoint consistente.
2. Reprocessa eventos pendentes de modo idempotente.
3. Restaura estado e relógio lógico sem duplicar pagamentos, XP, ações ou consequências.
4. Mantém o mundo congelado até a recuperação ser concluída e a liberação ser explícita.
5. Retoma a partir do mesmo instante lógico. Tempo com o servidor desligado não avança o mundo por padrão.

Também deve haver recuperação de encerramento inesperado. Autosave/debounce sozinho não é critério suficiente; será preciso checkpoint consistente e processamento durável de eventos/tarefas, reutilizando e ampliando a infraestrutura atual somente quando necessário.

### Classificação adulta permanente (18+)

O Mundo Vivo é exclusivamente 18+. A campanha será marcada como adulta desde a criação; convite, entrada e telas relevantes exibem essa classificação, e cada participante deverá confirmar maioridade antes de entrar. A arquitetura de acesso/participantes ainda deverá ser definida na Fase 0.

A IA precisa conseguir conduzir RPG com temas adultos como violência, horror, crime, linguagem adulta e sexualidade entre personagens adultos, obedecendo a uma configuração de intensidade e limites dos participantes (temas permitidos, proibidos, linhas e véus). O grupo poderá interromper, resumir ou retirar qualquer cena.

Limites obrigatórios:
- Qualquer conteúdo sexual ficcional envolve somente personagens inequivocamente adultos e consentimento no contexto.
- Menores de idade não participam de conteúdo sexual em nenhuma circunstância.
- Violência sexual, coerção e abuso, quando existirem como tema narrativo, nunca serão erotizados; por padrão serão não gráficos e poderão ser completamente excluídos.
- O mestre e os participantes podem impor limites mais restritivos a qualquer momento; a IA os respeita imediatamente.
- Ambientação 18+ não autoriza instruções de violência real nem elimina limites de segurança, consentimento, privacidade e legislação.
- Cenas sensíveis podem ser sinalizadas e conduzidas por corte de cena/“fade to black”.

### Critérios adicionais de aceite

- Configuração inicial obrigatória e confirmação explícita antes de iniciar o mundo.
- Taxas de dinheiro e XP, dificuldade, parâmetros do mundo/população e squads configuráveis e persistidos.
- Prévia com mapa, localidades, população, quantidade/composição dos squads e estimativa operacional.
- Mapa inicial limitado à metrópole fictícia + quatro ilhas pequenas + uma ilha média.
- Tokens somente durante batalhas; nenhuma cena não combativa depende de tokens.
- Nenhuma dependência da fila de turnos/ampulheta no modo IA; batalha fluida especificada sem resultados arbitrários.
- Testes de congelar/descongelar, desligamento limpo/crash, recuperação, idempotência e ausência de avanço do relógio enquanto congelado.
- Classificação 18+, confirmação de maioridade e limites de conteúdo maduro persistentes e respeitados.
- Toda a experiência continua usando os registros, serviços, permissões, motor de regras e persistência do Mestre RPG atual.
