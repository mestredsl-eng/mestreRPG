import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { sessions, memberships, characters } from "../db/schema.js";

// ---------- Mesa virtual: estado compartilhado (mapa + tokens + névoa) ----------
// Modelo único usado pelo Socket.IO (sockets/mesa.ts) e pelas rotas HTTP
// (routes/sessoes.ts) para que a filtragem de visibilidade seja idêntica
// em todos os caminhos de entrega.

export interface TokenVtt {
  id: string; nome: string; cor: string; x: number; y: number;
  personagemId?: string | null; userId?: string | null; ativo: boolean;
}
export interface MapaVtt { fileId: string; nome: string; largura?: number; altura?: number }
export interface PontoNevoa { x: number; y: number }
export interface TracoNevoa { id: string; raioX: number; raioY: number; pontos: PontoNevoa[] }
export interface NevoaVtt { ativa: boolean; revelados: TracoNevoa[] }
export interface VttState { mapa: MapaVtt | null; tokens: TokenVtt[]; nevoa: NevoaVtt }

export const VTT_MAX_TOKENS = 100;
export const VTT_MAX_BYTES = 64 * 1024;
export const VTT_MAX_NOME = 60;

export const NEVOA_MAX_TRAÇOS = 30;
export const NEVOA_MAX_PONTOS_TRACO = 128;
export const NEVOA_MAX_PONTOS_TOTAL = 1000;
export const NEVOA_RAIO_MIN = 0.005;
export const NEVOA_RAIO_MAX = 0.5;
export const NEVOA_MAX_ID = 48;
/** Tolerância geométrica documentada: pontos a <= 1+eps do traço contam como revelados. */
const NEVOA_EPS = 1e-9;

export const nevoaPadrao = (): NevoaVtt => ({ ativa: false, revelados: [] });
export const vttVazio = (): VttState => ({ mapa: null, tokens: [], nevoa: nevoaPadrao() });

const db = getDb();

const coordOk = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Sanitiza o campo `nevoa` de um vtt_state persistido.
 * - ausente/inválido como "sem névoa" → { ativa:false, revelados:[] } (retrocompatível);
 * - presente mas malformado ou acima dos limites → { ativa:true, revelados:[] }
 *   (falha segura: esconde o mapa em vez de vazá-lo por engano).
 */
export function nevoaSanitizada(raw: unknown, sessionId: string): NevoaVtt {
  if (raw === undefined || raw === null) return nevoaPadrao();
  const o = raw as { ativa?: unknown; revelados?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.ativa !== "boolean" || !Array.isArray(o.revelados)) {
    console.error(`[vtt] nevoa malformada na sessão ${sessionId} — adotando névoa ativa vazia`);
    return { ativa: true, revelados: [] };
  }
  const tracos: TracoNevoa[] = [];
  let totalPontos = 0;
  for (const tr of o.revelados) {
    const t = tr as { id?: unknown; raioX?: unknown; raioY?: unknown; pontos?: unknown } | null;
    if (!t || typeof t !== "object") return { ativa: true, revelados: [] };
    if (typeof t.id !== "string" || !t.id || t.id.length > NEVOA_MAX_ID) return { ativa: true, revelados: [] };
    if (typeof t.raioX !== "number" || !Number.isFinite(t.raioX) || t.raioX < NEVOA_RAIO_MIN || t.raioX > NEVOA_RAIO_MAX) return { ativa: true, revelados: [] };
    if (typeof t.raioY !== "number" || !Number.isFinite(t.raioY) || t.raioY < NEVOA_RAIO_MIN || t.raioY > NEVOA_RAIO_MAX) return { ativa: true, revelados: [] };
    if (!Array.isArray(t.pontos) || t.pontos.length === 0 || t.pontos.length > NEVOA_MAX_PONTOS_TRACO) return { ativa: true, revelados: [] };
    totalPontos += t.pontos.length;
    if (totalPontos > NEVOA_MAX_PONTOS_TOTAL) return { ativa: true, revelados: [] };
    const pontos: PontoNevoa[] = [];
    for (const p of t.pontos) {
      const q = p as { x?: unknown; y?: unknown } | null;
      if (!q || typeof q !== "object" || !coordOk(q.x) || !coordOk(q.y)) return { ativa: true, revelados: [] };
      pontos.push({ x: Math.round(q.x * 1e4) / 1e4, y: Math.round(q.y * 1e4) / 1e4 });
    }
    tracos.push({ id: t.id, raioX: t.raioX, raioY: t.raioY, pontos });
    if (tracos.length > NEVOA_MAX_TRAÇOS) return { ativa: true, revelados: [] };
  }
  return { ativa: o.ativa, revelados: tracos };
}

/**
 * Valida um traço recebido do cliente para a operação `revelar`.
 * Retorna o traço sanitizado (sem id — o servidor gera) ou { erro }.
 */
