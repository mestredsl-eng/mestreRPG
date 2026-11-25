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


## Divisão de trabalho registrada — 25/11/2026

As frentes foram separadas para reduzir trabalho duplicado e evitar sobreposição de arquivos:

| Responsável de projeto | Frente | Entrega solicitada |
|---|---|---|
| PAI | PR #328 | Sincronizar a fundação com main, auditar migrations 0036/0037 em fixture financeira 1.0.9 e registrar CI do SHA final |
| FILHO | PR #327 | Sincronizar UI e acrescentar E2E de navegador para Internet/gestão/Equipamento-Armazém em suíte já executada pelo workflow |
| INTERMEDIÁRIO | PR #336 | Comparar semanticamente a suíte de 108 asserts com os 127 da #329 e documentar apenas lacunas reais |
| Devin | Issue/épico #286 | Coordenar DAG, revisar migrations/contratos, conferir evidências exatas e manter o quadro de bloqueios atualizado |

Os pedidos estão registrados em comentários nas PRs/Issue. Isso constitui uma divisão de trabalho documentada, **não comprova que sessões externas dos agentes já iniciaram ou concluíram as tarefas**. Não há assignees/reviewers formais registrados no GitHub para essas PRs.

O Dono Técnico mantém somente a coordenação, reconciliação de estado e preparação da release, evitando alterar branches de implementação que pertencem às frentes acima. Nenhuma ordem permite modificar `.github/workflows/ci.yml`, mesclar, retarget, publicar tag/release ou iniciar escopo 1.1.1.


## Atualização de estado — 25/11/2026 (reconciliação mais recente)

Esta seção substitui as fotografias anteriores quando houver divergência de status. A `main` verificada agora é `f6979f48e5fff68a1ec4fedc72a5c48e1b3cdc55`.

### Estado por SHA e CI

- **#327 — UI:** HEAD `f84ea9b82321fe15101ab1947120a7fa024ba5f3`, sincronizada com a main atual por merge normal. Run `45564318683`: **3/3 SUCCESS** (Servidor, Windows e Navegador). O FILHO reportou `teste-internet-e2e.mjs` com **31/31 PASS local** contra o stack #328/#329. Esse arquivo permanece no PR, mas não está wired na CI; a CI verde atual ainda não executa essa jornada integrada. O wiring só deve ocorrer quando o backend estiver em main e após decisão/autorização sobre workflow.
- **#328 — fundação:** HEAD `e82b5cc8c7e9cd0b9361bd8b08237f87174564a4`, sincronizada com a main atual. Run `45564997816`: **3/3 SUCCESS** (Servidor, Windows e Navegador). PAI reportou auditoria manual one-off de fixture 1.0.9 (36 migrations, 3 contas e 6 transações preservadas por comparação canônica, `foreign_key_check` 0). **Ressalva:** o teste versionado `teste-bat-adocao-legado-boot.mjs` ainda constrói fixture **1.0.8** (34 migrations, 1 conta e 2 transações). A prova exata 1.0.9 ainda precisa virar regressão reproduzível na CI; ordem registrada em #328.
- **#329 — implementação backend:** HEAD continua `698035fe0e11e3b04290c153781a8799d6a815fc`; run `45557022249` foi **3/3 SUCCESS**, com **127/127** na suíte comercial. Entretanto, a branch é baseada no HEAD antigo da #328 (`b0a8817`) e está **11 commits atrás** do HEAD atual #328 (`e82b5cc`); precisa de merge normal da fundação atual e CI nova. A PR também contém delta em `.github/workflows/ci.yml`, cuja aceitação requer decisão explícita do proprietário. PAI recebeu tarefa para sincronização e correção/teste do achado L2 abaixo.
- **#336 — testes complementares:** HEAD `2f27ba0ef6b164946ec97dabe78bbf3a2d4499da`; execução local reportada **108/108**, não CI. A revisão semântica concluiu que a união das suítes cobre a matriz principal, mas registrou L1–L5: corrida do último item LOJA-B (média), fan-out durante barreira de restauração (média), venda em loja fechada (baixa), unsubscribe voluntário (baixa) e payload malformado de inscrição (baixa). L2 foi confirmado por inspeção estática em `emitirComercioInternet`: não consulta `barreiraRestauracaoAtiva` antes/depois dos awaits, ao contrário de `emitirPrivadoCampanha`. INTERMEDIÁRIO recebeu ordem para os testes L1/L3/L4/L5; PAI recebeu L2 na #329.
- **#341 — preparação:** continua Draft e documental. Não é candidata de release.

