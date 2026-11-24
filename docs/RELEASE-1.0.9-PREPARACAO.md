# Mestre RPG v1.0.9 — preparação de release

> **ESTADO: RASCUNHO INTERNO. NÃO PUBLICAR, NÃO TAGUEAR E NÃO DISTRIBUIR.**
>
> Documento atualizado em 24/11/2026 às 12:48 BRT. Os estados de CI abaixo estão vinculados aos SHAs atuais; jobs ainda em execução não contam como PASS. Não substitui a candidata única, a homologação de upgrade/cutover nem a autorização final do proprietário.

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

- HEAD atual da branch: `c2842b588f76327183a109f670acd5b37d7f96a2`, base `main@7e17c9bca9a893e5f4e05967f91629d0ccddbd0d`.
- Run natural atual: `45426615734`, no HEAD `c2842b5`. **Windows SUCCESS (19/19 etapas); Servidor SUCCESS (29/29); Navegador IN_PROGRESS** na última leitura de 24/11/2026 12:48 BRT. Portanto, ainda não há 3/3 no HEAD atual.
- Os resultados anteriores do run `45292451107` pertencem ao HEAD anterior `9b8c6e6`; continuam como histórico/regressão, mas não substituem a CI do SHA atual.
- **Windows atual:** 19/19 etapas, sem falhas; a homologação de atualização/restauração executou **29/29**. O run anterior também cobriu auto-update `npm.cmd` (118/118), Boot Lock Node 22 e 20, gate BAT (21/21), P10-C via `cmd.exe` (25/25) e restauração fail-closed (18/18).
- **Servidor atual:** 29/29 etapas, sem falhas; typecheck/build e as suítes obrigatórias concluíram. O log inclui P10-C gates (**54/54**) e documentação operacional (**12/12**).
- **Navegador:** ainda em execução; não marcar como PASS até o job terminar com conclusão SUCCESS no mesmo SHA.
- **Linux component-level:** no run anterior `45292451107`, `teste-recovery-linux.mjs` passou **18/18** em Ubuntu 26.04.1 / Node 22.23.5: lock, XDG/`MESTRE_STATE_DIR`, migrate fail-closed, SIGKILL/restart e permissão do diretório de estado. Isso não cria nem homologa launcher Linux; são testes de componentes Node.

### Integridade SQLite e isolamento entre campanhas — PR #316

- HEAD atual: `887ced30e3bd6504ea15947c3e944ced8b3bce89`, base `main@7e17c9b`.
- Run natural atual: `45428706739`, no HEAD `887ced3`. **Windows SUCCESS (16 etapas); Servidor e Navegador IN_PROGRESS** na última leitura de 24/11/2026 12:48 BRT. Não contar a CI anterior como aceite do patch novo.
- Histórico: no SHA anterior `0d2a06c`, a suíte SQLite executou **89/89** e a CI fechou 3/3. Esse resultado não inclui a correção F4 abaixo nem os dois asserts novos.
- **F4 corrigido no HEAD atual, aguardando CI:** o UPDATE do template-alvo agora filtra por `id + campaignId`, exige `changes === 1` dentro da transação e responde 409 com rollback quando o alvo fica indisponível. A suíte acrescentou SQLite `RAISE(IGNORE)` para provar que a limpeza do default anterior é revertida quando o UPDATE final afeta zero linhas.
- **Revisão independente ainda pendente:** a única submissão formal existente é `COMMENTED` pelo mesmo usuário autor; não equivale a `APPROVE` independente. Manter Draft até revisão elegível real.
- O índice parcial único de F4 permanece decisão separada; nenhuma migration ou alteração de dados legados foi executada. O serviço agora fecha o caso de zero linhas, mas não declarar garantia schema-level sem a decisão e a constraint correspondentes.
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
- **Issue #294 / PR #316:** a antiga PR de diagnóstico #306 continua aberta/Draft sobre base antiga `a958522`; a suíte atualizada e as correções de produção estão em #316. Tratar #306 como supersedida; não integrar ambas em paralelo.

## Gate de publicação — checklist obrigatório

- [ ] Uma única candidata 1.0.9 identificada, base `main`, DAG/diff cumulativo auditado e sem branches empilhadas pendentes.
- [ ] Todas as funcionalidades anunciadas estão no commit candidato; nenhuma Draft ou Issue aberta é apresentada como entregue.
- [ ] PR #308 no HEAD atual `c2842b5`: Windows 19/19 e Servidor 29/29 SUCCESS; Navegador ainda IN_PROGRESS no run `45426615734`. Os 3/3 anteriores pertencem ao SHA antigo `9b8c6e6`.
- [ ] PR #316 no HEAD atual `887ced3`: Windows SUCCESS; Servidor e Navegador IN_PROGRESS no run `45428706739`. O resultado 89/89 é do SHA anterior `0d2a06c`; a regressão F4 `RAISE(IGNORE)` ainda aguarda execução. **Revisão independente formal continua pendente.**
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