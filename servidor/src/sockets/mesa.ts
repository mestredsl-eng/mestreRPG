import { randomInt, randomUUID } from "node:crypto";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  sessions, turns, chatMessages, rolls, tests, characters, memberships, users,
} from "../db/schema.js";
import { mensagemVisivel } from "../routes/sessoes.js";
import { agendarAutosave } from "../lib/autosave.js";
import { permissoesDe } from "../lib/permissoes.js";

const db = getDb();

type Usuario = { id: string; username: string; displayName?: string | null };
type Papel = "mestre" | "jogador" | "espectador";

interface Ctx {
  sessao: typeof sessions.$inferSelect;
  membership: typeof memberships.$inferSelect;
  papel: Papel;
}

const LADOS_VALIDOS = new Set([4, 6, 8, 10, 20]);

// ---------- helpers ----------

async function resolverCtx(socket: Socket, sessionId: string): Promise<Ctx | { erro: string }> {
  const usuario = socket.data.usuario as Usuario | undefined;
  if (!usuario) return { erro: "Não autenticado" };
  const [sessao] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!sessao) return { erro: "Sessão não encontrada" };
  const [m] = await db.select().from(memberships)
    .where(and(eq(memberships.campaignId, sessao.campaignId), eq(memberships.userId, usuario.id), eq(memberships.status, "ativo")))
    .limit(1);
  if (!m) return { erro: "Sem permissão nesta campanha" };
  return { sessao, membership: m, papel: m.role as Papel };
}

async function mestresDaCampanha(campaignId: string): Promise<string[]> {
  const rows = await db.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), eq(memberships.role, "mestre"), eq(memberships.status, "ativo")));
  return rows.map((r) => r.userId);
}

async function nomeUsuario(id: string | null | undefined): Promise<string> {
  if (!id) return "Sistema";
  const [u] = await db.select({ username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, id)).limit(1);
  return u?.displayName || u?.username || "?";
}

/** Emite mensagem de chat respeitando visibilidade (spec §4/§14). */
async function emitirMensagem(io: SocketIOServer, msg: typeof chatMessages.$inferSelect) {
  const autorNome = await nomeUsuario(msg.authorId);
  const payload = { ...msg, autorNome };
  if (!msg.sessionId) {
    io.to(`campanha:${msg.campaignId}`).emit("mesa:mensagem", payload);
    return;
  }
  const room = `sessao:${msg.sessionId}`;
  if (msg.visibility === "publica" || msg.visibility === "sistema") {
    io.to(room).emit("mesa:mensagem", payload);
    return;
  }
  if (msg.visibility === "mestre" || msg.visibility === "secreta") {
    const mestres = await mestresDaCampanha(msg.campaignId);
    for (const uid of mestres) io.to(`usuario:${uid}`).emit("mesa:mensagem", payload);
    return;
  }
  // privada: autor + destinatários
  const destinos = new Set<string>((msg.recipients ?? []) as string[]);
  if (msg.authorId) destinos.add(msg.authorId);
  for (const uid of destinos) io.to(`usuario:${uid}`).emit("mesa:mensagem", payload);
}

// ---------- dados ----------

async function registrarChat(
  io: SocketIOServer,
  opts: {
    campaignId: string; sessionId?: string | null; authorId?: string | null;
    kind?: string; content: string; visibility?: string;
    recipients?: string[]; clientId?: string;
  }
) {
  const id = opts.clientId && /^[0-9a-f-]{36}$/i.test(opts.clientId) ? opts.clientId : randomUUID();
  try {
    await db.insert(chatMessages).values({
      id, campaignId: opts.campaignId, sessionId: opts.sessionId ?? null,
      authorId: opts.authorId ?? null, kind: opts.kind ?? "texto",
      content: opts.content, visibility: opts.visibility ?? "publica",
      recipients: opts.recipients ?? null, createdAt: new Date(),
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      const [existente] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
      if (existente) { await emitirMensagem(io, existente); return existente; }
    }
    throw e;
  }
  const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
  await emitirMensagem(io, msg);
  // Etapa 12: toda mutação de mesa que gera mensagem também agenda salvamento
  agendarAutosave(opts.campaignId);
  return msg;
}

async function turnoAtual(sessionId: string) {
  const [t] = await db.select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1);
  return t;
}

