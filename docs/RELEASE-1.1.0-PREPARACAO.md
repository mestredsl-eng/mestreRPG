# Mestre RPG v1.1.0 — preparação de release

> **ESTADO: PREPARAÇÃO DOCUMENTAL / NÃO É CANDIDATA. NÃO PUBLICAR, NÃO TAGUEAR E NÃO DISTRIBUIR.**
>
> Atualizado em 25/11/2026, 03:12 BRT. Este documento registra a preparação e os gates ainda pendentes; não substitui a candidata única, a homologação de upgrade nem a autorização final do proprietário.

## Identificação planejada

- Versão planejada: `1.1.0`
- Tag planejada: `v1.1.0`
- Release planejada: `Mestre RPG v1.1.0`
- Tag/release anterior: `v1.0.9`
- `main` no início desta preparação: `cc95eef05aa714607ca3f3c862433ac33264b759`
- Comparação final planejada: `https://github.com/mestredsl-eng/mestreRPG/compare/v1.0.9...v1.1.0`

A tag deve apontar **exatamente para o SHA final aprovado de `main`**, depois de integrar a candidata e executar todos os gates. Nunca apontar para branch de trabalho, HEAD isolado de PR ou merge-ref temporário.

## Escopo que pode entrar nas notas — condicionado à candidata final

As entregas abaixo estão implementadas nas PRs atuais, mas só podem ser anunciadas se permanecerem no diff da candidata final e passarem pelos gates:

- **Internet diegética e gate de acesso:** acesso permitido somente quando `(Computador >= 1 OU Tecnologia >= 1) E (possui Notebook OU possui Celular)`. O backend usa identificadores/templates canônicos do Acervo, valida em cada operação e falha fechado.
- **Comércio por loja:** lojas, gestores vinculados à membership da campanha, ofertas, preços, estoque, caixa próprio da loja e pedidos/recibos. O caixa pertence ao estabelecimento (`character_id NULL` + `shop_id`), não a NPC ou conta pessoal do gestor.
- **LOJA-A:** compra com débito do comprador, crédito no caixa, baixa de estoque, entrega no inventário existente, recibo e ledger na mesma transação.
- **LOJA-B:** venda de item do personagem para a loja, com pagamento ao vendedor, redução do inventário, crédito de estoque, recibo e auditoria na mesma transação.
- **Idempotência e isolamento:** replay seguro por campanha + iniciador + direção + requestId; fingerprint divergente retorna 409; referências de Acervo entre campanhas são recusadas.
- **Realtime protegido:** canal Internet separado da sala OOC da Mesa; inscrição validada no servidor e autorização/titularidade/gate revalidados antes das entregas.
- **Módulos separados da ficha:** Internet e Equipamento/Armazém como pontos de entrada independentes. Equipamento/Armazém é somente leitura neste corte; edição física continua nos fluxos de Patrimônio existentes.

### Fora do corte — não anunciar como entregue

- Serviços/ofertas sem item físico.
- Devolução/estorno C11.
- Marketplace entre personagens.
- Automação comercial de NPCs ou Jogadores IA.
- Edição física dentro do novo Equipamento/Armazém; o módulo atual é de consulta.
- Estados estruturados de carregado/guardado/depósito: `location` continua texto livre.

## Estado real das frentes no início da preparação

### PR #328 — fundação do backend

- HEAD: `b0a8817919c0e225d55d49f55137df179623f035`.
- Base declarada: `main@6f770a204be9dcd0eb67182a697cc1b608dab6b4`.
- CI histórica no HEAD: run `45535825427`, 3/3 SUCCESS.
- A branch está **5 commits atrás** da `main@cc95eef`; portanto a CI histórica não substitui a reconciliação e a nova CI após sincronização.
- Migrations introduzidas: `0036_free_quentin_quire.sql` (lojas, gestores, ofertas, pedidos e rebuild de contas/transações) e `0037_flippant_mordo.sql` (escopo idempotente por iniciador/direção/requestId).
- A migration 0036 reconstrói tabelas financeiras. O tratamento de foreign keys em `migrate.ts` e a verificação `foreign_key_check` são críticos para preservar bancos com contas/transações existentes.

### PR #329 — checkout, gate e realtime

- HEAD: `698035fe0e11e3b04290c153781a8799d6a815fc`, empilhada sobre #328.
- CI atual: run `45557022249`, ainda **IN_PROGRESS** na última leitura.
- Jobs Servidor e Auto-update Windows: SUCCESS no HEAD acima.
- Job Servidor executou `teste-comercio-lojas.mjs`: **127 passaram / 0 falharam** no HEAD acima, incluindo gate, gestão, LOJA-A/LOJA-B, isolamento entre campanhas e regressões transacionais.
- Job Navegador/Playwright ainda estava executando a suíte obrigatória geral. Não contar a PR como 3/3 até terminar.
- **Atenção de autorização:** o diff da PR modifica `.github/workflows/ci.yml` (gatilho da branch base e inclusão da suíte comercial). Esta alteração precisa de revisão/decisão explícita do proprietário; não ampliar nem editar o workflow durante esta preparação.

