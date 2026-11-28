import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import { getDb, CAMINHOS } from "../db/index.js";
import {
  campaigns, memberships, invitations, sheetTemplates, sheetVersions, characters, characterFields,
  ruleSets, ruleDefinitions, itemTemplates, inventoryEntries, equipmentEntries, vehicles,
  financialAccounts, moneyTransactions, shops, shopManagers, shopOffers, shopOrders,
  sessions, turns, chatMessages, rolls, tests, notes, files, folders, noteAttachments,
  users, internetPublicacoes,
  internetAccounts, internetContacts, internetConversations,
  internetDenuncias, internetMessages, internetPages,
  internetParticipantes, internetSites,
} from "../db/schema.js";
import { avaliarMorte, CHAVE_MORTE } from "./morte.js";
import { lerHp } from "./vida.js";
import type { EstadoCampanha } from "./estado.js";
import { obterChaveAssinatura } from "./assinatura-xp.js";
import {
  montarContextoSaneamento, relatorioSaneamentoVazio, sanearPersonagemImportado,
  type OrigemEstado, type RelatorioSaneamento, type SaneamentoPersonagem, type TotaisSaneamento,
} from "./saneamento-importacao.js";

const db = getDb();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const CAMPOS_CAMPANHA = ["name", "description", "system", "summary", "status", "settings", "coverImage"] as const;

export interface ResultadoRestauracao {
  arquivosRecuperados: number;
  arquivosAusentes: string[];
  saneamento: RelatorioSaneamento;
}

function reviverDatas(row: Record<string, unknown>, cols: Record<string, { dataType: string }>) {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && cols[k]?.dataType === "date") out[k] = new Date(v);
  }
  return out;
}

function inserir(tx: Tx, tabela: Parameters<typeof tx.insert>[0], rows: readonly unknown[] | undefined) {
  if (!rows?.length) return;
  const cols = getTableColumns(tabela as never) as Record<string, { dataType: string }>;
  tx.insert(tabela).values((rows as Record<string, unknown>[]).map((r) => reviverDatas(r, cols)) as never).run();
}