### Próximas provas exigidas

1. #328: commitar regressão automatizada exata de upgrade v1.0.9 com 3 contas/6 transações, preservação integral, backup e FK/integrity checks; a prova one-off não substitui CI.
2. #329: integrar #328@e82b5cc por merge normal; resolver L2 com teste determinístico durante restauração; executar CI no novo HEAD.
3. #336: executar os testes L1/L3/L4/L5 e reportar resultados por SHA, separando testes locais de CI.
4. #327: manter E2E 31/31 identificado como local até poder executá-lo contra a stack integrada; não ligar step na CI antes de o backend estar em main e do aceite do workflow.
5. Após a integração backend → UI, validar DAG/diff cumulativo e executar teste E2E integrado na candidata.

### Ordens recentes e limites

- Comentário #328 `7155850015`: regressão automatizada de 1.0.9.
- Comentário #329 `7155835610`: merge da #328 atual e L2 com teste de restauração.
- Comentário #336 `7155836254`: L1/L3/L4/L5.
- Comentário #286 `7155836977`: coordenação do DAG e atualização dos bloqueios.
- Essas são tarefas registradas no GitHub; só commits, logs/CI e evidência reproduzível comprovam entrega.

A versão 1.1.0 permanece **não candidata**. Nenhuma integração, promoção de Draft, mudança de workflow, tag ou release está autorizada por esta atualização.


## Atualização de execução — 25/11/2026 (novos commits e validação)

### Entregas posteriores à reconciliação anterior

- **#327 / FILHO:** HEAD continua `f84ea9b82321fe15101ab1947120a7fa024ba5f3`; CI natural reportada/consultada como SUCCESS, e o FILHO registrou **31/31 PASS local** em `teste-internet-e2e.mjs`. O arquivo segue sem wiring no job Navegador para evitar falso vermelho antes de o backend entrar em main.
- **#328 / PAI:** HEAD avançou para `76a8f4708b6eabd1211995f4f2ce61d150187d1c`. Foi adicionada regressão em `teste-adocao-legado.mjs` para a fixture exata v1.0.9: 36 migrations, 3 contas e 6 transações. Reportado localmente: 45/45 (30 asserts 1.0.8 + 15 novos 1.0.9) e E2E BAT de 1.0.8 22/22. O teste percorre adoção + backup + migrate até 0037 e confere preservação campo a campo, `shop_id` NULL, FK 0 e integrity ok. A regressão usa a suíte já presente no job Servidor; não houve alteração de workflow nesta entrega.
- **Correção adicional na #328:** a rotina `scripts/adotar-legado.mjs` não reconhecia esquema 1.0.9 de 36 migrations e falhava fechado com `esquema-nao-reconhecido`. PAI adicionou o conjunto válido `ULTIMO_IDX_109=35`; Devin revisou a lógica como correta. Gap de adoção corrigido em código e coberto pela nova fixture.
- **#329 / PAI:** HEAD avançou para `443b497929394512077a3200d24adffa4b2afbf6`, base #328@ `e82b5cc`. A correção L2 em `emitirComercioInternet` agora consulta a barreira de restauração antes do fan-out e revalida imediatamente antes das entregas, falhando fechado se a barreira iniciar no meio da emissão. Teste determinístico reportado localmente **135/135**; Devin revisou o desenho e não encontrou ressalvas.
- **#336 / INTERMEDIÁRIO:** HEAD `62b359e3ab2339614e11b59f65ff4c56db0f1845`, já sincronizado com #329@443b497. Casos L1/L3/L4/L5 foram adicionados à suíte complementar; total **122/122 PASS local**. L1 demonstra atomicidade com um 201 e um erro perdedor, mas o perdedor atual recebe 404 `item_nao_encontrado` quando a linha de inventário já foi removida. PAI foi solicitado a avaliar 409 específico para conflito de concorrência, preservando 404 para ID realmente inexistente.
- **Distribuição das responsabilidades:** PAI recebeu a integração #328@76a8f47 na #329 e a portabilidade dos cenários L1/L3/L4/L5 para `teste-comercio-lojas.mjs`, que já é executado na CI. INTERMEDIÁRIO fará revisão semântica desse port. Nenhum step novo foi solicitado no workflow.