export function tracoRevelarValido(raw: unknown): { ok: true; traco: Omit<TracoNevoa, "id"> } | { ok: false; erro: string } {
  const t = raw as { raioX?: unknown; raioY?: unknown; pontos?: unknown } | null;
  if (!t || typeof t !== "object") return { ok: false, erro: "Traço inválido" };
  const { raioX, raioY, pontos } = t;
  if (typeof raioX !== "number" || !Number.isFinite(raioX) || raioX < NEVOA_RAIO_MIN || raioX > NEVOA_RAIO_MAX
    || typeof raioY !== "number" || !Number.isFinite(raioY) || raioY < NEVOA_RAIO_MIN || raioY > NEVOA_RAIO_MAX) {
    return { ok: false, erro: "Raio fora do intervalo permitido" };
  }
  if (!Array.isArray(pontos) || pontos.length === 0 || pontos.length > NEVOA_MAX_PONTOS_TRACO) {
    return { ok: false, erro: "Quantidade de pontos inválida" };
  }
  const limpos: PontoNevoa[] = [];
  for (const p of pontos) {
    const q = p as { x?: unknown; y?: unknown } | null;
    if (!q || typeof q !== "object" || !coordOk(q.x) || !coordOk(q.y)) return { ok: false, erro: "Coordenada inválida" };
    limpos.push({ x: Math.round(q.x * 1e4) / 1e4, y: Math.round(q.y * 1e4) / 1e4 });
  }
  return { ok: true, traco: { raioX, raioY, pontos: limpos } };
}

/** Leitura defensiva do JSON persistido: nunca lança; inválido → vazio + log. */
export function vttDeTexto(raw: unknown, sessionId: string): VttState {
  if (raw == null || raw === "") return vttVazio();
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); }
    catch (e) {
      console.error(`[vtt] vtt_state inválido na sessão ${sessionId} — usando estado vazio:`, e);
      return vttVazio();
    }
  }
  const o = v as Partial<VttState> | null;
  const tokens = (Array.isArray(o?.tokens) ? o.tokens : []).filter((tk): tk is TokenVtt =>
    !!tk && typeof tk === "object"
    && typeof (tk as TokenVtt).id === "string"
    && typeof (tk as TokenVtt).nome === "string"
    && typeof (tk as TokenVtt).x === "number" && Number.isFinite((tk as TokenVtt).x)
    && typeof (tk as TokenVtt).y === "number" && Number.isFinite((tk as TokenVtt).y)
    && (tk as TokenVtt).x >= 0 && (tk as TokenVtt).x <= 1
    && (tk as TokenVtt).y >= 0 && (tk as TokenVtt).y <= 1
    && typeof (tk as TokenVtt).cor === "string");
  const mp = o?.mapa as { fileId?: unknown; nome?: unknown; largura?: unknown; altura?: unknown } | null | undefined;
  const mapa = mp && typeof mp === "object" && typeof mp.fileId === "string"
    ? {
        fileId: mp.fileId,
        nome: typeof mp.nome === "string" ? mp.nome : "Mapa",
        largura: typeof mp.largura === "number" && Number.isFinite(mp.largura) ? mp.largura : undefined,
        altura: typeof mp.altura === "number" && Number.isFinite(mp.altura) ? mp.altura : undefined,
      }
    : null;
  return { mapa, tokens, nevoa: nevoaSanitizada(o?.nevoa, sessionId) };
}

