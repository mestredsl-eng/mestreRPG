import { Router } from "express";
import { and, desc, eq, inArray, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { sessions, turns, chatMessages, tests, memberships, users, characters, rolls, auditLogs } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, permissoesDe } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha, barreiraRestauracaoAtiva } from "../lib/io.js";
import { vttStateFiltradoHttp } from "../lib/vtt.js";

const db = getDb();
export const sessoesRouter = Router({ mergeParams: true });
sessoesRouter.use(requireAuth);

// ---------- helpers ----------

// vtt_state é JSON livre: uma corrupção não pode derrubar a listagem/detalhe
// das sessões (chat, turnos, timer e histórico continuam funcionando).
const { vttState: _vttOmit, ...COLS_SEM_VTT } = getTableColumns(sessions);

async function sessoesComVttSeguro(where: ReturnType<typeof eq> | ReturnType<typeof and>) {
  try {
    return await db.select().from(sessions).where(where);
  } catch (e) {
    console.error("[vtt] falha ao ler sessões (vtt_state inválido?) — seguindo sem o estado VTT:", e);
    const rows = await db.select(COLS_SEM_VTT).from(sessions).where(where);
    return rows.map((r) => ({ ...r, vttState: null }));
  }
}

async function sessaoDaCampanha(sessionId: string, campaignId: string) {
  const [s] = await sessoesComVttSeguro(and(eq(sessions.id, sessionId), eq(sessions.campaignId, campaignId)));
  return s ?? null;
}

async function turnosDaSessao(sessionId: string) {
  const [t] = await db.select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1);
  return t ?? null;
}

/** Visibilidade da mensagem para o usuário requisitante (spec §4/§14).
 *  Autorização por visibilidade EXPLÍCITA, fail-closed:
 *  - publica|sistema → participantes autorizados;
 *  - mestre|secreta|qualquer valor ausente/desconhecido → somente
 *    mestres ATUAIS (ser o autor histórico NÃO concede exceção);
 *  - privada → mestres, autor e destinatários autorizados. */
export function mensagemVisivel(
  m: typeof chatMessages.$inferSelect,
  usuarioId: string,
  ehMestre: boolean,
  membershipIds: Set<string>
): boolean {
  if (m.visibility === "publica" || m.visibility === "sistema") return true;
  if (ehMestre) return true;
  if (m.visibility !== "privada") return false;
  if (m.authorId === usuarioId) return true;
  const recips = (m.recipients ?? []) as string[];
  return recips.includes(usuarioId) || recips.some((r) => membershipIds.has(r));
}

/** Remove `target` (dificuldade interna, §13.3) da serialização para
 *  não-mestres — a propriedade some do JSON, não vira null/placeholder. */
function testeSemDificuldade<T extends { target?: unknown }>(t: T): Omit<T, "target"> {
  const { target: _omitido, ...resto } = t;
  return resto;
}

// ---------- CRUD de sessões (mestre gerencia) ----------

/** GET /api/campaigns/:campaignId/sessoes */
sessoesRouter.get("/", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const lista = await sessoesComVttSeguro(eq(sessions.campaignId, req.params.campaignId));
  lista.sort((a, b) => b.number - a.number);
  // névoa: vttState filtrado por destinatário (jogador não recebe tokens ocultos)
  const papel = req.membership!.role as "mestre" | "jogador" | "espectador";
  const uid = req.usuario!.id;
  const filtrada = await Promise.all(lista.map(async (s) => ({
    ...s, vttState: await vttStateFiltradoHttp(s, papel, uid),
  })));
  res.json({ sessoes: filtrada });
});

const criarSchema = z.object({ name: z.string().max(160).optional() });

