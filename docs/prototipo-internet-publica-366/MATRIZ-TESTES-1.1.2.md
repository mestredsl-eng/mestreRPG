# Matriz integrada de testes — Internet pública 1.1.2

**Release:** #364 · **Contrato:** #365 · **UX:** #366 · **Threat model:** #367 · **Inventário técnico:** #368 · **Homologação:** #369 · **Board:** #370

**Base funcional integrada:** `main@4289adafe23d7343e083c02443ff09626a463726` (PR #388, W1/W3).
**Vereditos do proprietário:** 27/11/2026, registrados em `ESPECIFICACAO.md` §6/§9 e em `docs/CONTRATO-INTERNET-PUBLICA-365.md`.
**Regra:** esta matriz distingue comportamento já integrado, cobertura planejada e resultado efetivamente executado. Um item planejado nunca é PASS por existir aqui.

## 1. Estado de homologação já comprovado — W1/W3

| Prova no head final `ca76c21e` da PR #388 | Resultado documentado | Estado |
|---|---:|---|
| Suíte black-box do PAI `teste-internet-publica.mjs` | 46/46 | PASS |
| Suíte independente FILHO | 37 ok / 0 falhas / 2 skips fora do corte | PASS + SKIP explícito |
| Gates do Gerente de Execução | 29 ok / 0 falhas / 2 skips honestos | PASS + SKIP explícito |
| Fixtures públicas | 12/12 | PASS |
| Recuperação/restore `teste-restauracao-boot.mjs` após correção do merge | 237/237 | PASS |
| Identidade/recuperação #380 | 40/40 | PASS |
| CI natural da PR #388 no SHA exato | 6/6 verde | PASS |
| Revisão Técnico Geral | APROVADO no delta `58ab9b3..ca76c21` | PASS |
| Homologação FILHO e revisão INTERMEDIÁRIO | 37/0/2; APPROVE mantido | PASS |

W1/W3 incluídos: gate de leitura; diretório de sites da campanha; paginação keyset; prefixo `q`; detalhe de site; menu derivado apenas de páginas publicadas; leitura de página publicada; anti-enumeração cross-campaign/rascunho/arquivado; rate limit; migração aditiva 0043 e restore. Não reexecutar essas suítes sem alteração relevante ou regressão.

**Importante:** os skips acima são deliberados porque autoria/escrita, publicações e seus fluxos ainda não pertenciam ao slice W1/W3. Não contam como cobertura aprovada para as próximas fatias.

## 2. Invariantes transversais — obrigatórios em todos os módulos

| ID | Cenário | Resultado esperado |
|---|---|---|
| SEC-01 | Sessão ausente, conta Internet ausente/inativa, personagem inelegível, dispositivo perdido ou membership revogada | Leitura/escrita negada fail-closed conforme o gate canônico; revalidar em cada request |
| SEC-02 | Jogador tenta acessar outra campanha por ID, slug, cursor, payload, busca ou export | Nenhum dado cruzado; resposta sem oráculo e sem diferenciar conteúdo inacessível de inexistente quando o contrato exigir 404 uniforme |
| SEC-03 | Conteúdo restrito a contatos, bloqueado ou não visível | Não aparece em resultados, snippets, contagens, agregados, paginação, ranking, feed ou erro discernível |
| SEC-04 | Identidade de autor manipulada no body, path ou evento | Servidor deriva autoria do personagem/conta autorizada; rejeita tentativa de escrever em nome de outro personagem |
| SEC-05 | Internet pública comparada a Mensagens/mesa/OOC | Nenhum evento, mensagem privada, estado de digitação ou conteúdo OOC aparece em site, pesquisa, feed ou publicação pública |
| SEC-06 | Rate limit, retry, ACK perdido, request duplicado ou replay | Limites aplicados; idempotência não duplica efeitos; erro não expõe dados nem causa 5xx |
| SEC-07 | Mudança de titularidade P7, perda de dispositivo, personagem arquivado/morto | Autorização é reavaliada; autoria/ownership seguem o personagem pelas regras aprovadas; escrita bloqueada quando exigido |
| SEC-08 | Restart, upgrade 1.1.1→1.1.2, backup e restore | Integridade dos registros, relações, estados e índices; migração aditiva; sem regressão das rotas 1.1.1 |

## 3. Sites e páginas — ownership D14 e versionamento D3

| ID | Cenário | Resultado esperado |
|---|---|---|
| SITE-01 | Personagem elegível cria site | Site vinculado ao personagem criador e à campanha atual; sem aceitar owner/character arbitrário do cliente |
| SITE-02 | Personagem não elegível ou sem dispositivo tenta criar site | Negado pelo gate canônico; nenhum registro parcial |
| SITE-03 | Dono administra metadados do próprio site | Permitido somente nas propriedades de administração do site autorizadas pelo contrato |
| SITE-04 | Outro personagem tenta administrar site alheio | Negado; não alterar metadados nem ownership |
| SITE-05 | Autor cria página em site que pode administrar | Autoria registrada como o personagem autenticado; autor não pode ser escolhido pelo body |
| SITE-06 | Autor edita sua própria página | Permitido; versão incrementa exatamente uma vez; auditoria registra personagem/ator/horário/versão |
| SITE-07 | Dono do site tenta editar página escrita por outro autor | Negado; ownership do site não transfere autoria de página |
| SITE-08 | Mestre modera ou arquiva site/conteúdo alheio | Permitido de acordo com escopo de moderação; nunca recebe operação para reescrever o conteúdo alheio |
| SITE-09 | Transferência P7 do personagem | Ownership e autoria continuam vinculados ao personagem; titular novo recebe as permissões derivadas do personagem; titular anterior não conserva autoridade |
| SITE-10 | Duas edições concorrentes ou retry da mesma edição | Sem sobrescrita silenciosa; versão/auditoria consistentes; retry não incrementa duas vezes |
| VER-01 | Edição válida após versão N | Resultado N+1 e evento de auditoria correspondente |
| VER-02 | Tentar consultar versões antigas, restaurar versão ou fazer rollback | Não existe histórico recuperável, endpoint, UI ou rollback de conteúdo (D3=A) |
| VER-03 | Examinar auditoria | Contém trilha necessária, mas não funciona como cópia oculta recuperável do corpo anterior |

## 4. Publicações, rede social, notícias e jornalismo — D8=C

| ID | Cenário | Resultado esperado |
|---|---|---|
| PUB-01 | Personagem cria post de perfil permitido | Publicação associada ao personagem; anonimato não aparece para `post_perfil` (DP-6) |
| PUB-02 | Usuário envia autor/handle/characterId alheio | Identidade é derivada no servidor; escrita alheia rejeitada |
| NEWS-01 | Personagem sem `profissao:jornalista` ativa no campo Profissão do ruleset da campanha tenta publicar matéria | Negado sem criar publicação |
| NEWS-02 | Personagem com a chave estável `jornalista` no campo Profissão e definição `profissao:jornalista` ativa publica matéria | Permitido e autoria registrada |
| NEWS-03 | Mestre publica matéria/notícia | Permitido, com proveniência/autoria/auditoria preservadas |
| NEWS-04 | Cliente envia o rótulo "Jornalista" ou texto livre, sem a chave canônica | Não concede permissão; servidor lê a chave estável da ficha |
| NEWS-05 | Campanha remove `profissao:jornalista` do ruleset e ficha mantém valor antigo | Permissão negada; não re-semeia/reativa automaticamente |
| NEWS-06 | Requisito tenta introduzir classe/perícia/habilidade/atributo paralelo "jornalista" | Teste/inspeção confirma que não foi criado sistema paralelo |
| NEWS-07 | Mestre publica matéria sem profissão jornalística no personagem | Permitido conforme exceção decidida |
| NEWS-08 | Investigar matéria sem elegibilidade jornalística | Negado conforme regra D8 |
| NEWS-06 | Morte ativa gera notícia automática | Uma publicação por ocorrência/evento; deduplicação por personagem/época; selo automático |
| NEWS-07 | Ressurreição auditada e nova morte | Notícia antiga permanece; nova ocorrência pode gerar nova notícia, sem sobrescrever a anterior (DP-8/DP-9) |
| NEWS-08 | Corrigir causa da morte publicada | Nova publicação complementar; nunca alterar retroativamente a notícia automática ou `__morte.causa` |

**Base concreta D8 já localizada:** a biblioteca inicial em `servidor/src/lib/seed-regras.ts` registra `profissao:jornalista`; `profissao` é um `TipoRegra` válido; a ficha de referência tem campo Profissão com `regraKind: "profissao"`; e `site/src/FichaForm.tsx` salva `o.key` como valor, mantendo `o.name` só como rótulo. O gate usa a chave estável `jornalista` no ruleset ativo, server-side. O Mestre pode remover/editar a biblioteca: não recriar automaticamente a profissão apagada. `profissao:investigador` também existe, mas não dá permissão jornalística por si só.

## 5. Anúncios e classificados — D9=A e D11=A

| ID | Cenário | Resultado esperado |
|---|---|---|
| AD-01 | Personagem elegível publica anúncio/classificado | Autor derivado do personagem; visibilidade e tipo persistidos; validação de conteúdo |
| AD-02 | Anúncio com `expiresAt` futuro | Estado ativo antes do instante de expiração |
| AD-03 | Anúncio sem `expiresAt` | Permanece ativo até retirada/moderação; não expira por padrão |
| AD-04 | Anúncio com `expiresAt` passado | Estado expirado derivado na leitura/listagem; não necessita job/cron |
| AD-05 | Sistema é reiniciado durante a expiração | Estado continua correto, calculado pelo relógio na leitura; nenhuma fila/job necessária |
| AD-06 | Autor retira o próprio anúncio | Some das listagens públicas; estado/registro segue política de preservação aprovada |
| AD-07 | Denúncias atingem DP-3 | Auto-remoção em ≥2 contas distintas ou 1 denúncia grave; contestação conforme DP-2/admin plataforma, não Mestre |
| AD-08 | Publicação anônima de anúncio/classificado | Anonimato permitido somente nesses tipos; imutável após publicar; identidade real não é revelada na UI/export da campanha (DP-1/DP-6) |
| AD-09 | Contato com anunciante | Gera solicitação pelo fluxo de contatos existente; conversa só abre após aceite |
| AD-10 | Anunciante rejeita, ignora ou bloqueia; existe bloqueio bilateral | Não abrir conversa; respeitar o comportamento já existente sem canal alternativo |
| AD-11 | Usuário tenta abrir chat paralelo pelo detalhe do anúncio | Não há endpoint, tabela, evento ou interface de chat novo |

## 6. Perfis públicos — DP-4/5/7/10

| ID | Cenário | Resultado esperado |
|---|---|---|
| PROF-01 | Personagem nunca ativou perfil | Perfil inexistente/publicamente não ativado; demais áreas da Internet continuam funcionando |
| PROF-02 | Personagem confirma ativação | Perfil público persistente e irreversível; aviso claro antes da confirmação |
| PROF-03 | Após ativação tenta ocultar/desativar/excluir perfil | Não oferecer nem aceitar tais operações (D10) |
| PROF-04 | Perfil ativo | Exibe apenas nome público, avatar e descrição conforme decisões aceitas |
| PROF-05 | Pesquisa perfil | Localização por `handle`; não indexar `displayName` (D12) |
| PROF-06 | Transferência P7 | Perfil acompanha `characterId`; novo titular autorizado administra o perfil |
| PROF-07 | Personagem com morte ativa | Perfil permanece acessível em leitura, somente-leitura na escrita (DP-5) |
| PROF-08 | Ressurreição mestre auditada | Escrita reabre segundo DP-8; notícia anterior permanece |
| PROF-09 | Avatar atualizado | Usa pipeline `arquivos` existente; sem storage ou upload paralelo |

## 7. Pesquisa multiescopo — D12=A

| ID | Cenário | Resultado esperado |
|---|---|---|
| SEARCH-01 | Pesquisar sites | Encontrar pelo nome/título de site permitido ao leitor |
| SEARCH-02 | Pesquisar páginas | Encontrar títulos/conteúdo de página publicada e visível |
| SEARCH-03 | Pesquisar notícias | Encontrar matéria/notícia visível e sua fonte/autoria pública |
| SEARCH-04 | Pesquisar anúncios/classificados | Encontrar anúncios ativos e visíveis; expirados/removidos conforme estado/permissão |
| SEARCH-05 | Pesquisar perfil | Encontrar somente perfis ativados por `handle` |
| SEARCH-06 | Termo só presente em `displayName` | Não retorna perfil por esse campo |
| SEARCH-07 | Conteúdo oculto/restrito existe e o leitor não pode ver | Não altera quantidade, snippets, ordenação, cursor ou mensagem de "sem resultados" |
| SEARCH-08 | Consultas e cursores de outra campanha | Não atravessam a fronteira de campanha; cursor forjado é rejeitado |
| SEARCH-09 | Conteúdo muda para retirado, expirado ou removido | Resultado, detalhe, contagem e paginação refletem o estado sem cache/index stale que revele o conteúdo |
| SEARCH-10 | Paginação/ordenação estável | Sem duplicatas/omissões e sem influência de itens invisíveis |

## 8. Exportação/importação da campanha — D6=A

| ID | Cenário | Resultado esperado |
|---|---|---|
| EXP-01 | Export de campanha com sites e páginas | Inclui todos, inclusive rascunhos, versões atuais, status e autoria por personagem |
| EXP-02 | Export com notícias, posts, anúncios, classificados e perfis | Inclui integralmente o domínio público da campanha |
| EXP-03 | Export com conteúdo de visibilidade restrita | Preserva a regra de visibilidade sem promover conteúdo privado/restrito a público |
| EXP-04 | Export com denúncias e contestação | Preserva estado e metadados necessários à continuidade do ciclo de moderação |
| EXP-05 | Mensagens/conversas privadas existem na campanha | Não são incluídas no export/import da campanha |
| EXP-06 | Conteúdo anônimo existe | Export da campanha não revela vínculo da identidade real do autor; anonimato e DP-1/DP-6 continuam preservados |
| EXP-07 | Importar em campanha de destino | Remapeia IDs/foreign keys sem colisão; nenhum vínculo com a campanha de origem permanece |
| EXP-08 | Import com personagem/autor inexistente no destino | Falha controlada ou mapeamento explicitamente definido; nunca cria titular/autor falso |
| EXP-09 | Reexport após importar | Equivalência semântica do domínio público, excluindo os dados privados por regra |
| EXP-10 | Backup integral do servidor | Separado do export de campanha; restaura o banco completo conforme contrato de backup, sem confundir os dois formatos |

## 9. Investigação jornalística — W11

| ID | Cenário | Resultado esperado |
|---|---|---|
| INV-01 | Personagem elegível investiga publicação visível | Usa lançamento/teste do RPG real e evidências existentes; persiste referência ao teste |
| INV-02 | Personagem tenta investigar conteúdo que nunca pôde ver | Resposta sem oráculo; "informação insuficiente", sem revelar existência/autor/conteúdo |
| INV-03 | Repetir investigação sem nova pista/evidência | Bloqueado conforme regra de repetição; sem reroll abusivo |
| INV-04 | Resultado determinístico sobre lançamento salvo | Confiabilidade deriva do resultado persistido conforme contrato; não usar classe/perícia paralela |
| INV-05 | Informação obtida pode ser falsa | UI não sinaliza ao investigador quais trechos são falsos; sem rótulo verdade/falso |
| INV-06 | Investigar evento/matéria automática de morte | Fonte/ocorrência identificável, sem modificar a publicação original |

## 10. UX, acessibilidade, operação e regressão

| ID | Cenário | Resultado esperado |
|---|---|---|
| UX-01 | Viewport 390px, 768px e desktop | Layout utilizável, sem overflow funcional |
| UX-02 | Teclado/leitor de tela | Foco visível, ordem lógica, nomes acessíveis, estados anunciados |
| UX-03 | Loading, vazio, erro, retry, offline/reconectando e sem permissão | Estados honestos; nenhuma ação de escrita fora do gate |
| UX-04 | Conteúdo removido/expirado | 404 para quem nunca teve acesso; estado apropriado para quem tinha acesso legítimo, sem motivo de moderação indevido |
| OPS-01 | Banco limpo + upgrade 1.1.1→1.1.2 | Migrations idempotentes/ordenadas e schema compatível |
| OPS-02 | Backup/restore e inicialização Windows | Dados/índices íntegros; inicialização/upgrade sem intervenção destrutiva |
| OPS-03 | Regressão Internet 1.1.1 | Contas, Mensagens/contatos, gate/dispositivo e comércio existentes sem regressão |
| OPS-04 | CI no SHA de cada PR | Só marcar pronto com checks obrigatórios verdes no head exato; revalidar se head mudar |

## 11. Donos e protocolo de execução

| Papel | Responsabilidade | Entrega verificável |
|---|---|---|
| **PAI** | Implementar fatias verticais, atualizar contrato, mapear regra D8 no acervo e integrar o domínio existente | Branch/PR/SHA, diff, testes executáveis e migration/backup quando aplicável |
| **FILHO** | Homologação black-box independente; fixtures descartáveis; testar permissões e isolamento sem alterar código do PAI | Teste/branch/SHA, comandos e resultado PASS/FAIL/SKIP |
| **INTERMEDIÁRIO** | Revisão adversarial de IDOR, busca/anti-oráculo, autoria, anonimato/export e fronteiras campanha↔OOC | Parecer com severidade, arquivo/linha e SHA |
| **Técnico Geral** | Inventário de regra D8, schema, transferência P7, export/import, restore, SQLite e Windows | Mapa de arquivos, decisão técnica fundamentada e prova de compatibilidade |
| **Gerente de Execução** | Consolidar esta matriz, executar regressões/CI, separar PASS/FAIL/BLOCKED/SKIP | Check runs no SHA exato, logs e placar único |
| **Gerente Operacional** | Quadro #370, sequência e dependências sem abrir issues duplicadas | Board com dono, estado real, PR/SHA e próximo marco |
| **Dono Técnico (GPT)** | Coordenar, auditar evidência, revisar escopo e integrar PR pronta imediatamente | Registro de decisões, revisão e merge quando gates verdes |

## 12. Sequência vertical autorizada — sem novas decisões de produto

1. **W3 escrita/ownership** — criação e administração do site pelo personagem dono; autoria/edição das próprias páginas; moderação/arquivamento pelo Mestre sem reescrita; `version`+audit sem rollback. Revalidar transferência P7 antes de fechar schema.
2. **W4/W5 publicações e notícias** — modelo de publicações, posts e autoria; mapear elegibilidade D8 diretamente para o ruleset existente; automatismo de notícia de morte e consequências DP-8/DP-9.
3. **W6/W7/W8 anúncios/classificados** — publicação, denúncia/contestação, anonimato DP-6, contato via fluxo existente (D9), validade opcional (D11).
4. **W9/W10 perfis** — ativação opcional irreversível, avatar pipeline, perfil ligado ao personagem, morte/ressurreição.
5. **W2 pesquisa** — indexação multiescopo sobre entidades já persistidas, por `handle` para perfis, sem `displayName`, filtro de visibilidade antes de qualquer resultado/metadado.
6. **W11 investigação** — usa regras e testes reais do sistema, após notícias/publicações; sem sistema paralelo.

W2 pode ter desenho/benchmark técnico em paralelo, mas não declarar busca multiescopo concluída antes de existirem os tipos de conteúdo previstos. W11 depende da camada jornalística.

## 13. Estados de homologação

- **PASS**: cenário executado no SHA indicado, resultado observado igual ao esperado.
- **FAIL**: cenário executado e comportamento divergente reproduzido.
- **BLOCKED**: pré-requisito ausente ou decisão técnica bloqueante, com evidência.
- **SKIP**: fora do slice atual, explicitamente justificado; nunca conta como PASS.
- **NOT RUN**: ainda não executado; não usar ícone verde nem linguagem de conclusão.

Nenhuma ordem escrita/comentário é prova de execução. Nenhum agente pode declarar tarefa em andamento/entregue sem branch/commit/SHA, artefato ou execução observável.
