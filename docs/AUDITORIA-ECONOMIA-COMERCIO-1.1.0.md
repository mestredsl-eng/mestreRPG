# Auditoria técnica — economia existente e lacuna para lojas (1.1.0)

**Auditoria do Dono Técnico · 23/11/2026**  
**Repositório:** `mestredsl-eng/mestreRPG`  
**Base analisada:** `main@a9585225ffb7b1a59d475d5f8a965692fe963fb7`  
**Natureza:** leitura de código e testes existentes; nenhuma execução de testes nesta auditoria e nenhuma alteração de código.

## Conclusão executiva

O Mestre RPG **já tem compras e vendas no patrimônio do personagem**. Reimplementar compras/vendas, carteira, pagamentos ou o inventário do jogador seria duplicação.

O que ainda não existe é uma **loja/estabelecimento como entidade persistente do mundo**, com proprietário/gestor, catálogo público, estoque pertencente à loja, caixa/conta da loja e checkout entre dois lados:

- comprador: débito na conta do personagem e entrada do item no inventário do comprador;
- loja: crédito no caixa/conta da loja e baixa do estoque comercial.

Hoje o fluxo é individual: compra debita a própria conta do personagem e adiciona o item ao inventário dele; venda retira do próprio inventário e credita a conta dele. O campo `contraparte` é texto descritivo; não efetua o pagamento para uma loja ou outro proprietário.

Portanto, a entrega 1.1.0 deve se chamar e ser especificada como **Lojas e comércio entre comprador e estabelecimento**, não como uma segunda implementação de compra/venda.

## 1. O que já existe e deve ser reutilizado

### 1.1 Catálogo de itens e Acervo

- Tabela `item_templates`, por campanha: `servidor/src/db/schema.ts#L339-L351`.
- API de catálogo: `servidor/src/routes/catalogo.ts`.
- A listagem combina os templates administrados pelo mestre com elementos `kind:item` do Acervo, incluindo dados econômicos e pré-requisitos.
- O mestre cria/edita/desativa templates; cada template tem identidade, categoria, descrição, `data` e estado ativo.
- A ponte econômica Acervo → template já copia/resolve preço de referência, peso e demais dados econômicos. A rota de patrimônio revalida template e vínculo na transação.

**Reutilização:** identidade de produto, Acervo, descrição, categoria, atributos, requisitos e preço de referência. O catálogo atual não é o estoque de uma loja.

### 1.2 Carteiras, contas e histórico financeiro

- Tabela `financial_accounts`: `servidor/src/db/schema.ts#L353-L371`.
- Tabela `money_transactions`: `servidor/src/db/schema.ts#L396-L425`.
- API de leitura de contas e histórico: `servidor/src/routes/patrimonio.ts#L1156-L1177`.
- Contas são atualmente de um personagem (`characterId` obrigatório), vinculadas também à campanha. Valores são armazenados em centavos; moeda e limite de crédito são configuráveis.
- A movimentação usa transação SQLite, relê o saldo dentro da transação, registra saldo anterior/posterior, `requestId`, auditoria e evento realtime.
- A transferência/PIX fictício entre personagens da mesma campanha já movimenta débito e crédito em duas contas numa única transação: `servidor/src/routes/patrimonio.ts#L1369` em diante.

**Reutilização:** conta do comprador, precisão em centavos, ledger, PIX fictício, auditoria, idempotência e emissão realtime. A conta atual não pode pertencer diretamente a uma loja.

### 1.3 Compra e venda de itens na ficha

- Endpoint existente: `POST /api/characters/:id/financeiro/operacao`, em `servidor/src/routes/patrimonio.ts#L1471-L1850`.
- A compra usa o catálogo/template ou dados de item, valida vínculo e pré-requisitos do Acervo, debita a conta escolhida e cria a entrada no inventário do personagem.
- A venda exige `itemId`, valida quantidade, retira unidades do inventário daquele personagem e credita a conta dele.
- Compra/venda, saldo, item, histórico, metadados de estorno e idempotência por `requestId` são tratados na mesma transação. Há proteção contra retry duplicado, saldo insuficiente, item/template inexistente e corrida de estoque.
- A UI já exibe “Comprar…” e fluxo de venda em Patrimônio: `site/src/paginas/Patrimonio.tsx#L290`, `#L512` e `#L727`. A aba Catálogo é atualmente exclusiva do mestre: `#L105`.