### PR #327 — interface Internet / Equipamento-Armazém

- HEAD: `0e6233040c48882727370f2a05c7429736d6a58b`, base `main@cc95eef`.
- CI run `45556998995`: **3/3 SUCCESS** no SHA exato.
- O delta de interface inclui administração de lojas, criação/vinculação de gestores, ofertas, preços, estoque, caixa/reserva e revisão de revendas.
- **Lacuna de teste identificada:** não localizei no diff atual um E2E de navegador dedicado aos novos fluxos de Internet/administração de lojas/Equipamento-Armazém. O Playwright verde atual é a regressão geral existente; não prova, sozinho, esses novos fluxos de UI ponta a ponta.

### PR #336 — suíte complementar da Issue #289

- HEAD: `2f27ba0ef6b164946ec97dabe78bbf3a2d4499da`, base #329 em `698035f`.
- O INTERMEDIÁRIO registrou execução local de `node teste-comercio-289.mjs`: **108 passaram / 0 falharam**.
- A execução de 108/108 é evidência local declarada, não CI.
- O único workflow visto nesse SHA foi o Assistente de Desenvolvimento; ele não executa a suíte de comércio.
- Antes do aceite, decidir como garantir que os casos adicionais da #336 façam parte da validação repetível: integrar a suíte em CI mediante autorização específica para workflow, ou portar os casos distintos e críticos para a suíte `teste-comercio-lojas.mjs` que já está ligada ao CI. Não registrar 108/108 como CI.

### Revisões e responsáveis

- Não há revisões formais submetidas nas PRs #327, #328, #329 e #336 na última consulta; todas continuam Draft.
- Comentários de revisão técnica são evidência de análise registrada, mas não equivalem a uma submissão GitHub `APPROVED`.
- Não confundir comentários/instruções nos PRs com dispatch confirmado de agentes externos.

## Preparação de versão e documentação — ainda não aplicada

O `main` atual ainda declara `1.0.9` em todos os manifests verificados:

- `package.json`
- `servidor/package.json`
- `site/package.json`
- `package-lock.json` (raiz e workspaces)

O `CHANGELOG.md` ainda tem `[Unreleased]` vazio. O README ainda destaca a versão 1.0.8, sem uma seção de destaques 1.1.0. Nenhum desses arquivos foi alterado por esta preparação.

Na candidata final, fazer em um único corte coerente:

1. Bump dos três `package.json` e de todas as entradas de versão correspondentes no `package-lock.json` para `1.1.0`; conferir igualdade entre raiz, servidor, site e lock.
2. Atualizar `CHANGELOG.md` com a seção 1.1.0, usando apenas funcionalidades integradas e testadas; não anunciar itens fora do corte.
3. Atualizar o README com os destaques da 1.1.0 e preservar instruções operacionais corretas.
4. Atualizar a versão exibida pela aplicação/metadados de backup (a versão lida do manifesto raiz deve refletir 1.1.0).
5. Acrescentar uma entrada idempotente à Central de Novidades, seguindo o padrão das migrations de release anteriores. A próxima numeração após 0037 é 0038; usar ID estável e `INSERT OR IGNORE`, incluir no journal e testar que o seed não duplica.
6. Criar runbook específico de upgrade `v1.0.9 → v1.1.0`, cobrindo backup íntegro, parada do servidor, migração, verificação de integridade/FKs, health/login e plano de rollback.

## Gates técnicos obrigatórios antes de tag

- [ ] Sincronizar #328 com a `main` atual, preservar o histórico e executar CI no HEAD sincronizado.
- [ ] Concluir CI 3/3 da #329 no SHA exato `698035f` ou em SHA posterior revisado; servidor, Windows e Playwright precisam terminar SUCCESS.
- [ ] Resolver e registrar a decisão do proprietário sobre o delta existente de `.github/workflows/ci.yml` na #329.
- [ ] Integrar #328 → #329 → #327 na candidata; confirmar DAG, bases, diff cumulativo e ausência de mudanças inesperadas.
- [ ] Decidir o destino da #336 e garantir que os casos adicionais relevantes não fiquem apenas como execução local não repetível.
- [ ] Adicionar E2E de navegador dos fluxos novos: gate/estado sem dispositivo; entrar na Internet; vitrine; criar/editar loja; permissões mestre/gestor/não-gestor; oferta inativa não comprável; ativar/precificar revenda; LOJA-A/LOJA-B pela UI; recibo/histórico; Equipamento/Armazém sem compra/venda; desktop/mobile; OOC intacto.
- [ ] Testar migration 0036 + 0037 a partir de uma fixture **exata da tag v1.0.9**, com contas e transações financeiras populadas. Confirmar backup pré-migration, preservação de IDs/saldos/transações, `foreign_key_check` sem violações e inicialização do servidor.
- [ ] Cobrir também banco vazio e fixture com patrimônio/inventário/equipamentos/veículos, export/import/restore de lojas e contas vinculadas.
- [ ] Executar regressão da carteira/ledger e APIs patrimoniais legadas; testar concorrência do último item, retry, requestId divergente, rollback injetado e nenhuma mutação parcial nas negativas.
- [ ] Testar seed de novidades 1.1.0 duas vezes sem duplicar e conferir que a Central exibe a versão correta.
- [ ] Fazer `npm ci`, typecheck/build servidor+site, instalação limpa e smoke na candidata final; sem SKIP silencioso.
- [ ] Executar CI natural em `main` no SHA final: jobs Servidor, Navegador/Playwright, Windows e workflows complementares aplicáveis; registrar cada run, SHA, resultado e logs.
- [ ] Revisar o diff final contra `v1.0.9`; confirmar que nenhum recurso fora do corte aparece anunciado.
- [ ] Conferir árvore de distribuição: código-fonte apenas. Não anunciar ZIP instalável nem instalador próprio sem artefato homologado.

