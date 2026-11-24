# Mestre RPG v1.0.9 — preparação de release

> **ESTADO: RASCUNHO INTERNO. NÃO PUBLICAR, NÃO TAGUEAR E NÃO DISTRIBUIR.**
>
> Documento atualizado em 24/11/2026 com os últimos runs naturais. Não substitui a candidata única, a homologação de upgrade/cutover nem a autorização final do proprietário.

## Identificação planejada

- Versão: `1.0.9`
- Tag planejada: `v1.0.9`
- Release planejada: `Mestre RPG v1.0.9`
- Base atual de reconciliação: `main@7e17c9bca9a893e5f4e05967f91629d0ccddbd0d`
- Versão declarada na base atual: `1.0.8`
- Tag anterior: `v1.0.8`
- Comparação correta: `https://github.com/mestredsl-eng/mestreRPG/compare/v1.0.8...v1.0.9`

A tag final deve apontar **exatamente para o commit final de `main` depois da integração e homologação da candidata 1.0.9**. Nunca apontar para branch de trabalho, HEAD de PR ou merge-ref temporário.

## Conteúdo já integrado à main

Os itens abaixo já estão em `main@7e17c9b` e podem aparecer nas notas finais somente se continuarem presentes no diff/tag final:

- **Pontos de Sangue na ficha configurável** — PR #275 integrada; painel vinculado à ficha configurada.
- **Concessão de XP em lote** — PR #277 integrada; UI usa o backend de lote existente.
- **Extrato de XP e âncora de histórico** — PRs #217, #257 e #258 integradas; extrato somente leitura preserva a âncora quando eventos são truncados.
- **Nomes acessíveis dos seis controles financeiros de Dinheiro** — PR #312 integrada à main por merge commit `7e17c9b`; os nomes acessíveis foram exercitados na matriz #300.

A integração não equivale, sozinha, a aceite de release. O diff final e a CI da candidata única precisam confirmar esses itens.

## Evidência atual das frentes de estabilização

### Boot, atualização e recuperação — PR #308

- HEAD da branch: `9b8c6e6e45745e561a0f6d9bb0114ef01c275ef7`, base `main@7e17c9bca9a893e5f4e05967f91629d0ccddbd0d`.
- CI natural canônica mais recente: `45292451107`, HEAD `9b8c6e6e45745e561a0f6d9bb0114ef01c275ef7`; merge-ref registrado pelo teste Linux: **`193a05755633b62eb57455e15ce10ebacd09616f`**.
- **Windows:** SUCCESS, **19/19 etapas**, zero falhas e zero SKIPs. Inclui build, atualização/restauração, auto-update `npm.cmd` (**118/118**), Boot Lock Node 22 e 20, gate BAT (**21/21**), P10-C real via `cmd.exe` (**25/25**) e restauração fail-closed (**18/18**).
- **Servidor:** SUCCESS, **29/29 etapas**, zero falhas e zero SKIPs. Inclui typecheck/build, 29 suítes obrigatórias, camada adicional #189 e teste Linux de componentes no runner Ubuntu.
- **Linux component-level:** `teste-recovery-linux.mjs` executado em Ubuntu 26.04.1 / Node 22.23.5, **18 passaram / 0 falharam**. Cobriu aquisição/liberação/concorrência do lock, XDG/`MESTRE_STATE_DIR`, migrate fail-closed, SIGKILL real + restart e recusa de escrita em state dir sem permissão. Isso não cria nem homologa um launcher Linux; a camada é de componentes Node.
- **Navegador:** SUCCESS, **15/15 etapas**, sem falhas ou SKIPs; suites obrigatórias Playwright, Extrato XP e concessão XP em lote passaram.
- A correção final do P10-C foi test-only: o sentinela passou a exportar `recuperarAtualizacaoPendente()` para satisfazer o contrato importado pelo avaliador real; não foram removidos nem relaxados asserts.
- **Estado geral da CI #308: 3/3 jobs SUCCESS** (Servidor 29/29, Windows 19/19, Navegador 15/15), sem falhas ou SKIPs. CI técnica fechada no HEAD atual.

### Integridade SQLite e isolamento entre campanhas — PR #316

- HEAD: `0d2a06c471b0e053f13635955dbb53665da5b551`, base `main@7e17c9b`.
- CI natural mais recente `45291323608`: **3/3 SUCCESS** — Servidor 27 etapas, Windows 16 etapas, Navegador 15 etapas; sem falhas e sem SKIPs.
- `teste-integridade-sqlite.mjs`: **89 passaram / 0 falharam**, incluindo F1–F6, as duas rodadas concorrentes PUT × publish (F5), rollback de upload/vínculo, isolamento cross-campaign, auditoria/eventos e reabertura/integrity_check.
- A descrição da PR foi atualizada para retirar a afirmação obsoleta de que faltava teste concorrente F5.
- **Revisão independente ainda pendente:** a única submissão GitHub registrada é `COMMENTED` pelo mesmo usuário do repositório; isso não constitui `APPROVE` independente. Manter Draft até revisão elegível real.
- Limites declarados: ENOSPC global não coberto; sem outbox/reconciliação para falha extraordinária de auditoria pós-commit; compensação física que falhe por segundo erro do filesystem é registrada, mas sem reparação automática neste escopo.

### Acessibilidade e matriz de fluxos — PR #300 / Issue #297