/** POST /api/campaigns/:campaignId/sessoes — mestre inicia sessão */
sessoesRouter.post("/", requirePapel("mestre"), async (req, res) => {
  const body = criarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const cid = req.params.campaignId;
  // mutação durante restauração seria sobrescrita pelo commit — rejeita
  if (barreiraRestauracaoAtiva(cid)) { res.status(409).json({ erro: "Campanha em restauração" }); return; }
  const rows = await db.select({ number: sessions.number }).from(sessions).where(eq(sessions.campaignId, cid));
  const proximo = rows.reduce((m, r) => Math.max(m, r.number), 0) + 1;
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id, campaignId: cid, number: proximo, name: body.data.name ?? `Sessão ${proximo}`,
    status: "ativa", startedAt: agora, createdBy: req.usuario!.id, createdAt: agora, updatedAt: agora,
  });
  await db.insert(turns).values({ id: crypto.randomUUID(), sessionId: id, state: { ordem: [], atual: -1, ativo: false }, updatedBy: req.usuario!.id, updatedAt: agora });
  await audit(req, "sessao.criada", { sessionId: id });
  emitirCampanha(cid, "sessao:atualizada", { sessionId: id });
  const [s] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  res.status(201).json({ sessao: s });
});

const patchSchema = z.object({
  name: z.string().max(160).optional(),
  summary: z.string().max(20000).optional(),
  status: z.enum(["ativa", "pausada", "encerrada"]).optional(),
});

/** PATCH /api/campaigns/:campaignId/sessoes/:sessionId — pausar/retomar/encerrar */
sessoesRouter.patch("/:sessionId", requirePapel("mestre"), async (req, res) => {
  const s = await sessaoDaCampanha(req.params.sessionId, req.params.campaignId);
  if (!s) { res.status(404).json({ erro: "Sessão não encontrada" }); return; }
  if (barreiraRestauracaoAtiva(s.campaignId)) { res.status(409).json({ erro: "Campanha em restauração" }); return; }
  const body = patchSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const agora = new Date();
  const updates: Record<string, unknown> = { updatedAt: agora };
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.summary !== undefined) updates.summary = body.data.summary;
  if (body.data.status !== undefined) {
    updates.status = body.data.status;
    if (body.data.status === "encerrada") updates.endedAt = agora;
    if (body.data.status === "pausada" && s.timerState && (s.timerState as { status?: string }).status === "rodando") {
      const ts = s.timerState as { remainingMs?: number; totalMs?: number; endsAt?: number };
      const rest = ts.endsAt ? Math.max(0, ts.endsAt - Date.now()) : (ts.remainingMs ?? 0);
      updates.timerState = { status: "pausado", remainingMs: rest, totalMs: ts.totalMs ?? rest };
    }
  }
  await db.update(sessions).set(updates).where(eq(sessions.id, s.id));
  await audit(req, "sessao.atualizada", { sessionId: s.id, status: body.data.status });
  emitirCampanha(s.campaignId, "sessao:atualizada", { sessionId: s.id });
  res.json({ ok: true });
});

/** GET /api/campaigns/:campaignId/sessoes/:sessionId — detalhe + turnos */
sessoesRouter.get("/:sessionId", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const s = await sessaoDaCampanha(req.params.sessionId, req.params.campaignId);
  if (!s) { res.status(404).json({ erro: "Sessão não encontrada" }); return; }
  const t = await turnosDaSessao(s.id);
  res.json({
    sessao: { ...s, vttState: await vttStateFiltradoHttp(s, req.membership!.role as "mestre" | "jogador" | "espectador", req.usuario!.id) },
    turnos: t?.state ?? { ordem: [], atual: -1, ativo: false },
  });
});

