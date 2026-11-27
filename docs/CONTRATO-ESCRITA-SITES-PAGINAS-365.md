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
   `avaliarElegibilidadeInternet`) **em toda mutação**, inclusive
   rascunho, edição de metadados, publicação, retirada, arquivamento,
   restauração e moderação. Sem exceção por estado privado.

Mestre nunca escreve conteúdo como se fosse autor: moderação é endpoint
separado, auditado com `papel: "mestre"`, e jamais altera `corpo`,
`titulo` ou `nome`/`descricao` (D14).

## Matriz de permissões (D14)

| Recurso | Ação | Titular da conta dona do site | Autor da página | Outro jogador | Mestre |
|---|---|---|---|---|---|
| Site | criar | conta ativa + gate P5 | — | idem (qualquer conta elegível) | via conta própria |
| Site | editar metadados (`nome`, `descricao`, `slug`) | sim | não | 403 | não (só modera) |
| Site | arquivar / restaurar | sim | não | 403 | sim |
| Página | criar em site `ativo` | **somente o dono do site** | — | 403/404 | via conta própria |
| Página | editar conteúdo (`titulo`, `corpo`, `formato`) | só se for o autor | sim | 403/404 | nunca (D14) |
| Página | transição de status | só se for o autor | sim | 403/404 | arquivar/restaurar apenas |
| Página | arquivar | autor | sim | 403/404 | sim |
| Página | restaurar | autor | sim | 403/404 | sim |

Notas de decisão:

- **Autoria única no corte 1.1.2** (fechamento já aprovado — SITE-12 da
  matriz de testes): somente o personagem proprietário cria páginas
  novas dentro do próprio site. Não há convite, colaboração nem criação
  de página em site alheio neste corte — criação por não-dono responde
  4xx. Páginas com `autorContaId` distinto do dono atual só podem surgir
  via importação (EXP-08), nunca via endpoint de escrita.
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
- Requer conta ativa, titularidade atual e gate P5 elegível, como toda
  mutação → `403 internet_elegibilidade_revogada`.
- `status` inicial `ativo`; `ownerContaId` = conta do requisitante
- `201 { ok, site }`; audit `internet.site_criado`

`PATCH /sites/:slug` — editar metadados

- Body: `{ nome?, descricao?, slug? }` — qualquer subconjunto; `slug`
  novo deve respeitar formato + unicidade → `409`
- Somente dono (`ownerContaId === conta.id`) e gate P5 atual →
  `403 nao_autorizado` ou `403 internet_elegibilidade_revogada`.
- Site `arquivado` aceita edição de metadados? **Não** — `409
  estado_invalido` (restaurar primeiro). A restauração também exige gate
  P5 atual.
- Audit `internet.site_atualizado` com `camposAlterados[]`

`POST /sites/:slug/arquivar` e `POST /sites/:slug/restaurar`

- Dono da conta ou mestre, ambos sujeitos à autorização/gate vigente;
  transição `ativo ↔ arquivado`. Mestre não ganha bypass do gate nem
  permissão para editar conteúdo.
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

