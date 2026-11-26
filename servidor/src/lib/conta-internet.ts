// Gate dedicado da conta diegética (Issue #349/#350, release 1.1.1).
// Separado de personagemAutorizadoInternet/gateInternetDoPersonagem: a conta
// NUNCA herda o bypass de titularidade do mestre — o acesso exige que o
// usuário seja o titular ATUAL do personagem da conta (P10 trata a leitura
// do mestre como permissão separada e somente leitura, em outro caminho).
// Fail-closed: qualquer elo ausente → null.
import { createHash } from "node:crypto";
import { and, eq, inArray, or, gt, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  characters, memberships, internetAccounts, internetContacts,
  internetConversations, internetParticipantes, internetMessages,
} from "../db/schema.js";
import { gateInternetDoPersonagem } from "./gate-internet.js";

const db = getDb();

export interface ContaAutorizada {
  conta: typeof internetAccounts.$inferSelect;
  personagem: typeof characters.$inferSelect;
  membership: typeof memberships.$inferSelect; // membership do USUÁRIO na campanha
  papel: "mestre" | "jogador";
}

/**
 * Revalida a autorização completa da conta em CADA operação relevante:
 *  1. conta existe, status "ativa", campanha coerente com o personagem;
 *  2. personagem existe, não arquivado, mesma campanha da conta;
 *  3. usuário tem membership ATIVA na campanha com papel mestre|jogador
 *     (espectador negado — cobre espectador-dono);
 *  4. titularidade ATUAL: characters.membershipId → memberships.userId
 *     === userId, sem bypass para mestre;
 *  5. elegibilidade canônica: perícia/conhecimento + dispositivo
 *     (gateInternetDoPersonagem — mesmo cálculo da Internet 1.1.0).
 */
export async function contaAutorizadaPara(
  contaId: string,
  userId: string,
): Promise<ContaAutorizada | null> {
  const [conta] = await db.select().from(internetAccounts).where(eq(internetAccounts.id, contaId)).limit(1);
  if (!conta || conta.status !== "ativa") return null;

  const [personagem] = await db.select().from(characters)
    .where(and(eq(characters.id, conta.characterId), eq(characters.campaignId, conta.campaignId)))
    .limit(1);
  if (!personagem || personagem.status === "arquivado") return null;

  const [membership] = await db.select().from(memberships)
    .where(and(
      eq(memberships.campaignId, conta.campaignId),
      eq(memberships.userId, userId),
      eq(memberships.status, "ativo"),
    ))
    .limit(1);
  if (!membership || (membership.role !== "mestre" && membership.role !== "jogador")) return null;

  // titularidade atual — SEM bypass de mestre (P10 é caminho separado)
  const [dono] = await db.select({ userId: memberships.userId, status: memberships.status }).from(memberships)
    .where(and(
      eq(memberships.id, personagem.membershipId),
      eq(memberships.campaignId, conta.campaignId),
    ))
    .limit(1);
  if (!dono || dono.status !== "ativo" || dono.userId !== userId) return null;

  if (!(await gateInternetDoPersonagem(personagem)).elegivel) return null;

  return { conta, personagem, membership, papel: membership.role as "mestre" | "jogador" };
}

/** P10 — leitura privilegiada do mestre: membership ativa com papel
 *  "mestre" NA CAMPANHA da conversa. Somente leitura; nunca concede
 *  envio/gestão. ADMIN global não herda (não consulta is_admin). */
export async function mestreLeitorDaCampanha(campaignId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ role: memberships.role }).from(memberships)
    .where(and(
      eq(memberships.campaignId, campaignId),
      eq(memberships.userId, userId),
      eq(memberships.status, "ativo"),
    ))
    .limit(1);
  return m?.role === "mestre";
}

/** Resolve as contas do usuário na campanha (para "minhas contas"). */
export async function contasDoUsuario(campaignId: string, userId: string) {
  const chars = await db.select({ id: characters.id }).from(characters)
    .innerJoin(memberships, eq(characters.membershipId, memberships.id))
    .where(and(
      eq(characters.campaignId, campaignId),
      eq(memberships.userId, userId),
      eq(memberships.status, "ativo"),
    ));
  if (!chars.length) return [] as (typeof internetAccounts.$inferSelect)[];
  return db.select().from(internetAccounts)
    .where(and(
      eq(internetAccounts.campaignId, campaignId),
      inArray(internetAccounts.characterId, chars.map((c) => c.id)),
      eq(internetAccounts.status, "ativa"),
    ));
}

// ---------- contatos ----------

export type EstadoContato = "pendente" | "aceito" | "bloqueado";

/** Aresta origem→destino no estado pedido (qualquer direção de leitura). */
export async function arestaContato(campaignId: string, origemId: string, destinoId: string) {
  const [c] = await db.select().from(internetContacts)
    .where(and(
      eq(internetContacts.campaignId, campaignId),
      eq(internetContacts.contaOrigemId, origemId),
      eq(internetContacts.contaDestinoId, destinoId),
    ))
    .limit(1);
  return c ?? null;
}

/**
 * Bloqueio bilateral de facto (P3): o envio entre duas contas é vedado se
 * QUALQUER direção estiver `bloqueado`. Consultado dentro da transação de
 * envio — estado lido na hora, nunca cache.
 */
