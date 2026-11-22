# Issue #65 — matriz de permissões por escopo

Documento de auditoria inicial para a hierarquia de contas. Esta etapa **não altera schema, migrations, rotas ou sessões**. O objetivo é congelar a separação entre conta/plataforma, guilda e campanha antes de qualquer mudança de código.

## Estado autoritativo observado na `main`

- `users.isAdmin` + `admin_principal`: privilégio global de plataforma.
- `memberships.role`: papel **por campanha** (`mestre`, `jogador`, `espectador`).
- `guild_members.role`: papel **por guilda** (inclui `gm`).
- `requirePapel()`: exige membership de campanha e não transforma ADMIN/GM em mestre.
- `requireGuildAcesso()` / `requireGuildGestao()`: guards próprios de guilda.
- Campanhas podem ter `guildId = null`; vínculo de guilda não cria membership de campanha.

## Vocabulário e escopos

| Escopo | Identidade | Fonte de autoridade | O que **não** concede automaticamente |
| --- | --- | --- | --- |
| Conta/plataforma | usuário comum, ADMIN, ADMIN principal | `users.isAdmin`, `admin_principal` | papel de campanha, GM de qualquer guilda, acesso a dados privados |
| Guilda | membro, GM | `guild_members` + estado da guilda | papel de campanha, acesso a campanha sem membership |
| Campanha | mestre, jogador, espectador, status da membership | `memberships` | GM/ADMIN, acesso a outra campanha |

## Matriz mínima de autorização

Legenda: **A** = permitido; **C** = permitido com condição/guard; **N** = negar.

### Conta/plataforma

| Ação | Usuário comum | ADMIN | ADMIN principal |
| --- | ---: | ---: | ---: |
| Ler/editar o próprio perfil | A | A | A |
| Listar contas no painel ADMIN | N | A | A |
| Bloquear/desbloquear conta comum | N | C | C |
| Conceder/revogar ADMIN | N | N | C |
| Bloquear/excluir/rebaixar o ADMIN principal | N | N | N |
| Consultar configuração global administrativa | N | A | A |

**Condições obrigatórias:** promoção/revogação de ADMIN deve ser exclusiva do ADMIN principal, auditada e com revogação de sessões quando o privilégio diminuir.

### Guilda

| Ação | Não membro | Membro comum | GM da guilda | GM de outra guilda | ADMIN sem membership |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ler dados da guilda | N | C | A | N | C |
| Listar membros da guilda | N | C | A | N | C |
| Convidar/remover membro | N | N | A | N | N |
| Conceder/revogar GM | N | N | C | N | N |
| Criar/vincular campanha à guilda | N | N | C | N | N |
| Arquivar/transferir guilda | N | N | C | N | C |

**Condições obrigatórias:** escopo sempre validado pelo `guildId`; impedir remoção/rebaixamento do último GM ativo; GM não concede ADMIN e não obtém acesso privado de campanha por herança.

### Campanha

| Ação | Sem membership | Espectador | Jogador | Mestre | ADMIN/GM sem membership |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ver campanha listada para si | N | A | A | A | N |
| Ver conteúdo compartilhado | N | A | A | A | N |
| Editar a própria ficha | N | N | C | C | N |
| Administrar participantes | N | N | N | A | N |
| Alterar regras/configuração da mesa | N | N | N | A | N |
| Executar ação de mesa protegida | N | C | C | A | N |
| Ler campo privado de outro participante | N | C | C | C | N |

**Condições obrigatórias:** cada rota de campanha deve resolver a membership da campanha-alvo; esconder botão no frontend não substitui a verificação no backend.

## Mapeamento de guards e rotas auditadas

| Área | Guard/serviço observado | Regra que deve ser preservada |
| --- | --- | --- |
| Painel ADMIN | `requireAdmin` | ADMIN global; não implica membership de campanha |
| Rotas de campanha | `requireAuth` + `requirePapel` / `getMembership` | papel é da campanha-alvo |
| Rotas de guilda | `requireAuth` + `requireGuildAcesso` / `requireGuildGestao` | GM só administra a guilda autorizada |
| Tempo real | revalidação no backend + notificações de usuário | evento não substitui autorização; cliente deve reler dados |
| Auditoria | `audit()` nas mutações administrativas | promoção/revogação e mudanças de escopo devem deixar trilha |

## Casos negativos que devem virar testes antes de migrations

1. GM da Guilda A tenta ler/editar Guilda B: negar sem vazamento.
2. GM tenta usar `guildId` ou `role` forjado para virar mestre de campanha.
3. ADMIN sem membership tenta ler ficha privada ou executar ação de mesa.
4. Usuário comum tenta promover a si mesmo a GM/ADMIN por REST, socket ou payload.
5. ADMIN não principal tenta conceder/revogar ADMIN.
6. Remoção/rebaixamento do último GM ativo.
7. Revogação de privilégio invalida sessão/socket e impede ação já aberta.
8. Usuário com papéis diferentes em três campanhas mantém isolamento entre elas.

## Próxima fatia segura

A próxima PR de código deve ser independente e pequena: transformar os casos negativos acima em uma suíte de autorização contra banco temporário, sem migration e sem alterar contratos públicos. Só depois da cobertura verde deve-se iniciar qualquer mudança estrutural em guildas/ADMIN.
