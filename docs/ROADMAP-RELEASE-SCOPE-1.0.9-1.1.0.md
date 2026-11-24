# Mestre RPG — Escopo oficial das versões 1.0.9 e 1.1.0

**Documento de governança de release.** A Issue #204 permanece como quadro operacional e checkpoint. Este documento define o que pertence a cada release e evita que tarefas sejam movidas de versão por interpretação individual.

## 1. Nomenclatura usada pelo projeto

| Nome usado pelo dono | Versão técnica nos manifests | Situação |
|---|---:|---|
| **0.8** | **1.0.8** | Versão estável em uso; congelada |
| **0.9** | **1.0.9** | Próxima entrega em desenvolvimento |
| Próxima depois da 0.9 | **1.1.0** | Backlog futuro; ainda não liberado para implementação |

Não abrir uma linha técnica paralela chamada apenas 0.9. Para código, branches, manifests, changelog e releases, usar 1.0.9. Na comunicação com o dono, pode-se chamar de versão 0.9.

## 2. Versão 0.8 / 1.0.8 — congelada

A versão 0.8 é a versão que o dono está jogando e considera boa. Não recebe novas funcionalidades, refatorações, correções cosméticas ou backports por causa do trabalho da 0.9.

- Preservar o comportamento e a instalação existentes.
- Não fazer reset da main para um commit antigo.
- Não misturar PRs da 0.9 na instalação do dono.
- A #282 foi um hotfix técnico de build já integrado à main; não é uma nova funcionalidade e não autoriza mexer na instalação estável.
- O núcleo de Sangue/Poderes e os custos D10 já aparecem no changelog da 1.0.8. A extensão de ativação narrativa da #279 é tratada separadamente como trabalho da 1.0.9, conforme a descrição explícita da própria PR.

## 3. Versão 0.9 / 1.0.9 — escopo ativo

**Objetivo:** fechar a extensão narrativa de Poderes e a cadeia de atualização/recuperação segura. O pacote de XP em lote e extrato já foi integrado à main; resta validar regressões e consolidar a release. Preservar dados e backups criados pela 1.0.8.

### 3.1 Sangue/Poderes — extensão do fluxo de ficha

- **PR #279 / Issue #186:** ação narrativa diretamente junto ao Poder já adquirido na ficha; Poderes marcados como exigindo D10 continuam no fluxo de rolagem; validação e cobrança permanecem autoritativas no servidor.
- A PR declara expressamente v1.0.9 no próprio escopo.
- Não reimplementar o ledger de Sangue, o runtime D10 ou o painel já entregues na 1.0.8.
- Aceite: CI completa no SHA final, revisão independente atualizada, retry idempotente, permissões corretas e ausência de regressão do fluxo D10.

### 3.2 Atualização, Boot Lock e recuperação

- **Issue #155 / cadeia #176, #188, #189:** atualização segura, serialização do boot, recuperação e proteção dos dados locais.
- **Issue #265 (W14):** detector de restauração fail-closed. A execução já existente deve continuar sem duplicação; a evidência em `b903bb2` cobre a view quebrada, mas faltam snapshots do banco/backup e prova do BAT bloquear migrate/start.
- **Issue #266 / PR #280 (W16):** compatibilidade com backups legados v1 da 1.0.8 e preservação do último backup válido. HEAD `a4e0230f28e1ac900329d96075074a7adabd5f05`; Servidor e Windows SUCCESS; Browser pendente no run `45109255431`.
- **PR #281:** correção do harness Windows já integrada à branch de recuperação (merge `46e2915`), não à main.
- **Issue #270:** homologação real do BAT em Windows/cmd.exe; depende da cadeia #189.
- **Issue #271:** homologação Linux; depende de W14/W16 e Boot Lock.
- **Issue #272:** upgrade real 1.0.8 → candidata 1.0.9, dependente dos gates Windows/Linux e W14/W16.
- **Issue #273:** integridade do pacote, manifests, changelog, instalação limpa e hashes; depende da candidata final.
- **Issue #274:** coordenar DAG e montar uma única candidata 1.0.9.
- **PR #189:** OPEN/Draft e `mergeable=false` contra main; não integrar às cegas. Exige reconciliar a ancestralidade e migrations.
- **Aceite:** testes de contrato executados (não SKIP), prova de integridade e preservação, Windows e Linux homologados, upgrade real testado e CI completa na árvore final.

