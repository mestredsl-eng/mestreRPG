# Contrato — Internet pública 1.1.2, fatia W1/W3 (#365)

Base original do slice: `main@36f6b23` + migração `0043` (`internet_sites`, `internet_pages`). W1/W3 integrados em `main@4289adafe23d7343e083c02443ff09626a463726` pela PR #388.
Escopo desta fatia: **somente leitura** — diretório de sites, detalhe de
site e leitura de página. Criação/edição de sites e páginas NÃO existe
nesta fatia read-only. O ownership para futuras fatias foi decidido em
27/11/2026 (D14): personagem elegível cria/possui e administra seu site;
cada autor edita suas páginas; Mestre pode moderar/arquivar, sem reescrever
conteúdo alheio.

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
(W11), criação/edição/publicação (D14 decidido; escrita pertence a fatias futuras), menu editor,
histórico/rollback de versões (D3 fechado: `version` incremental + auditoria,
sem revisões recuperáveis nem rollback).

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


## Decisões consolidadas para as próximas fatias — 27/11/2026

As decisões abaixo são vinculantes para o produto 1.1.2. Não alteram
retroativamente o escopo read-only da PR #388; as rotas de escrita serão
entregues em fatias verticais próprias.

### D14 — ownership de sites e páginas (A)

- Um personagem elegível cria seu próprio site; o dono administra os
  metadados e a configuração permitida do site.
- Cada página possui autor próprio; somente esse autor edita o conteúdo
  da página.
- O proprietário do site não ganha permissão para reescrever páginas de
  outros autores.
- Mestre pode moderar/arquivar o site ou conteúdo, mas não reescrever
  conteúdo alheio.
- Ownership e autoria acompanham o personagem conforme a regra de
  transferência P7, não a identidade humana do titular anterior.
- Antes da implementação, PAI/Técnico Geral devem conferir como a conta
  Internet e `owner_conta_id` atual se comportam na transferência P7.
  Escolher a representação persistida que mantém o vínculo canônico ao
  personagem; não mudar o significado da decisão.

### D3 — versionamento (A)

- Cada edição aceita incrementa `version` e grava evento de auditoria
  com autor/personagem, ator autenticado, horário e versão resultante.
- Não criar tabela de revisões recuperáveis, histórico navegável,
  endpoint de restauração ou rollback de conteúdo.
- A auditoria não deve virar cópia oculta recuperável do corpo anterior.

### D6 — export/import da campanha (A)

- Exportar/importar o domínio público completo da campanha: sites, páginas,
  notícias, posts, anúncios/classificados, perfis, rascunhos, estados,
  visibilidade, denúncias/contestação e metadados necessários para
  reconstruir o comportamento.
- Mensagens privadas, conversas, presença/digitação e demais dados do
  mensageiro privado não entram no export/import da campanha.
- Preservar relações por personagem, estados, autoria permitida, datas,
  expiração e isolamento entre campanhas; mapear IDs sem colisão no destino.
- **Privacidade de anonimato**: exportação de campanha não pode revelar
  o vínculo de identidade real de publicação anônima. Manter somente os
  dados necessários ao comportamento público/moderação, respeitando DP-1
  e DP-6; não serializar campo secreto de desanonimização para o pacote
  entregue ao Mestre.
- Backup integral do servidor permanece distinto e protege o banco
  completo conforme seu próprio contrato operacional.

### D8 — publicação jornalística (C)

- A biblioteca inicial já contém a profissão existente
  `profissao:jornalista` em `servidor/src/lib/seed-regras.ts`; o tipo
  `profissao` consta de `TIPOS_REGRA` em `servidor/src/lib/regras.ts`.
- A estrutura de ficha de referência contém o campo **Profissão**,
  `tipo: selecao_unica`, `regraKind: "profissao"` em
  `fixtures/estrutura-cacadores-dump.json`; `regraKind` vincula as
  opções à biblioteca do respectivo tipo em `servidor/src/lib/ficha.ts`.
- Elegibilidade jornalística do personagem: valor/chave estável
  `jornalista` no campo de Profissão da ficha, validado contra a definição
  `profissao:jornalista` ainda existente no ruleset ativo da campanha.
  A consulta ocorre server-side; não aceitar label/texto livre ou profissão
  informada pelo cliente como prova.
- Mestre também pode publicar conteúdo jornalístico, independentemente
  do gate de profissão do personagem, conforme a decisão C.
- Não criar classe, perícia, conhecimento, habilidade, atributo,
  especialização ou profissão nova chamada jornalista. Usar a profissão
  existente; não semear/reativar a definição automaticamente se o Mestre
  a tiver removido ou desativado na campanha.
- `profissao:investigador` também consta da biblioteca, mas não concede
  automaticamente permissão jornalística; a elegibilidade D8 escolhida
  é `profissao:jornalista`.
- Referências de código:
  - [seed de profissões](../servidor/src/lib/seed-regras.ts#L96)
  - [tipo de regra](../servidor/src/lib/regras.ts#L23-L29)
  - [campo de ficha por ruleKind](../servidor/src/lib/ficha.ts#L92-L93)
  - [campo Profissão da estrutura de referência](../fixtures/estrutura-cacadores-dump.json#L8-L19)

### D9 — contato em anúncios (A)

- A ação "Contatar" cria/usa a solicitação de contato do sistema existente.
- A conversa existente só abre depois do aceite do destinatário.
- Bloqueio bilateral, rejeição, pendência e privacidade continuam sob as
  regras do mensageiro 1.1.1.
- Nenhuma conversa direta nem segundo mecanismo de chat.

### D11 — validade de anúncios (A)

- `expiresAt` é opcional e escolhido pelo autor na publicação/edição
  permitida.
- Sem `expiresAt`, o anúncio permanece ativo até retirada/moderação.
- Estado expirado é derivado pela comparação do instante atual com
  `expiresAt` no momento da leitura/listagem; não criar cron/job de
  expiração em background.

### D12 — pesquisa (A)

- Escopos indexados: sites, páginas, notícias, anúncios/classificados e
  perfis públicos.
- Perfil é localizado por `handle`; `displayName` não participa do
  índice.
- Visibilidade e autorização são aplicadas antes de calcular resultados,
  snippets, totais, ordenação ou paginação. Conteúdo invisível não pode
  influenciar contagens, ranking, cursor ou mensagens de erro.
- O gate de Internet, a separação por campanha e os controles de
  visibilidade existentes continuam obrigatórios.

### Forma do produto

A camada pública é uma plataforma integrada dentro da Internet diegética:
Explorar reúne sites, páginas, pesquisa, notícias, perfis/posts e
classificados; Mensagens e Lojas/Vender/Pedidos reutilizam os módulos
privados e comerciais já existentes. Não criar app/browser/login,
mensageiro, checkout ou armazenamento paralelo.
