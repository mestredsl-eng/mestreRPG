# Rollout gradual do Mundo Vivo — versões 1.1.x até 2.0

**Decisão do dono do produto: 23/11/2026.** Este documento complementa e prevalece sobre as passagens anteriores do documento de escopo que colocavam todo o Mundo Vivo exclusivamente na 2.0. A versão 2.0 continua sendo a integração do ecossistema, mas suas partes funcionais serão entregues gradualmente na linha 1.1.x.

## Princípio

Construir desde já os componentes definitivos do Mundo Vivo, liberando fatias independentes quando estiverem completas. Não criar sistemas temporários para depois descartar. A implementação deve estender a campanha real **Caçadores & Caçados**, o template **Os Caçadores Caçados**, as fichas, ruleset, personagem, motor D10, HP/Vitalidade, XP, dinheiro, patrimônio, inventário, mesa, permissões e persistência já existentes.

Não criar segunda ficha, segundo inventário, segundo saldo, segundo motor de RPG, segundo chat OOC ou nova base de campanhas.

## Sequência candidata

| Versão | Fatia funcional |
|---|---|
| **1.1.0** | Primeira fatia comercial: lojas, catálogo de produtos/serviços, preços, estoque, caixa e compras/vendas integradas com carteira e inventário existentes. Administração inicial por mestre/proprietário; preparar contratos para NPCs e Jogadores IA. |
| **1.1.1** | Dispositivos diegéticos: celular/computador/notebook como equipamento que o personagem realmente possui; contas, contatos e mensagens privadas/em grupo. |
| **1.1.2** | Internet pública: sites, busca, notícias, jornais, anúncios, classificados, perfis e redes sociais. Separada do chat OOC da mesa. |
| **1.1.3** | Empresas e trabalho: proprietários, funcionários, vagas, contratação, salários, fornecedores, receitas e despesas. |
| **1.1.4** | NPCs habitantes: rotina, profissão, memória com escopo autorizado, relações, objetivos e ações limitadas pelo motor de regras. |
| **1.1.5** | Jogadores IA: personagens reais usando fichas e regras existentes; autonomia gradual para conversar, trabalhar, comprar, vender, aprender, evoluir e participar da sociedade. |
| **1.1.6 em diante** | Organizações/guildas humanas, de IA ou mistas; liderança e sucessão; patrimônio, alianças, influência, propriedades e administração territorial, entregues em fatias. |
| **2.0** | Integração do Mundo Vivo: humanos, Jogadores IA e NPCs coexistindo na mesma sociedade persistente, com economia, Internet, empresas, guildas, territórios, PvP/PvE, guerras e simulação contínua enquanto o servidor estiver ligado. |

A sequência é uma proposta de planejamento e será refinada após auditorias de dependências e capacidade. Não transforma a lista em promessa de data ou autorização automática para implementar tudo em paralelo.

## Regras de produto já definidas

- **Cenário:** Caçadores & Caçados contemporâneo e realista, abrangendo ciência, tecnologia, política, religião, economia, negócios, segurança, sociedade e conflitos.
- **Espécies:** Humano, Meta-humano, Vampiro, Lobisomem e demais opções já existentes na campanha.
- **Controlador separado da espécie:** um personagem pode ser controlado por jogador humano, Jogador IA ou NPC. Espécie e controlador não são o mesmo campo.
- **Mesmo motor:** humanos, IA e NPC usam as mesmas regras, permissões e serviços. A IA propõe ações; o servidor valida e executa.
- **Mundo:** com o servidor ligado, a campanha continua mesmo sem humanos conectados. Servidor desligado congela tudo. Ao reiniciar, retoma do estado persistido, sem simulação retroativa.
- **Morte:** permadeath. Morreu, a ficha é encerrada; nova ficha começa do zero, sem herança automática. Guilda pode ajudar usando recursos próprios.
- **Guildas:** humanas, de IA ou mistas; podem fundar-se, comandar-se, recrutar, aliar-se, acumular patrimônio e guerrear. Com a morte do líder, o braço direito assume; sem sucessor elegível, a guilda é extinta.
- **Territórios:** cidades podem ser controladas e administradas por guildas, incluindo propriedades, comércio, impostos, defesa e administração.
- **PvP e PvE:** ambos fazem parte do mundo, inclusive humano contra IA, IA contra IA, NPC contra NPC e conflitos entre grupos.