### Runs em andamento no momento desta atualização

- #328 HEAD `76a8f47`: CI run `45571997887` — Servidor, Navegador e Windows ainda **IN_PROGRESS** na última consulta.
- #329 HEAD `443b497`: CI run `45570504599` — Servidor e Windows **SUCCESS**; Navegador ainda **IN_PROGRESS**.
- #327 HEAD `f84ea9b`: run de CI `45564318683` **SUCCESS**; workflow separado Mestre Voice também SUCCESS.
- #336 HEAD `62b359e`: suíte 122/122 local; workflow de Assistente concluiu, mas não executa a suíte de comércio. Não classificar como CI.

### Integração ainda necessária

A #329 está baseada em #328@ `e82b5cc`, enquanto a #328 avançou para `76a8f47`. Compare confirma apenas um commit à frente na #328, contendo arquivos de adoção/teste sem interseção com o código comercial. PAI recebeu ordem para incorporar esse commit por merge normal e repetir a CI. Até a integração e os novos runs terminarem, não existe candidata integrada final.

A decisão do proprietário sobre o delta de workflow já existente na #329 continua pendente e separada. Nenhuma PR foi promovida, mesclada ou publicada por esta atualização.


## Checkpoint de integração — 25/11/2026, 08:05 UTC

- **#328** HEAD `76a8f4708b6eabd1211995f4f2ce61d150187d1c`: migration/adoption 1.0.9 automatizada no arquivo que já pertence à suíte de CI do Servidor. Run `45571997887`: Windows SUCCESS; Servidor ainda em etapa `Suítes da stack`; Navegador ainda em andamento. Não declarar CI completa até o run terminar.
- **#329** HEAD `443b497929394512077a3200d24adffa4b2afbf6`, base #328@ `e82b5cc`: run `45570504599`: Servidor SUCCESS e Windows SUCCESS; Navegador em `Suítes obrigatórias v1.0.8 — Navegador`, ainda em andamento. #329 já contém correção L2, mas ainda **não** contém o novo teste de adoção 1.0.9 da #328.
- **#336** HEAD `62b359e3ab2339614e11b59f65ff4c56db0f1845`, base #329@443b497: 122/122 local. Revisão complementar solicitada para depois do port dos cenários à suíte CI-enabled.
- **#327** HEAD `f84ea9b82321fe15101ab1947120a7fa024ba5f3`: CI reportada como 5/5 SUCCESS, teste dedicado de UI 31/31 local, ainda não wired à CI integrada.
- **main** permanece `f6979f48e5fff68a1ec4fedc72a5c48e1b3cdc55`.

### Sequência coordenada atual

O Devin registrou que a sincronização #328@76a8f47 → #329 deve esperar a CI da #328 terminar, para não mover o HEAD enquanto seus jobs ainda executam. Assim que concluir:
1. PAI incorpora #328@76a8f47 em #329 por merge normal e executa nova CI no resultado.
2. PAI porta cenários L1/L3/L4/L5 para a suíte `teste-comercio-lojas.mjs` já rodando na CI.
3. INTERMEDIÁRIO revisa semanticamente o port.
4. Após CI do backend integrado, sincronizar/testar UI #327 contra a stack e wirear seu E2E somente na fase adequada, sem alterar workflow sem autorização.

L1 segue com comportamento observado: o perdedor da corrida recebe 404 `item_nao_encontrado` quando o vencedor remove a linha de inventário. Atomicidade e ledger estão coerentes segundo a prova local, mas o contrato 404 versus 409 ainda está com o PAI para definição. Não contar L1 como definitivamente fechado até esse ponto ser tratado.

A #329 ainda contém o delta próprio de `.github/workflows/ci.yml` (branch trigger + testes de schema e comércio). A revisão técnica considerou o delta aditivo e sem remoções, mas a aprovação explícita do proprietário ainda não foi registrada. #327/#328/#329/#336/#341 permanecem Draft/open; nenhuma integração foi mergeada em main.



## Checkpoint de execução — 25/11/2026 (após 09:10 BRT)

