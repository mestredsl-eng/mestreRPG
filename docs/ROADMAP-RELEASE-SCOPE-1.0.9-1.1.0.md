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

**Objetivo:** melhorar o uso narrativo de Poderes, entregar progressão XP com interface/extrato e tornar atualização/recuperação segura, preservando dados e backups criados pela 1.0.8.

### 3.1 Sangue/Poderes — extensão do fluxo de ficha

- **PR #279 / Issue #186:** ação narrativa diretamente junto ao Poder já adquirido na ficha; Poderes marcados como exigindo D10 continuam no fluxo de rolagem; validação e cobrança permanecem autoritativas no servidor.
- A PR declara expressamente v1.0.9 no próprio escopo.
- Não reimplementar o ledger de Sangue, o runtime D10 ou o painel já entregues na 1.0.8.
- Aceite: CI completa no SHA final, revisão independente atualizada, retry idempotente, permissões corretas e ausência de regressão do fluxo D10.

### 3.2 Atualização, Boot Lock e recuperação

- **Issue #155 / cadeia #176, #188, #189 e dependências:** atualização segura, serialização do boot, recuperação e proteção dos dados locais.
- **PR #280 / Issue #266 (W16):** leitura e validação de backups legados v1 produzidos pela 1.0.8, sem rejeitá-los na atualização para 1.0.9.
- **PR #281 / Issue #270:** correção do harness de teste Windows; já foi incorporada à branch da stack de recuperação, não à main. É suporte de teste dessa cadeia, não funcionalidade isolada da release.
- A #280 permanece empilhada sobre a branch de recuperação; não deve ser mesclada diretamente na main sem reconciliar primeiro a árvore #155.
- Aceite: testes de contrato de backup executados (não SKIP), provas de integridade e preservação do último backup válido, Windows/Node suportados, CI completa no SHA final e revisão independente.

### 3.3 Progressão XP — interface e extrato

- **Backend #213:** já existente na linha principal; reutilizar. Não criar tabela, endpoint ou ledger paralelo.
- **PR #215:** interface de concessão de XP em lote.
- **PR #217:** extrato/histórico de XP.
- **PRs #257 e #258:** âncora/saldo de abertura do extrato e compatibilidade associada.
- Consolidar as frentes numa árvore consumidora coerente e executar a CI canônica no merge-ref final.
- Aceite: mestre-only, autorização por campanha/personagem, atomicidade, idempotência, auditoria, realtime, mobile e testes reais de UI/API.

### 3.4 Fora do corte 1.0.9

PRs independentes de auditoria visual, CSS/acessibilidade, convites, autorizações e HP manual em tokens não entram automaticamente. Só podem ser adicionadas após decisão explícita de escopo e avaliação de risco.

## 4. Versão 1.1.0 — backlog futuro, não iniciado

**Tema:** progressão avançada de XP. Esta versão começa depois da estabilização/publicação da 1.0.9.

Escopo futuro proposto a partir da Issue #185:

1. **Estorno auditado de compra de nível:** evento append-only, autor/motivo, idempotência e validação de pré-requisitos, tetos, exclusividades e níveis dependentes. Nunca simular estorno apagando histórico ou reduzindo saldo sem evento.
2. **XP por sessão ou gancho narrativo:** definir critérios de presença/ausência, personagens participantes e aprovação explícita do mestre. Não conceder XP automaticamente antes de regra aprovada.

### Conflito a resolver antes de qualquer implementação

A Issue #185 também menciona “concessão em lote” como melhoria futura. Porém, o backend de concessão em lote #213 já existe na main e a interface/extrato #215/#217 estão no escopo da 1.0.9.

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
- **0.9 / 1.0.9:** #279 + atualização/recuperação #155/#266 + XP UI/extrato #215/#217/#257/#258; é o único corte ativo.
- **1.1.0:** estorno auditado e XP por sessão/gancho narrativo; backlog futuro, sem implementação autorizada.
- **XP em lote:** backend #213 já existe e sua UI está no plano da 1.0.9; reconciliar a menção antiga da #185 antes de qualquer trabalho adicional.
