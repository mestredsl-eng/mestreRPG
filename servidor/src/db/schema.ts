import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_username_idx").on(t.username)]);

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

export const campaigns = sqliteTable("campaigns", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  system: text("system"), // sistema de RPG em texto livre (ex.: "Caçadores & Caçados")
  coverImage: text("cover_image"), // caminho do arquivo de capa em arquivos/campanhas/
  status: text("status").notNull().default("preparacao"), // preparacao|andamento|pausada|concluida|arquivada (spec §19.5)
  ownerId: text("owner_id").notNull().references(() => users.id),
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
  status: text("status").notNull().default("rascunho"), // rascunho|aguardando_aprovacao|devolvida|aprovada|bloqueada (spec §6.7)
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

// Dinheiro fictício e transações (inclui "PIX fictício" — spec §9.3)
export const moneyTransactions = sqliteTable("money_transactions", {
  id: id(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  // tipo: saldo_inicial|entrada|saida|pix_ficticio|ajuste_mestre|transferencia
  kind: text("kind").notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("BRL"),
  account: text("account"), // especie|banco|pix_ficticio|outro
  counterparty: text("counterparty"), // NPC, outro personagem, loja etc.
  description: text("description"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index("money_tx_char_idx").on(t.characterId)]);

// Sessões de jogo (spec §20)
export const sessions = sqliteTable("sessions", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  name: text("name"),
  summary: text("summary"), // resumo escrito pelo mestre
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("ativa"), // ativa|encerrada
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("sessions_campaign_idx").on(t.campaignId)]);

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
  createdAt: createdAt(),
}, (t) => [index("rolls_campaign_idx").on(t.campaignId, t.createdAt)]);

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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("tests_campaign_idx").on(t.campaignId, t.createdAt)]);

// Diário do jogador e anotações do mestre (spec §18) — visibilidade no servidor
export const notes = sqliteTable("notes", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => users.id), // dono da anotação
  characterId: text("character_id").references(() => characters.id, { onDelete: "set null" }),
  category: text("category"),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  // visibilidade: privada|mestre|publica|selecionada; recipients em JSON (§18.4)
  visibility: text("visibility").notNull().default("privada"),
  recipients: text("recipients", { mode: "json" }),
  status: text("status").notNull().default("pendente"), // pendente|concluida
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("notes_campaign_idx").on(t.campaignId)]);

// Arquivos da campanha (spec §22) — metadados; conteúdo em arquivos/campanhas/
export const files = sqliteTable("files", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  folderPath: text("folder_path").notNull().default("/"),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  uploadedBy: text("uploaded_by").notNull().references(() => users.id),
  visibility: text("visibility").notNull().default("mestre"), // mestre|publica|selecionada
  recipients: text("recipients", { mode: "json" }),
  createdAt: createdAt(),
}, (t) => [index("files_campaign_idx").on(t.campaignId)]);

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

// Trilha de auditoria administrativa (spec §24)
export const auditLogs = sqliteTable("audit_logs", {
  id: id(),
  actorId: text("actor_id").references(() => users.id),
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  detail: text("detail", { mode: "json" }),
  createdAt: createdAt(),
}, (t) => [index("audit_campaign_idx").on(t.campaignId, t.createdAt)]);
