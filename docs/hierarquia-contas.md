# Hierarquia de contas — matriz de permissões (Issue #65)

O Mestre RPG separa **três escopos independentes**. Nenhum substitui o outro:

| Escopo | Onde vive | Valores |
|---|---|---|
| Papel de conta/plataforma | `users.is_admin` + `admin_principal` | usuário comum · **ADMIN** · **ADMIN principal** |
| Guilda | `guild_members.role` | sem vínculo · **membro** · **GM** |
| Campanha | `memberships.role` | sem vínculo · **ESPECTADOR** · **JOGADOR** · **MESTRE** |

Um mesmo usuário pode ser MESTRE na Campanha A, JOGADOR na B, ESPECTADOR na
C, GM da Guilda X e ADMIN global — simultaneamente, sem conflito.

## Regras estruturais

- **Admin global não vira mestre.** ADMIN/GM sem `membership` ativa não
  acessam dados privados nem executam ações de mesa. `requirePapel()` exige
  membership ativo — não há bypass por privilégio.
- **GM não vira mestre.** Ser GM de uma guilda não concede papel de campanha;
  designar mestres continua sendo ato do mestre da campanha (ou do ADMIN em
  operações administrativas auditadas).
- **Papel de campanha não escala para guilda.** MESTRE de campanha não ganha
  gestão de guilda; só `guild_members.role = 'gm'` (ou ADMIN) gerencia.
- **Nunca aceitar privilégio de payload público.** Convites e cadastro só
  criam jogador/espectador; `isAdmin`, `role=gm` e vínculos de guilda só são
  gravados por rotas autenticadas com autorização própria.

## Matriz — conta/plataforma

| Ação | Usuário comum | GM (sem ADMIN) | ADMIN | ADMIN principal |
|---|---|---|---|---|
| Criar conta própria (convite) | sim | sim | sim | sim |
| Gerir usuários (listar/criar/bloquear) | não | não | sim | sim |
| Conceder/revogar **ADMIN** | não | não | **não** | **sim** |
| Bloquear/excluir o ADMIN principal | não | não | não | não (protegido por trigger + API) |
| Rebaixar a si mesmo (qualquer escopo) | — | — | conta própria bloqueada pela API | conta própria bloqueada pela API |
| Painel de guildas (listar todas) | só as suas | só as suas | todas | todas |
| Configuração global do servidor | não | não | sim | sim |

## Matriz — guilda (escopo `guild_members`)

| Ação | Não-membro | Membro | GM da guilda | GM de OUTRA guilda | ADMIN |
|---|---|---|---|---|---|
| Ver a guilda / roster / campanhas | não | sim | sim | **não (403)** | sim |
| Criar guilda | — vira GM fundador | — | — | — | — |
| Editar nome/descrição/status | não | não | sim | não | sim |
| Adicionar/remover membro | não | não | sim | não | sim |
| Promover/rebaixar GM | não | não | sim | não | sim |
| Remover/rebaixar **último GM ativo** | não | não | **recusado (409)** até haver sucessão | não | recusado igual |
| Vincular campanha **sem guilda** à guilda | não | não | sim **+** ser mestre/owner da campanha | não | sim |
| Mover campanha entre guildas / desvincular | não | não | não | não | sim |
| Criar campanha já dentro da guilda | não | não | sim | não | sim |

## Matriz — campanha (escopo `memberships`)

Inalterada em relação ao modelo anterior (spec §3/§21):

| Papel | Ações típicas |
|---|---|
| ESPECTADOR | somente conteúdo compartilhado; ações por permissão individual |
| JOGADOR | joga, edita a própria ficha/patrimônio conforme regras |
| MESTRE | administra campanha, sessão, mesa, fichas e permissões |

`ADMIN` e `GM` **não aparecem** na gestão de participantes da campanha —
visibilidade de escopo em todas as telas ("GM — Guilda X", "ADMIN").

## Proteções em profundidade

- **Banco (triggers, migração 0023):** `admin_principal` imutável; UPDATE em
  `users` não pode rebaixar o principal nem criar admin sem identidade
  protegida; INSERT direto de `is_admin=1` bloqueado (grant só via UPDATE
  mediado pela API); DELETE do principal bloqueado.
- **API:** `PATCH /admin/users/:id` com `isAdmin` exige ser o principal;
  revogação de ADMIN derruba sessões HTTP e sockets do usuário na hora.
- **Último GM:** `contarGMs()` recusa remover/rebaixar o último GM ativo
  (409) até que outro membro seja promovido.
- **Auditoria:** `audit_logs` registra `admin.conceder`, `admin.revogar`,
  `guilda.criar`, `guilda.atualizar`, `guilda.membro.*`,
  `guilda.campanha.vincular/desvincular` com `actor_id` e `guild_id`.

## Rotas

- `GET/POST /api/guildas` · `GET/PATCH /api/guildas/:guildId`
- `GET/POST /api/guildas/:guildId/membros` · `PATCH/DELETE .../membros/:userId`
- `GET /api/guildas/:guildId/campanhas` · `PUT .../campanhas/:campaignId`
- `GET /api/guildas?todas=1` (somente ADMIN)
- `PATCH /api/admin/users/:id` agora aceita `isAdmin` (somente principal)
- `GET /api/auth/me` e login/registro devolvem `adminPrincipal` + `guildas[]`
