# Rollout gradual do Mundo Vivo — versões 1.1.x até 2.0

**Decisões do dono do produto: 23/11/2026.** Os subsistemas da 2.0 serão entregues funcionalmente na linha 1.1.x. A 2.0 integrará o ecossistema completo; não será o primeiro dia em que essas funções existirão.

## Princípio central

Construir os componentes definitivos do Mundo Vivo e liberá-los por fatias funcionais. Estender a campanha real **Caçadores & Caçados**, o template **Os Caçadores Caçados**, fichas e ruleset atuais, atributos, talentos, perícias, conhecimentos, habilidades, poderes, motor D10, HP/Vitalidade, XP, dinheiro e os dados patrimoniais que já existem.

**A ficha deixa de ser o contêiner de todas as funções do personagem.** A ficha fica focada nos dados e regras do personagem. As funções operacionais passam a ser módulos próprios, separados e acessados por botões na campanha/personagem:

- **Internet:** celular/computador do personagem. Abriga lojas, compras, vendas, classificados e, gradualmente, mensagens, contatos, grupos, notícias, pesquisas, redes sociais, empresas e empregos.
- **Equipamento/Armazém:** módulo próprio para consultar e administrar inventário, equipamentos, veículos, itens carregados e itens guardados. Não é lugar de comprar/vender; essas operações ficam na Internet.
- **Ficha:** atributos, características, talentos, perícias, conhecimentos, habilidades, poderes, defeitos/qualidades, raça, profissão e demais campos oficiais do template.
- O chat OOC da mesa continua separado da Internet diegética.

Não criar segunda ficha, segundo inventário, segundo saldo/ledger, segundo motor de RPG, segundo chat OOC ou outra base de campanha. Separar a interface e os fluxos não significa duplicar nem apagar os modelos/API existentes. Preservar IDs e vínculos das fichas, itens, equipamentos, veículos, contas e transações. A mudança da UI deve ser feita com migração segura e sem perda dos dados atuais.

## Sequência candidata

| Versão | Fatia funcional |
|---|---|
| **1.1.0** | Primeira organização dos módulos + comércio na Internet: botões separados **Internet** e **Equipamento/Armazém** fora da ficha; vitrine de lojas, ofertas, compras e vendas pela Internet; equipamento/armazém passa a ser a área de inventário, equipamento, veículos e armazenamento. Checkout entre comprador e loja usa dinheiro/ledger e inventário atuais. |
| **1.1.1** | Internet diegética expandida: dispositivos reais como celular/notebook/computador, contas/contatos, mensagens privadas e em grupo. Acesso à Internet respeita posse/condição do dispositivo. |
| **1.1.2** | Sites, busca, notícias, jornais, anúncios, classificados, perfis e redes sociais; autoria, privacidade e consequências persistentes. |
| **1.1.3** | Empresas e trabalho: proprietários, funcionários, vagas, contratação, salários, fornecedores, receitas e despesas. |
| **1.1.4** | NPCs habitantes: rotina, profissão, memória com escopo autorizado, relações, objetivos e ações limitadas pelo mesmo motor. |
| **1.1.5** | Jogadores IA: personagens reais usando fichas/regras existentes; autonomia gradual para conversar, trabalhar, comprar, vender, aprender, evoluir e participar da sociedade. |
| **1.1.6 em diante** | Organizações/guildas humanas, IA ou mistas; liderança e sucessão; patrimônio, alianças, influência, propriedades e administração territorial em fatias. |
| **2.0** | Integração do Mundo Vivo: humanos, Jogadores IA e NPCs coexistem na mesma sociedade persistente, com economia, Internet, empresas, guildas, territórios, PvP/PvE, guerras e simulação contínua enquanto o servidor estiver ligado. |

A sequência é planejamento candidato, não promessa de data nem autorização automática de implementação. Refinar com auditorias, dependências e testes.

## Regras de produto já definidas

- **Cenário:** Caçadores & Caçados contemporâneo e realista: ciência, tecnologia, política, religião, economia, negócios, segurança, sociedade e conflitos.
- **Espécies:** Humano, Meta-humano, Vampiro, Lobisomem e as demais opções já existentes na campanha.
- **Controlador separado da espécie:** um personagem pode ser conduzido por humano, Jogador IA ou NPC.
- **Mesmo motor:** todos usam as mesmas regras, permissões e serviços. A IA propõe ações; o servidor valida e executa.
- **Mundo:** servidor ligado = campanha avança mesmo sem humanos conectados; servidor desligado = tudo congela. Na retomada, continua do estado persistido, sem simulação retroativa.
- **Morte:** permadeath; ficha encerrada definitivamente e nova ficha começa do zero, sem herança automática. Guilda pode ajudar com seus próprios recursos.
- **Guildas:** humanas, IA ou mistas; fundam-se, comandam-se, recrutam, fazem alianças, acumulam patrimônio e guerreiam. Se o líder morrer, o braço direito assume; sem sucessor elegível, a guilda é extinta.
- **Territórios:** cidades controláveis e administráveis por guildas, incluindo propriedades, comércio, impostos, defesa e administração.
- **PvP/PvE:** ambos fazem parte do mundo, inclusive humano contra IA, IA contra IA, NPC contra NPC e conflitos entre grupos.

## Módulo Internet