export async function contatoBloqueadoEntre(
  tx: { select: typeof db.select },
  campaignId: string,
  contaA: string,
  contaB: string,
): Promise<boolean> {
  const rows = await tx.select({ status: internetContacts.status }).from(internetContacts)
    .where(and(
      eq(internetContacts.campaignId, campaignId),
      or(
        and(eq(internetContacts.contaOrigemId, contaA), eq(internetContacts.contaDestinoId, contaB)),
        and(eq(internetContacts.contaOrigemId, contaB), eq(internetContacts.contaDestinoId, contaA)),
      ),
    ));
  return rows.some((r) => r.status === "bloqueado");
}

/**
 * Bloqueios par-a-par (P3, deliberação do proprietário): mapa
 * contaId → (contaContraparte → instante do bloqueio). Cobre arestas
 * `bloqueado` em QUALQUER direção — o bloqueio é simétrico de facto.
 * O instante é `responded_at` (fallback `updated_at`) e serve de corte
 * temporal: mensagens POSTERIORES a ele são ocultadas do par bloqueado
 * no histórico; anteriores permanecem visíveis (P12).
 */
export async function bloqueiosEntreContas(
  campaignId: string,
  contaIds: string[],
): Promise<Map<string, Map<string, Date>>> {
  const out = new Map<string, Map<string, Date>>();
  if (!contaIds.length) return out;
  const rows = await db.select({
    origem: internetContacts.contaOrigemId,
    destino: internetContacts.contaDestinoId,
    quando: internetContacts.respondedAt,
    atualizado: internetContacts.updatedAt,
  }).from(internetContacts).where(and(
    eq(internetContacts.campaignId, campaignId),
    eq(internetContacts.status, "bloqueado"),
    or(
      inArray(internetContacts.contaOrigemId, contaIds),
      inArray(internetContacts.contaDestinoId, contaIds),
    ),
  ));
  for (const r of rows) {
    const t = r.quando ?? r.atualizado;
    if (!t) continue;
    for (const [eu, outro] of [[r.origem, r.destino], [r.destino, r.origem]] as const) {
      if (!contaIds.includes(eu)) continue;
      let m = out.get(eu);
      if (!m) { m = new Map(); out.set(eu, m); }
      const ant = m.get(outro);
      if (!ant || t < ant) m.set(outro, t);
    }
  }
  return out;
}

/** Contato aceito em alguma direção é pré-requisito de conversa/convite (P4). */
export async function contatoAceitoEntre(
  tx: { select: typeof db.select },
  campaignId: string,
  contaA: string,
  contaB: string,
): Promise<boolean> {
  const rows = await tx.select({ status: internetContacts.status }).from(internetContacts)
    .where(and(
      eq(internetContacts.campaignId, campaignId),
      or(
        and(eq(internetContacts.contaOrigemId, contaA), eq(internetContacts.contaDestinoId, contaB)),
        and(eq(internetContacts.contaOrigemId, contaB), eq(internetContacts.contaDestinoId, contaA)),
      ),
      eq(internetContacts.status, "aceito"),
    ));
  return rows.length > 0;
}

// ---------- mensagens: limites e idempotência (P8) ----------

export const LIMITE_CONTEUDO_CHARS = 4000;
export const LIMITE_MSG_POR_MINUTO = 20;
export const JANELA_RATE_MS = 60_000;

/** Payload canônico NFC-normalizado → SHA-256 (fingerprint de replay). */
export function hashPayloadMensagem(conteudo: string): string {
  return createHash("sha256").update(conteudo.normalize("NFC"), "utf8").digest("hex");
}

/** Conta quantas mensagens a conta enviou na janela — chamado dentro da tx. */
export async function contarMensagensRecentes(
  tx: { select: typeof db.select },
  autorContaId: string,
  desde: Date,
): Promise<number> {
  const [r] = await tx
    .select({ c: sql<number>`count(*)` })
    .from(internetMessages)
    .where(and(
      eq(internetMessages.autorContaId, autorContaId),
      gt(internetMessages.createdAt, desde),
    ));
  return Number(r?.c ?? 0);
}

// ---------- participantes e cursor ----------

export async function participanteDaConta(conversaId: string, contaId: string) {
  const [p] = await db.select().from(internetParticipantes)
    .where(and(
      eq(internetParticipantes.conversaId, conversaId),
      eq(internetParticipantes.contaId, contaId),
    ))
    .limit(1);
  return p ?? null;
}

/** Cursor keyset opaco: base64url(`${createdAtMs}:${messageId}`). */
export function codificarCursor(createdAt: Date | number, messageId: string): string {
  const ms = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  return Buffer.from(`${ms}:${messageId}`, "utf8").toString("base64url");
}

export function decodificarCursor(cursor: string): { createdAt: Date; messageId: string } | null {
  try {
    const bruto = Buffer.from(cursor, "base64url").toString("utf8");
    const i = bruto.indexOf(":");
    if (i <= 0) return null;
    const ms = Number(bruto.slice(0, i));
    const messageId = bruto.slice(i + 1);
    if (!Number.isFinite(ms) || !messageId) return null;
    return { createdAt: new Date(ms), messageId };
  } catch {
    return null;
  }
}

/** Participante ativo da conversa para a conta (gate de leitura/escrita normal). */
export async function participanteAtivo(conversaId: string, contaId: string) {
  const p = await participanteDaConta(conversaId, contaId);
  return p && p.status === "ativo" ? p : null;
}