/** GET /api/campaigns/:campaignId/sessoes/:sessionId/mensagens?limite=200 */
sessoesRouter.get("/:sessionId/mensagens", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const s = await sessaoDaCampanha(req.params.sessionId, req.params.campaignId);
  if (!s) { res.status(404).json({ erro: "Sessão não encontrada" }); return; }
  const limite = Math.min(Number(req.query.limite) || 200, 500);
  const msgs = await db.select().from(chatMessages)
    .where(eq(chatMessages.sessionId, s.id))
    .orderBy(desc(chatMessages.createdAt)).limit(limite);
  const ehMestre = req.membership!.role === "mestre";
  const meusIds = new Set([req.usuario!.id, req.membership!.id]);
  const visiveis = msgs.filter((m) => mensagemVisivel(m, req.usuario!.id, ehMestre, meusIds));
  const autorIds = [...new Set(visiveis.map((m) => m.authorId).filter(Boolean) as string[])];
  const autores = autorIds.length
    ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, autorIds))
    : [];
  const mapa = new Map(autores.map((a) => [a.id, a]));
  res.json({
    mensagens: visiveis.reverse().map((m) => ({ ...m, autor: m.authorId ? mapa.get(m.authorId) ?? null : null })),
  });
});

/** GET /api/campaigns/:campaignId/sessoes/:sessionId/testes — solicitações filtradas por papel */
sessoesRouter.get("/:sessionId/testes", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const s = await sessaoDaCampanha(req.params.sessionId, req.params.campaignId);
  if (!s) { res.status(404).json({ erro: "Sessão não encontrada" }); return; }
  const lista = await db.select().from(tests).where(eq(tests.sessionId, s.id)).orderBy(desc(tests.createdAt)).limit(100);
  const ehMestre = req.membership!.role === "mestre";
  const minhas = await db.select().from(memberships)
    .where(and(eq(memberships.campaignId, req.params.campaignId), eq(memberships.userId, req.usuario!.id)));
  const meusChars = new Set(
    (await db.select({ id: characters.id, membershipId: characters.membershipId }).from(characters)
      .where(eq(characters.campaignId, req.params.campaignId)))
      .filter((c) => minhas.some((m) => m.id === c.membershipId)).map((c) => c.id)
  );
  // fail-closed: só "publica" é pública e só "privada" chega ao dono —
  // mestre/secreta/desconhecida são exclusivas de mestres atuais
  const visiveis = lista.filter((t) =>
    ehMestre || t.visibility === "publica" || (t.visibility === "privada" && meusChars.has(t.characterId))
  );
  // `target` é dificuldade interna: sai da serialização para não-mestres
  res.json({ testes: ehMestre ? visiveis : visiveis.map(testeSemDificuldade) });
});

