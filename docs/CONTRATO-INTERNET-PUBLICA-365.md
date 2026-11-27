# Contrato — Internet pública 1.1.2, fatia W1/W3 (#365)

Base: `main@36f6b23` + migração `0043` (`internet_sites`, `internet_pages`).
Escopo desta fatia: **somente leitura** — diretório de sites, detalhe de
site e leitura de página. Criação/edição de sites e páginas NÃO existe
aqui (regra de produto pendente de deliberação — ver #365).

Implementação: `servidor/src/routes/internet-publica.ts`, montado em
`/api/campaigns/:campaignId/internet` (mesmo prefixo e mesmo
`blindar`+lease das rotas 1.1.1). Cliente:
`site/src/paginas/internet/adaptador-publica.ts` + `Explorar.tsx`
(aba "Explorar" dentro da camada diegética — Internet → Rede).

## Gate do leitor (fail-closed)

Todo endpoint exige `requireAuth` + `requirePapel("mestre","jogador")`
na campanha **e** uma das duas provas de leitura:

1. ≥1 conta Internet **autorizada** do requisitante —
   `contaAutorizadaPara` revalida a cada chamada: conta `ativa`,
   personagem não arquivado, membership ativa do usuário, **titularidade
   atual** (sem bypass de mestre) e **elegibilidade canônica**
   (`gateInternetDoPersonagem` — perícia/conhecimento + dispositivo);
2. `mestreLeitorDaCampanha` — membership `mestre` ativa na campanha
   (leitura privilegiada, mesmo modelo do P10 de mensagens).

Sem as duas → `403 {"erro":"Sem acesso à camada pública da Internet"}`.
Sem sessão → `401`. Papel fora de mestre/jogador → negado por
`requirePapel`.

## Endpoints

### `GET /api/campaigns/:cid/internet/sites?q=&cursor=&limit=`

Diretório de sites **`ativo`** da campanha (D2: descobrível por todos
os elegíveis).

- `q` — filtro prefixo (`nome LIKE 'q%'`), trim, máx. 80 chars.
- `limit` — 1..50, default 20.
- `cursor` — keyset opaco (`base64url(createdAtMs:id)`), ordenação
  `(createdAt,id) DESC`; cursor inválido → `400`.

Resposta:

```json
{ "sites": [{ "id", "slug", "nome", "descricao",
              "owner": { "id", "handle", "displayName" } | null,
              "paginasPublicadas": 3, "criadoEm": "<ISO>" }],
  "cursor": "<opaco|null>" }
```

`paginasPublicadas` conta **somente** `internet_pages.status='publicado'`
— rascunho/retirado/arquivado nunca contam para o leitor. `owner` é a
conta pública mínima (id+handle+displayName) — **nunca**
`characterId`/`userId`/`ownerContaId`.

### `GET /api/campaigns/:cid/internet/sites/:slug`

Detalhe do site `ativo` + menu derivado das páginas `publicado`
(D13-a — sem editor de menu nesta fatia), ordenado por `titulo`.

```json
{ "site": { "id","slug","nome","descricao","owner","criadoEm" },
  "paginas": [{ "slug","titulo","publicadoEm" }] }
```

### `GET /api/campaigns/:cid/internet/sites/:slug/paginas/:pageSlug`

Página `publicado` de site `ativo` da **mesma** campanha.

```json
{ "pagina": { "slug","titulo","corpo","formato","version",
              "publicadoEm","autor": {...}|null },
  "site": { "slug","nome" } }
```

`formato` é `texto` (o valor `markdown-subset` é normalizado para
`texto` nesta fatia — renderização rica não existe ainda).

## Fronteiras (anti-enumeração)

- Site de outra campanha, `arquivado` ou slug inexistente → `404`
  `"Site não encontrado"` — indistinguível.
- Página `rascunho`/`retirado`/`arquivado`, de site arquivado ou de
  outra campanha → `404` `"Página não encontrada"` — indistinguível.
  Nesta fatia **não há** estado "visível-antes vs nunca-visível" (sem
  histórico de acesso); a fronteira honesta chega com a fatia de
  publicações.
- `contatos` como visibilidade de conteúdo **não existe** nesta fatia —
  toda página publicada é legível por qualquer leitor autorizado (D2/D5).

## Fora de escopo (fatias seguintes do #366)

Notícias, classificados, perfil público (W9/W10), pesquisa multi-escopo
(W2), denúncias, anonimato por tipo, perfil pós-morte, investigação
(W11), criação/edição/publicação (DP de produto pendente), menu editor,
histórico/rollback de versões (D3 → `version`+audit basta por ora).

## Dados

- `internet_sites`: `id, campaign_id, slug (único/campanha), nome,
  descricao, owner_conta_id → internet_accounts, status
  (ativo|arquivado), created_at, updated_at`.
- `internet_pages`: `id, site_id → sites (cascade), campaign_id,
  slug (único/site), titulo, corpo, formato (texto|markdown-subset),
  status (rascunho|publicado|retirado|arquivado), version,
  autor_conta_id → internet_accounts, published_at, created_at,
  updated_at`.
- Migração `0043` puramente aditiva; `internet_pages`/`internet_sites`
  registradas em `TABELAS_ANTIGAS` de `teste-restauracao-boot.mjs`.