Esta seção é a fotografia mais recente. Ela substitui os estados anteriores quando houver divergência; não transforma a preparação em candidata.

### Estado comprovado

- **#327 — UI / Internet:** HEAD `e897f06b9024d32a0e864da7ebafd9421e712502`. O FILHO adicionou 10 verificações UI específicas (perda de ponto, dispositivo fantasma, isolamento de caixa/loja, ausência de membership e silêncio realtime pós-revogação). Execução local de `node teste-internet-e2e.mjs`: **41/41 PASS**. A suíte OOC×Internet segue com **29/29 PASS local** no worktree integrado contra #329@\`8931b7e\`. CI run `45582842125`: Servidor SUCCESS e Auto-update Windows SUCCESS; Navegador ainda IN_PROGRESS na última consulta. Não declarar a CI deste novo HEAD fechada.
- **#328 — fundação:** HEAD `76a8f4708b6eabd1211995f4f2ce61d150187d1c`; CI reportada como **5/5 SUCCESS**. A regressão `teste-adocao-legado.mjs` para a fixture exata 1.0.9 (36 migrations, 3 contas e 6 transações) é executada pelo job Servidor e preserva os dados, com FK/integrity checks aprovados.
- **#329 — comércio/backend integrado:** HEAD `8931b7ea829b323edac9acd3dcde842ab3c1523c`, baseada em #328@\`76a8f47\`. CI run `45576590199`: **3/3 SUCCESS** (Servidor, Windows, Navegador). Evidências locais reportadas nesse SHA: comércio 153/153; adoção 45/45; restauração journal 117/117; boot 236/236. L1–L5 foram portados para a suíte executada na CI; o contrato de venda distingue 404 para item inexistente de 409 para item consumido em corrida.
- **#336 — matriz complementar:** HEAD `eea7e0f9ff1afd0fe80ec28b8bc7ef7fb2f00cef`. Revisão semântica confirma o port L1–L5 sem gaps. A classificação seguinte identificou **7 grupos de cobertura ainda não executados pela CI da #329** e os marcou como bloqueadores até port/prova: B1 gate por operação após perda de ponto; B2 resolução canônica de dispositivo; B3 saldo insuficiente/rollback multi-item/corrida LOJA-A; B4 bordas LOJA-B; B5 isolamento de campanha/gestor; B6 revogação realtime/envelope de IDs; B7 não-regressão patrimonial.
- **#341 — este documento:** HEAD anterior `3f4c79a`; PR continua Draft. A base registrada é `main@a1522a8`, enquanto a main atual conhecida é `f6979f4`; a branch documental ainda precisa ser reconciliada com main antes do aceite final.

### Próxima execução — sem ampliar escopo

- **PAI / #329:** recebeu ordem `7157827642` para portar os testes já existentes B1–B7 da #336 para `teste-comercio-lojas.mjs`, que já roda no job Servidor. Não alterar workflow; se algum teste revelar defeito de produto, reportar reprodução antes de mexer na produção.
- **INTERMEDIÁRIO / #336:** recebeu ordem `7157828358` para revisar semanticamente B1–B7 após o port.
- **FILHO / #327:** recebeu ordem `7157829066`; entregou 41/41 locais e auditoria UI dos gaps solicitados. Falta fechar o run de CI do HEAD `e897f06`.
- **PAI / #341:** recebeu ordem `7157830010` para atualizar este checkpoint e reconciliar a documentação. Esta atualização documental foi aplicada pelo Dono Técnico como avanço imediato; o PAI ainda deve confirmar a sincronização da branch documental com main.

### Decisão de prontidão

A 1.1.0 **ainda não é candidata de release**: B1–B7 ainda precisam estar na suíte CI-enabled e passar no CI do SHA final; a CI do HEAD mais recente da UI ainda estava em execução; a documentação precisa ser reconciliada com a main atual. Não promover Draft, mesclar PRs, alterar `.github/workflows/ci.yml`, criar tag ou release sem as autorizações correspondentes.


## Checkpoint de execução — 25/11/2026 (sincronização #341 + estado consolidado)

Ordem `7168039299` (Dono Técnico): merge normal da `main` atual nesta branch documental, preservando diff docs-only, com atualização da fotografia de estado. Executado pelo FILHO.

### Sincronização desta branch

