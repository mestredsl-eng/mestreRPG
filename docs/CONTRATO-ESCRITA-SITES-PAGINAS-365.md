# Contrato — Escrita de sites e páginas (W3-write, #365)

Fatia de escrita do domínio público da Internet diegética: criar/editar/
publicar/arquivar `internet_sites` e `internet_pages`. Complementa
`CONTRATO-INTERNET-PUBLICA-365.md` (fatia read-only W1/W3, mergeada na
PR #388) e aplica as decisões D14, D3 e demais deliberações do
proprietário registradas em 27/11/2026.

Base verificada em `main@4289ada`. **Zero migration nesta fatia** —
schema atual já representa ownership canonicamente (ver D14 abaixo).

## Escopo

Dentro:

- CRUD de sites e páginas do próprio personagem (conta Internet ativa)
- Transições de status de páginas (`rascunho|publicado|retirado|arquivado`)
  e de sites (`ativo|arquivado`)
- Moderação de mestre (arquivar/restaurar; nunca reescrever conteúdo)
- Versionamento incremental + auditoria por edição (D3)
- Leitura autenticada de rascunhos pelo autor/mestre/dono (prévia)

Fora de escopo (fatias próprias): notícias/matérias W4/W5 (inclui gate
D8 `profissao:jornalista`), classificados W6/W7, posts/perfil W9–W11,
mensageiro privado, export/import D6, eventos de socket em tempo real.

## Autorização — pilha fail-closed

Toda rota de escrita exige, em ordem:

1. `requirePapel("mestre","jogador")` + membership ativa na campanha
   (padrão dos routers existentes; `espectador` fora — mesmo critério de
   `personagemAutorizadoInternet`);
2. Conta resolvida por `contaAutorizadaPara` — titularidade ATUAL via
   `characters.membershipId → memberships.userId`, **sem bypass de
   mestre** para ações de ownership. Transferência P7 é herdada
   automaticamente (nova titular passa, anterior perde — sem migração);
3. `internet_accounts.status = "ativa"`;
4. Regra de ownership da tabela abaixo;
5. Gate P5 cumulativo (`gateInternetDoPersonagem` /
   `avaliarElegibilidadeInternet`) **somente na primeira publicação**
   (ver "Gate P5" abaixo).

Mestre nunca escreve conteúdo como se fosse autor: moderação é endpoint
separado, auditado com `papel: "mestre"`, e jamais altera `corpo`,
`titulo` ou `nome`/`descricao` (D14).

## Matriz de permissões (D14)

| Recurso | Ação | Titular da conta dona do site | Autor da página | Outro jogador | Mestre |
|---|---|---|---|---|---|
| Site | criar | conta ativa + gate P5 | — | idem (qualquer conta elegível) | via conta própria |
| Site | editar metadados (`nome`, `descricao`, `slug`) | sim | não | 403 | não (só modera) |
| Site | arquivar / restaurar | sim | não | 403 | sim |
| Página | criar em site `ativo` | sim (é autor da página) | — | sim — qualquer conta elegível da campanha pode publicar página em site alheio; autor = conta do requisitante | via conta própria |
| Página | editar conteúdo (`titulo`, `corpo`, `formato`) | só se for o autor | sim | 403/404 | nunca (D14) |
| Página | transição de status | só se for o autor | sim | 403/404 | arquivar/restaurar apenas |
| Página | arquivar | autor | sim | 403/404 | sim |
| Página | restaurar | autor | sim | 403/404 | sim |

Notas de decisão (propostas de contrato — Deliberação se o dono divergir):

- **Multi-autoria**: sites admitem páginas de vários autores da campanha
  (D14 separa owner de autor). Criação de página não exige ser dono do
  site — o site é o "espaço", o autor assina a página.
- **Múltiplos sites por conta**: schema não restringe; esta fatia não
  cria limite artificial.
- **Sem DELETE**: remoção é sempre `arquivar` — rastro auditável (D3).

## Endpoints

Prefixo comum: `/api/campaigns/:campaignId/internet`. Respostas de erro
no padrão `erroHttp` (`{ erro, detalhes? }`). Rate limit de escrita:
`limiteUsuario` com **30 req/min por usuário** (metade do teto de
leitura — mutações são mais caras; enumeração de slugs continua cara).

### Sites

`POST /sites` — criar site

- Body: `{ slug, nome, descricao? }` (zod strict)
- `slug`: `/^[a-z0-9][a-z0-9._-]{1,62}$/` após normalização
  (minúsculas); único por campanha → `409 slug_em_uso`
- Requer conta ativa + titular + **gate P5 elegível** (criar site é
  estrear presença pública) → `403 internet_elegibilidade_revogada`
- `status` inicial `ativo`; `ownerContaId` = conta do requisitante
- `201 { ok, site }`; audit `internet.site_criado`

`PATCH /sites/:slug` — editar metadados

- Body: `{ nome?, descricao?, slug? }` — qualquer subconjunto; `slug`
  novo deve respeitar formato + unicidade → `409`
- Somente dono (`ownerContaId === conta.id`) → `403 nao_autorizado`
- Site `arquivado` aceita edição de metadados? **Não** — `409
  estado_invalido` (restaurar primeiro)
- Audit `internet.site_atualizado` com `camposAlterados[]`

`POST /sites/:slug/arquivar` e `POST /sites/:slug/restaurar`

- Dono da conta ou mestre; transição `ativo ↔ arquivado`
- Site arquivado some do diretório/leitura pública (read slice já filtra
  `status="ativo"` — invariante preservada, zero mudança no GET)
- Audit `internet.site_arquivado` / `internet.site_restaurado` com
  `por: "titular" | "mestre"`

`GET /sites/meus` — sites da(s) conta(s) do requisitante

- Lista sites onde `ownerContaId ∈ contasDoUsuario(campaignId, userId)`
- Inclui `status` (o dono precisa ver os próprios arquivados) e
  `paginasPublicadas` por site
- Sem essa rota o jogador não consegue achar o que editou — necessário
  para a UI de escrita

### Páginas

`POST /sites/:slug/paginas` — criar página

- Body: `{ slug, titulo, corpo, formato?, statusInicial? }`
- `formato`: `"texto" | "markdown-subset"` (default `texto`)
- `statusInicial`: `"rascunho" | "publicado"` (default `rascunho`)
- Site precisa existir e estar `ativo` → `404`/`409 estado_invalido`
- `statusInicial="publicado"` exige gate P5 elegível (mesmo critério do
  site) → `403 internet_elegibilidade_revogada`
- `autorContaId` = conta do requisitante; `campaignId` desnormalizado =
  `site.campaignId`; `version=1`; `publishedAt` preenchido só se já
  publicado
- Slug único por site → `409 slug_em_uso`
- Audit `internet.pagina_criada` `{ pageId, siteId, slug, autorContaId,
  version: 1, status }`

`PATCH /sites/:slug/paginas/:pageSlug` — editar conteúdo

- Body: `{ titulo?, corpo?, formato?, expectedVersion? }`
- Somente o autor (`autorContaId === conta.id`) → `404` uniforme para
  não-autor/não-mestre (existência de rascunho não vaza — a leitura
  pública já responde 404 idêntico para não-`publicado`)
- `expectedVersion` presente e ≠ `version` atual → `409
  versao_desatualizada` com `{ versionAtual }` (optimistic concurrency —
  D3 torna a versão o mecanismo anti-lost-update)
- Toda edição aceita incrementa `version` em 1, grava audit
  `internet.pagina_editada` `{ pageId, siteId, autorContaId, version,
  camposAlterados[] }` — ator autenticado (`actorId`) e horário já vêm
  do `audit()`; `autorContaId` identifica o personagem diegético
- Editar página `arquivada` → `409 estado_invalido`

`POST /sites/:slug/paginas/:pageSlug/publicar`

- Autor only; transição `rascunho → publicado` (ou re-publicar
  `retirado → publicado`)
- Revalida **gate P5** no ato → `403 internet_elegibilidade_revogada`
- `publishedAt` = agora na primeira publicação; em re-publicação,
  mantém o original? **Decisão**: `publishedAt` registra a PRIMEIRA
  publicação (histórico); `updatedAt` cobre as demais
- Audit `internet.pagina_status` `{ de, para, version }`

`POST /sites/:slug/paginas/:pageSlug/retirar`

- Autor only; `publicado → retirado` (despublica sem apagar — distinto
  de arquivar: retirado pode voltar por `publicar`)
- Audit `internet.pagina_status`

`POST /sites/:slug/paginas/:pageSlug/arquivar` e `.../restaurar`

- Autor da página **ou mestre**; `qualquer-status → arquivado`
- `restaurar`: arquivado → `publicado` se `publishedAt` existe, senão
  `rascunho` (regra derivável do estado persistido — sem tabela extra)
- Mestre nunca passa por este caminho para editar conteúdo — arquivar/
  restaurar é moderação, auditada com `papel: "mestre"` quando for o caso
- Audit `internet.pagina_arquivada` / `internet.pagina_restaurada` com
  `{ de, para, por }`

`GET /sites/:slug/paginas` — listagem autenticada

- Anônimo-equivalente (qualquer membro): apenas `publicado` (mesmo
  recorte do read slice)
- Autor autenticado: suas páginas naquele site em qualquer status
- Mestre: todas as páginas do site com `status` e `autorContaId`
  (visão de moderação)
- Dono do site que não é autor nem mestre: apenas `publicado` (D14 não
  lhe dá leitura de rascunhos alheios)

`GET /sites/:slug/paginas/:pageSlug` — leitura autenticada de rascunho

- Mesmo site/página do endpoint público, mas aceita qualquer `status`:
  - autor da página → qualquer status (prévia do rascunho)
  - mestre → qualquer status (moderação)
  - demais → somente `publicado`; não-`publicado` responde `404`
    idêntico ao endpoint público (zero oráculo)
- Resposta inclui `version`, `status`, `autorContaId`/handle do autor —
  campos que a visão pública omite

## Formato `markdown-subset` — whitelist fechada

O corpo em `markdown-subset` aceita somente:

- Parágrafos e quebras de linha
- Headings `##` e `###` (sem `#` título — o `titulo` da página cumpre
  esse papel)
- ênfase `**negrito**` e `*itálico*`
- Listas `- item` (sem aninhamento)
- Links `[texto](https://...)` — somente scheme `http:`/`https:`, sem
  `javascript:`/`data:`/`file:`
- Bloco de código com fence ` ``` ` (sem linguagem obrigatória)

Tudo fora da whitelist → `400 formato_invalido` com a regra violada —
**rejeitar, nunca sanitizar em silêncio** (sanitização silenciosa
esconde ataque do autor e do auditor). `texto` é armazenado verbatim e
renderizado como texto puro pelo cliente (sem HTML).

Limites de tamanho (valores de contrato): `titulo` ≤ 200 chars,
`corpo` ≤ 50.000 chars, `nome` de site ≤ 120, `descricao` ≤ 1.000,
`slug` conforme regex acima. Excedido → `400 dados_invalidos`.

## Gate P5 — onde se aplica

`avaliarElegibilidadeInternet` (perícia/conhecimento configurado +
dispositivo) é cumulativo e pode ser perdido (item vendido, ficha
alterada). Regra desta fatia:

- **Sempre**: titularidade atual + conta `ativa` (toda mutação)
- **Publicar** (criar site, criar página já `publicada`, transição
  `→ publicado`): revalida o gate — ir ao público é o ato privilegiado
- **Rascunho/edição privada/metadados de site**: não revalida (trabalho
  em andamento não é exposição)

Se o dono preferir gate em TODA mutação, é deliberação de uma linha —
a implementação isola a checagem em um helper para trocar o ponto.

## Invariantes preservadas (testes devem provar)

1. Read slice inalterado: só `publicado` em site `ativo` aparece em
   `GET /sites`, `GET /sites/:slug`, `GET .../paginas/:pageSlug`
2. `version` só cresce; nunca retrocede; audit por edição carrega a
   versão resultante (D3)
3. P7: após transferência aceita, titular anterior recebe `403`/`404`
   em qualquer mutação; novo titular opera normalmente — sem migração
   de `owner_conta_id`/`autor_conta_id`
4. Mestre não consegue alterar `corpo`/`titulo`/`nome`/`descricao` por
   nenhum endpoint — somente arquivar/restaurar
5. Dono do site não edita página de outro autor (D14)
6. `markdown-subset` rejeita HTML, scripts, schemes perigosos —
   `400 formato_invalido`, nunca 200 com conteúdo alterado
7. Slug duplicado → `409`; corrida de criação resolvida pelo UNIQUE do
   banco (mesmo padrão de `character_transfers`)
8. Rate limit: 31ª mutação no minuto → `429`, nunca 5xx

## Auditoria — ações novas

`internet.site_criado`, `internet.site_atualizado`,
`internet.site_arquivado`, `internet.site_restaurado`,
`internet.pagina_criada`, `internet.pagina_editada`,
`internet.pagina_status`, `internet.pagina_arquivada`,
`internet.pagina_restaurada` — todas via `audit()` existente
(`actorId` = usuário autenticado, `campaignId` automático, `createdAt`),
com `detail` carregando ids diegéticos (`contaId`, `autorContaId`,
`ownerContaId`, `pageId`, `siteId`), `version` resultante e
`papel: "titular"|"mestre"` quando aplicável. Nenhuma tabela nova —
`audit_logs` já cobre D3.

## Questões em aberto para deliberação

1. **Multi-autoria irrestrita** (qualquer conta elegível cria página em
   site alheio): se o dono quiser "só o dono do site convida/autoria",
   a fatia ganha um conceito de permissão por site — deliberação antes
   de codar se preferir o modelo restrito.
2. **Gate P5 só na publicação** (proposta acima) vs. em toda mutação.
3. **`publishedAt`** = primeira publicação (proposta) vs. última —
   afeta ordenação "mais recentes" do W4 futuro.
4. Sites: **sem `version`** no schema — D3 cobre páginas; se o dono
   quiser versionamento de metadados de site, exige migration aditiva
   (`version` integer default 1) — fora desta fatia salvo deliberação.