**Limite atual:** a compra cria um item diretamente no inventário do personagem e debita a conta desse mesmo personagem. A venda retira item do inventário desse personagem e credita a conta dele. `contraparte`/campo counterparty registra um rótulo, não uma transferência real para o vendedor/loja. Não há conta de loja, estoque comercial nem uma entidade de estabelecimento.

### 1.4 Inventário

- Tabela `inventory_entries`: `servidor/src/db/schema.ts#L309-L323`.
- Cada item pertence a um `characterId`; a tabela representa o patrimônio carregado/guardado pelo personagem, não estoque empresarial.
- A baixa de venda e a criação da compra usam essa tabela. Equipar/devolver item também mantém invariantes entre inventário e equipamento.

**Reutilização:** quando a loja concluir a venda, o item comprado deve aparecer no inventário atual do comprador, com a mesma procedência e snapshot de Acervo/template. Não transformar o estoque da loja no inventário pessoal de algum personagem.

## 2. O que falta para uma loja real

1. **Entidade estabelecimento:** identidade da loja, nome, categoria, endereço/localização no mundo, estado, proprietário/gestor e permissões.
2. **Oferta comercial:** produtos/serviços publicados pela loja, preço de venda, moeda, disponibilidade e vínculo a `item_templates`/Acervo.
3. **Estoque próprio:** quantidades disponíveis, reposição, reserva/baixa concorrente e histórico de movimentações. Não usar o inventário pessoal do proprietário como se fosse estoque da loja.
4. **Caixa/conta da loja:** titularidade econômica da empresa/estabelecimento. Atualmente `financial_accounts.characterId` é obrigatório e não aceita loja como titular.
5. **Checkout bilateral:** pagamento sai da conta do comprador e entra na conta da loja; estoque diminui; item entra no inventário do comprador; operação e recibos são registrados na mesma transação.
6. **Serviços sem item físico:** cobrança, confirmação de prestação e histórico, sem criar item fictício no inventário.
7. **Operação administrativa:** abrir/fechar loja, editar preços, repor estoque, consultar vendas/caixa e autorizar gestores.
8. **Persistência e compatibilidade:** snapshots, exportação/importação, backups, restore, isolamento por campanha e realtime devem incluir lojas, estoque e suas movimentações.

## 3. Cuidado com nomes já existentes

### “Guildas” atuais

As tabelas `guilds` e `guild_members` são o escopo administrativo da plataforma: associação de usuários e gestores de guilda, criado por um usuário e com membros ligados a `users` (`servidor/src/db/schema.ts#L60-L90`). Elas **não** representam guildas/facções autônomas dentro do cenário Caçadores & Caçados.

Não reaproveitar silenciosamente esse significado. As organizações do mundo são um domínio diferente (organizações/facções dentro da campanha), embora possam compartilhar conceitos depois de uma auditoria.

### NPC atual

A tabela `characters` exige `membershipId`; `isNpc` significa atualmente “personagem controlado pelo mestre” (`servidor/src/db/schema.ts#L187-L205`). A criação de NPC é exclusiva do mestre e nasce aprovada. Isso não representa ainda um Jogador IA autônomo nem uma identidade de serviço.

A separação entre espécie/raça e controlador (humano/IA/NPC) deve respeitar a arquitetura de identidade e capacidades prevista em #182. Não usar `isNpc` como substituto improvisado de Jogador IA.

## 4. Recomendação técnica para a 1.1.0

### Modelo de domínio mínimo

- `stores` (ou entidade de estabelecimento equivalente): campanha, identidade, localização, estado e referência de proprietário/gestores.
- `store_offers`: loja, referência do produto/serviço já cadastrado, preço e moeda, estado/publicação.
- `store_stock`: oferta/item e quantidade disponível; movimentações de entrada/saída ajustam o estoque com controle de concorrência.
- Conta/caixa da loja integrada ao **mesmo domínio de contas e ledger financeiro**, não um saldo paralelo.
- `store_sales` (ou comprovante de operação comercial equivalente): requestId, comprador, loja, itens/serviços, preços efetivamente aceitos, totais, moeda, estado e referência ao ledger.

Estes nomes são conceituais, não decisões definitivas de schema. O PAI deve confirmar a menor extensão e verificar se alguma primitiva existente já resolve parte do modelo.