/** Lê vtt_state como texto bruto (contorna o parse json do Drizzle). */
export async function lerVtt(sessionId: string): Promise<VttState> {
  const [row] = await db.select({ v: sql<string | null>`vtt_state` }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return vttDeTexto(row?.v, sessionId);
}

// ---------- geometria da névoa ----------

/** Distância elíptica normalizada do ponto p ao segmento a–b (espaço escalado por raio). */
function distSegElipse(px: number, py: number, ax: number, ay: number, bx: number, by: number, rx: number, ry: number): number {
  // escala para espaço euclidiano: u = x/rx, v = y/ry
  const pax = (px - ax) / rx, pay = (py - ay) / ry;
  const pbx = (bx - ax) / rx, pby = (by - ay) / ry;
  const len2 = pbx * pbx + pby * pby;
  let t = len2 === 0 ? 0 : (pax * pbx + pay * pby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = pax - pbx * t, cy = pay - pby * t;
  return Math.sqrt(cx * cx + cy * cy);
}

/** Ponto (coords 0–1) está dentro de um traço? Cápsula elíptica sobre a polilinha. */
export function pontoEmTraco(px: number, py: number, t: TracoNevoa): boolean {
  const ps = t.pontos;
  if (ps.length === 1) return distSegElipse(px, py, ps[0].x, ps[0].y, ps[0].x, ps[0].y, t.raioX, t.raioY) <= 1 + NEVOA_EPS;
  for (let i = 0; i < ps.length - 1; i++) {
    if (distSegElipse(px, py, ps[i].x, ps[i].y, ps[i + 1].x, ps[i + 1].y, t.raioX, t.raioY) <= 1 + NEVOA_EPS) return true;
  }
  return false;
}

/** Regra geral de visibilidade do mapa para não-mestres. */
export function pontoVisivelNevoa(nevoa: NevoaVtt, x: number, y: number): boolean {
  if (!nevoa.ativa) return true;
  return nevoa.revelados.some((t) => pontoEmTraco(x, y, t));
}

// ---------- dono efetivo dos tokens (lote, sem N+1) ----------

/**
 * Resolve o dono efetivo de cada token em lote:
 * userId direto ou userId da membership do personagem — sempre exigindo
 * membership ATIVA na campanha (token.userId sozinho não basta).
 * Retorna Map<tokenId, userId | null>.
 */
export async function donosDosTokens(sessionId: string, tokens: TokenVtt[]): Promise<Map<string, string | null>> {
  const mapa = new Map<string, string | null>();
  if (!tokens.length) return mapa;
  const [sess] = await db.select({ campaignId: sessions.campaignId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!sess) { for (const t of tokens) mapa.set(t.id, null); return mapa; }
  const cid = sess.campaignId;

  const uids = [...new Set(tokens.map((t) => t.userId).filter((u): u is string => typeof u === "string" && !!u))];
  const pids = [...new Set(tokens.map((t) => t.personagemId).filter((p): p is string => typeof p === "string" && !!p))];

  // personagemId -> userId dono (membership ativa)
  const pidDono = new Map<string, string>();
  // userIds com membership ativa na campanha (diretos + vindos de personagens)
  const uidValido = new Set<string>();
  const candidatos = new Set<string>(uids);
  if (pids.length) {
    const chars = await db.select({ id: characters.id, membershipId: characters.membershipId }).from(characters)
      .where(and(eq(characters.campaignId, cid), inArray(characters.id, pids)));
    const mids = chars.map((c) => c.membershipId);
    if (mids.length) {
      const mems = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships)
        .where(and(inArray(memberships.id, mids), eq(memberships.status, "ativo")));
      const memUser = new Map(mems.map((m) => [m.id, m.userId]));
      for (const c of chars) {
        const uid = memUser.get(c.membershipId);
        if (uid) { pidDono.set(c.id, uid); candidatos.add(uid); }
      }
    }
  }
  if (candidatos.size) {
    const rows = await db.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.campaignId, cid), eq(memberships.status, "ativo"), inArray(memberships.userId, [...candidatos])));
    for (const r of rows) uidValido.add(r.userId);
  }
  for (const t of tokens) {
    // dono por userId direto e por personagemId são resolvidos de forma
    // independente; se ambos existem e divergem, a exceção é NEGADA —
    // nunca escolhemos silenciosamente um dos dois.
    const donoUser = t.userId && uidValido.has(t.userId) ? t.userId : null;
    const uidPers = t.personagemId ? pidDono.get(t.personagemId) : undefined;
    const donoPers = uidPers && uidValido.has(uidPers) ? uidPers : null;
    let dono: string | null;
    if (donoUser && donoPers && donoUser !== donoPers) dono = null;
    else dono = donoUser ?? donoPers;
    mapa.set(t.id, dono);
  }
  return mapa;
}

// ---------- filtro por destinatário ----------

export type PapelVtt = "mestre" | "jogador" | "espectador";

/**
 * Visão VTT de um destinatário. Nunca muta o estado original.
 * - mestre ou névoa desativada → estado completo;
 * - não-mestre → tokens filtrados pela névoa; jogador mantém o próprio token
 *   (dono efetivo resolvido no servidor) mesmo fora da área revelada.
 */
export function vttParaDestinatario(
  vtt: VttState, papel: PapelVtt, userId: string, donos: Map<string, string | null>
): VttState {
  if (papel === "mestre" || !vtt.nevoa.ativa) return vtt;
  const tokens = vtt.tokens.filter((tk) =>
    pontoVisivelNevoa(vtt.nevoa, tk.x, tk.y) || (papel === "jogador" && donos.get(tk.id) === userId));
  return { ...vtt, tokens };
}

/**
 * Filtro para respostas HTTP (routes/sessoes.ts).
 * Devolve o vttState como string JSON (mesmo tipo do texto persistido)
 * já filtrado para o requisitante; null quando não há estado.
 */
export async function vttStateFiltradoHttp(
  sessao: { id: string; vttState: unknown }, papel: PapelVtt, userId: string
): Promise<unknown> {
  const raw = sessao.vttState;
  if (raw == null || raw === "") return raw ?? null;
  const vtt = vttDeTexto(typeof raw === "string" ? raw : JSON.stringify(raw), sessao.id);
  if (papel === "mestre" || !vtt.nevoa.ativa) return raw;
  const donos = await donosDosTokens(sessao.id, vtt.tokens);
  return JSON.stringify(vttParaDestinatario(vtt, papel, userId, donos));
}