## Issues vinculadas — fechar somente após prova final

- **#286:** épico/roadmap Mundo Vivo 1.1.x. Deve permanecer aberto para as próximas entregas 1.1.x.
- **#287:** auditoria da economia/Acervo; encerrar quando a entrega vinculada estiver integrada e a auditoria reconciliada.
- **#288:** UX da separação Internet / Equipamento-Armazém; encerrar após aceite da UI e suas regressões.
- **#289:** matriz de testes comerciais; manter aberta até os casos requeridos estarem executáveis e repetíveis no pipeline aprovado.
- **#290:** auditoria de extração patrimonial; encerrar após validar preservação e regressões na candidata.

PR #338 (Community Standards) e PR #340 (documentação de rate limiting) são frentes documentais separadas e não devem ser tratadas como requisito de publicação da 1.1.0.

## Procedimento de corte e publicação — não executar ainda

1. Criar uma única candidata `release/1.1.0-candidata` a partir de `main` depois da integração das PRs aprovadas; usar merges normais e registrar os SHAs.
2. Aplicar versão, changelog, README, migration da Central de Novidades e runbook na mesma árvore candidata.
3. Rodar os gates técnicos na candidata final e depois confirmar que `main` aponta para o SHA aprovado.
4. Confirmar que a tag `v1.1.0` ainda não existe.
5. Criar a tag anotada `v1.1.0` **no SHA final de main**.
6. Criar a página GitHub Release como **Draft**, título `Mestre RPG v1.1.0`, comparação correta `v1.0.9...v1.1.0`.
7. Conferir se tag e release apontam ao mesmo SHA; revisar notas, migrations e ausência de dados/segredos.
8. Distribuição: código-fonte do GitHub. A release v1.0.9 não tinha assets e não há workflow de release/empacotamento na lista de workflows consultada; não inventar binários.
9. Publicar a release somente após autorização final explícita do proprietário.

## Limites desta preparação

- Esta PR é exclusivamente documental.
- Não altera manifests, lockfile, changelog, README, migrations, código de produto ou workflows.
- Não cria tag, release GitHub, pacote ou instalador.
- Não faz merge de nenhuma PR da implementação.
- Não acessa nem altera a instalação, banco, arquivos, backups ou servidor local do proprietário.
- Atualizar este documento contra a candidata real antes de usar qualquer checklist como PASS.


## Atualização de reconciliação — 25/11/2026, 03:21 BRT

A `main` avançou de `cc95eef` para `a1522a8c6acf92c41aa5652539c377a947dfba08` enquanto esta preparação era aberta. A comparação de commits confirma que os dois commits novos vieram da PR #340 e só adicionaram `docs/SEGURANCA-RATE-LIMIT-296.md`; não alteraram o código comercial 1.1.0.

Contagens atuais contra `main@a1522a8`:
- #328: 9 à frente / 7 atrás (base histórica `6f770a2`); precisa sincronizar e reexecutar CI.
- #327: 16 à frente / 2 atrás (base `cc95eef`); CI 3/3 verde pertence ao HEAD `0e62330`, não à main atualizada.
- #341 (esta preparação): 1 à frente / 2 atrás; diff contém somente este documento e permanece Draft/mergeável.

A fotografia de CI continua: #327 run `45556998995` SUCCESS 3/3; #329 run `45557022249` ainda IN_PROGRESS na última leitura, com Servidor e Windows SUCCESS e Playwright executando; #336 108/108 local declarado, sem CI da suíte.


## Atualização de CI — 25/11/2026, após 03:21 BRT

O run `45557022249` da PR #329 concluiu **3/3 SUCCESS** no SHA exato `698035fe0e11e3b04290c153781a8799d6a815fc`:
- Servidor — typecheck, build e suítes sem navegador: SUCCESS.
- Auto-update — Windows: SUCCESS.
- Navegador — homologações Playwright: SUCCESS.

O log do job Servidor da mesma execução registra `teste-comercio-lojas.mjs`: **127 passaram / 0 falharam**. Este resultado substitui o estado IN_PROGRESS anotado na fotografia anterior. Permanecem os gates de integração com a main atual, decisão sobre o diff existente de `.github/workflows/ci.yml`, E2E browser específico da nova UI e repetibilidade CI dos testes adicionais da #336.