- `docs/release-1.1.0-preparacao` estava baseada em `main@a1522a8` (4 commits atrás). Merge normal de `origin/main@f6979f4` aplicado — **zero conflitos**; o diff vs main permanece exclusivamente `docs/RELEASE-1.1.0-PREPARACAO.md` (docs-only preservado).

### Fotografia de estado verificada (GitHub, ~16:40 UTC)

- **`main`:** `f6979f48e5fff68a1ec4fedc72a5c48e1b3cdc55`.
- **#327 — UI/Internet:** HEAD `e897f06b9024d32a0e864da7ebafd9421e712502`. CI run `45582842125` fechou **5/5 SUCCESS** (Servidor, Navegador, Build, Auto-update Windows, voz). `teste-internet-e2e.mjs` com **41/41 PASS local** no worktree integrado (#329@`8931b7e` + UI) e **29/29** na regressão OOC×D10. Arquivo segue sem wiring no job Navegador — aplicação do step proposto aguarda backend em main + autorização de workflow.
- **#328 — fundação:** HEAD `76a8f4708b6eabd1211995f4f2ce61d150187d1c`; CI **5/5 SUCCESS**. Regressão 1.0.9 versionada (36 migrations, 3 contas, 6 transações) executada no job Servidor.
- **#329 — comércio/backend:** HEAD avançou para `320ee73` — port integral B1–B7 de #336 para `teste-comercio-lojas.mjs` (suíte já CI-enabled); Devin verificou **223 passaram** localmente no estado idêntico ao commit. CI do novo HEAD em andamento na última consulta (Build SUCCESS; Servidor/Windows/Navegador rodando).
- **#336 — matriz complementar:** HEAD `eea7e0f9ff1afd0fe80ec28b8bc7ef7fb2f00cef`; revisão semântica do port B1–B7 aprovada sem gaps.
- **#341 — este documento:** Draft; branch agora sincronizada com `main@f6979f4`.

### Decisão de prontidão (atualizada)

B1–B7 foram portados para a suíte CI-enabled da #329 (`320ee73`) — resta o CI desse SHA fechar SUCCESS. Permanecem pendentes: merge do stack #328→#329→#327 pelo proprietário, wiring do E2E de UI após backend em main, e aceite final. A 1.1.0 **ainda não é candidata de release**. Nenhuma promoção de Draft, merge, alteração de workflow, tag ou release foi realizada nesta atualização.



## Checkpoint de integração pós-merge da fundação — 25/11/2026, 13:47 BRT

Esta fotografia substitui os estados anteriores quando houver divergência. A integração da fundação #328 foi autorizada e concluída; os próximos passos continuam condicionados à CI e à decisão explícita do proprietário sobre o delta do workflow da #329.

### Estado confirmado no GitHub

- **main:** `48aeb1e2c0773da049a7450ca4dac7de618c8d71` — merge normal da PR #328, com migrations 0036/0037, adoção 1.0.9 e testes de schema.
- **#328:** merged em `48aeb1e`. CI do HEAD `76a8f47`: Servidor, Navegador e Windows SUCCESS.
- **#329:** HEAD `320ee73caff7d3340a53591232d5a4fea17063ad`, agora direcionada a `main@48aeb1e`, Draft e mergeable. Port B1–B7 adicionou 70 asserts à suíte `teste-comercio-lojas.mjs`, total **223/223**. O log do job Servidor da CI run `45654682237` confirma **223 passaram, 0 falharam**; build/typecheck, Servidor e Windows estão SUCCESS. O job Navegador ainda está IN_PROGRESS; não declarar CI 3/3 até terminar.
- **B1–B7:** os sete grupos exigidos pela matriz #336 estão agora na suíte executada pelo job Servidor: gate por operação, dispositivo canônico, saldo/rollback/concorrência LOJA-A, bordas LOJA-B, isolamento campanha/gestor, revogação/envelope realtime e não-regressão patrimonial. Devin executou também o estado de teste correspondente localmente (223/223). A #336 continua como suíte complementar/histórica; não é necessário adicionar outro step de workflow para esses grupos.
- **#327:** HEAD `e897f06`; CI run `45582842125` fechou 5/5 SUCCESS nesse SHA. Homologação integrada reportada localmente: `teste-internet-e2e.mjs` 41/41 e `teste-mesa-d10-e2e.mjs` 29/29. Esses dois resultados são locais, não CI. Após o merge de #328, esta PR ainda precisa ser validada contra a nova main/backend final; o E2E específico da Internet continua sem wiring na CI.
- **#341:** HEAD `5a0ddf9`, diff exclusivo de documentação, mas o checkpoint de sua branch ainda usa `main@f6979f4`; a main atual avançou para `48aeb1e`. A CI run `45654951420` tem Servidor e Windows SUCCESS; Navegador IN_PROGRESS. Reconciliar a branch documental com a main atual e atualizar a fotografia novamente após a integração final.