- HEAD: `30b75e90687c707939229395491ab4b03781d83f`, base `main@7e17c9b`.
- CI natural `45286641268`: **3/3 jobs SUCCESS** — Servidor 27, Windows 16 e Navegador 15 etapas; sem falhas ou SKIPs. O workflow Assistente também concluiu SUCCESS.
- Auditor WCAG: 46/46; matriz de fluxos: 204/204; homologação D10 da ficha executada; alvos de ponteiro 36/36; contraste 0 FAIL / 38 REVIEW.
- Os seis nomes acessíveis financeiros corrigidos pela #312 passaram após a sincronização.
- Lacunas restantes da Issue #297: E2E de convites/cadastro (#255) não incluída nesta matriz; estados vazios/loading/erro (#238) não integrados; 38 ocorrências REVIEW ainda exigem disposição humana. Não converter REVIEW em PASS.

### Linux

- A homologação de componentes foi incorporada isoladamente à #308; a branch divergente #311 (108 commits à frente) não foi mesclada.
- No merge-ref `193a05755633b62eb57455e15ce10ebacd09616f`, runner Ubuntu 26.04.1 / Node 22.23.5: **18/18 checks PASS** em Boot Lock, XDG/state externo, migrate fail-closed, SIGKILL/restart e permissão do diretório de estado.
- Isso homologa a camada de componentes Node no Linux. Não existe launcher oficial `.sh`; não anunciar nem pressupor suporte de inicialização Linux por shell.

## Itens condicionais — não anunciar até integrar e homologar

- **Uso narrativo de Poderes na ficha** — PR #279 permanece aberta. Incluir somente se integrada, revisada e testada na candidata.
- **Qualquer entrega Draft/Issue aberta** — não anunciar como concluída sem integração efetiva e evidência no SHA final.

## Gate de publicação — checklist obrigatório

- [ ] Uma única candidata 1.0.9 identificada, base `main`, DAG/diff cumulativo auditado e sem branches empilhadas pendentes.
- [ ] Todas as funcionalidades anunciadas estão no commit candidato; nenhuma Draft ou Issue aberta é apresentada como entregue.
- [x] PR #308: CI natural 3/3 no HEAD `9b8c6e6`; Windows 19/19, Servidor 29/29 (inclui Linux component-level 18/18) e Navegador 15/15, sem falhas ou SKIPs.
- [x] PR #316: CI natural 3/3 no HEAD `0d2a06c`; F1–F6 89/89, sem falhas ou SKIPs. **Revisão independente formal continua pendente.**
- [ ] PR #300: CI 3/3 verde e matriz 204/204; limitar anúncios aos fluxos cobertos. Permanecem convite/cadastro (#255), estados vazio/loading/erro (#238) e 38 REVIEW de contraste sem disposição humana.
- [ ] W14/W16 executados como regressões, preservando banco, arquivos, configuração e backup.
- [x] Homologação Windows real no HEAD #308: Node 22/20, P10-C 25/25 e restauração fail-closed 18/18; a homologação final de cutover 1.0.8→1.0.9 continua separada.
- [x] Homologação Linux component-level em runner Ubuntu 26.04.1 no merge-ref `193a057` (18/18).
- [ ] Upgrade/cutover real de instalação 1.0.8 para a candidata final, com banco, arquivos, backups, campanhas, fichas e progressão preservados.
- [ ] Instalação limpa e build reproduzível de servidor/site.
- [ ] XP em lote e Extrato XP executados na CI da árvore candidata, sem SKIP.
- [ ] Testes de segurança, integridade SQLite, Mesa, ficha/ruleset, acessibilidade e regressões aplicáveis executados no SHA final.
- [ ] `package.json`, `servidor/package.json`, `site/package.json` e `package-lock.json` em `1.0.9`, todos no mesmo commit.
- [ ] `CHANGELOG.md` atualizado somente com funcionalidades integradas e validadas.
- [ ] Versão na API/UI e metadados de backup consistente com `1.0.9`.
- [ ] Pacote/árvore de distribuição revisado para excluir banco, arquivos de usuários, backups, segredos, caches e temporários.
- [ ] CI natural 3/3 na **candidata única que reúna #308 + #316 e o escopo de testes escolhido**, após integração e revisão.
- [ ] Revisões independentes registradas e bloqueadores resolvidos.
- [ ] Autorização final do proprietário para tag/publicação.

## Procedimento de corte — somente depois dos gates

1. Congelar o HEAD final e registrar SHA, diff, migrations, manifests e logs.
2. Confirmar que `main` aponta para o SHA aprovado e que não há commits de release pendentes.
3. Confirmar ausência prévia da tag `v1.0.9`.
4. Atualizar manifests/lockfile/changelog e validar a versão `1.0.9` na mesma árvore candidata.
5. Criar a tag anotada `v1.0.9` no SHA final de `main`.
6. Criar o GitHub Release como **Draft**, título `Mestre RPG v1.0.9`, notas finais e comparação `v1.0.8...v1.0.9`.
7. Conferir que tag e página da release apontam ao mesmo SHA.
8. Publicar somente após autorização final. Não inventar instalador/ZIP: se não houver empacotador oficial homologado, declarar distribuição como código-fonte.

## Histórico e precisão

- A publicação `v1.0.8` existe no GitHub Releases.
- A tag `v1.0.8` aponta para `d1c3155ebbd0e952e1c4fb7119733ee0019db667`; `main@7e17c9b` está além dessa tag e continua declarada como versão 1.0.8.
- A release anterior continha comparação `v1.0.8...v1.0.8`, que não mostra o delta. Não repetir: o link correto para 1.0.9 é `v1.0.8...v1.0.9`.
- Este arquivo continua sendo rascunho interno. Atualizar novamente contra o diff/tag final antes de publicação.