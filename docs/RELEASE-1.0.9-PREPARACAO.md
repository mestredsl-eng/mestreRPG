# Mestre RPG v1.0.9 — preparação de release

> **ESTADO: RASCUNHO INTERNO. NÃO PUBLICAR, NÃO TAGUEAR E NÃO DISTRIBUIR.**
>
> Este documento prepara o corte da release. Ele não substitui a candidata única, os gates de CI, a homologação de upgrade nem a autorização final do proprietário.

## Identificação planejada

- Versão: `1.0.9`
- Tag planejada: `v1.0.9`
- Release planejada: `Mestre RPG v1.0.9`
- Base de preparação consultada: `main@a9585225ffb7b1a59d475d5f8a965692fe963fb7`
- Versão declarada nessa base: `1.0.8`
- Tag anterior: `v1.0.8`
- Link de comparação a usar na publicação: `https://github.com/mestredsl-eng/mestreRPG/compare/v1.0.8...v1.0.9`

A tag final deve apontar **exatamente para o commit final de `main` depois do merge da candidata 1.0.9**. Nunca apontar para uma branch de trabalho, HEAD de PR ou merge-ref temporário.

## Conteúdo confirmado na linha de desenvolvimento

Os itens abaixo foram encontrados integrados à `main` de preparação e podem entrar nas notas finais, desde que permaneçam no diff/tag final:

- **Pontos de Sangue na ficha configurável** — PR #275 integrada. O painel compacto é vinculado ao campo configurado da ficha; não cria uma segunda seleção de Poderes nem um fluxo paralelo de ativação.
- **Concessão de XP em lote** — PR #277 integrada. A UI utiliza o backend de lote já existente; não duplica tabela, endpoint ou migration.
- **Extrato de XP e âncora de histórico** — PRs #217, #257 e #258 integradas. O extrato é somente leitura e preserva a referência do saldo quando a janela de eventos é truncada.

A integração não equivale, sozinha, a aceite de release: os testes dessas entregas ainda precisam ser identificados na CI natural da candidata final.

## Itens condicionais — não anunciar até integrar e homologar

- **Uso narrativo de Poderes na ficha** — PR #279 está aberta. Só incluir se for integrada e passar pela CI/revisão exigidas.
- **Atualização/Boot Lock/recuperação** — PR #308 está aberta. A cobertura W14/W16 e BAT já tem regressões verdes, mas P10-C real no launcher e recuperação durável após crash do atualizador continuam bloqueadores conhecidos.
- **Homologação Linux** — Issue #271 / PR #311: harness preparado, mas ainda sem evidência de execução Linux real em runner versionado. Não chamar execução Windows ou build isolado de PASS Linux.
- **Acessibilidade dos controles financeiros** — PR #312 está aberta/Draft; a CI 3/3 e a composição de validação #313 (161/161, sem falhas) não significam que a correção já está integrada. #313 é PR temporária de verificação e não deve ser incorporada.
- **Integridade SQLite e isolamento entre campanhas** — PR #316 está aberta/Draft; precisa CI natural completa no SHA final, revisão independente e fechamento da lacuna declarada do teste determinístico PUT × publicação.
- **Upgrade real 1.0.8 → 1.0.9** — Issue #272 tem evidência local positiva de banco/migration/restore, mas o cutover completo pelo launcher novo e a execução na árvore final permanecem pendentes.

## Gate de publicação — checklist obrigatório

- [ ] Uma única PR candidata 1.0.9 identificada, com base `main`, DAG de integração e diff cumulativo auditado.
- [ ] Todas as funcionalidades anunciadas estão efetivamente no commit candidato; nenhuma Draft ou Issue aberta aparece como entregue.
- [ ] Stack de update/recuperação aprovada: Boot Lock, P10-C pelo launcher real, journal durável e retomada após crash cobertos.
- [ ] W14 e W16 executados como regressões, com preservação comprovada de banco, arquivos, configuração e backup.
- [ ] Homologação Windows real no SHA final.
- [ ] Homologação Linux real em runner versionado, ou decisão explícita de escopo documentada pelo proprietário antes de considerar a release.
- [ ] Upgrade/cutover de uma instalação 1.0.8 para a candidata final, com banco, arquivos, backups, campanhas, fichas e progressão preservados.
- [ ] Instalação limpa e build reproduzível de servidor/site.
- [ ] Testes de XP em lote e Extrato XP executados na CI da árvore candidata, sem SKIP.
- [ ] Testes de segurança, integridade SQLite, Mesa, ficha/ruleset, acessibilidade e regressões aplicáveis executados no SHA final.
- [ ] `package.json`, `servidor/package.json`, `site/package.json` e `package-lock.json` em `1.0.9`, todos no mesmo commit.
- [ ] `CHANGELOG.md` atualizado somente com funcionalidades integradas e validadas.
- [ ] Versão apresentada por API/UI e metadados de backup consistente com `1.0.9`.
- [ ] Pacote/árvore de distribuição revisado para excluir banco, arquivos de usuários, backups, segredos, caches e temporários.
- [ ] CI natural completa 3/3 (Servidor, Windows e Navegador) no SHA/merge-ref exato da candidata.
- [ ] Revisões independentes registradas e bloqueadores resolvidos.
- [ ] Autorização final do proprietário para tag/publicação.

## Procedimento de corte — somente depois dos gates

1. Congelar o HEAD final e registrar SHA, diff, migrations, manifests e logs.
2. Confirmar que `main` aponta para o SHA aprovado e que não há commits de release pendentes.
3. Confirmar ausência prévia da tag `v1.0.9`.
4. Criar a tag anotada `v1.0.9) no SHA final de `main`.
5. Criar o GitHub Release como **Draft** com o título `Mestre RPG v1.0.9`, notas finais e comparação `v1.0.8...v1.0.9`.
6. Conferir que a tag e a página da release apontam ao mesmo SHA.
7. Publicar a GitHub Release somente após autorização final. Não inventar instalador/ZIP: a auditoria anterior não identificou empacotador oficial; declarar claramente se a distribuição é apenas código-fonte ou se um pacote foi produzido e homologado.

## Histórico e correções de precisão

- A publicação `v1.0.8` já existe em GitHub Releases.
- A tag `v1.0.8` aponta para `d1c3155ebbd0e952e1c4fb7119733ee0019db667`; a `main` de preparação está 43 commits à frente. Essa diferença deve ser interpretada junto ao escopo pós-.8, não como autorização para etiquetar o HEAD atual como .9.
- A release anterior contém um link de comparação `v1.0.8...v1.0.8`, que não mostra o delta de .8. Não repetir esse erro: o link correto para .9 é `v1.0.8...v1.0.9`.
- As notas finais devem ser conferidas contra o diff da tag; este arquivo é apenas uma preparação e não é texto aprovado para publicação.