- É a área diegética do personagem, acessada por celular/computador/notebook que ele realmente possui e pode utilizar.
- Compras e vendas saem da ficha/Patrimônio e passam para os serviços comerciais da Internet.
- Lojas, ofertas, preços, estoque, compras, vendas, classificados e serviços devem aparecer na Internet.
- Futuramente: mensagens privadas/grupos, contatos, notícias, pesquisa, sites, redes sociais, empregos e empresas.
- Dados financeiros e operações usam as contas e o ledger existentes; a UI pode oferecer serviços bancários/pagamentos pela Internet sem criar carteira paralela.
- A Internet dos personagens é separada do chat OOC da mesa.
- Humanos, NPCs e Jogadores IA podem utilizar os mesmos serviços conforme identidade, permissões e conhecimento.

## Módulo Equipamento/Armazém

- Botão independente, fora da ficha.
- Reúne a visualização e administração de inventário, equipamentos, veículos, carga e itens guardados.
- Preservar as tabelas e invariantes atuais de inventário↔equipamentos↔veículos; identificar no layout o que está carregado, equipado, guardado ou indisponível.
- Não incluir catálogo de compras, botão Comprar ou fluxo Vender nesse módulo. Comprar/vender ocorre pela Internet; após a operação, os itens aparecem/desaparecem aqui pelo inventário existente.
- Não criar outro inventário nem duplicar quantidades. Definir depósito/armazém como localização/contêiner dentro do mesmo domínio patrimonial, caso o modelo atual não suporte armazenamento com clareza.
- Ficha principal não deve montar ou renderizar o módulo inteiro de patrimônio.

## Primeira fatia comercial — lojas na Internet (1.1.0)

- Loja com nome, categoria, localização, proprietário/responsável e estado.
- Ofertas de produtos/serviços usando identidade e conteúdo do Acervo/templates existentes.
- Estoque comercial próprio, separado do inventário do personagem proprietário.
- Caixa/conta da loja integrada ao mesmo domínio financeiro/ledger; nunca um saldo paralelo.
- Compra de produto: debitar comprador, creditar loja, reduzir estoque e adicionar item ao inventário atual do comprador atomicamente.
- Venda pelo personagem (ex.: classificado/compra de volta por loja): debitar o comprador final e creditar vendedor, com transferência de item e registro idempotente/auditável.
- Serviços sem item físico registram cobrança e prestação sem criar item falso no inventário.
- Interface de loja e compra/venda aparece na Internet. A área Equipamento/Armazém apenas reflete o resultado.
- Administração inicial manual pelo mestre/proprietário; autonomia de NPCs e Jogadores IA vem depois.

## Auditoria técnica antes da implementação

- Reaproveitar carteira, ledger, transferências, Acervo, templates, inventário, equipamentos, veículos, auditoria e realtime.
- Mapear titularidade financeira para que estabelecimento tenha caixa dentro do mesmo domínio.
- Separar a UI de Patrimônio em módulos sem remover dados/APIs atuais até concluir substituição e regressão.
- Definir armazenamento/armazém sem duplicar inventário nem perder procedência de itens.
- Verificar posse/condição de dispositivos para autorizar Internet.
- Auditar snapshots, exportação/importação, backup/restore, migrations e compatibilidade Windows.
- Mapear contratos compartilhados por humanos, NPCs e Jogadores IA.

## Distribuição de preparação

- **Devin — Gerente Operacional de Desenvolvimento:** atualizar matriz de versões/dependências e remover duplicações.
- **Devin — Gerente de Execução:** distribuir tarefas autorizadas, acompanhar sessões reais e exigir branch, SHA, CI e evidências. Ordem registrada não prova sessão iniciada.
- **PAI:** auditoria backend de comércio, contas/ledger, inventário, equipamentos, veículos, armazenamento e persistência.
- **FILHO:** desenhar duas áreas independentes: Internet (lojas/compra/venda e aplicações futuras) e Equipamento/Armazém (inventário/equipamento/carga/armazenamento), removendo esses fluxos da ficha sem refazer a ficha.
- **INTERMEDIÁRIO:** revisão independente, matriz de testes de checkout, retirada da ficha, isolamento dos módulos, preservação de dados, permissões, privacidade e regressões.
- **ChatGPT — Dono Técnico:** arquitetura, integração e critérios de aceite.
- **Dono do projeto:** decisão final de produto.

## Proteção das releases atuais

- **0.8 / 1.0.8:** congelada e preservada.
- **0.9 / 1.0.9:** corte ativo; não desviar seus gates críticos.
- Até estabilizar 1.0.9, trilha 1.1.x pode avançar em auditoria, especificação, UX, fixtures e critérios. Não integrar código 1.1.x nem substituir tarefas críticas sem autorização explícita adicional.
- Cada fatia deve virar PR pequena, independente, testável e com release-alvo.
- Nenhuma decisão neste roadmap autoriza merge, tag ou release automaticamente.

## Referências

- Épico Mundo Vivo: #180 e arquitetura #181–#184.
- Quadro operacional: #204.
- Plano de rollout: #286.
- Auditoria econômica: #287 e documento `AUDITORIA-ECONOMIA-COMERCIO-1.1.0.md`.
- UX atualizada: #288.
- Testes comerciais: #289.