### 3.3 Progressão XP — IMPLEMENTADA NA MAIN; NÃO REFAZER

- Backend #213 já está integrado.
- **#277** integrou a UI de XP em lote; merge commit `f70c2c71c79c646fb3d714ee622e2d6281db94e5`.
- **#215** foi fechada como supersedida por #277. Não reabrir nem duplicar.
- **#217, #257 e #258** estão fechadas como merged.
- **#282** corrigiu o tipo `xp.ancora` e JSX; integrada em `a9585225ffb7b1a59d475d5f8a965692fe963fb7`.
- CI pós-#282 na main: run `45107544190`, Servidor + Windows + Navegador 3/3 SUCCESS.
- Esta frente já não é trabalho de implementação da 1.0.9. Apenas regressão, manutenção e inclusão correta no changelog final.

### 3.4 Fora do corte 1.0.9

PRs independentes de auditoria visual, CSS/acessibilidade, convites, autorizações e HP manual em tokens não entram automaticamente. Só podem ser adicionadas após decisão explícita de escopo e avaliação de risco.

## 4. Versão 1.1.0 — primeira fatia: comércio pela Internet e separação dos módulos

**Tema:** primeira fatia funcional do rollout do Mundo Vivo (#286): separar **Internet** e **Equipamento/Armazém** da ficha e entregar lojas/comércio pela Internet. A 1.1.0 **não** é o pacote de progressão/visual/realtime antes candidato — ver §4.4 para o destino dessas frentes.

A implementação começa somente depois da estabilização/publicação da 1.0.9 e de autorização explícita para abrir o ciclo 1.1.0. Até lá, o trabalho permitido é especificação, auditoria, revisão de requisitos, preparação de testes e organização das dependências — **sem afirmar que loja/checkout já existe**: hoje não existe entidade loja, oferta, estoque comercial ou checkout bilateral; o que existe é o domínio financeiro/patrimonial por personagem (ver auditoria #287).

### 4.1 Contrato de módulos da primeira fatia

Separação explícita aprovada pelo dono (detalhada em `ROADMAP-MUNDO-VIVO-ROLLOUT-1.1X.md` e Issue #288):

- **Internet = loja/oferta/checkout.** Botão independente fora da ficha. Abriga vitrine de lojas, ofertas, preços, estoque comercial, compras, vendas e classificados — usando o dinheiro/ledger, inventário e Acervo existentes, sem carteira paralela.
- **Equipamento/Armazém = patrimônio físico.** Botão independente fora da ficha. Inventário, equipamentos, veículos, itens carregados e itens guardados. **Não é lugar de comprar/vender** — reflete o resultado das operações feitas na Internet.
- **Ficha = campos e regras do personagem.** Atributos, características, talentos, perícias, conhecimentos, habilidades, poderes e demais campos oficiais do template. A ficha deixa de montar o painel de patrimônio inteiro.

### 4.2 Comércio — lojas na Internet (Issue #286, fatia 1.1.0)

- Loja com nome, categoria, localização, proprietário/responsável e estado; ofertas de produtos/serviços apoiadas em templates/Acervo existentes.
- Estoque comercial e caixa/conta da loja **dentro do mesmo domínio financeiro/ledger** — nunca saldo paralelo; titularidade a definir pela auditoria #287 (NPC/personagem vs. entidade nova).
- Compra: debitar comprador, creditar loja, reduzir estoque e entregar item ao inventário do comprador **atomicamente e idempotentemente**; estorno/audit/realtime preservados.
- Administração inicial manual pelo mestre/proprietário; autonomia de NPCs e Jogadores IA fica para fatias posteriores.

### 4.3 Dependências e trilhas da fatia

- **#287 (PAI):** auditoria econômica — contas/ledger/PIX/compra-venda/estorno/Acervo/catálogo/inventário e modelo mínimo de loja/oferta/estoque/caixa/recibo.
- **#290 (PAI):** auditoria patrimonial — extração de Equipamento/Armazém sem duplicar inventário, semântica real de `location`, plano de UI e matriz de regressão.
- **#288 (FILHO):** delta UX — consolidação dos dois botões e wireflows, sem repetir specs aceitas.
- **#289 (INTERMEDIÁRIO):** matriz de testes comercial/extração patrimonial.
- Cada entrega vira PR pequena, independente e testável, com release-alvo explícito.

### 4.4 Fatias 1.1.x posteriores e fora do corte 1.1.0

**Restante do Mundo Vivo:** continua fatiado nas versões 1.1.x posteriores e na integração 2.0, conforme `ROADMAP-MUNDO-VIVO-ROLLOUT-1.1X.md` — Internet diegética expandida (dispositivos, mensagens, contatos), sites/notícias/classificados/redes, empresas e trabalho, NPCs habitantes, Jogadores IA e, por fim, guildas/territórios; a 2.0 integra o ecossistema completo. Nenhuma dessas fatias entra na 1.1.0 sem nova decisão do dono.

**Frentes antes candidatas à 1.1.0, realocadas para fatias posteriores da linha 1.1.x** (não apagadas; reordenar exige decisão explícita):

- **Progressão XP — #185/#284:** estorno auditado de compra de nível, XP por sessão/gancho narrativo e saldo-âncora do Extrato XP.
- **Finalização visual/acessibilidade — #132 (#233/#236/#239):** ícones semânticos, estados vazios ilustrados, carregamento/erro recuperável.
- **Sincronização da campanha — #285:** indicador discreto de conexão/última sincronização.

**Fora de qualquer release sem Issue própria:** funcionalidades já entregues (iniciativa d20, régua, retratos, Mestre Voice, lote/extrato XP integrado, HP/Vitalidade nos tokens) não devem ser reimplementadas; ideias novas viram Issue com aceite e dependências.

### Critério de conclusão da 1.1.0

- A fatia de comércio (#286) entregue na árvore candidata: botões **Internet** e **Equipamento/Armazém** fora da ficha, compra/checkout atômico e idempotente, sem segundo inventário/saldo/ledger, com dados e IDs legados preservados.
- Auditorias #287/#290 concluídas e revisadas; especificações #288/#289 integradas; implementação somente após autorização do dono.
- Testes de domínio, autorização, privacidade, idempotência e regressão executados no SHA final.
- CI Servidor + Navegador + Windows verde no SHA/merge-ref exato, sem SKIP indevido.
- CHANGELOG e artefatos anunciam somente funcionalidades realmente integradas — **nenhum anúncio de loja/checkout antes da implementação existir**.
- Nenhuma mudança na instalação estável 0.8/1.0.8.

## 5. Responsabilidades operacionais

| Integrante | Responsabilidade |
|---|---|
| **Devin — Gerente Operacional de Desenvolvimento** | Manter o roadmap, separar backlog por versão, identificar dependências/sobreposições e cobrar atualização do quadro |
| **Devin — Gerente de Execução** | Abrir/acompanhar sessões reais, distribuir tarefas autorizadas, controlar conflitos de arquivos e cobrar SHAs, PRs e testes |
| **PAI** | Backend, arquitetura, banco, serviços de atualização/recuperação e correções de servidor |
| **FILHO** | Frontend, ficha, experiência de uso, XP UI e extrato |
| **INTERMEDIÁRIO** | Integração, auditoria independente, testes, CI e análise de regressões |
| **ChatGPT — Dono Técnico** | Decidir escopo, arquitetura, regras do RPG, prioridades e critérios de aceite; revisar tecnicamente |
| **Usuário** | Responsável pelo projeto e decisões finais |

A atribuição de uma responsabilidade não prova que uma sessão está ativa. Cada tarefa só deve ser reportada como iniciada quando houver sessão/execução identificável; concluída somente com SHA e evidências.

### 5.1 Carga de trabalho registrada

| Integrante | Frentes atribuídas | Estado/limite |
|---|---|---|
| **Devin — Gerente Operacional** | Auditoria de todas as PRs/Issues abertas por release; manter #204/#274 e este documento coerentes; preparar inventário da distribuição 1.0.9 | Organização e inventário; sem alterar manifests antes da candidata final |
| **Devin — Gerente de Execução** | Abrir e acompanhar sessões reais de PAI/FILHO/INTERMEDIÁRIO; monitorar #279/#280; encadear #265–#273 sem colisão | Registrar sessão real, branch, SHA, CI e bloqueio; não declarar sessões sem prova |
| **PAI** | Auditoria DAG #176→#188→#189; Boot Lock/recuperação; preparação Linux #271; auditorias 1.1.x #287 (economia/lojas) e #290 (Equipamento/Armazém) | Não duplicar a execução W14 #265 nem W16 #266/#280; 1.1.x sem implementação antes da liberação |
| **FILHO** | Regressão UI #279; confirmar XP/extrato já integrado sem recriar #215/#217/#257/#258; UX #185/#284; indicador realtime #285; cadeia visual #233/#236/#239 | 1.1.0 somente especificação/preparação até a estabilização da 1.0.9 e autorização |
| **INTERMEDIÁRIO** | Revisão final #279 e #280; preparação Windows #270; matriz de upgrade #272; auditoria independente de #185/#284/#285 e da cadeia visual #233/#236/#239 | Homologações finais aguardam as dependências de #189/W14/W16; não validar 1.1.0 em SHA antigo |

**Checkpoint consultado:** #279@`951a345` com CI natural 3/3 SUCCESS (run `45108119458`); #280@`a4e0230` com Server/Windows SUCCESS e Browser pendente (run `45109255431`); #189 OPEN/Draft e não mergeable contra main. #265 já tem execução em andamento e não deve ser duplicada. XP lote/extrato está integrado na main.

## 6. Regras de controle de release

1. Toda PR deve declarar no título ou corpo: **Release alvo: 1.0.9** ou **Release alvo: 1.1.0**.
2. Toda Issue deve ter uma única versão-alvo. Itens sem classificação ficam em triagem, não entram em release por inferência.
3. O Gerente Operacional mantém o quadro de escopo; o Gerente de Execução distribui somente tarefas autorizadas e sem colisão.
4. Antes de integrar: conferir base, head, ancestry, diff, migrations, arquivos compartilhados e CI do SHA/merge-ref exato.
5. Teste SKIP, execução auxiliar e CI de SHA antigo não contam como aprovação.
6. Não fazer merge de feature, retarget, promoção de Draft, tag ou GitHub Release sem autorização explícita.
7. A candidata 1.0.9 só pode ser apresentada quando as frentes do escopo ativo estiverem integradas numa árvore única e a CI completa tiver passado nessa árvore.
8. Nenhuma alteração deste plano autoriza mudanças na instalação estável 0.8/1.0.8.

## 7. Resumo executivo

- **0.8 / 1.0.8:** congelada; preservar.
- **0.9 / 1.0.9:** #279 + atualização/recuperação #155/#265–#274. XP em lote/extrato (#213/#277/#217/#257/#258) já está integrado; não duplicar.
- **1.1.0:** primeira fatia do Mundo Vivo — **comércio pela Internet** (lojas/ofertas/checkout bilateral) + botões independentes **Internet** e **Equipamento/Armazém** fora da ficha (#286–#290). XP (#185/#284), visual (#132) e sincronização (#285) foram realocados para fatias 1.1.x posteriores.
- **1.1.0:** ainda não iniciada; somente auditoria, especificação e organização até a 1.0.9 estabilizar e o dono liberar o início. Loja/checkout **não existem** hoje.
- **Mundo Vivo:** subsistemas da 2.0 entregues funcionalmente na linha 1.1.x (ver `ROADMAP-MUNDO-VIVO-ROLLOUT-1.1X.md`); a 2.0 integra o ecossistema completo.
- **Regra permanente:** nenhum item da 1.1.0 autoriza alteração na instalação estável 0.8/1.0.8.