### Decisões e gates ainda abertos

1. **Delta de workflow da #329:** a PR contém 19 linhas aditivas em `.github/workflows/ci.yml`: inclui a branch base da stack no gatilho e executa o teste de schema e a suíte de comércio. O delta preserva os steps existentes, e o job Servidor confirmou a execução 223/223. Ainda assim, a regra do projeto exige autorização explícita do proprietário para alterar workflow. Não mesclar #329 antes dessa autorização e da CI 3/3 no SHA testado.
2. **Interface:** depois de #329 entrar em main, revalidar #327 na base atual e decidir/autorização para ligar `teste-internet-e2e.mjs` ao job Navegador. O step foi preparado, mas ainda não está no workflow.
3. **Corte de versão:** a main ainda usa versão `1.0.9` nos manifests; `CHANGELOG.md` permanece com `[Unreleased]` vazio. Ainda faltam bump coerente de manifests/lockfile, destaques no README e Changelog, migration idempotente 0038 para Central de Novidades, runbook de upgrade 1.0.9→1.1.0 e homologação desses artefatos na candidata.
4. **Candidata/release:** após integração backend → UI e os gates da versão, criar uma única candidata a partir da main, executar CI no SHA exato, revisar o diff contra v1.0.9 e então preparar tag/release. Não existe candidata final ainda.

Nenhuma tag ou GitHub Release foi criada. A PR #328 foi a única mesclada nesta etapa; #329, #327 e #341 continuam Draft/open. Não declarar a 1.1.0 pronta para distribuição até fechar os gates acima.


## Checkpoint final pós-#328 — 25/11/2026 (FILHO, ordem `7168616208`)

### Sincronização e CI desta branch

- HEAD: `62a05c1` (merge de `main@48aeb1e` pós-#328 + docs `2d2c8c6`), 0 commits atrás de main, diff exclusivo do documento.
- CI run `45658087334` no SHA `62a05c1`: **SUCCESS** (Build e relatório, Servidor, Navegador e Auto-update Windows — todos completed/success).

### Estado final das frentes (verificado no GitHub)

- **#328 — fundação:** MERGEADA em main (`48aeb1e`). Regressão 1.0.9 versionada na CI.
- **#329 — comércio/backend:** HEAD `320ee73` (base agora `main`, pós-retarget). Port B1–B7 para `teste-comercio-lojas.mjs` — **223 asserts** verificados localmente por Devin; o job Servidor da CI executa essa suíte. Na última consulta o CI do SHA `320ee73` estava em andamento (Build SUCCESS; Servidor/Navegador/Windows rodando) — não declarar fechado.
- **#327 — UI:** HEAD `b966e33` (sync pós-#328). CI do HEAD reportada SUCCESS nos checks consultados. Re-homologação FILHO no worktree integrado `#329@320ee73 + #327@b966e33` (HEAD `1423f35`, merge limpo): `teste-internet-e2e.mjs` **41/41 PASS** e `teste-mesa-d10-e2e.mjs` **29/29 PASS** — ambas **locais**, não CI; o arquivo E2E de UI permanece sem wiring até autorização separada.
- **#336 — matriz complementar:** HEAD `efa36d0` (propagado `320ee73`); revisão do port B1–B7 **aprovada, matriz completa**.

### Prontidão

A fundação 1.1.0 está em main; restam #329 (CI do HEAD em fechamento) e #327 (aguarda merge do backend + wiring do E2E). A 1.1.0 **ainda não é candidata de release** até #329 mergear, a CI final fechar e a ordem de merge ser executada. Nenhuma promoção, merge, workflow, tag ou release nesta atualização.