// ---------- dados ----------

function rolarLados(lados: number, count: number): number[] {
  return Array.from({ length: count }, () => randomInt(1, lados + 1));
}

// ---------- registro ----------

export function registrarMesa(io: SocketIOServer) {
  // cada socket entra na sala do próprio usuário para mensagens direcionadas
  io.on("connection", (socket) => {
    const u = socket.data.usuario as Usuario | undefined;
    if (u) socket.join(`usuario:${u.id}`);
  });

  // ---------- presença ----------
  function presentes(sessionId: string): string[] {
    const room = io.sockets.adapter.rooms.get(`sessao:${sessionId}`);
    if (!room) return [];
    const ids = new Set<string>();
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      const uid = (s?.data.usuario as Usuario | undefined)?.id;
      if (uid) ids.add(uid);
    }
    return [...ids];
  }
  async function emitirPresenca(sessionId: string) {
    io.to(`sessao:${sessionId}`).emit("mesa:presenca", { sessionId, online: presentes(sessionId) });
  }

  // ---------- entrada/saída ----------
  socket_handlers(io, presentes, emitirPresenca);
}

// separado para legibilidade
function socket_handlers(
  io: SocketIOServer,
  presentes: (sessionId: string) => string[],
  emitirPresenca: (sessionId: string) => Promise<void>
) {
  io.on("connection", (socket) => {
    const usuario = () => socket.data.usuario as Usuario | undefined;

    /** mesa:entrar {sessionId} — válido para mestre/jogador/espectador ativo */
    socket.on("mesa:entrar", async (payload: { sessionId?: string }, cb?: (r: unknown) => void) => {
      const sessionId = payload?.sessionId;
      if (!sessionId || !usuario()) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      const ctx = await resolverCtx(socket, sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
      socket.join(`sessao:${sessionId}`);
      const [t] = await db.select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1);
      const podeEnviar = ctx.papel !== "espectador" || permissoesDe(ctx.membership).enviarMensagens === true;
      cb?.({
        ok: true, papel: ctx.papel, podeEnviar,
        sessao: ctx.sessao,
        turnos: t?.state ?? { ordem: [], atual: -1, ativo: false },
        presenca: presentes(sessionId),
        agora: Date.now(),
      });
      await emitirPresenca(sessionId);
      await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId, authorId: usuario()!.id,
        kind: "evento", content: `${await nomeUsuario(usuario()!.id)} entrou na mesa`, visibility: "publica",
      });
    });

    socket.on("mesa:sair", (payload: { sessionId?: string }, cb?: (r: unknown) => void) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) { cb?.({ ok: false }); return; }
      socket.leave(`sessao:${sessionId}`);
      void emitirPresenca(sessionId);
      cb?.({ ok: true });
    });

    // ---------- chat / declarações ----------
    socket.on("mesa:mensagem", async (payload: {
      sessionId?: string; content?: string; clientId?: string;
      visibilidade?: "publica" | "privada" | "secreta"; destinatarioUserId?: string; tipo?: "texto" | "acao";
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.content?.trim()) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      // espectador só envia mensagem se o mestre concedeu a permissão individual
      if (ctx.papel === "espectador" && permissoesDe(ctx.membership).enviarMensagens !== true) {
        cb?.({ ok: false, erro: "Espectadores não podem enviar mensagens" }); return;
      }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }

      const vis = payload.visibilidade ?? "publica";
      // espectador só participa do chat público — nunca envia privada/secreta
      if (ctx.papel === "espectador" && vis !== "publica") {
        cb?.({ ok: false, erro: "Espectadores só podem enviar mensagens públicas" }); return;
      }
      let visibility = "publica";
      let recipients: string[] | undefined;
      if (vis === "secreta") {
        if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre envia mensagens secretas" }); return; }
        visibility = "mestre";
      } else if (vis === "privada") {
        if (!payload.destinatarioUserId) { cb?.({ ok: false, erro: "Destinatário obrigatório" }); return; }
        // destinatário precisa ser membro ativo da campanha
        const [dm] = await db.select({ id: memberships.id }).from(memberships)
          .where(and(eq(memberships.campaignId, ctx.sessao.campaignId), eq(memberships.userId, payload.destinatarioUserId), eq(memberships.status, "ativo"))).limit(1);
        if (!dm) { cb?.({ ok: false, erro: "Destinatário inválido" }); return; }
        visibility = "privada";
        recipients = [payload.destinatarioUserId];
      }

      const msg = await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: payload.tipo === "acao" ? "acao" : "texto",
        content: payload.content.trim().slice(0, 4000),
        visibility, recipients, clientId: payload.clientId,
      });
      cb?.({ ok: true, id: msg?.id });
    });

    // ---------- solicitações de teste (mestre) ----------
    socket.on("mesa:teste:pedir", async (payload: {
      sessionId?: string; characterId?: string; rotulo?: string;
      campoId?: string; skillRef?: unknown; bonus?: number; malus?: number;
      dadosLados?: number; dadosCount?: number; minimo?: number;
      visibilidade?: "publica" | "privada"; requestId?: string;
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.characterId) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre solicita testes" }); return; }

      const [char] = await db.select().from(characters).where(and(eq(characters.id, payload.characterId), eq(characters.campaignId, ctx.sessao.campaignId))).limit(1);
      if (!char) { cb?.({ ok: false, erro: "Personagem não encontrado" }); return; }
      const [membroDono] = await db.select().from(memberships).where(eq(memberships.id, char.membershipId)).limit(1);
      if (!membroDono) { cb?.({ ok: false, erro: "Dono não encontrado" }); return; }

      // dados calculados no servidor: campoId → valor numérico da ficha; senão dadosCount explícito
      const dadosLados = LADOS_VALIDOS.has(payload.dadosLados ?? 0) ? payload.dadosLados! : 20;
      let count = payload.dadosCount ?? 1;
      let valorCampo: number | null = null;
      if (payload.campoId) {
        const dados = (char.data ?? {}) as Record<string, unknown>;
        const v = dados[payload.campoId];
        if (typeof v === "number" && Number.isFinite(v)) {
          valorCampo = v;
          count = Math.max(1, Math.round(v) + (payload.bonus ?? 0) - (payload.malus ?? 0));
        }
      }
      count = Math.min(Math.max(1, count), 30);

      const id = payload.requestId ?? randomUUID();
      const agora = new Date();
      try {
        await db.insert(tests).values({
          id, campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id,
          characterId: char.id, requestedBy: u.id,
          skillRef: (payload.skillRef ?? (payload.campoId ? { campoId: payload.campoId, rotulo: payload.rotulo } : null)) as never,
          modifiers: { bonus: payload.bonus ?? 0, malus: payload.malus ?? 0, valorCampo } as never,
          diceCount: count, diceSides: dadosLados,
          target: payload.minimo ?? null,
          status: "pendente",
          visibility: payload.visibilidade === "privada" ? "privada" : "publica",
          requestId: payload.requestId ?? null,
          createdAt: agora, updatedAt: agora,
        });
      } catch (e) {
        if (String(e).includes("UNIQUE") && payload.requestId) {
          const [ex] = await db.select().from(tests).where(and(eq(tests.campaignId, ctx.sessao.campaignId), eq(tests.requestId, payload.requestId))).limit(1);
          cb?.({ ok: true, id: ex?.id, duplicado: true });
          return;
        }
        throw e;
      }

      // notifica: sala recebe versão pública; dono recebe completa (com alvo se privada)
      const nomeChar = char.name;
      const nomeAutor = await nomeUsuario(u.id);
      const publico = {
        id, sessionId: ctx.sessao.id, characterId: char.id, characterName: nomeChar,
        requestedByName: nomeAutor, rotulo: payload.rotulo ?? null,
        skillRef: payload.skillRef ?? null, // skillRef pode ter nome; mínimo NÃO vai
        status: "pendente", createdAt: agora,
      };
      if (payload.visibilidade === "privada") {
        // privada: só dono do personagem + mestres recebem (com alvo/dados)
        io.to(`usuario:${membroDono.userId}`).emit("mesa:teste", {
          ...publico, alvo: payload.minimo ?? null,
          dados: { lados: dadosLados, count }, privado: true,
        });
        const mestresPriv = await mestresDaCampanha(ctx.sessao.campaignId);
        for (const mid of mestresPriv) io.to(`usuario:${mid}`).emit("mesa:teste", {
          ...publico, alvo: payload.minimo ?? null,
          dados: { lados: dadosLados, count }, privado: true,
        });
      } else {
        io.to(`sessao:${ctx.sessao.id}`).emit("mesa:teste", { ...publico, alvo: null });
        io.to(`usuario:${membroDono.userId}`).emit("mesa:teste", {
          ...publico, alvo: payload.minimo ?? null,
          dados: { lados: dadosLados, count }, privado: false,
        });
        io.to(`sessao:${ctx.sessao.id}`).emit("mesa:teste:detalhe", { id, alvo: payload.minimo ?? null, dados: { lados: dadosLados, count } });
      }

      await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: "teste", content: `${nomeAutor} solicitou teste para ${nomeChar}${payload.rotulo ? ` (${payload.rotulo})` : ""}`,
        visibility: payload.visibilidade === "privada" ? "privada" : "publica",
        recipients: payload.visibilidade === "privada" ? [membroDono.userId] : undefined,
      });
      cb?.({ ok: true, id });
    });

    // ---------- rolar teste pendente (dono do personagem ou mestre) ----------
    socket.on("mesa:teste:rolar", async (payload: { testId?: string; requestId?: string }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.testId) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      const [teste] = await db.select().from(tests).where(eq(tests.id, payload.testId)).limit(1);
      if (!teste || !teste.sessionId) { cb?.({ ok: false, erro: "Teste não encontrado" }); return; }
      const ctx = await resolverCtx(socket, teste.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      const [char] = await db.select().from(characters).where(eq(characters.id, teste.characterId)).limit(1);
      const [membroDono] = char ? await db.select().from(memberships).where(eq(memberships.id, char.membershipId)).limit(1) : [null];
      const ehDono = membroDono?.userId === u.id;
      if (ctx.papel !== "mestre" && !ehDono) { cb?.({ ok: false, erro: "Só o dono do personagem ou o mestre rolam" }); return; }
      if (teste.status !== "pendente") { cb?.({ ok: true, id: teste.id, status: teste.status, jaRolado: true }); return; }

      const resultados = rolarLados(teste.diceSides, teste.diceCount);
      const total = resultados.reduce((a, b) => a + b, 0);
      const rollId = payload.requestId ?? randomUUID();
      const agora = new Date();
      try {
        await db.insert(rolls).values({
          id: rollId, campaignId: teste.campaignId, sessionId: teste.sessionId,
          characterId: teste.characterId, userId: u.id,
          dice: [{ sides: teste.diceSides, count: teste.diceCount }] as never,
          results: { dados: resultados, total, soma: total } as never,
          reason: `teste:${teste.id}`, visibility: teste.visibility,
          requestId: payload.requestId ?? null, createdAt: agora,
        });
      } catch (e) {
        if (String(e).includes("UNIQUE") && payload.requestId) {
          const [ex] = await db.select().from(rolls).where(and(eq(rolls.campaignId, teste.campaignId), eq(rolls.requestId, payload.requestId))).limit(1);
          cb?.({ ok: true, rollId: ex?.id, duplicado: true });
          return;
        }
        throw e;
      }
      await db.update(tests).set({ status: "rolado", rollId, updatedAt: agora }).where(eq(tests.id, teste.id));

      const payloadRoll = {
        id: rollId, testId: teste.id, sessionId: teste.sessionId,
        characterId: teste.characterId, characterName: char?.name,
        userId: u.id, rolador: await nomeUsuario(u.id),
        dados: resultados, total, lados: teste.diceSides, count: teste.diceCount,
        alvo: teste.target, // só mestres recebem via filtro abaixo
        visibility: teste.visibility, createdAt: agora,
      };
      // público: sem alvo; privado: dono+mestre com alvo; mestre sempre com alvo
      io.to(`sessao:${teste.sessionId}`).emit("mesa:rolagem", { ...payloadRoll, alvo: null });
      if (membroDono) io.to(`usuario:${membroDono.userId}`).emit("mesa:rolagem", payloadRoll);
      const mestres = await mestresDaCampanha(teste.campaignId);
      for (const mid of mestres) io.to(`usuario:${mid}`).emit("mesa:rolagem", payloadRoll);

      await registrarChat(io, {
        campaignId: teste.campaignId, sessionId: teste.sessionId, authorId: u.id,
        kind: "rolagem",
        content: `${await nomeUsuario(u.id)} rolou ${teste.diceCount}d${teste.diceSides} → ${resultados.join(", ")} = ${total}`,
        visibility: teste.visibility === "privada" ? "privada" : "publica",
        recipients: teste.visibility === "privada" && membroDono ? [membroDono.userId] : undefined,
      });
      cb?.({ ok: true, id: rollId, dados: resultados, total });
    });

    // ---------- rolagem livre ----------
    socket.on("mesa:rolar", async (payload: {
      sessionId?: string; dados?: { sides: number; count: number }[];
      motivo?: string; visibilidade?: "publica" | "privada"; requestId?: string;
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.dados?.length) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectadores não podem rolar" }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }

      const dadosValidados = payload.dados.slice(0, 5).map((d) => ({
        sides: LADOS_VALIDOS.has(d.sides) ? d.sides : 20,
        count: Math.min(Math.max(1, Math.round(d.count) || 1), 30),
      }));
      const grupos = dadosValidados.map((d) => ({ ...d, resultados: rolarLados(d.sides, d.count) }));
      const total = grupos.reduce((s, g) => s + g.resultados.reduce((a, b) => a + b, 0), 0);
      const rollId = payload.requestId ?? randomUUID();
      const agora = new Date();
      const vis = payload.visibilidade === "privada" ? "privada" : "publica";
      try {
        await db.insert(rolls).values({
          id: rollId, campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id,
          characterId: null, userId: u.id,
          dice: dadosValidados as never,
          results: { grupos, total } as never,
          reason: payload.motivo?.slice(0, 300) ?? null,
          visibility: vis, requestId: payload.requestId ?? null, createdAt: agora,
        });
      } catch (e) {
        if (String(e).includes("UNIQUE") && payload.requestId) { cb?.({ ok: true, id: rollId, duplicado: true }); return; }
        throw e;
      }
      const rollPayload = {
        id: rollId, sessionId: ctx.sessao.id, userId: u.id, rolador: await nomeUsuario(u.id),
        grupos: grupos.map((g) => ({ lados: g.sides, resultados: g.resultados })),
        total, motivo: payload.motivo ?? null, visibility: vis, createdAt: agora,
      };
      if (vis === "publica") io.to(`sessao:${ctx.sessao.id}`).emit("mesa:rolagem", rollPayload);
      else {
        io.to(`usuario:${u.id}`).emit("mesa:rolagem", rollPayload);
        const mestres = await mestresDaCampanha(ctx.sessao.campaignId);
        for (const mid of mestres) io.to(`usuario:${mid}`).emit("mesa:rolagem", rollPayload);
      }
      await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: "rolagem",
        content: `${rollPayload.rolador} rolou ${grupos.map((g) => `${g.count}d${g.sides}`).join(" + ")} → ${total}${payload.motivo ? ` (${payload.motivo})` : ""}`,
        visibility: vis === "privada" ? "privada" : "publica",
        recipients: vis === "privada" ? [u.id, ...(await mestresDaCampanha(ctx.sessao.campaignId))] : undefined,
      });
      cb?.({ ok: true, id: rollId, grupos, total });
    });

    // ---------- decisão do mestre ----------
    socket.on("mesa:teste:decidir", async (payload: { testId?: string; outcome?: string; nota?: string }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.testId || !payload.outcome) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      const [teste] = await db.select().from(tests).where(eq(tests.id, payload.testId)).limit(1);
      if (!teste || !teste.sessionId) { cb?.({ ok: false, erro: "Teste não encontrado" }); return; }
      const ctx = await resolverCtx(socket, teste.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre decide" }); return; }
      const outcomes = ["sucesso", "parcial", "falha", "falha_critica", "personalizado"];
      if (!outcomes.includes(payload.outcome)) { cb?.({ ok: false, erro: "Resultado inválido" }); return; }
      await db.update(tests).set({ status: "decidido", outcome: payload.outcome, outcomeNote: payload.nota?.slice(0, 2000) ?? null, updatedAt: new Date() }).where(eq(tests.id, teste.id));
      const [char] = await db.select().from(characters).where(eq(characters.id, teste.characterId)).limit(1);
      const decisao = {
        testId: teste.id, sessionId: teste.sessionId, characterId: teste.characterId,
        characterName: char?.name, outcome: payload.outcome, nota: payload.nota ?? null,
        decididoPor: await nomeUsuario(u.id), visibility: teste.visibility,
      };
      io.to(`sessao:${teste.sessionId}`).emit("mesa:decisao", { ...decisao, alvo: null, nota: teste.visibility === "privada" ? null : decisao.nota });
      const mestres = await mestresDaCampanha(teste.campaignId);
      for (const mid of mestres) io.to(`usuario:${mid}`).emit("mesa:decisao", decisao);
      if (char) {
        const [md] = await db.select().from(memberships).where(eq(memberships.id, char.membershipId)).limit(1);
        if (md) io.to(`usuario:${md.userId}`).emit("mesa:decisao", decisao);
      }
      await registrarChat(io, {
        campaignId: teste.campaignId, sessionId: teste.sessionId, authorId: u.id,
        kind: "decisao", content: `Decisão: ${payload.outcome}${payload.nota ? ` — ${payload.nota}` : ""}`,
        visibility: teste.visibility === "privada" ? "privada" : "publica",
      });
      cb?.({ ok: true });
    });

    // ---------- turnos (mestre) ----------
    socket.on("mesa:turno", async (payload: {
      sessionId?: string; acao?: string;
      ordem?: string[]; primeiro?: number; pular?: number;
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.acao) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre controla turnos" }); return; }

      let t = await turnoAtual(payload.sessionId);
      if (!t) {
        const id = randomUUID();
        await db.insert(turns).values({ id, sessionId: payload.sessionId, state: { ordem: [], atual: -1, ativo: false }, updatedBy: u.id, updatedAt: new Date() });
        [t] = await db.select().from(turns).where(eq(turns.id, id)).limit(1);
      }
      const state = { ...((t.state ?? {}) as Record<string, unknown>) } as { ordem?: string[]; atual?: number; ativo?: boolean };
      state.ordem = state.ordem ?? [];
      const n = state.ordem.length;

      const rotuloMembro = async (membershipId: string) => {
        const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId)).limit(1);
        if (!m) return "?";
        return nomeUsuario(m.userId);
      };

      switch (payload.acao) {
        case "iniciar": {
          if (payload.ordem?.length) state.ordem = payload.ordem;
          state.ativo = true;
          state.atual = payload.primeiro !== undefined ? Math.min(Math.max(0, payload.primeiro), n - 1) : 0;
          break;
        }
        case "avancar":
          if (state.ativo && n > 0) state.atual = ((state.atual ?? -1) + 1) % n;
          break;
        case "voltar":
          if (state.ativo && n > 0) state.atual = ((state.atual ?? 0) - 1 + n) % n;
          break;
        case "pular": {
          const pular = payload.pular ?? 1;
          if (state.ativo && n > 0) state.atual = (((state.atual ?? -1) + pular) % n + n) % n;
          break;
        }
        case "definirOrdem":
          if (Array.isArray(payload.ordem)) { state.ordem = payload.ordem; if (state.atual !== undefined && state.atual >= state.ordem.length) state.atual = state.ordem.length - 1; }
          break;
        case "encerrar":
          state.ativo = false;
          break;
        default:
          cb?.({ ok: false, erro: "Ação inválida" }); return;
      }

      await db.update(turns).set({ state: state as never, updatedBy: u.id, updatedAt: new Date() }).where(eq(turns.id, t.id));
      io.to(`sessao:${payload.sessionId}`).emit("mesa:turnos", { sessionId: payload.sessionId, turnos: state });
      const atualId = state.ativo && state.atual !== undefined && state.atual >= 0 ? state.ordem[state.atual] : null;
      const rotulo = atualId ? await rotuloMembro(atualId) : null;
      await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: "evento",
        content: payload.acao === "iniciar" ? `Turnos iniciados${rotulo ? ` — começa ${rotulo}` : ""}`
          : payload.acao === "encerrar" ? "Sequência de turnos encerrada"
          : payload.acao === "avancar" || payload.acao === "voltar" || payload.acao === "pular" ? `Turno: ${rotulo ?? "—"}`
          : "Ordem de turnos atualizada",
        visibility: "publica",
      });
      cb?.({ ok: true, turnos: state });
    });

    // ---------- temporizador (mestre) ----------
    socket.on("mesa:timer", async (payload: { sessionId?: string; acao?: string; duracaoSegundos?: number }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.acao) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre controla o temporizador" }); return; }

      const [s] = await db.select().from(sessions).where(eq(sessions.id, payload.sessionId)).limit(1);
      if (!s) { cb?.({ ok: false, erro: "Sessão não encontrada" }); return; }
      const atual = (s.timerState ?? {}) as { status?: string; remainingMs?: number; totalMs?: number; endsAt?: number };
      const agora = Date.now();
      let novo: Record<string, unknown>;

      switch (payload.acao) {
        case "iniciar": {
          const dur = Math.min(Math.max(1, payload.duracaoSegundos ?? 300), 86400) * 1000;
          novo = { status: "rodando", endsAt: agora + dur, remainingMs: dur, totalMs: dur };
          break;
        }
        case "pausar": {
          const rest = atual.endsAt ? Math.max(0, atual.endsAt - agora) : (atual.remainingMs ?? 0);
          novo = { status: "pausado", remainingMs: rest, totalMs: atual.totalMs ?? rest };
          break;
        }
        case "retomar": {
          const rest = atual.remainingMs ?? 0;
          novo = rest > 0 ? { status: "rodando", endsAt: agora + rest, remainingMs: rest, totalMs: atual.totalMs ?? rest } : { status: "parado", remainingMs: 0, totalMs: atual.totalMs ?? 0 };
          break;
        }
        case "reiniciar": {
          const dur = (atual.totalMs ?? (payload.duracaoSegundos ?? 300) * 1000);
          novo = { status: "rodando", endsAt: agora + dur, remainingMs: dur, totalMs: dur };
          break;
        }
        case "encerrar":
          novo = { status: "parado", remainingMs: 0, totalMs: atual.totalMs ?? 0 };
          break;
        default:
          cb?.({ ok: false, erro: "Ação inválida" }); return;
      }
      await db.update(sessions).set({ timerState: novo as never, updatedAt: new Date() }).where(eq(sessions.id, s.id));
      agendarAutosave(s.campaignId);
      const estadoTimer = { sessionId: s.id, ...novo, servidorAgora: agora };
      io.to(`sessao:${s.id}`).emit("mesa:timer", estadoTimer);
      cb?.({ ok: true, timer: estadoTimer });
    });
  });

  // ---------- ticker do temporizador (sincronização servidor→clientes) ----------
  setInterval(async () => {
    try {
      const rodando = await db.select().from(sessions);
      for (const s of rodando) {
        const ts = s.timerState as { status?: string; endsAt?: number; remainingMs?: number; totalMs?: number } | null;
        if (!ts || ts.status !== "rodando") continue;
        // recuperação pós-restart: se endsAt faltar, reconstrói a partir de remainingMs persistido
        const endsAt = ts.endsAt ?? (ts.remainingMs ? Date.now() + ts.remainingMs : 0);
        if (!endsAt) {
          const parado = { status: "parado", remainingMs: 0, totalMs: ts.totalMs ?? 0 };
          await db.update(sessions).set({ timerState: parado as never }).where(eq(sessions.id, s.id));
          agendarAutosave(s.campaignId);
          io.to(`sessao:${s.id}`).emit("mesa:timer", { sessionId: s.id, ...parado, servidorAgora: Date.now() });
          continue;
        }
        const rest = Math.max(0, endsAt - Date.now());
        if (rest <= 0) {
          const parado = { status: "parado", remainingMs: 0, totalMs: ts.totalMs ?? 0 };
          await db.update(sessions).set({ timerState: parado as never }).where(eq(sessions.id, s.id));
          agendarAutosave(s.campaignId);
          io.to(`sessao:${s.id}`).emit("mesa:timer", { sessionId: s.id, ...parado, servidorAgora: Date.now() });
        } else {
          io.to(`sessao:${s.id}`).emit("mesa:timer", {
            sessionId: s.id, status: "rodando", remainingMs: rest, totalMs: ts.totalMs, endsAt: ts.endsAt, servidorAgora: Date.now(),
          });
        }
      }
    } catch { /* ticker não pode derrubar o servidor */ }
  }, 1000);
}

// expõe helpers usados por outros módulos
export { emitirMensagem, mestresDaCampanha, nomeUsuario, registrarChat, rolarLados };
