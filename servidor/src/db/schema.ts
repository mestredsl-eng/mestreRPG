import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Schema do Mestre RPG — fundação (Etapa 1).
 *
 * Princípio: tabelas estruturais têm colunas; o CONTEÚDO de regras e fichas
 * fica em colunas JSON validadas por Zod no servidor. Isso permite que o mestre
 * crie atributos, habilidades, poderes, vantagens, campos de ficha etc. sem
 * nenhuma alteração de banco — a plataforma fornece as ferramentas, o mestre
 * define o RPG (spec §6, §7, §34).
 */

const id = () => text("id").primaryKey();
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull();
const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).notNull();

// Papéis globais de conta (spec §3): admin do servidor; mestre/jogador/espectador
// são papéis POR CAMPANHA em `memberships`.
export const users = sqliteTable("users", {
  id: id(),
  username: text("username").notNull(),
  email: text("email"),
  displayName: text("display_name"),
  passwordHash: text("password_hash").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("ativo"), // ativo|bloqueado
  // Preferências visuais do usuário (JSON): ex. { dados: { corExterna, corInterna } }
  preferences: text("preferences", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_username_idx").on(t.username)]);

// Identidade imutável do administrador principal (v1.0): uma única linha
// apontando para o usuário que nasceu como admin da instalação. Triggers em
// `users` e nesta tabela (migração 0013) impedem promoção, rebaixamento,
// exclusão e alteração do identificador protegido.
export const adminPrincipal = sqliteTable("admin_principal", {
  userId: text("user_id").primaryKey().references(() => users.id),
  createdAt: createdAt(),
});

// Sessões de autenticação persistentes (cookie httpOnly → token hash).
// Distinta de `sessions` (sessões de jogo da campanha, spec §20).
export const authSessions = sqliteTable("auth_sessions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("auth_sessions_token_idx").on(t.tokenHash), index("auth_sessions_user_idx").on(t.userId)]);

// ---------- Guildas e GUILD MASTER (Issue #65) ----------
// Escopo intermediário entre conta e campanha: o GM administra membros,
// convites internos e associação de campanhas DA(S) SUA(S) GUILDA(S).
// NÃO é papel de campanha nem privilégio global — os três escopos são
// independentes (ver docs/hierarquia-contas.md). Declarado antes de
// `campaigns` porque a tabela referencia guilds.id.
export const guilds = sqliteTable("guilds", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("ativa"), // ativa|arquivada
  createdBy: text("created_by").notNull().references(() => users.id),
  // Responsável administrativo atual — transferível via API; NUNCA é
  // confundido com created_by (autoria histórica imutável) nem com o
  // papel GM de guild_members (vários GMs podem coexistir).
  responsibleUserId: text("responsible_user_id").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("guilds_name_idx").on(t.name)]);

// Vínculo usuário↔guilda. role: gm|membro — uma guilda pode ter vários
// GMs ativos; a remoção do último GM ativo é bloqueada pela API até que
// outro membro seja promovido (proteção no serviço, não no schema).
export const guildMembers = sqliteTable("guild_members", {
  id: id(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("membro"), // gm|membro
  status: text("status").notNull().default("ativo"), // ativo|removido
  joinedAt: integer("joined_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("guild_members_guild_user_idx").on(t.guildId, t.userId),
  index("guild_members_user_idx").on(t.userId),
]);

// Convites internos de guilda (Issue #65): código secreto nunca persistido
// em claro — apenas o hash SHA-256 (mesmo padrão de `invitations.code`).
// Concessão exclusiva do papel `membro`; nunca GM/ADMIN.
export const guildInvites = sqliteTable("guild_invites", {
  id: id(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  code: text("code").notNull(), // SHA-256 hex do código apresentado
  createdBy: text("created_by").notNull().references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  maxUses: integer("max_uses").notNull(),
  uses: integer("uses").notNull().default(0),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("guild_invites_code_idx").on(t.code),
  index("guild_invites_guild_idx").on(t.guildId),
]);

export const campaigns = sqliteTable("campaigns", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  system: text("system"), // sistema de RPG em texto livre (ex.: "Caçadores & Caçados")
  coverImage: text("cover_image"), // caminho do arquivo de capa em arquivos/campanhas/
  summary: text("summary"), // resumo geral escrito pelo mestre (Etapa 8)
  status: text("status").notNull().default("preparacao"), // preparacao|andamento|pausada|concluida|arquivada (spec §19.5)
  ownerId: text("owner_id").notNull().references(() => users.id),
  // Guilda à qual a campanha está vinculada (Issue #65). null = campanha
  // pessoal/legada sem guilda — permanece válida e fora do escopo de GM.
  guildId: text("guild_id").references(() => guilds.id),
  // Regras/configurações da campanha em JSON (custos, limites, pontuação — spec §8)
  settings: text("settings", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("campaigns_owner_idx").on(t.ownerId)]);

// Participante de uma campanha com papel local (spec §3, §21)
export const memberships = sqliteTable("memberships", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // mestre|jogador|espectador
  // Permissões granulares do espectador/jogador em JSON (spec §21.2)
  permissions: text("permissions", { mode: "json" }).notNull().default({}),
  status: text("status").notNull().default("ativo"), // ativo|bloqueado|removido
  joinedAt: integer("joined_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("memberships_campaign_user_idx").on(t.campaignId, t.userId),
  index("memberships_user_idx").on(t.userId),
]);

// Convites por link/código (spec §4)
export const invitations = sqliteTable("invitations", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  role: text("role").notNull().default("jogador"), // jogador|espectador
  createdBy: text("created_by").notNull().references(() => users.id),
  maxUses: integer("max_uses"),
  uses: integer("uses").notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(false),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("invitations_code_idx").on(t.code)]);

// Modelos de ficha reutilizáveis e versionados (spec §6.5)
// `structure` = JSON com seções, subseções e definições de campos (tipos da §6.2)
export const sheetTemplates = sqliteTable("sheet_templates", {
  id: id(),
  // null = modelo global da conta; preenchido = modelo da campanha (spec §3)
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id").notNull().references(() => users.id),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false), // modelo para novos personagens
  currentVersionId: text("current_version_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("sheet_templates_campaign_idx").on(t.campaignId)]);

export const sheetVersions = sqliteTable("sheet_versions", {
  id: id(),
  templateId: text("template_id").notNull().references(() => sheetTemplates.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  structure: text("structure", { mode: "json" }).notNull(), // seções/campos/tipos/regras de exibição
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

// Personagens — `data` guarda os valores dos campos conforme o template (spec §6)
export const characters = sqliteTable("characters", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
  templateVersionId: text("template_version_id").references(() => sheetVersions.id),
  name: text("name").notNull(),
  // Valores dos campos em JSON; chaves = ids dos campos do template
  data: text("data", { mode: "json" }).notNull().default({}),
  // Ajustes por personagem definidos pelo mestre: visibilidade/edição por campo (spec §8)
  overrides: text("overrides", { mode: "json" }).notNull().default({}),
  status: text("status").notNull().default("rascunho"), // rascunho|aguardando_aprovacao|devolvida|reaberta|aprovada|bloqueada (spec §6.7)
  isNpc: integer("is_npc", { mode: "boolean" }).notNull().default(false), // personagem controlado pelo mestre (NPC/inimigo)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("characters_campaign_idx").on(t.campaignId)]);

// Campos calculados/valores avulsos de personagem (inventário, dinheiro etc. podem
// viver aqui ou nas tabelas dedicadas abaixo — o mestre decide via template)
export const characterFields = sqliteTable("character_fields", {
  id: id(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  fieldKey: text("field_key").notNull(),
  value: text("value", { mode: "json" }),
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("character_fields_char_key_idx").on(t.characterId, t.fieldKey)]);

// Conjuntos de regras customizáveis por campanha (spec §7, §8)
// `definition` JSON: atributos, talentos, conhecimentos, profissões, poderes,
// vantagens, defeitos, tabelas de custo, pré-requisitos, exclusividades.
export const ruleSets = sqliteTable("rule_sets", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  // Configuração do motor de regras: pontos, reservas, custos, auto-aprovação etc. (spec §5, §9)
  config: text("config", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const ruleDefinitions = sqliteTable("rule_definitions", {
  id: id(),
  ruleSetId: text("rule_set_id").notNull().references(() => ruleSets.id, { onDelete: "cascade" }),
  // tipo: atributo|conhecimento|habilidade|profissao|poder|vantagem|defeito|talento|moeda|item...
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  category: text("category"), // ex.: Ciências, Tecnologia, Mecânica (biblioteca §7.2)
  parentKey: text("parent_key"), // especialização → habilidade pai (§7.3)
  definition: text("definition", { mode: "json" }).notNull().default({}), // custos, bônus, pré-reqs, exclusividades
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("rule_definitions_set_kind_key_idx").on(t.ruleSetId, t.kind, t.key)]);

// ---------- Acervo global de livros de regras (independente de campanha) ----------
// Livros e suplementos agrupam elementos de regras (kind/key/definition
// flexíveis — estendem os tipos da biblioteca por campanha sem substituí-la).

export const ruleBooks = sqliteTable("rule_books", {
  id: id(),
  titulo: text("titulo").notNull(),
  descricao: text("descricao"),
  autor: text("autor"),
  sistema: text("sistema"),
  edicao: text("edicao"),
  tipo: text("tipo").notNull().default("livro"), // livro|suplemento
  versao: integer("versao").notNull().default(1), // revisão interna do conteúdo
  formatoVersao: integer("formato_versao").notNull().default(1), // versão do envelope de import/export
  origem: text("origem").notNull().default("manual"), // manual|importado
  // Soft delete: livro "excluído" sai das consultas mas mantém itens e
  // backups — exclusão definitiva só via DELETE ?definitivo=1.
  excluidoEm: integer("excluido_em", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("rule_books_titulo_idx").on(t.titulo)]);

export const ruleBookItems = sqliteTable("rule_book_items", {
  id: id(),
  bookId: text("book_id").notNull().references(() => ruleBooks.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // tipo extensível: atributo|habilidade|regra_combate|tabela|...
  key: text("key").notNull(),
  name: text("name").notNull(),
  category: text("category"),
  parentKey: text("parent_key"),
  definition: text("definition", { mode: "json" }).notNull().default({}),
  ordem: integer("ordem").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("rule_book_items_book_kind_key_idx").on(t.bookId, t.kind, t.key),
  index("rule_book_items_book_idx").on(t.bookId),
]);

// Snapshots completos do livro (metadados + itens) antes de atualizações
// em massa — base do mecanismo de reversão do acervo.
export const ruleBookBackups = sqliteTable("rule_book_backups", {
  id: id(),
  bookId: text("book_id").notNull().references(() => ruleBooks.id, { onDelete: "cascade" }),
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  motivo: text("motivo").notNull(),
  createdAt: createdAt(),
}, (t) => [index("rule_book_backups_book_idx").on(t.bookId)]);

// Aplicação explícita de livros do Acervo em campanhas (snapshot, nunca vínculo vivo).
export const campaignRuleBooks = sqliteTable("campaign_rule_books", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  bookId: text("book_id").notNull().references(() => ruleBooks.id, { onDelete: "cascade" }),
  appliedVersion: integer("applied_version").notNull(),
  // Snapshot da origem no momento da aplicação; permite diff/sync futuro sem
  // confundir regras personalizadas da campanha com conteúdo do Acervo.
  snapshot: text("snapshot", { mode: "json" }).notNull().default([]),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("campaign_rule_books_campaign_book_idx").on(t.campaignId, t.bookId),
  index("campaign_rule_books_campaign_idx").on(t.campaignId),
]);

// Inventário dentro da ficha (spec §9.1)
export const inventoryEntries = sqliteTable("inventory_entries", {
  id: id(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: real("quantity").notNull().default(1),
  description: text("description"),
  category: text("category"),
  location: text("location"), // onde está guardado
  condition: text("condition"), // estado de conservação
  weight: real("weight"),
  data: text("data", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("inventory_entries_char_idx").on(t.characterId)]);

// Equipamentos na ficha (spec §9.2)
export const equipmentEntries = sqliteTable("equipment_entries", {
  id: id(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind"), // arma|protecao|roupa|ferramenta|eletronico|especial...
  slot: text("slot"),
  equipped: integer("equipped", { mode: "boolean" }).notNull().default(false),
  description: text("description"),
  data: text("data", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("equipment_entries_char_idx").on(t.characterId)]);

// Catálogo de itens gerenciado pelo mestre (Etapa 6, spec §3/§13)
export const itemTemplates = sqliteTable("item_templates", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  description: text("description"),
  // dados padrão aplicados ao criar item do catálogo: peso, valor, etc.
  data: text("data", { mode: "json" }).notNull().default({}),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("item_templates_camp_idx").on(t.campaignId)]);

// Contas financeiras fictícias do personagem (Etapa 6, spec §7):
// especie | banco | cartao_debito | cartao_credito | pre_pago | pix | outro
export const financialAccounts = sqliteTable("financial_accounts", {
  id: id(),
  // Titular da conta: exatamente um de characterId/shopId (invariante de
  // aplicação — o schema não usa CHECK). characterId nullable desde 1.1.0
  // para contas de estabelecimento (Issue #286).
  characterId: text("character_id").references(() => characters.id, { onDelete: "cascade" }),
  shopId: text("shop_id").references(() => shops.id),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  institution: text("institution"), // banco/emissor fictício
  agency: text("agency"),
  accountNumber: text("account_number"), // fictício — nunca dado real
  holder: text("holder"),
  currency: text("currency").notNull().default("BRL"),
  balanceCents: integer("balance_cents").notNull().default(0), // centavos — sem float
  creditLimitCents: integer("credit_limit_cents"), // cartões de crédito
  data: text("data", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("fin_accounts_char_idx").on(t.characterId)]);

// Veículos do personagem (Etapa 6, spec §6)
export const vehicles = sqliteTable("vehicles", {
  id: id(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind"), // carro|moto|caminhao|barco|heli|aviao|militar|futurista...
  brand: text("brand"),
  model: text("model"),
  year: integer("year"),
  color: text("color"),
  plate: text("plate"),
  serialNumber: text("serial_number"),
  condition: text("condition"),
  valueCents: integer("value_cents"),
  fuel: text("fuel"),
  capacity: text("capacity"),
  ownership: text("ownership").notNull().default("propriedade"), // propriedade|compartilhado
  data: text("data", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("vehicles_char_idx").on(t.characterId)]);

// Dinheiro fictício e transações (inclui "PIX fictício" — spec §9.3)
export const moneyTransactions = sqliteTable("money_transactions", {
  id: id(),
  // Titular da movimentação: characterId (conta de personagem) ou shopId
  // (conta de estabelecimento). shopId é preenchido em AMBAS as pernas de
  // uma operação que envolve loja, para consultas do caixa por loja.
  characterId: text("character_id").references(() => characters.id, { onDelete: "cascade" }),
  shopId: text("shop_id").references(() => shops.id),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  // tipo: saldo_inicial|entrada|saida|pix_ficticio|ajuste_mestre|transferencia
  kind: text("kind").notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("BRL"),
  account: text("account"), // especie|banco|pix_ficticio|outro
  counterparty: text("counterparty"), // NPC, outro personagem, loja etc.
  counterpartyCharacterId: text("counterparty_character_id").references(() => characters.id),
  accountId: text("account_id").references(() => financialAccounts.id),
  description: text("description"),
  // Precisão monetária em centavos + saldos para auditoria (spec §8/§14)
  amountCents: integer("amount_cents"),
  balanceBeforeCents: integer("balance_before_cents"),
  balanceAfterCents: integer("balance_after_cents"),
  requestId: text("request_id"), // idempotência — impede duplicação
  // Vínculo explícito com a operação de patrimônio que gerou a
  // movimentação (compra/venda/estorno): requestId da operação, id do
  // item de inventário afetado e metadados necessários ao estorno.
  inventoryItemId: text("inventory_item_id"),
  operacao: text("operacao", { mode: "json" }),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  index("money_tx_char_idx").on(t.characterId),
  uniqueIndex("money_tx_request_idx").on(t.campaignId, t.requestId),
]);

// Registro persistente de estornos de operações de patrimônio que NÃO
// geram transação financeira (ex.: compra com pagar=false). Sem ele, a
// segunda tentativa de estorno não teria como distinguir "operação já
// estornada" de "operação inexistente" — o item já foi removido.
// O escopo de idempotência das operações sem pagamento é por
// PERSONAGEM (characterId + requestId), então a unicidade aqui também
// é por personagem: dois personagens podem usar o mesmo requestId e
// estornar independentemente. UNIQUE(campaign, character, operacao)
// torna o registro à prova de corrida.
export const operacaoEstornos = sqliteTable("operacao_estornos", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  operacaoId: text("operacao_id").notNull(), // requestId da operação estornada
  tipo: text("tipo").notNull(), // compra_sem_pagamento (futuros tipos aqui)
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("operacao_estorno_char_op_idx").on(t.campaignId, t.characterId, t.operacaoId),
]);

// Lotes de concessão de XP (Issue #185 item 3): registro idempotente por
// (campaignId, requestId). `itens` guarda o resultado por personagem
// (saldo resultante) para que um retry devolva exatamente o que foi
// gravado — sem duplicar saldo, histórico ou auditoria. `payloadHash`
// distingue retry idêntico (devolve resultado) de requestId reutilizado
// com payload divergente (409).
export const xpLotes = sqliteTable("xp_lotes", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  motivo: text("motivo").notNull(),
  itens: text("itens", { mode: "json" }).notNull(), // [{characterId, quantidade, saldoResultante}]
  totalPersonagens: integer("total_personagens").notNull(),
  totalXp: integer("total_xp").notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("xp_lote_request_idx").on(t.campaignId, t.requestId),
]);

// Estornos auditados de XP (Issue #185 item 1): idempotência por
// (characterId, requestId) — mesmo padrão de xp_lotes, escopo
// personagem. `resultado` guarda o que foi efetivado (nível revertido,
// XP creditado, saldo) para retry idêntico devolver o gravado sem
// duplicar evento; `payloadHash` distingue retry de requestId
// reutilizado com payload divergente (409).
export const xpEstornos = sqliteTable("xp_estornos", {
  id: id(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  resultado: text("resultado", { mode: "json" }).notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("xp_estorno_request_idx").on(t.characterId, t.requestId),
]);

// Sessões de jogo (spec §20)
export const sessions = sqliteTable("sessions", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  name: text("name"),
  summary: text("summary"), // resumo escrito pelo mestre
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("ativa"), // ativa|pausada|encerrada
  timerState: text("timer_state", { mode: "json" }), // temporizador sincronizado pelo servidor (Etapa 7)
  // Mesa virtual (mapa + tokens) — JSON por sessão, mesmo padrão do timerState
  vttState: text("vtt_state", { mode: "json" }),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("sessions_campaign_idx").on(t.campaignId),
  // Número da sessão é sequencial por campanha e exibido ao usuário —
  // criações simultâneas não podem gerar duplicatas.
  uniqueIndex("sessions_campaign_number_idx").on(t.campaignId, t.number),
]);

// Controle de turnos (spec §14) — estado atual da rodada em JSON
export const turns = sqliteTable("turns", {
  id: id(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  state: text("state", { mode: "json" }).notNull().default({}), // ordem, atual, pausado etc.
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

// Chat da campanha (spec §11) — visibility garante sigilo no servidor (§11.3, §24)
// visibility: publica|privada|mestre|sistema; `recipients` em JSON para privadas
export const chatMessages = sqliteTable("chat_messages", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  authorId: text("author_id").references(() => users.id), // null = mensagem do sistema
  kind: text("kind").notNull().default("texto"), // texto|teste|rolagem|evento|decisao
  content: text("content").notNull(),
  visibility: text("visibility").notNull().default("publica"),
  recipients: text("recipients", { mode: "json" }), // ids de usuários/memberships para privadas
  // Identidade vocal não substitui author_id, preservado para auditoria.
  // Sem FK intencional: o histórico sobrevive à remoção do personagem.
  speakerCharacterId: text("speaker_character_id"),
  speakerName: text("speaker_name"),
  speakerGender: text("speaker_gender"), // feminina|masculina|null
  createdAt: createdAt(),
}, (t) => [index("chat_campaign_idx").on(t.campaignId, t.createdAt)]);

// Rolagens de dados (spec §12) — resultado gravado no servidor, imutável para o jogador
export const rolls = sqliteTable("rolls", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  characterId: text("character_id").references(() => characters.id, { onDelete: "set null" }),
  userId: text("user_id").notNull().references(() => users.id),
  dice: text("dice", { mode: "json" }).notNull(), // [{sides:10,count:2}] — arquitetura permite novos dados (§12.1)
  results: text("results", { mode: "json" }).notNull(), // resultados individuais + totais
  reason: text("reason"), // motivo da rolagem
  visibility: text("visibility").notNull().default("publica"), // publica|privada|secreta (§12.4)
  requestId: text("request_id"), // idempotência do cliente
  createdAt: createdAt(),
}, (t) => [index("rolls_campaign_idx").on(t.campaignId, t.createdAt), uniqueIndex("rolls_request_idx").on(t.campaignId, t.requestId)]);

// Testes de habilidades (spec §13) — o sistema organiza e calcula; o mestre decide
export const tests = sqliteTable("tests", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  requestedBy: text("requested_by").notNull().references(() => users.id),
  // Habilidade/atributo usado, nível na ficha, bônus, penalidades, dados finais (§13.2, §13.5)
  skillRef: text("skill_ref", { mode: "json" }),
  modifiers: text("modifiers", { mode: "json" }).notNull().default({}),
  diceCount: integer("dice_count").notNull(),
  diceSides: integer("dice_sides").notNull().default(10),
  target: integer("target"), // mínimo de referência INTERNO — pode ficar oculto (§13.3)
  status: text("status").notNull().default("pendente"), // pendente|rolado|decidido|cancelado
  rollId: text("roll_id").references(() => rolls.id, { onDelete: "set null" }),
  outcome: text("outcome"), // sucesso|parcial|falha|falha_critica|personalizado (§13.4)
  outcomeNote: text("outcome_note"), // explicação narrativa do mestre
  visibility: text("visibility").notNull().default("publica"),
  requestId: text("request_id"), // idempotência do cliente
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("tests_campaign_idx").on(t.campaignId, t.createdAt), uniqueIndex("tests_request_idx").on(t.campaignId, t.requestId)]);

// Diário do jogador e anotações do mestre (spec §18) — visibilidade no servidor
export const notes = sqliteTable("notes", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => users.id), // dono da anotação
  characterId: text("character_id").references(() => characters.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("diario"), // diario|mestre (Etapa 8)
  category: text("category"),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  important: integer("important").notNull().default(0), // marcado como importante
  // visibilidade: privada|mestre|publica|selecionada; recipients em JSON (§18.4)
  visibility: text("visibility").notNull().default("privada"),
  recipients: text("recipients", { mode: "json" }),
  status: text("status").notNull().default("pendente"), // pendente|concluida
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("notes_campaign_idx").on(t.campaignId)]);

// Pastas da biblioteca de arquivos (Etapa 9)
export const folders = sqliteTable("folders", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  parentId: text("parent_id"), // null = raiz; referência fraca a folders.id (mesma campanha)
  name: text("name").notNull(),
  allowPlayerUploads: integer("allow_player_uploads", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index("folders_campaign_idx").on(t.campaignId)]);

// Arquivos da campanha (spec §22) — metadados; conteúdo em arquivos/campanhas/
export const files = sqliteTable("files", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  folderPath: text("folder_path").notNull().default("/"),
  folderId: text("folder_id"), // pasta lógica (Etapa 9); folderPath mantido por compatibilidade
  displayName: text("display_name"),
  description: text("description"),
  category: text("category"),
  status: text("status").notNull().default("aprovado"), // aprovado|pendente|rejeitado (uploads de jogadores)
  storageName: text("storage_name"), // nome físico seguro gerado no servidor
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  uploadedBy: text("uploaded_by").notNull().references(() => users.id),
  visibility: text("visibility").notNull().default("mestre"), // mestre|publica|selecionada
  recipients: text("recipients", { mode: "json" }),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
}, (t) => [index("files_campaign_idx").on(t.campaignId)]);

// Anexos de anotações do diário/mestre (Etapa 11) — vínculo nota ↔ arquivo da biblioteca
export const noteAttachments = sqliteTable("note_attachments", {
  id: id(),
  noteId: text("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("note_att_unique_idx").on(t.noteId, t.fileId),
  index("note_att_note_idx").on(t.noteId),
]);

// Backups (spec §23)
export const backups = sqliteTable("backups", {
  id: id(),
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }), // null = backup completo do servidor
  kind: text("kind").notNull().default("manual"), // automatico|manual|pre_restauracao
  filePath: text("file_path").notNull(),
  sizeBytes: integer("size_bytes"),
  note: text("note"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
});

// Pontos de recuperação da campanha (Etapa 8, spec §5)
export const snapshots = sqliteTable("snapshots", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("manual"), // manual|automatico|pre_restauracao
  description: text("description"),
  data: text("data", { mode: "json" }).notNull(), // estado completo da campanha em JSON
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index("snapshots_campaign_idx").on(t.campaignId, t.createdAt)]);

// Configurações globais do servidor (Etapa 10) — chave/valor JSON
export const serverSettings = sqliteTable("server_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

// Trilha de auditoria administrativa (spec §24)
export const auditLogs = sqliteTable("audit_logs", {
  id: id(),
  actorId: text("actor_id").references(() => users.id),
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  guildId: text("guild_id").references(() => guilds.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  detail: text("detail", { mode: "json" }),
  createdAt: createdAt(),
}, (t) => [index("audit_campaign_idx").on(t.campaignId, t.createdAt)]);

// ---------- Central de Novidades (Issue #42) ----------
// Publicações do administrador para todos os usuários autenticados.
// estado: rascunho (invisível fora do admin) | publicada.
// categoria: novidade | melhoria | correcao.
export const novidades = sqliteTable("novidades", {
  id: id(),
  titulo: text("titulo").notNull(),
  resumo: text("resumo"),
  conteudo: text("conteudo").notNull().default(""),
  versao: text("versao"),
  categoria: text("categoria").notNull().default("novidade"), // novidade|melhoria|correcao
  estado: text("estado").notNull().default("rascunho"), // rascunho|publicada
  publicadoEm: integer("publicado_em", { mode: "timestamp_ms" }),
  autorId: text("autor_id").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("novidades_estado_publicado_idx").on(t.estado, t.publicadoEm)]);

// Leitura individual por usuário — unique(novidade_id, user_id) impede
// duplicidade mesmo com marcações concorrentes (INSERT OR IGNORE).
export const novidadesLeituras = sqliteTable("novidade_leituras", {
  id: id(),
  novidadeId: text("novidade_id").notNull().references(() => novidades.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lidaEm: integer("lida_em", { mode: "timestamp_ms" }).notNull(),
}, (t) => [
  uniqueIndex("novidade_leitura_unica_idx").on(t.novidadeId, t.userId),
  index("novidade_leitura_user_idx").on(t.userId),
]);

// ---------- Comércio — lojas na Internet (Issue #286, release 1.1.0) ----------
// Estabelecimento comercial diegético. O caixa da loja vive em
// financial_accounts/money_transactions com shop_id (titular =
// estabelecimento, nunca personagem/NPC nem carteira do gestor).

export const shops = sqliteTable("shops", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"), // ex.: mercadoria, servicos, classificados
  location: text("location"), // descrição livre do estabelecimento
  description: text("description"),
  isOpen: integer("is_open", { mode: "boolean" }).notNull().default(true),
  data: text("data", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("shops_campaign_idx").on(t.campaignId)]);

// Gestores da loja: memberships (usuários) com papel de gestão. O mestre
// da campanha sempre tem bypass; gestor é jogador não-mestre explicitamente
// vinculado à loja.
export const shopManagers = sqliteTable("shop_managers", {
  id: id(),
  shopId: text("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("gestor"), // gestor|proprietario
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("shop_manager_unico_idx").on(t.shopId, t.membershipId),
  index("shop_manager_membership_idx").on(t.membershipId),
]);

// Oferta comercial da loja (vitrine). Estoque comercial próprio, separado do
// inventário do personagem; stockQty NULL = ilimitado.
export const shopOffers = sqliteTable("shop_offers", {
  id: id(),
  shopId: text("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  itemTemplateId: text("item_template_id").references(() => itemTemplates.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull().default("BRL"),
  stockQty: integer("stock_qty"), // NULL = ilimitado
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  data: text("data", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("shop_offers_shop_idx").on(t.shopId),
  index("shop_offers_campaign_idx").on(t.campaignId),
]);

// Pedido/recibo de compra na loja. Escopo idempotente aceito na matriz
// #289: campanha + usuário humano iniciador (createdBy) + direção
// (compra|venda_para_loja) + requestId — NÃO global por campanha.
export const shopOrders = sqliteTable("shop_orders", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  shopId: text("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  createdBy: text("created_by").notNull(), // user id do iniciador humano
  direction: text("direction").notNull(), // compra | venda_para_loja
  buyerCharacterId: text("buyer_character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  items: text("items", { mode: "json" }).notNull(), // [{offerId, name, qty, unitCents}]
  totalCents: integer("total_cents").notNull(),
  currency: text("currency").notNull().default("BRL"),
  status: text("status").notNull().default("concluido"), // concluido|estornado
  moneyTransactionIds: text("money_transaction_ids", { mode: "json" }).notNull().default([]),
  data: text("data", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("shop_order_request_idx").on(t.campaignId, t.createdBy, t.direction, t.requestId),
  index("shop_orders_shop_idx").on(t.shopId),
  index("shop_orders_buyer_idx").on(t.buyerCharacterId),
]);

// ---------- Internet diegética — contas e mensagens (Issue #349/#350, v1.1.1) ----------
// Escopo aprovado P1–P12 (contrato docs/ISSUE-349-ARQUITETURA-CONTRATO.md):
// conta opt-in 1:1 por personagem, contatos por aresta dirigida, conversas
// diretas/grupo e mensagens persistentes. NUNCA entram em exportação de
// campanha (P9) — exportarCampanha enumera tabelas explicitamente e estas
// ficam de fora por omissão deliberada. P13: sem rotina de expurgo — o
// createdAt indexado permite o job futuro sem migration destrutiva.

// Conta diegética: uma por personagem (opt-in do titular). O handle é
// legível e normalizado, único por campanha; a identidade real nunca
// aparece — autorização sempre resolve personagem→membership→userId.
export const internetAccounts = sqliteTable("internet_accounts", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  handle: text("handle").notNull(), // normalizado: minúsculas, [a-z0-9._-]
  displayName: text("display_name"),
  status: text("status").notNull().default("ativa"), // ativa|inativa|arquivada
  // P11 — perfil público mínimo: presença e "digitando" desligados por padrão
  mostrarPresenca: integer("mostrar_presenca", { mode: "boolean" }).notNull().default(false),
  mostrarDigitando: integer("mostrar_digitando", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("internet_accounts_handle_idx").on(t.campaignId, t.handle),
  uniqueIndex("internet_accounts_char_idx").on(t.characterId),
  index("internet_accounts_campaign_idx").on(t.campaignId),
]);

// Contato = aresta DIRIGIDA origem→destino (pedido unilateral, P2).
// `bloqueado` tem efeito bilateral de facto (P3): a checagem de envio
// olha as duas direções. Remoção/recusa apagam a aresta — o histórico
// das conversas é preservado (P12) e fica na auditoria.
export const internetContacts = sqliteTable("internet_contacts", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  contaOrigemId: text("conta_origem_id").notNull().references(() => internetAccounts.id, { onDelete: "cascade" }),
  contaDestinoId: text("conta_destino_id").notNull().references(() => internetAccounts.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pendente"), // pendente|aceito|bloqueado
  // P3 (deliberação do proprietário): qualquer ponta da aresta pode
  // iniciar o bloqueio — este campo registra QUAL conta o iniciou
  // (auditoria + autorização de remoção). NULL fora de `bloqueado`.
  bloqueadoPorContaId: text("bloqueado_por_conta_id").references(() => internetAccounts.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("internet_contacts_aresta_idx").on(t.campaignId, t.contaOrigemId, t.contaDestinoId),
  index("internet_contacts_origem_idx").on(t.contaOrigemId),
  index("internet_contacts_destino_idx").on(t.contaDestinoId),
]);

// Conversa direta ou grupo. `parKey` só existe em diretas
// (min|max dos contaIds) — UNIQUE(campaignId,parKey) resolve a criação
// concorrente pela constraint, sem check-then-act. Grupos: parKey NULL
// (NULLs são distintos no SQLite — várias conversas grupo coexistem).
export const internetConversations = sqliteTable("internet_conversations", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  tipo: text("tipo").notNull(), // direta|grupo
  parKey: text("par_key"),
  nome: text("nome"), // título do grupo (opcional)
  status: text("status").notNull().default("ativa"), // ativa|arquivada
  createdByContaId: text("created_by_conta_id").references(() => internetAccounts.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("internet_conv_par_idx").on(t.campaignId, t.parKey),
  index("internet_conv_campaign_idx").on(t.campaignId),
]);

// Participante da conversa. Cursor de leitura `(lastReadCreatedAt,
// lastReadMessageId)` vive NESTA linha — fonte única de verdade (D2),
// atualizado na mesma transação da leitura. Reconvite reativa a mesma
// linha (trilha preservada em audit_logs), nunca apaga+recria.
export const internetParticipantes = sqliteTable("internet_participantes", {
  id: id(),
  conversaId: text("conversa_id").notNull().references(() => internetConversations.id, { onDelete: "cascade" }),
  contaId: text("conta_id").notNull().references(() => internetAccounts.id, { onDelete: "cascade" }),
  papel: text("papel").notNull().default("membro"), // dono|membro
  status: text("status").notNull().default("convidado"), // convidado|ativo|recusado|cancelado|saiu
  convidadoPorContaId: text("convidado_por_conta_id").references(() => internetAccounts.id),
  convidadoEm: integer("convidado_em", { mode: "timestamp_ms" }),
  decididoEm: integer("decidido_em", { mode: "timestamp_ms" }),
  saiuEm: integer("saiu_em", { mode: "timestamp_ms" }),
  lastReadCreatedAt: integer("last_read_created_at", { mode: "timestamp_ms" }),
  lastReadMessageId: text("last_read_message_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("internet_part_conv_conta_idx").on(t.conversaId, t.contaId),
  index("internet_part_conta_idx").on(t.contaId),
  index("internet_part_status_idx").on(t.conversaId, t.status),
]);

// Mensagem diegética persistente. Ordenação canônica (createdAt,id);
// idempotência por UNIQUE(conversaId,autorContaId,requestId) + payloadHash
// (SHA-256 do conteúdo NFC-normalizado). `campaignId` desnormalizado
// para escopo/auditoria sem join.
export const internetMessages = sqliteTable("internet_messages", {
  id: id(),
  conversaId: text("conversa_id").notNull().references(() => internetConversations.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  autorContaId: text("autor_conta_id").notNull().references(() => internetAccounts.id),
  requestId: text("request_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  conteudo: text("conteudo").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [
  uniqueIndex("internet_msg_idem_idx").on(t.conversaId, t.autorContaId, t.requestId),
  index("internet_msg_conv_ordem_idx").on(t.conversaId, t.createdAt, t.id),
  index("internet_msg_campaign_idx").on(t.campaignId, t.createdAt),
]);

// Internet pública 1.1.2 (#365, fatia W1/W3 — somente leitura): sites
// e páginas de campanha. Site = espaço nomeado do personagem
// (ownerContaId administra); página = conteúdo publicado derivado no
// menu do site (D13-a). Fronteira de campanha absoluta (D1) e sites
// descobríveis por todos os elegíveis da campanha (D2) — conteúdo com
// escopo `contatos` NÃO existe nesta fatia. `campaignId`
// desnormalizado em páginas para escopo sem join (mesmo padrão de
// internet_messages). Criação/edição depende de decisão de produto
// pendente — nesta fatia as tabelas só são lidas.
export const internetSites = sqliteTable("internet_sites", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  nome: text("nome").notNull(),
  descricao: text("descricao"),
  // D6: nullable — sites importados sem conta local ficam read-only
  ownerContaId: text("owner_conta_id").references(() => internetAccounts.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("ativo"), // ativo|arquivado
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("internet_sites_slug_idx").on(t.campaignId, t.slug),
  index("internet_sites_campaign_idx").on(t.campaignId),
]);

export const internetPages = sqliteTable("internet_pages", {
  id: id(),
  siteId: text("site_id").notNull().references(() => internetSites.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  titulo: text("titulo").notNull(),
  corpo: text("corpo").notNull(),
  formato: text("formato").notNull().default("texto"), // texto|markdown-subset
  status: text("status").notNull().default("publicado"), // rascunho|publicado|retirado|arquivado
  version: integer("version").notNull().default(1),
  // D6: nullable — páginas importadas sem conta local ficam read-only
  autorContaId: text("autor_conta_id").references(() => internetAccounts.id, { onDelete: "cascade" }),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("internet_pages_slug_idx").on(t.siteId, t.slug),
  index("internet_pages_site_idx").on(t.siteId, t.status),
  index("internet_pages_campaign_idx").on(t.campaignId),
]);

// Publicações da Internet pública 1.1.2 (#365, fatia W4/W5 — contrato
// docs/CONTRATO-W4W5-PUBLICACOES-365.md): notícias e posts de perfil.
// Autoria server-side (autorContaId/origem/publicadoEm nunca vêm do
// body); `origem='sistema'` = notícia automática de morte (DP-8/9),
// somente leitura para todos. `visibilidade='contatos'` restringe a
// aresta aceita vigente — invisível em busca/agregados (Quiz 2).
// `autorModo='anonimo'` existe no schema mas é rejeitado nesta fatia
// (DP-6: só classificado/anuncio — fatias W6/W7).
export const internetPublicacoes = sqliteTable("internet_publicacoes", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  tipo: text("tipo").notNull(), // noticia|post_perfil|anuncio|classificado
  titulo: text("titulo").notNull(),
  corpo: text("corpo").notNull(),
  formato: text("formato").notNull().default("markdown-subset"),
  status: text("status").notNull().default("rascunho"), // rascunho|publicado|retirado|removido
  visibilidade: text("visibilidade").notNull().default("campanha"), // campanha|contatos
  autorModo: text("autor_modo").notNull().default("identificado"), // identificado|pseudonimo|anonimo
  pseudoNome: text("pseudo_nome"),
  autorContaId: text("autor_conta_id").references(() => internetAccounts.id),
  // D6: ref opaca do pacote de origem p/ anon importado — agrupa o
  // "mesmo anônimo" num reexport sem reidentificar (A3/A18).
  autorAnonRef: text("autor_anon_ref"),
  origem: text("origem").notNull().default("usuario"), // usuario|sistema|importado
  fonteRef: text("fonte_ref"),
  personagemId: text("personagem_id").references(() => characters.id),
  publicadoEm: integer("publicado_em", { mode: "timestamp_ms" }),
  // D11 (W6/W7): validade opcional de anuncio/classificado — estado
  // expirado é derivado na leitura, nunca por job/cron.
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  retiradoEm: integer("retirado_em", { mode: "timestamp_ms" }),
  retiradoMotivo: text("retirado_motivo"),
  denunciaAberta: integer("denuncia_aberta").notNull().default(0),
  denunciaGrave: integer("denuncia_grave").notNull().default(0),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("internet_publicacoes_feed_idx").on(t.campaignId, t.tipo, t.status, t.publicadoEm),
  index("internet_publicacoes_autor_idx").on(t.autorContaId, t.status),
  index("internet_publicacoes_personagem_idx").on(t.personagemId),
]);

// Denúncias de publicações (DP-2/DP-3): máquina
// aberta→contestada|em_analise→auto_removida|resolvida_admin|encerrada.
// Limiar de auto-remoção: ≥2 denúncias distintas OU 1 denunciaGrave —
// aplicado na mesma tx do registro. Contestações resolvem admin da
// plataforma (não mestre). Uma denúncia por par (publicação, conta).
export const internetDenuncias = sqliteTable("internet_denuncias", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  publicacaoId: text("publicacao_id").notNull().references(() => internetPublicacoes.id, { onDelete: "cascade" }),
  // D6: nullable + denunciante_ref opaca — denunciante importado não
  // tem conta local; a ref preserva dedupe sem reidentificar (A10).
  denuncianteContaId: text("denunciante_conta_id").references(() => internetAccounts.id),
  denuncianteRef: text("denunciante_ref").notNull(),
  motivo: text("motivo").notNull(),
  denunciaGrave: integer("denuncia_grave").notNull().default(0),
  status: text("status").notNull().default("aberta"), // aberta|contestada|em_analise|auto_removida|resolvida_admin|encerrada
  resolucao: text("resolucao"),
  resolvidoPor: text("resolvido_por"),
  prazoContestacaoEm: integer("prazo_contestacao_em", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("internet_denuncias_par_idx").on(t.publicacaoId, t.denuncianteRef),
  index("internet_denuncias_pub_idx").on(t.publicacaoId, t.status),
  index("internet_denuncias_campaign_idx").on(t.campaignId),
]);

// Perfil público 1.1.2 (#365, fatia W9/W10 — D10/DP-4/DP-5): opcional,
// ativação IRREVERSÍVEL, segue o PERSONAGEM (characterId) — transferência
// P7 e ressurreição preservam o perfil. Localizador público = handle da
// conta Internet do mesmo personagem (não duplicado aqui). Exibe só
// nome público (default = nome do personagem), avatar (arquivo da
// biblioteca `files`) e descrição — nunca ids internos (V-08). Não há
// status ativo/inativo: a linha existir É o perfil ativado.
export const internetPerfis = sqliteTable("internet_perfis", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  nomePublico: text("nome_publico"), // null → cai no characters.name
  descricao: text("descricao"),
  avatarFileId: text("avatar_file_id").references(() => files.id, { onDelete: "set null" }),
  ativadoEm: integer("ativado_em", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("internet_perfis_char_idx").on(t.characterId),
  index("internet_perfis_campaign_idx").on(t.campaignId),
]);

// Acordo de patrocínio (veredito Dono 7232130363 — modo AUTOMÁTICO):
// partes, campanha, valor em centavos, condição de liquidação
// verificável server-side e estado. NÃO é transação financeira — a
// liquidação gera as pernas em money_transactions na mesma tx do CAS
// de estado (atomicidade + idempotência por requestId por perna).
// Estados: proposto|aceito|cancelado|liquidado|falha_liquidacao;
// `expirado` é derivado na leitura (now > expiresAt), mesmo padrão D11.
export const internetPatrocinios = sqliteTable("internet_patrocinios", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  proponenteCharacterId: text("proponente_character_id").notNull().references(() => characters.id),
  pagadorCharacterId: text("pagador_character_id").notNull().references(() => characters.id),
  beneficiarioCharacterId: text("beneficiario_character_id").notNull().references(() => characters.id),
  pagadorAccountId: text("pagador_account_id").notNull().references(() => financialAccounts.id),
  beneficiarioAccountId: text("beneficiario_account_id").references(() => financialAccounts.id), // fixada no aceite
  amountCents: integer("amount_cents").notNull(), // centavos inteiros > 0
  currency: text("currency").notNull().default("BRL"),
  condicaoTipo: text("condicao_tipo").notNull(), // imediato|data_alvo|metrica_publicacao
  condicaoJson: text("condicao_json", { mode: "json" }).notNull().default({}),
  estado: text("estado").notNull().default("proposto"),
  propostaRequestId: text("proposta_request_id"), // idempotência da proposta
  liquidacaoRequestId: text("liquidacao_request_id"), // requestId base das pernas
  propostoEm: integer("proposto_em", { mode: "timestamp_ms" }).notNull(),
  aceitoEm: integer("aceito_em", { mode: "timestamp_ms" }),
  aceitoPor: text("aceito_por").references(() => users.id),
  canceladoEm: integer("cancelado_em", { mode: "timestamp_ms" }),
  canceladoPor: text("cancelado_por").references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  liquidadoEm: integer("liquidado_em", { mode: "timestamp_ms" }),
  falhaMotivo: text("falha_motivo"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("internet_patrocinios_campaign_idx").on(t.campaignId, t.estado),
  index("internet_patrocinios_pagador_idx").on(t.pagadorCharacterId),
  index("internet_patrocinios_beneficiario_idx").on(t.beneficiarioCharacterId),
  uniqueIndex("internet_patrocinios_prop_req_idx").on(t.campaignId, t.propostaRequestId),
]);

// Transferência de personagem (P7, contrato #349): convite do titular
// atual + aceite explícito do novo titular. No máximo 1 `pendente` por
// personagem (índice parcial). Conta diegética e histórico acompanham
// por characterId sem mudança; o aceite é atômico (UPDATE condicional
// do titular + status do pedido na mesma tx).
export const characterTransfers = sqliteTable("character_transfers", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  fromMembershipId: text("from_membership_id").notNull().references(() => memberships.id),
  toMembershipId: text("to_membership_id").notNull().references(() => memberships.id),
  status: text("status").notNull().default("pendente"), // pendente|aceita|recusada|cancelada
  createdAt: createdAt(),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("char_transf_pendente_idx").on(t.characterId).where(sql`status = 'pendente'`),
  index("char_transf_campaign_idx").on(t.campaignId),
  index("char_transf_to_idx").on(t.toMembershipId, t.status),
]);