// `data.__arquivamento` é metadado reservado, autoridade exclusiva do
// backend (rotas /arquivar e /desarquivar). Pacotes de importação ou
// snapshots adulterados não podem forjá-lo: personagem arquivado precisa
// de statusAnterior válido (senão assume rascunho); fora de arquivado a
// chave é sempre removida.
const STATUS_RESTAURO_VALORES = new Set(["rascunho", "aguardando_aprovacao", "devolvida", "reaberta", "aprovada", "bloqueada"]);
function sanitizarArquivamento(row: Record<string, unknown>) {
  const data = (row.data && typeof row.data === "object" ? { ...(row.data as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const meta = data.__arquivamento as Record<string, unknown> | undefined;
  if (row.status === "arquivado") {
    const anterior = typeof meta?.statusAnterior === "string" && STATUS_RESTAURO_VALORES.has(meta.statusAnterior) ? meta.statusAnterior : "rascunho";
    data.__arquivamento = {
      statusAnterior: anterior,
      arquivadoEm: typeof meta?.arquivadoEm === "string" ? meta.arquivadoEm : null,
      arquivadoPor: typeof meta?.arquivadoPor === "string" ? meta.arquivadoPor : null,
    };
  } else {
    delete data.__arquivamento;
  }
  row.data = data;
}

// Issue #186/C3 (§13): `__sangue_sig` e `__xp.sig` são credenciais de
// TRANSPORTE — válidas só durante a verificação de uma importação
// externa. Nunca persistem em `characters.data`. Na origem interna não
// há verificação, então resíduos são removidos antes de inserir.
function removerCredenciaisTransporte(row: Record<string, unknown>) {
  const data = row.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const d = data as Record<string, unknown>;
  delete d.__sangue_sig;
  const xp = d.__xp;
  if (xp && typeof xp === "object" && !Array.isArray(xp)) {
    delete (xp as Record<string, unknown>).sig;
  }
}

// Snapshots e pacotes exportados antes da migration 0023 podem conter
// (campaign_id, number) duplicados em sessions — a constraint única
// rejeitaria a restauração/importação. Mesma regra da migration: a
// ocorrência mais antiga de cada número é preservada e as demais recebem
// números acima do MAX da campanha, na ordem de criação. IDs e demais
// referências das sessões não mudam.
export function normalizarNumerosSessao(rows: unknown[] | undefined) {
  if (!rows?.length) return rows;
  const criadoEm = (r: Record<string, unknown>) => {
    const v = r.createdAt ?? r.created_at;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    const t = Date.parse(String(v ?? ""));
    return Number.isNaN(t) ? 0 : t;
  };
  const porCampanha = new Map<string, Record<string, unknown>[]>();
  for (const row of rows as Record<string, unknown>[]) {
    const cid = String(row.campaignId ?? row.campaign_id ?? "");
    const lista = porCampanha.get(cid) ?? [];
    lista.push(row);
    porCampanha.set(cid, lista);
  }
  for (const lista of porCampanha.values()) {
    const ordenada = [...lista].sort(
      (a, b) => criadoEm(a) - criadoEm(b) || String(a.id ?? "").localeCompare(String(b.id ?? "")),
    );
    const ocupados = new Set<number>();
    let proximo = Math.max(0, ...lista.map((r) => Number(r.number ?? 0) || 0)) + 1;
    for (const r of ordenada) {
      const n = Number(r.number ?? 0) || 0;
      if (!ocupados.has(n)) { ocupados.add(n); continue; }
      r.number = proximo++;
    }
  }
  return rows;
}

const repVazio = (): SaneamentoPersonagem => ({
  personagemId: "", nome: null, eventosXpDescartados: 0, ledgerXpInvalidado: false,
  financiadoRejeitados: 0, seloRemovido: false, bonusAjustado: false,
  pontosHistoricoDescartados: 0, hpHistoricoDescartados: 0, hpCorrigido: false, hpRemovido: false,
  vitalidadeHistoricoDescartados: 0, vitalidadeCorrigida: false, vitalidadeRemovida: false,
  retratoRemovido: false, npcVisivelRemovido: false,
  sangueRemovido: false, sangueAutenticado: false, sangueInvalido: false, motivoSangue: null,
});

function acumulou(r: SaneamentoPersonagem): boolean {
  return r.eventosXpDescartados > 0 || r.ledgerXpInvalidado || r.financiadoRejeitados > 0 ||
    r.seloRemovido || r.bonusAjustado || r.pontosHistoricoDescartados > 0 ||
    r.hpHistoricoDescartados > 0 || r.hpCorrigido || r.hpRemovido ||
    r.vitalidadeHistoricoDescartados > 0 || r.vitalidadeCorrigida || r.vitalidadeRemovida ||
    r.retratoRemovido || r.npcVisivelRemovido ||
    r.sangueRemovido || r.sangueAutenticado || r.sangueInvalido || r.motivoSangue !== null;
}

// ---- Domínio Internet (1.1.1/1.1.2 + público 1.1.2) — preservação no
// restore "substituir". O pacote EstadoCampanha NÃO carrega estas
// tabelas (P9; D6 pendente): sem preservação, o limpar apagaria
// mensageiro privado E conteúdo público fora do pacote. Captura
// integral por campaignId antes de qualquer delete; recriação em
// ordem FK após inserirEstado, com âncoras mínimas para contas cujo
// personagem não veio no pacote.
type ContaInternet = typeof internetAccounts.$inferSelect;
type ContatoInternet = typeof internetContacts.$inferSelect;
type ConversaInternet = typeof internetConversations.$inferSelect;
type ParticipanteInternet = typeof internetParticipantes.$inferSelect;
type MensagemInternet = typeof internetMessages.$inferSelect;
type SiteInternet = typeof internetSites.$inferSelect;
type PaginaInternet = typeof internetPages.$inferSelect;
type PublicacaoInternet = typeof internetPublicacoes.$inferSelect;
type DenunciaInternet = typeof internetDenuncias.$inferSelect;
type PersonagemRef = { id: string; name: string; membershipId: string; isNpc: boolean | null; createdAt: Date | null; updatedAt: Date | null };
type MembershipRow = typeof memberships.$inferSelect;

interface DominioInternetPreservado {
  contas: ContaInternet[];
  contatos: ContatoInternet[];
  conversas: ConversaInternet[];
  participantes: ParticipanteInternet[];
  mensagens: MensagemInternet[];
  sites: SiteInternet[];
  paginas: PaginaInternet[];
  publicacoes: PublicacaoInternet[];
  denuncias: DenunciaInternet[];
  personagens: PersonagemRef[];
  memberships: MembershipRow[];
}

function capturarDominioInternet(tx: Tx, campaignId: string): DominioInternetPreservado {
  const conversas = tx.select().from(internetConversations)
    .where(eq(internetConversations.campaignId, campaignId)).all();
  const convIds = conversas.map((c) => c.id);
  return {
    contas: tx.select().from(internetAccounts).where(eq(internetAccounts.campaignId, campaignId)).all(),
    contatos: tx.select().from(internetContacts).where(eq(internetContacts.campaignId, campaignId)).all(),
    conversas,
    // participantes não têm campaign_id — só das conversas capturadas
    participantes: convIds.length
      ? tx.select().from(internetParticipantes).where(inArray(internetParticipantes.conversaId, convIds)).all()
      : [],
    mensagens: tx.select().from(internetMessages).where(eq(internetMessages.campaignId, campaignId)).all(),
    sites: tx.select().from(internetSites).where(eq(internetSites.campaignId, campaignId)).all(),
    paginas: tx.select().from(internetPages).where(eq(internetPages.campaignId, campaignId)).all(),
    publicacoes: tx.select().from(internetPublicacoes).where(eq(internetPublicacoes.campaignId, campaignId)).all(),
    denuncias: tx.select().from(internetDenuncias).where(eq(internetDenuncias.campaignId, campaignId)).all(),
    personagens: tx.select({
      id: characters.id, name: characters.name, membershipId: characters.membershipId,
      isNpc: characters.isNpc, createdAt: characters.createdAt, updatedAt: characters.updatedAt,
    }).from(characters).where(eq(characters.campaignId, campaignId)).all(),
    memberships: tx.select().from(memberships).where(eq(memberships.campaignId, campaignId)).all(),
  };
}

/** P1 integridade cross-campaign: IDs globais existentes em OUTRA
 *  campanha não são prova de pertencimento. Toda aresta do snapshot
 *  capturado precisa resolver DENTRO dos conjuntos da campanha-alvo —
 *  qualquer inconsistência lança erro e provoca rollback integral da
 *  transação; nunca filtrar, apagar ou reparar silenciosamente. */
function validarIntegridadeDominioInternet(d: DominioInternetPreservado, campaignId: string) {
  const falha = (aresta: string, id: string) => {
    throw new Error(`restore: aresta Internet inconsistente — ${aresta} → ${id} fora do conjunto da campanha ${campaignId}`);
  };
  const contaIds = new Set(d.contas.map((c) => c.id));
  const charIds = new Set(d.personagens.map((c) => c.id));
  const memIds = new Set(d.memberships.map((m) => m.id));
  const convIds = new Set(d.conversas.map((c) => c.id));
  const siteIds = new Set(d.sites.map((s) => s.id));
  const pubIds = new Set(d.publicacoes.map((p) => p.id));
  const memPorId = new Map(d.memberships.map((m) => [m.id, m] as const));
  const charPorId = new Map(d.personagens.map((c) => [c.id, c] as const));

  for (const c of d.contas) {
    // personagem precisa ser DA campanha (characterId é global — um id
    // de outra campanha passaria no FK mas é corrupção de dados)
    const char = charPorId.get(c.characterId);
    if (!char) falha("internet_accounts.characterId", c.characterId);
    // membership do personagem precisa existir e ser da mesma campanha
    const mem = memPorId.get(char.membershipId);
    if (!mem || mem.campaignId !== campaignId) falha("characters.membershipId", char.membershipId);
  }
  for (const c of d.contatos) {
    if (!contaIds.has(c.contaOrigemId)) falha("internet_contacts.conta_origem_id", c.contaOrigemId);
    if (!contaIds.has(c.contaDestinoId)) falha("internet_contacts.conta_destino_id", c.contaDestinoId);
    if (c.bloqueadoPorContaId && !contaIds.has(c.bloqueadoPorContaId)) falha("internet_contacts.bloqueado_por_conta_id", c.bloqueadoPorContaId);
  }
  for (const c of d.conversas) {
    if (c.createdByContaId && !contaIds.has(c.createdByContaId)) falha("internet_conversations.created_by_conta_id", c.createdByContaId);
  }
  for (const p of d.participantes) {
    if (!contaIds.has(p.contaId)) falha("internet_participantes.conta_id", p.contaId);
    if (p.convidadoPorContaId && !contaIds.has(p.convidadoPorContaId)) falha("internet_participantes.convidado_por_conta_id", p.convidadoPorContaId);
  }
  for (const m of d.mensagens) {
    if (m.campaignId !== campaignId) falha("internet_messages.campaign_id", m.campaignId);
    if (!convIds.has(m.conversaId)) falha("internet_messages.conversa_id", m.conversaId);
    if (!contaIds.has(m.autorContaId)) falha("internet_messages.autor_conta_id", m.autorContaId);
  }
  for (const s of d.sites) {
    if (!contaIds.has(s.ownerContaId)) falha("internet_sites.owner_conta_id", s.ownerContaId);
  }
  for (const p of d.paginas) {
    if (p.campaignId !== campaignId) falha("internet_pages.campaign_id", p.campaignId);
    if (!siteIds.has(p.siteId)) falha("internet_pages.site_id", p.siteId);
    if (!contaIds.has(p.autorContaId)) falha("internet_pages.autor_conta_id", p.autorContaId);
  }
  for (const p of d.publicacoes) {
    if (p.campaignId !== campaignId) falha("internet_publicacoes.campaign_id", p.campaignId);
    if (p.autorContaId && !contaIds.has(p.autorContaId)) falha("internet_publicacoes.autor_conta_id", p.autorContaId);
    if (p.personagemId && !charIds.has(p.personagemId)) falha("internet_publicacoes.personagem_id", p.personagemId);
  }
  for (const n of d.denuncias) {
    if (n.campaignId !== campaignId) falha("internet_denuncias.campaign_id", n.campaignId);
    if (!pubIds.has(n.publicacaoId)) falha("internet_denuncias.publicacao_id", n.publicacaoId);
    if (!contaIds.has(n.denuncianteContaId)) falha("internet_denuncias.denunciante_conta_id", n.denuncianteContaId);
  }
}

/** Recria o domínio Internet preservado, em ordem FK. Personagens
 *  referenciados que não vieram no pacote ganham âncora mínima
 *  (status='arquivado', dados vazios, sem template) com o MESMO id —
 *  contas mantêm characterId e a titularidade resolve pelo novo
 *  membership via P7. Conta de âncora fica 'inativa' (gate
 *  contaAutorizadaPara já rejeita inativa/arquivado). Qualquer FK
 *  não resolvida aborta a transação inteira — nunca descarte
 *  silencioso de conversa. */
function restaurarDominioInternet(tx: Tx, campaignId: string, d: DominioInternetPreservado) {
  const vazio = !d.contas.length && !d.contatos.length && !d.conversas.length &&
    !d.mensagens.length && !d.sites.length && !d.paginas.length &&
    !d.publicacoes.length && !d.denuncias.length;
  if (vazio) return;

  const charsPresentes = new Set(
    tx.select({ id: characters.id }).from(characters)
      .where(eq(characters.campaignId, campaignId)).all().map((r) => r.id),
  );
  const memPorUser = new Map(
    tx.select().from(memberships).where(eq(memberships.campaignId, campaignId)).all()
      .map((m) => [m.userId, m] as const),
  );
  const memAntigaPorId = new Map(d.memberships.map((m) => [m.id, m] as const));
  const charAntigoPorId = new Map(d.personagens.map((c) => [c.id, c] as const));
  const agora = new Date();

  // ids de personagem referenciados pelo domínio: contas + notícias de
  // sistema (publicacoes.personagemId). Qualquer ausência vira âncora.
  const idsReferenciados = new Set<string>();
  for (const c of d.contas) idsReferenciados.add(c.characterId);
  for (const p of d.publicacoes) if (p.personagemId) idsReferenciados.add(p.personagemId);

  const contas = d.contas.map((c) => ({ ...c }));
  for (const charId of idsReferenciados) {
    if (charsPresentes.has(charId)) continue;
    const antigo = charAntigoPorId.get(charId);
    const memAntiga = antigo ? memAntigaPorId.get(antigo.membershipId) : undefined;
    const userId = memAntiga?.userId;
    if (!antigo || !memAntiga || !userId) {
      throw new Error(`restore: personagem ${charId} referenciado pela Internet sem membership resolvível — abortando`);
    }
    // membership alvo: a importada para o mesmo usuário, se houver;
    // senão reintroduz a antiga com status='removido' (nunca duplicata
    // — UNIQUE(campaignId,userId) já garantida pelo mapa acima).
    let memAlvo = memPorUser.get(userId);
    if (!memAlvo) {
      const reintro: MembershipRow = { ...memAntiga, status: "removido", updatedAt: agora };
      inserir(tx, memberships, [reintro]);
      memAlvo = reintro;
      memPorUser.set(userId, reintro);
    }
    inserir(tx, characters, [{
      id: charId, campaignId, membershipId: memAlvo.id,
      templateVersionId: null, name: antigo.name || "(personagem arquivado)",
      data: {}, overrides: {}, status: "arquivado", isNpc: antigo.isNpc ?? false,
      createdAt: antigo.createdAt ?? agora, updatedAt: agora,
    }]);
    charsPresentes.add(charId);
    for (const conta of contas) if (conta.characterId === charId) conta.status = "inativa";
  }

  inserir(tx, internetAccounts, contas);
  inserir(tx, internetContacts, d.contatos);
  inserir(tx, internetConversations, d.conversas);
  inserir(tx, internetParticipantes, d.participantes);
  inserir(tx, internetMessages, d.mensagens);
  inserir(tx, internetSites, d.sites);
  inserir(tx, internetPages, d.paginas);
  inserir(tx, internetPublicacoes, d.publicacoes);
  inserir(tx, internetDenuncias, d.denuncias);
}

/**
 * Insere todas as entidades do estado na ordem de dependência
 * (restauração e importação). `origem` é explícita e o padrão é
 * "externa": qualquer chamador novo é tratado como pacote não
 * confiável até provar o contrário. Snapshots criados pelo servidor
 * passam "interna" e preservam os metadados reservados integralmente.
 * Retorna o RelatorioSaneamento (vazio quando origem="interna").
 */
/** Último evento de HP negativo do histórico saneado — aproximação do
 *  evento letal para datar a epoch de morte importada (em/causa). */
function eventoLetalHp(d: Record<string, unknown>): { em: string; causa: string | null } | null {
  const hp = lerHp(d);
  if (!hp) return null;
  for (let i = hp.historico.length - 1; i >= 0; i--) {
    const e = hp.historico[i];
    if (typeof e.quantidade === "number" && e.quantidade < 0 && typeof e.em === "string") {
      return { em: e.em, causa: typeof e.motivo === "string" ? e.motivo : null };
    }
  }
  return null;
}

export function inserirEstado(tx: Tx, dados: EstadoCampanha, opts: { origem?: OrigemEstado; chaveAssinatura?: Buffer | null; campanhaIdOrigem?: string | null } = {}): RelatorioSaneamento {
  const origem: OrigemEstado = opts.origem ?? "externa";
  const rel = relatorioSaneamentoVazio(origem);
  const chars = (dados.characters ?? []) as Record<string, unknown>[];
  for (const r of chars) sanitizarArquivamento(r);
  if (origem === "interna") {
    // C3/§13: credenciais de transporte (`__sangue_sig` e `__xp.sig`)
    // nunca sobrevivem à persistência — snapshots internos não passam
    // por verificação, então resíduos são removidos defensivamente.
    for (const r of chars) removerCredenciaisTransporte(r);
  }

  // __morte é server-managed (Internet pública v2.6 + DP-8/9): pacote
  // externo não forja epochs — descartadas e re-derivadas do __hp
  // saneado. HP≤0 ⇒ epoch + notícia de sistema na mesma tx (apenas
  // primeira morte da ficha). Snapshots internos (origem='interna')
  // não passam por aqui — estado confiável preservado integralmente.
  if (origem === "externa" && chars.length) {
    // autoria: autorId precisa existir nesta instalação para manter o nome
    const autores = new Map<string, string | null>();
    for (const u of tx.select({ id: users.id, displayName: users.displayName, username: users.username }).from(users).all()) {
      autores.set(u.id, u.displayName ?? u.username ?? null);
    }
    const ctx = montarContextoSaneamento(dados, autores, {
      chaveAssinatura: opts.chaveAssinatura ?? null,
      // C3: envelope do pacote — contexto de proveniência da cadeia
      // (NÃO assinado); validado contra sheetTemplates.campaignId
      campanhaIdOrigem: opts.campanhaIdOrigem ?? null,
    });
    for (const row of chars) {
      const rep = repVazio();
      rep.personagemId = String(row.id ?? "");
      rep.nome = typeof row.name === "string" ? row.name : null;
      sanearPersonagemImportado(row, ctx, rep);
      const dadosRow = row.data;
      if (dadosRow && typeof dadosRow === "object" && !Array.isArray(dadosRow)) {
        const d = dadosRow as Record<string, unknown>;
        delete d[CHAVE_MORTE];
        const hpAtual = lerHp(d)?.atual ?? null;
        if (hpAtual !== null && hpAtual <= 0) {
          const letal = eventoLetalHp(d);
          const r = avaliarMorte(d, {
            hpAtual,
            em: letal?.em ?? new Date().toISOString(),
            causa: letal?.causa ?? null,
          });
          // DP-8/9: a epoch é re-derivada para dedup futuro, mas a
          // importação NÃO gera notícia retroativa — mortes do
          // histórico já foram (ou não foram) notícia na origem.
          if (r.morteNova) row.data = r.dados;
        }
      }
      if (!acumulou(rep)) continue;
      rel.personagens.push(rep);
      const t = rel.totais as TotaisSaneamento;
      t.personagensAfetados++;
      t.eventosXpDescartados += rep.eventosXpDescartados;
      if (rep.ledgerXpInvalidado) t.ledgersXpInvalidos++;
      t.financiadoRejeitados += rep.financiadoRejeitados;
      if (rep.seloRemovido) t.selosRemovidos++;
      if (rep.bonusAjustado) t.bonusAjustados++;
      t.pontosHistoricoDescartados += rep.pontosHistoricoDescartados;
      t.hpHistoricoDescartados += rep.hpHistoricoDescartados;
      if (rep.hpCorrigido) t.hpCorrigidos++;
      if (rep.hpRemovido) t.hpRemovidos++;
      t.vitalidadeHistoricoDescartados += rep.vitalidadeHistoricoDescartados;
      if (rep.vitalidadeCorrigida) t.vitalidadeCorrigidas++;
      if (rep.vitalidadeRemovida) t.vitalidadeRemovidas++;
      if (rep.retratoRemovido) t.retratosRemovidos++;
      if (rep.npcVisivelRemovido) t.npcVisivelRemovidos++;
      if (rep.sangueRemovido) t.sanguesRemovidos++;
      if (rep.sangueAutenticado) t.sanguesAutenticados++;
      if (rep.sangueInvalido) t.sanguesInvalidos++;
    }
  }
  inserir(tx, memberships, dados.memberships);
  inserir(tx, invitations, dados.invitations);
  inserir(tx, sheetTemplates, dados.sheetTemplates);
  inserir(tx, sheetVersions, dados.sheetVersions);
  inserir(tx, characters, dados.characters);
  inserir(tx, characterFields, dados.characterFields);
  inserir(tx, ruleSets, dados.ruleSets);
  inserir(tx, ruleDefinitions, dados.ruleDefinitions);
  inserir(tx, itemTemplates, dados.itemTemplates);
  inserir(tx, inventoryEntries, dados.inventoryEntries);
  inserir(tx, equipmentEntries, dados.equipmentEntries);
  inserir(tx, vehicles, dados.vehicles);
  // lojas antes de financialAccounts/moneyTransactions: shop_id é FK delas
  inserir(tx, shops, dados.shops);
  inserir(tx, shopManagers, dados.shopManagers);
  inserir(tx, shopOffers, dados.shopOffers);
  inserir(tx, financialAccounts, dados.financialAccounts);
  inserir(tx, moneyTransactions, dados.moneyTransactions);
  inserir(tx, shopOrders, dados.shopOrders);
  inserir(tx, sessions, normalizarNumerosSessao(dados.sessions));
  inserir(tx, turns, dados.turns);
  inserir(tx, chatMessages, dados.chatMessages);
  inserir(tx, rolls, dados.rolls);
  inserir(tx, tests, dados.tests);
  inserir(tx, notes, dados.notes);
  inserir(tx, folders, dados.folders);
  inserir(tx, files, dados.files);
  inserir(tx, noteAttachments, dados.noteAttachments);
  return rel;
}

/**
 * Restaura o estado de uma campanha a partir de um EstadoCampanha exportado.
 * Transacional no banco; arquivos físicos movidos para a lixeira e recuperados
 * em seguida (best-effort, nunca deixa registros apontando para caminho inválido).
 */
export async function restaurarEstado(campaignId: string, dados: EstadoCampanha, opts: { gravarArquivos?: Record<string, { conteudo: string }>; origem?: OrigemEstado; campanhaIdOrigem?: string | null } = {}): Promise<ResultadoRestauracao> {
  // ids necessários para deletes com FK indireta (calculados antes da transação)
  const charIds = (await db.select({ id: characters.id }).from(characters).where(eq(characters.campaignId, campaignId))).map((r) => r.id);
  const tplIds = (await db.select({ id: sheetTemplates.id }).from(sheetTemplates).where(eq(sheetTemplates.campaignId, campaignId))).map((r) => r.id);
  const sessIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId))).map((r) => r.id);
  const ruleSetIds = (await db.select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.campaignId, campaignId))).map((r) => r.id);
  const noteIds = (await db.select({ id: notes.id }).from(notes).where(eq(notes.campaignId, campaignId))).map((r) => r.id);
  // arquivos físicos dos registros que serão substituídos vão para a lixeira (recuperáveis)
  const arquivosAtuais = await db.select({ storageName: files.storageName }).from(files).where(eq(files.campaignId, campaignId));
  const baseDir = resolve(CAMINHOS.arquivos, campaignId);
  const lixeira = resolve(baseDir, ".lixeira");
  const moverParaLixeira = (storageName: string | null) => {
    if (!storageName) return;
    const origem = resolve(baseDir, storageName);
    if (!origem.startsWith(baseDir + sep)) return;
    const destino = resolve(lixeira, storageName);
    if (existsSync(origem) && !existsSync(destino)) {
      mkdirSync(lixeira, { recursive: true });
      try { renameSync(origem, destino); } catch { /* best-effort */ }
    }
  };

  let saneamento = relatorioSaneamentoVazio(opts.origem ?? "externa");
  // B1: a verificação de proveniência do ledger exige a chave de
  // assinatura da instalação — buscada FORA da transação (get-or-create).
  const chaveAssinatura = (opts.origem ?? "externa") === "externa"
    ? await obterChaveAssinatura(db)
    : null;
  db.transaction((tx) => {
    const limpar = (tabela: Parameters<typeof tx.delete>[0], where: unknown) =>
      tx.delete(tabela).where(where as never).run();
    // Domínio Internet ANTES de qualquer delete: o pacote não o carrega
    // (P9/D6) — captura integral para recriação preservada ao final.
    const dominioInternet = capturarDominioInternet(tx, campaignId);
    // P1: arestas precisam resolver DENTRO da campanha — id global de
    // outra campanha não é prova de pertencimento. Inconsistência
    // lança erro → rollback integral, sem filtro/reparo silencioso.
    validarIntegridadeDominioInternet(dominioInternet, campaignId);
    // filhos primeiro
    limpar(tests, eq(tests.campaignId, campaignId));
    limpar(rolls, eq(rolls.campaignId, campaignId));
    limpar(chatMessages, eq(chatMessages.campaignId, campaignId));
    if (sessIds.length) limpar(turns, inArray(turns.sessionId, sessIds));
    limpar(sessions, eq(sessions.campaignId, campaignId));
    limpar(moneyTransactions, eq(moneyTransactions.campaignId, campaignId));
    limpar(financialAccounts, eq(financialAccounts.campaignId, campaignId));
    // lojas: filhas primeiro; shops só depois das contas/transações que a referenciam
    limpar(shopOrders, eq(shopOrders.campaignId, campaignId));
    limpar(shopOffers, eq(shopOffers.campaignId, campaignId));
    limpar(shopManagers, eq(shopManagers.campaignId, campaignId));
    limpar(shops, eq(shops.campaignId, campaignId));
    limpar(vehicles, eq(vehicles.campaignId, campaignId));
    if (charIds.length) {
      limpar(equipmentEntries, inArray(equipmentEntries.characterId, charIds));
      limpar(inventoryEntries, inArray(inventoryEntries.characterId, charIds));
      limpar(characterFields, inArray(characterFields.characterId, charIds));
    }
    if (noteIds.length) limpar(noteAttachments, inArray(noteAttachments.noteId, noteIds));
    limpar(notes, eq(notes.campaignId, campaignId));
    limpar(files, eq(files.campaignId, campaignId));
    limpar(folders, eq(folders.campaignId, campaignId));
    // Domínio Internet diegética/pública (1.1.1/1.1.2): o pacote de
    // exportação NÃO carrega estas tabelas (P9; export do domínio
    // público é decisão D6 pendente). As linhas foram capturadas no
    // início da tx e serão recriadas preservadas após inserirEstado —
    // a limpeza existe só para a reinserção com os mesmos IDs e para
    // o delete em cascata de characters não perder a ordem FK.
    // Ordem filhas→pais.
    limpar(internetDenuncias, eq(internetDenuncias.campaignId, campaignId));
    limpar(internetPublicacoes, eq(internetPublicacoes.campaignId, campaignId));
    limpar(internetMessages, eq(internetMessages.campaignId, campaignId));
    // participantes não têm campaign_id — resolve via conversas da campanha
    const convIds = tx.select({ id: internetConversations.id }).from(internetConversations)
      .where(eq(internetConversations.campaignId, campaignId)).all().map((r) => r.id);
    if (convIds.length) limpar(internetParticipantes, inArray(internetParticipantes.conversaId, convIds));
    limpar(internetConversations, eq(internetConversations.campaignId, campaignId));
    limpar(internetContacts, eq(internetContacts.campaignId, campaignId));
    limpar(internetPages, eq(internetPages.campaignId, campaignId));
    limpar(internetSites, eq(internetSites.campaignId, campaignId));
    limpar(internetAccounts, eq(internetAccounts.campaignId, campaignId));
    limpar(characters, eq(characters.campaignId, campaignId));
    if (tplIds.length) limpar(sheetVersions, inArray(sheetVersions.templateId, tplIds));
    limpar(sheetTemplates, eq(sheetTemplates.campaignId, campaignId));
    if (ruleSetIds.length) limpar(ruleDefinitions, inArray(ruleDefinitions.ruleSetId, ruleSetIds));
    limpar(ruleSets, eq(ruleSets.campaignId, campaignId));
    limpar(itemTemplates, eq(itemTemplates.campaignId, campaignId));
    limpar(invitations, eq(invitations.campaignId, campaignId));
    limpar(memberships, eq(memberships.campaignId, campaignId));

    // campos mutáveis da campanha
    const c = dados.campanha ?? {};
    const upd: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of CAMPOS_CAMPANHA) if (c[k] !== undefined) upd[k] = c[k];
    tx.update(campaigns).set(upd).where(eq(campaigns.id, campaignId)).run();

    // reinsere na ordem de dependência (datas voltam de ISO string para Date)
    saneamento = inserirEstado(tx, dados, {
      origem: opts.origem,
      chaveAssinatura,
      campanhaIdOrigem: opts.campanhaIdOrigem ?? null,
    });
    // Domínio Internet preservado: recriado por último, já com
    // memberships/characters do pacote no lugar — âncoras cobrem os
    // personagens ausentes e contas ancoradas ficam inativas.
    restaurarDominioInternet(tx, campaignId, dominioInternet);
  });

  // ---- arquivos físicos: lixeira dos substituídos + gravação dos importados ----
  for (const a of arquivosAtuais) moverParaLixeira(a.storageName);
  let arquivosRecuperados = 0;
  const arquivosAusentes: string[] = [];
  const binarios = opts.gravarArquivos ?? {};
  for (const f of dados.files ?? []) {
    if (!f.storageName) continue;
    const vivo = resolve(baseDir, f.storageName);
    const naLixeira = resolve(lixeira, f.storageName);
    if (vivo.startsWith(baseDir + sep) && existsSync(naLixeira) && !existsSync(vivo)) {
      mkdirSync(baseDir, { recursive: true });
      try { renameSync(naLixeira, vivo); } catch { /* segue */ }
    }
    // pacote de importação pode trazer o binário embutido
    const embutido = binarios[f.id];
    if (embutido && !existsSync(vivo)) {
      try {
        mkdirSync(baseDir, { recursive: true });
        writeFileSync(vivo, Buffer.from(embutido.conteudo, "base64"));
      } catch { /* segue */ }
    }
    if (existsSync(vivo)) arquivosRecuperados++;
    else arquivosAusentes.push(f.fileName ?? f.id);
  }

  return { arquivosRecuperados, arquivosAusentes, saneamento };
}