/** GET /api/campaigns/:campaignId/sessoes/:sessionId/historico — histórico consolidado (Etapa 8) */
sessoesRouter.get("/:sessionId/historico", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  // espectador sem permissão individual de histórico (Etapa 13)
  if (req.membership!.role === "espectador" && permissoesDe(req.membership).verHistorico === false) {
    res.status(403).json({ erro: "Sem permissão para consultar o histórico" }); return;
  }
  const s = await sessaoDaCampanha(req.params.sessionId, req.params.campaignId);
  if (!s) { res.status(404).json({ erro: "Sessão não encontrada" }); return; }
  const ehMestre = req.membership!.role === "mestre";
  const meusIds = new Set([req.usuario!.id, req.membership!.id]);

  const todosMsgs = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, s.id)).orderBy(chatMessages.createdAt);
  const eventos = todosMsgs.filter((m) => mensagemVisivel(m, req.usuario!.id, ehMestre, meusIds));
  const todosTestes = await db.select().from(tests).where(eq(tests.sessionId, s.id));
  const minhas = await db.select().from(memberships)
    .where(and(eq(memberships.campaignId, req.params.campaignId), eq(memberships.userId, req.usuario!.id)));
  const meusChars = new Set(
    (await db.select({ id: characters.id, membershipId: characters.membershipId }).from(characters)
      .where(eq(characters.campaignId, req.params.campaignId)))
      .filter((c) => minhas.some((m) => m.id === c.membershipId)).map((c) => c.id)
  );
  const testesVisiveis = todosTestes.filter((t) =>
    ehMestre || t.visibility === "publica" || (t.visibility === "privada" && meusChars.has(t.characterId))
  );
  const rollsIds = testesVisiveis.map((t) => t.rollId).filter(Boolean) as string[];
  const rollsSessao = await db.select().from(rolls).where(eq(rolls.sessionId, s.id));
  const rolagensVisiveis = rollsSessao.filter((r) => {
    if (ehMestre) return true;
    if (r.visibility === "publica") return true;
    if (r.visibility !== "privada") return false; // secreta/desconhecida: fail-closed
    // privada DE PERSONAGEM: só o dono atual daquele personagem —
    // possuir outro personagem na campanha NÃO autoriza
    if (r.characterId) return meusChars.has(r.characterId);
    // privada LIVRE: somente o próprio autor da rolagem
    return r.userId === req.usuario!.id;
  });

  // participantes: autores de mensagens + donos de testes + quem estava online não é persistido;
  // usamos membros ativos da campanha + autores presentes no chat
  const autorIds = [...new Set([...eventos.map((m) => m.authorId), ...testesVisiveis.map((t) => t.requestedBy)].filter(Boolean) as string[])];
  const autores = autorIds.length
    ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, autorIds))
    : [];

  const inicio = s.startedAt ? new Date(s.startedAt).getTime() : null;
  const fim = s.endedAt ? new Date(s.endedAt).getTime() : null;

  // alterações relevantes da campanha no período da sessão (audit_logs)
  const limiteInicio = s.startedAt ?? new Date(0);
  const limiteFim = s.endedAt ?? new Date();
  const auditorias = await db.select().from(auditLogs)
    .where(and(eq(auditLogs.campaignId, req.params.campaignId)))
    .orderBy(auditLogs.createdAt);
  const alteracoes = auditorias.filter((a) => {
    const t = new Date(a.createdAt).getTime();
    return t >= new Date(limiteInicio).getTime() && t <= new Date(limiteFim).getTime();
  });
  const atorIds = [...new Set(alteracoes.map((a) => a.actorId).filter(Boolean) as string[])];
  const atores = atorIds.length
    ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, atorIds))
    : [];

  res.json({
    sessao: { ...s, vttState: await vttStateFiltradoHttp(s, req.membership!.role as "mestre" | "jogador" | "espectador", req.usuario!.id) },
    duracaoMs: inicio && fim ? fim - inicio : null,
    participantes: autores,
    eventos: eventos.map((m) => ({ id: m.id, kind: m.kind, content: m.content, createdAt: m.createdAt, autor: m.authorId ? autores.find((a) => a.id === m.authorId) ?? null : null })),
    testes: ehMestre ? testesVisiveis : testesVisiveis.map(testeSemDificuldade),
    rolagens: rolagensVisiveis,
    alteracoes: alteracoes.map((a) => ({
      id: a.id, action: a.action, createdAt: a.createdAt,
      autor: a.actorId ? atores.find((u) => u.id === a.actorId) ?? null : null,
      // detalhe só para o mestre — pode conter ids/dados internos
      detalhe: ehMestre ? a.detail : undefined,
    })),
    resumo: s.summary,
  });
});

/** GET /api/campaigns/:campaignId/sessoes/:sessionId/estado — snapshot para reconexão */
sessoesRouter.get("/:sessionId/estado", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const s = await sessaoDaCampanha(req.params.sessionId, req.params.campaignId);
  if (!s) { res.status(404).json({ erro: "Sessão não encontrada" }); return; }
  const t = await turnosDaSessao(s.id);
  res.json({
    sessao: { ...s, vttState: await vttStateFiltradoHttp(s, req.membership!.role as "mestre" | "jogador" | "espectador", req.usuario!.id) },
    turnos: t?.state ?? { ordem: [], atual: -1, ativo: false }, agora: Date.now(),
  });
});