## Primeira fatia — lojas e comércio (1.1.0)

- Loja com nome, categoria, localização, proprietário/responsável e estado.
- Catálogo de produtos e serviços, descrição, preço, disponibilidade e estoque.
- Compra/venda valida saldo, estoque e autorização; debita/crédita recursos, atualiza inventário e estoque de forma consistente; gera recibo e histórico auditável.
- Reutilizar a carteira, o financeiro, as transações, o Acervo e o inventário existentes. Não criar inventário ou saldo comercial paralelo.
- Especificar reposição de estoque, devolução/estorno, concorrência em compras e fechamento de loja.
- Começar com administração manual por mestre/proprietário. A autonomia comercial de NPCs e Jogadores IA chega em versões posteriores.

## Internet diegética — fatias 1.1.x

- O personagem acessa serviços por meio de dispositivos que possui no inventário/equipamento (celular, notebook, computador etc.).
- Mensagens privadas e em grupo, contatos e histórico.
- Sites, pesquisa, notícias, jornais, redes sociais, anúncios, lojas online, classificados, empresas e empregos.
- A Internet dos personagens é separada do chat fora de personagem (OOC) da mesa.
- Humanos, NPCs e Jogadores IA poderão usar os mesmos serviços, com autenticação, permissões, autoria e conhecimento compatíveis.

## Auditoria técnica antes de implementação

- Mapear loja/organização existente, carteira, financeiro, transferências, transações, catálogo/Acervo, inventário e auditoria.
- Verificar atomicidade, idempotência, concorrência, realtime e estorno no fluxo atual de dinheiro e itens.
- Verificar como NPCs e guildas atuais são modelados; mapear identidade do controlador sem confundir com a raça.
- Definir como posse/estado do equipamento autoriza o acesso à Internet, sem criar inventário paralelo.
- Auditar snapshots, exportação/importação, backup/restore, migrations e compatibilidade Windows.
- Mapear serviços internos que possam ser compartilhados por humanos, NPCs e IA.

## Distribuição de preparação

- **Devin — Gerente Operacional de Desenvolvimento:** atualizar matriz de releases, dependências e sobreposições com Issues/PRs existentes.
- **Devin — Gerente de Execução:** distribuir somente tarefas autorizadas; exigir sessão real, branch, SHA, CI e evidências. Uma ordem escrita não prova que uma sessão foi iniciada.
- **PAI:** auditoria de backend, financeiro, patrimônio, transações, NPCs, identidade do controlador e modelo de serviços reutilizáveis.
- **FILHO:** fluxos UX de loja/compra e celular/computador/Internet, separando canais de personagem e chat OOC.
- **INTERMEDIÁRIO:** revisão independente, cenários de aceite para concorrência, idempotência, saldo/estoque insuficientes, autorização, privacidade e regressões.
- **ChatGPT — Dono Técnico:** arquitetura, integração às regras e critérios de aceite.
- **Dono do projeto:** decisões finais de produto.

## Proteção das releases atuais

- **0.8 / 1.0.8:** congelada e preservada.
- **0.9 / 1.0.9:** continua sendo o corte ativo. Não desviar os gates críticos para acelerar o roadmap.
- Até a estabilização da 1.0.9, a trilha 1.1.x pode avançar em auditoria, especificação, UX, fixtures e critérios de teste. Nenhum código dessa trilha deve ser integrado nem substituir tarefas críticas da 1.0.9 sem autorização explícita adicional.
- Cada fatia deve virar PR pequena, separada, testável e com release-alvo explícito.
- Nenhuma decisão deste roadmap autoriza merge, tag ou publicação automaticamente.

## Referências

- Épico Mestre IA / Mundo Vivo: #180 e arquitetura #181–#184.
- Quadro operacional: #204.
- Plano operacional detalhado: #286.
- Escopo de releases: #283.
