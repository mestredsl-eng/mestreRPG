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

## 4. Versão 1.1.0 — backlog futuro, não iniciado

**Tema:** progressão avançada de XP. Esta versão começa depois da estabilização/publicação da 1.0.9.

Escopo futuro proposto a partir da Issue #185:

1. **Estorno auditado de compra de nível:** evento append-only, autor/motivo, idempotência e validação de pré-requisitos, tetos, exclusividades e níveis dependentes. Nunca simular estorno apagando histórico ou reduzindo saldo sem evento.
2. **XP por sessão ou gancho narrativo:** definir critérios de presença/ausência, personagens participantes e aprovação explícita do mestre. Não conceder XP automaticamente antes de regra aprovada.

### Conflito a resolver antes de qualquer implementação

A Issue #185 também menciona “concessão em lote” como melhoria futura. Porém, o backend #213 e a UI #277 já estão integrados à main; #215 foi supersedida e #217/#257/#258 foram merged.

Portanto, **não criar uma segunda implementação de XP em lote para a 1.1.0**. Antes de mover qualquer requisito adicional, o Gerente Operacional deve comparar o texto da #185 com #213/#215 e registrar se existe requisito funcional realmente diferente. Até essa reconciliação, o item fica marcado como sobreposição, não como entrega aprovada da 1.1.0.

Nenhuma implementação da 1.1.0 está autorizada por este documento. A #185 permanece em especificação/backlog até a conclusão da 1.0.9 e aprovação do Dono Técnico.

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
- **1.1.0:** estorno auditado e XP por sessão/gancho narrativo; backlog futuro, sem implementação autorizada.
- **XP em lote:** backend #213 já existe e sua UI está no plano da 1.0.9; reconciliar a menção antiga da #185 antes de qualquer trabalho adicional.