### Checkout — invariantes de aceite

Dentro de uma única transação:
1. Revalidar comprador, campanha, loja aberta, permissão, oferta publicada e preço vigente.
2. Reler a conta do comprador e o caixa da loja; validar moeda e saldo/limite.
3. Reler o estoque e reservar/baixar a quantidade com condição de concorrência.
4. Registrar débito do comprador e crédito da loja no ledger, com saldos anterior/posterior.
5. Criar os itens físicos no inventário atual do comprador, preservando a identidade/snapshot do Acervo.
6. Registrar operação comercial com `requestId` idempotente e recibo.
7. Confirmar tudo junto; qualquer falha desfaz todos os efeitos.
8. Após commit, emitir eventos realtime apenas para participantes autorizados e registrar auditoria.

Não permitir que o cliente envie preço final, saldo, estoque ou proprietário como verdade: o servidor resolve esses dados a partir da oferta/loja e confirma o valor antes do pagamento.

### Titularidade financeira — decisão técnica crítica

Antes de codificar, resolver como contas e ledger representarão titulares que não são personagens. Duas opções a comparar:
- ampliar o modelo de titularidade financeira existente para suportar personagem e estabelecimento (mantendo compatibilidade com contas antigas);
- introduzir uma abstração comum de titular econômico e migrar as contas de personagens para ela de forma aditiva.

Não criar uma tabela de saldo/ledger independente para lojas. Evitar também usar um NPC artificial como “conta bancária” da loja: uma empresa deve ser titular do caixa, independentemente de quem a administra ou trabalha nela.

## 5. Testes e qualidade

Arquivos de teste/homologação já existentes no repositório incluem:
- `teste-financeiro-atomico.mjs`
- `teste-financeiro-compras.mjs`
- `teste-financeiro-integracao.mjs`
- `teste-venda-estoque.mjs`
- `teste-ponte-economica-acervo.mjs`
- `homologacao-compras-vendas.mjs`
- `homologacao-patrimonio.mjs`
- `homologacao-patrimonio-permissoes.mjs`

A existência dos arquivos não significa que foram executados nesta auditoria. No `.github/workflows/ci.yml` da base analisada, a lista obrigatória de Browser contém `homologacao-patrimonio.mjs` e `homologacao-patrimonio-permissoes.mjs`, mas não contém a homologação direcionada `homologacao-compras-vendas.mjs` nem as suítes financeiras listadas acima. Confirmar cobertura de todos os workflows e adicionar os testes comerciais apropriados como gate obrigatório quando a funcionalidade for implementada; ausência de suíte não pode virar SKIP silencioso.

Testes novos mínimos para loja:
- compra válida com débito do comprador + crédito da loja + redução de estoque + item adicionado;
- saldo insuficiente, estoque insuficiente, loja fechada e oferta retirada sem qualquer mutação parcial;
- duas compras concorrentes do último item: somente uma conclui;
- retry após ACK perdido: uma venda, um débito, um crédito e uma entrega;
- falha injetada entre cada escrita: rollback integral;
- devolução/estorno conforme política definida;
- privacidade de caixa, relatório de vendas e gestão da loja;
- isolamento entre campanhas e persistência em backup/restore;
- regressão dos fluxos antigos de compra/venda direta da ficha.

## 6. Resultado e próximo passo

**Resultado comprovado pela leitura do código:** catálogo, Acervo, carteira, transferências e compra/venda individual já existem. O módulo novo necessário é a camada de estabelecimento/estoque comercial/checkout bilateral.

**Próximo passo PAI (#287):** entregar inventário técnico com migrations e arquivos de suporte, comparar as duas opções de titularidade financeira, identificar testes executados pela CI de cada workflow e propor o menor modelo aditivo.  
**Próximo passo INTERMEDIÁRIO (#289):** validar este contrato e a matriz de corrida/idempotência/rollback/ACL.  
**Próximo passo FILHO (#288):** UX de descoberta de loja, vitrine, detalhe da oferta, carrinho/checkout e painel do proprietário — sem duplicar a aba Patrimônio atual.

Nenhuma implementação foi feita por esta auditoria. A 0.8/1.0.8 continua congelada; a 0.9/1.0.9 continua sendo o corte ativo. Preparação da 1.1.0 permanece documental/UX/testes até estabilização da 1.0.9 e autorização explícita para implementar.