POST /sites/:slug/paginas` — criar página

- Body: `{ slug, titulo, corpo, formato?, statusInicial? }`
- `formato`: `"texto" | "markdown-subset"` (default `texto`)
- `statusInicial`: `"rascunho" | "publicado"` (default `"rascunho"`)
- Somente o dono do site cria páginas (SITE-12); não-dono recebe
  `403 nao_autorizado`.
- Site precisa existir e estar `ativo` → `404`/`409 estado_invalido`.
- Toda criação, inclusive como rascunho, exige conta ativa,
  titularidade atual e gate P5 elegível → `403
  internet_elegibilidade_revogada`.
- `autorContaId` = conta do requisitante; `campaignId` = campanha do
  site; `version=1`; `publishedAt` preenchido somente se publicado.
- Slug único por site → `409 slug_em_uso`.
- Audit `internet.pagina_criada` na mesma transação:
  `{ pageId, siteId, slug, autorContaId, version: 1, status }`.

`PATCH /sites/:slug/paginas/:pageSlug` — editar conteúdo

- Body: `{ titulo?, corpo?, formato?, expectedVersion }`
- `expectedVersion` **obrigatório** em toda edição de conteúdo — D3
  torna a versão o mecanismo anti-lost-update; sem ele um PATCH cego
  sobrescreveria edição concorrente. Divergente → `409
  versao_desatualizada` com `{ versionAtual }`
- Somente o autor (`autorContaId === conta.id`) → `404` uniforme para
  não-autor/não-mestre (existência de rascunho não vaza — a leitura
  pública já responde 404 idêntico para não-`publicado`)
- Site `arquivado` congela o site inteiro: qualquer mutação em página
  dele (edição ou status) → `409 estado_invalido` — restaurar o site
  primeiro
- Toda edição aceita incrementa `version` em 1, grava audit
  `internet.pagina_editada` `{ pageId, siteId, autorContaId, version,
  camposAlterados[] }` — ator autenticado (`actorId`) e horário já vêm
  do `audit()`; `autorContaId` identifica o personagem diegético
- Editar página `arquivada` → `409 estado_invalido`

POST /sites/:slug/paginas/:pageSlug/publicar

- Autor only; transição `rascunho → publicado` ou
  `retirado → publicado`.
- Revalida conta, titularidade atual e gate P5 em toda operação.
- Body exige `{ expectedVersion }`; versão divergente → `409
  versao_desatualizada` com `{ versionAtual }`.
- Ao aceitar, incrementa `version` exatamente uma vez e grava
  `internet.pagina_status` na mesma transação da publicação.
- `publishedAt` registra a primeira publicação; re-publicar mantém
  a data original e `updatedAt` registra a alteração posterior.

`POST /sites/:slug/paginas/:pageSlug/retirar`

- Autor only; `publicado → retirado` (despublica sem apagar; pode
  voltar por `publicar`).
- Body exige `{ expectedVersion }`; revalida conta, titularidade e
  gate P5. Versão divergente → `409 versao_desatualizada`.
- Ao aceitar, incrementa `version` exatamente uma vez e grava
  `internet.pagina_status` atomicamente com a transição.

`POST /sites/:slug/paginas/:pageSlug/arquivar` e
`POST /sites/:slug/paginas/:pageSlug/restaurar`

- Autor da página ou Mestre; Mestre pode somente moderar, nunca
  reescrever conteúdo. Ambos revalidam autorização/gate P5.
- Body exige `{ expectedVersion }`; versão divergente →
  `409 versao_desatualizada`.
- Arquivar: qualquer estado permitido → `arquivado`. Restaurar:
  `arquivado → publicado` se `publishedAt` existir; caso contrário,
  `arquivado → rascunho`.
- Ao aceitar, incrementa `version` exatamente uma vez e grava
  `internet.pagina_arquivada` ou `internet.pagina_restaurada`
  na mesma transação.
- Auditoria registra `{ de, para, por, version }`, sem snapshots.

Regra transversal às transições: site `arquivado` congela o status
de suas páginas → `409 estado_invalido` (mesma regra do PATCH).

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
  campos que a visão pública omite. Registro: páginas não admitem
  anonimato (DP-6), mas se um tipo futuro admitir, `autorContaId`/handle
  não pode vazar nessa visão — revisar antes de reusar o endpoint

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

## Gate P5 — obrigatório em toda mutação

`contaAutorizadaPara(contaId, userId)` é a fonte server-side de
autorização e deve ser executada novamente em **cada operação de
escrita**. Ela revalida conta ativa, personagem não arquivado,
membership ativa, titularidade atual após P7 e elegibilidade canônica
(dispositivo + requisito de ficha configurado). Não reutilizar um
resultado anterior nem confiar em um gate calculado pelo cliente.

A exigência cobre criação e edição de site, criação de rascunho ou página
publicada, edição de conteúdo, publicação, retirada, arquivamento,
restauração e ações de moderação. Rascunho não é uma rota de escrita
privilegiada: perder dispositivo, requisito ou titularidade bloqueia
também a manutenção do rascunho até a elegibilidade ser recuperada.

O papel de Mestre amplia somente as ações de moderação expressamente
permitidas (arquivar/restaurar); não permite reescrever conteúdo nem
contornar a validação de autorização da camada diegética. Toda falha de
autorização/elegibilidade é negada antes da mutação e da auditoria.

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
5. Dono do site não edita página de outro autor (D14); criação de
   página em site alheio → 4xx (SITE-12 — autoria única no corte)
6. `markdown-subset` rejeita HTML, scripts, schemes perigosos —
   `400 formato_invalido`, nunca 200 com conteúdo alterado
7. Slug duplicado → `409`; corrida de criação resolvida pelo UNIQUE do
   banco (mesmo padrão de `character_transfers`)
8. Rate limit: 31ª mutação no minuto → `429`, nunca 5xx

## Auditoria — ações novas e atomicidade

Ações: `internet.site_criado`, `internet.site_atualizado`,
`internet.site_arquivado`, `internet.site_restaurado`,
`internet.pagina_criada`, `internet.pagina_editada`,
`internet.pagina_status`, `internet.pagina_arquivada` e
`internet.pagina_restaurada`.

**A gravação do recurso e o registro em `audit_logs` devem ocorrer na
mesma transação do banco.** Usar a transação Drizzle/SQLite da mutação
para inserir o evento de auditoria diretamente; se a inserção da
auditoria falhar, a mutação inteira deve sofrer rollback e responder
erro. O helper `audit()` atual é best-effort (captura e engole falhas),
portanto **não satisfaz D3 e não pode ser usado isoladamente** como
garantia desta fatia.

O detalhe de auditoria registra somente metadados necessários:
`actorId`, `campaignId`, IDs diegéticos (`contaId`,
`ownerContaId`, `autorContaId`, `pageId`, `siteId`), ação,
`camposAlterados[]`, transição de status, versão resultante e papel
(`titular` ou `mestre`) quando aplicável. Nunca gravar corpo anterior,
corpo atual, snapshots, conteúdo recuperável ou dados que permitam
transformar auditoria em histórico/rollback oculto. Horário vem do
registro de auditoria no banco.

## Decisões técnicas fechadas para a implementação

- Gate P5 é revalidado em **toda** mutação, inclusive rascunhos e
  moderação; não há exceção para trabalho privado.
- `publishedAt` registra a primeira publicação. Re-publicações não
  substituem a data original; `updatedAt` registra alterações
  posteriores.
- O schema atual não possui versão de metadados de site. Não criar
  migration para isso nesta fatia: o versionamento D3 aplica-se às
  páginas; metadados de site recebem auditoria atômica com
  `camposAlterados[]`.
- Toda alteração de página — conteúdo ou transição de estado — exige
  `expectedVersion`, incrementa `version` exatamente uma vez e grava
  auditoria atômica. Conflito de versão resulta em `409
  versao_desatualizada`; não sobrescrever alteração concorrente.

Fechado conforme D14/SITE-12: somente o personagem proprietário cria
páginas no próprio site; não há convite, colaboração nem criação em site
alheio nesta versão. Não reabrir essas decisões no ciclo técnico.
