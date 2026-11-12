import { randomInt, randomUUID } from "node:crypto";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { and, eq, inArray, sql, getTableColumns } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  sessions, turns, chatMessages, rolls, tests, characters, memberships, users, sheetVersions, files,
} from "../db/schema.js";
import { estruturaFichaSchema, mapaCampos, campoElegivelParaTeste, type CampoDef } from "../lib/ficha.js";
import { mensagemVisivel } from "../routes/sessoes.js";
import { agendarAutosave } from "../lib/autosave.js";
import { permissoesDe } from "../lib/permissoes.js";
import { carregarRegras } from "../lib/regras.js";
import { resumoVitalidade } from "../lib/vida.js";
import {
  lerVtt, nevoaPadrao, tracoRevelarValido, donosDosTokens,
  vttParaDestinatario, VTT_MAX_BYTES, VTT_MAX_NOME, VTT_MAX_TOKENS, NEVOA_MAX_TRAÇOS,
  type TokenVtt, type VttState,
} from "../lib/vtt.js";

const db = getDb();

// Serialização explícita das mutações da mesa virtual: o ciclo
// ler→validar→alterar→gravar→emitir precisa ser atômico por sessão.
// Hoje o driver síncrono (better-sqlite3) já serializa os handlers, mas
// esta fila garante a mesma propriedade se o driver virar assíncrono.
let filaVtt: Promise<unknown> = Promise.resolve();
function comLockVtt<T>(fn: () => Promise<T>): Promise<T> {
  const p = filaVtt.then(fn, fn);
  filaVtt = p.then(() => undefined, () => undefined);
  return p;
}

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
  let sessao: typeof sessions.$inferSelect | undefined;
  try {
    [sessao] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  } catch (e) {
    // vtt_state corrompido (JSON inválido) não pode derrubar a sessão inteira:
    // recarrega sem a coluna e segue com o estado VTT vazio (o módulo VTT
    // relê o texto bruto de forma defensiva e registra o problema).
    console.error(`[vtt] falha ao ler sessão ${sessionId} (vtt_state inválido?):`, e);
    const { vttState: _omit, ...colsSemVtt } = getTableColumns(sessions);
    const [row] = await db.select(colsSemVtt).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (row) sessao = { ...row, vttState: null } as typeof sessions.$inferSelect;
  }
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
  // privada: autor + destinatários — somente membros ainda ativos recebem
  const destinos = new Set<string>((msg.recipients ?? []) as string[]);
  if (msg.authorId) destinos.add(msg.authorId);
  const ids = [...destinos];
  const ativos = ids.length
    ? new Set(
        (
          await db
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(
              and(
                eq(memberships.campaignId, msg.campaignId),
                eq(memberships.status, "ativo"),
                inArray(memberships.userId, ids)
              )
            )
        ).map((r) => r.userId)
      )
    : new Set<string>();
  for (const uid of ids) {
    if (ativos.has(uid)) io.to(`usuario:${uid}`).emit("mesa:mensagem", payload);
  }
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
      // Barreira de teste determinística (somente NODE_ENV=test +
      // MESTRE_VTT_BARRIER_MS): abre uma janela controlada entre a
      // validação inicial e a autorização final, permitindo reproduzir
      // troca de papel/membership no meio da entrada. Inerte em produção.
      if (process.env.NODE_ENV === "test") {
        const barreiraMs = Number(process.env.MESTRE_VTT_BARRIER_MS ?? 0);
        if (barreiraMs > 0) await new Promise((r) => setTimeout(r, barreiraMs));
      }
      // Seção crítica: o socket SÓ entra na sala depois da autorização
      // final. Enquanto não ingressa, nenhum evento da sala (mensagens
      // públicas/sistema emitidas via io.to(room)) pode alcançá-lo.
      // As leituras ocorrem dentro do lock para refletir mutações VTT
      // anteriores e serializar a entrada com mapa/token/névoa.
      await comLockVtt(async () => {
        const vttEntrar = await lerVtt(sessionId);
        const [donos, t] = await Promise.all([
          donosDosTokens(sessionId, vttEntrar.tokens),
          db.select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1).then((r) => r[0]),
        ]);
        // Revalidação final: membership, papel e status da sessão podem
        // ter mudado durante a espera do lock e as leituras. O join, o
        // emit e o ACK usam SOMENTE este contexto.
        const ctxF = await resolverCtx(socket, sessionId);
        if ("erro" in ctxF || ctxF.sessao.status === "encerrada") {
          cb?.({ ok: false, erro: "erro" in ctxF ? ctxF.erro : "Sessão encerrada" });
          return;
        }
        socket.join(`sessao:${sessionId}`);
        const papel = ctxF.papel;
        const uF = usuario()!;
        const vttEu = papel === "mestre" || !vttEntrar.nevoa.ativa
          ? vttEntrar
          : vttParaDestinatario(vttEntrar, papel as "jogador" | "espectador", uF.id, donos);
        socket.emit("mesa:vtt", { sessionId, vtt: vttEu });
        const podeEnviar = papel !== "espectador" || permissoesDe(ctxF.membership).enviarMensagens === true;
        cb?.({
          ok: true, papel, podeEnviar,
          // vttState filtrado e sanitizado: JSON inválido ou névoa não vazam
          sessao: { ...ctxF.sessao, vttState: vttEu },
          turnos: t?.state ?? { ordem: [], atual: -1, ativo: false },
          presenca: presentes(sessionId),
          agora: Date.now(),
        });
        await emitirPresenca(sessionId);
        await registrarChat(io, {
          campaignId: ctxF.sessao.campaignId, sessionId, authorId: uF.id,
          kind: "evento", content: `${await nomeUsuario(uF.id)} entrou na mesa`, visibility: "publica",
        });
      });
    });

    socket.on("mesa:sair", (payload: { sessionId?: string }, cb?: (r: unknown) => void) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) { cb?.({ ok: false }); return; }
      socket.leave(`sessao:${sessionId}`);
      void emitirPresenca(sessionId);
      cb?.({ ok: true });
    });

    // ---------- mesa virtual: mapa + tokens (Etapa 1) ----------
    // Estado persistido em sessions.vtt_state (JSON texto) — mesmo padrão do
    // temporizador. O servidor é autoridade: valida papel, associação do
    // token e coordenadas antes de gravar; emite `mesa:vtt` com o estado
    // completo somente após a persistência. Reconexão recebe o estado via
    // callback de `mesa:entrar` (sessao.vttState) e pelo emit fresco pós-join.
    // Mutações passam por comLockVtt (serialização explícita do ciclo
    // ler→validar→gravar→emitir, independente do driver).

    /**
     * Emissão filtrada por destinatário (Etapa 2 — névoa): cada socket da sala
     * recebe somente a visão autorizada. Papel e membership são revalidados
     * no banco a cada emissão — socket.data nunca é fonte de autorização.
     * Sockets sem usuário autenticado ou sem acesso atual não recebem nada.
     */
    const emitirVtt = async (sessionId: string, vtt: VttState) => {
      const room = `sessao:${sessionId}`;
      // sockets reais (não RemoteSocket): emissão direcionada funciona com
      // qualquer adaptador e preserva socket.data do socket local
      const sockets = [...io.sockets.sockets.values()].filter((s) => s.rooms.has(room));
      if (!sockets.length) return;
      const donos = await donosDosTokens(sessionId, vtt.tokens);
      await Promise.all(sockets.map(async (s) => {
        const u = s.data.usuario as Usuario | undefined;
        if (!u) return;
        const ctx = await resolverCtx(s, sessionId);
        if ("erro" in ctx || ctx.sessao.status === "encerrada") return;
        s.emit("mesa:vtt", { sessionId, vtt: vttParaDestinatario(vtt, ctx.papel, u.id, donos) });
      }));
    };
    /** Visão VTT do próprio requisitante (ACKs e mesa:entrar). */
    const vttParaUsuario = async (sessionId: string, vtt: VttState, papel: string, userId: string): Promise<VttState> => {
      if (papel === "mestre" || !vtt.nevoa.ativa) return vtt;
      const donos = await donosDosTokens(sessionId, vtt.tokens);
      return vttParaDestinatario(vtt, papel as "jogador" | "espectador", userId, donos);
    };

    const posicaoValida = (x: unknown, y: unknown): x is number =>
      typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1
      && typeof y === "number" && Number.isFinite(y) && y >= 0 && y <= 1;
    const corValida = (c: unknown): c is string =>
      typeof c === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c);
    /** Nome de token: string obrigatória quando informada; 1–60 chars após trim. */
    const nomeValido = (n: unknown): n is string =>
      typeof n === "string" && n.trim().length >= 1 && n.trim().length <= VTT_MAX_NOME;

    /** Dono efetivo do token: userId direto; senão o userId da membership do personagem. */
    async function donoDoToken(sessionId: string, token: TokenVtt): Promise<string | null> {
      if (token.userId) return token.userId;
      if (!token.personagemId) return null;
      const [s] = await db.select({ campaignId: sessions.campaignId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!s) return null;
      const [ch] = await db.select({ membershipId: characters.membershipId }).from(characters)
        .where(and(eq(characters.id, token.personagemId), eq(characters.campaignId, s.campaignId))).limit(1);
      if (!ch) return null;
      const [m] = await db.select({ userId: memberships.userId, status: memberships.status }).from(memberships)
        .where(eq(memberships.id, ch.membershipId)).limit(1);
      return m && m.status === "ativo" ? m.userId : null;
    }
    /** Jogador só move token cujo dono efetivo é ele. */
    async function tokenPertenceAoUsuario(sessionId: string, token: TokenVtt, userId: string): Promise<boolean> {
      return (await donoDoToken(sessionId, token)) === userId;
    }
    /**
     * Valida coerência dos vínculos userId/personagemId (P4): no máximo um
     * dono. Se ambos informados, o personagem precisa pertencer à membership
     * do mesmo usuário. Retorna { ok, userId, personagemId } ou { erro }.
     */
    async function validarVinculo(campaignId: string, userId: unknown, personagemId: unknown):
      Promise<{ ok: true; userId: string | null; personagemId: string | null } | { ok: false; erro: string }> {
      let uid: string | null = null;
      let pid: string | null = null;
      if (userId !== undefined && userId !== null) {
        if (typeof userId !== "string" || !userId) return { ok: false, erro: "userId inválido" };
        const [mem] = await db.select({ id: memberships.id }).from(memberships)
          .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId), eq(memberships.status, "ativo"))).limit(1);
        if (!mem) return { ok: false, erro: "Usuário não é membro ativo" };
        uid = userId;
      }
      if (personagemId !== undefined && personagemId !== null) {
        if (typeof personagemId !== "string" || !personagemId) return { ok: false, erro: "personagemId inválido" };
        const [ch] = await db.select({ membershipId: characters.membershipId }).from(characters)
          .where(and(eq(characters.id, personagemId), eq(characters.campaignId, campaignId))).limit(1);
        if (!ch) return { ok: false, erro: "Personagem não encontrado na campanha" };
        pid = personagemId;
        if (uid) {
          const [mem] = await db.select({ userId: memberships.userId }).from(memberships)
            .where(and(eq(memberships.id, ch.membershipId), eq(memberships.status, "ativo"))).limit(1);
          if (!mem || mem.userId !== uid) return { ok: false, erro: "Personagem pertence a outro jogador" };
        }
      }
      return { ok: true, userId: uid, personagemId: pid };
    }

    /** mesa:vtt:mapa {sessionId, acao:"definir"|"remover", mapa?} — somente mestre. */
    socket.on("mesa:vtt:mapa", async (payload: {
      sessionId?: string; acao?: string;
      mapa?: { fileId?: string; nome?: string; largura?: number; altura?: number } | null;
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      const ctx = await resolverCtx(socket, sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      // P1: espectador é somente leitura — nenhuma mutação de mapa ou token
      if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectador não pode alterar a mesa" }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Somente o mestre altera o mapa" }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
      await comLockVtt(async () => {
        // revalida dentro da seção crítica: membership/papel podem mudar durante a espera do lock
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Somente o mestre altera o mapa" }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        if (payload.acao === "remover") {
          vtt.mapa = null;
        } else if (payload.acao === "definir") {
          const m = payload.mapa;
          if (!m || typeof m.fileId !== "string" || !m.fileId || m.fileId.length > 100) {
            cb?.({ ok: false, erro: "Mapa inválido" }); return;
          }
          // o arquivo precisa existir na biblioteca DESTA campanha, ser imagem
          // aprovada e visível a todos os participantes (P3: visibility pública)
          const [arq] = await db.select({ id: files.id, mimeType: files.mimeType, fileName: files.fileName, status: files.status, visibility: files.visibility })
            .from(files)
            .where(and(eq(files.id, m.fileId), eq(files.campaignId, ctx.sessao.campaignId))).limit(1);
          if (!arq || arq.status !== "aprovado") { cb?.({ ok: false, erro: "Imagem de mapa não encontrada" }); return; }
          if (arq.visibility !== "publica") { cb?.({ ok: false, erro: "Mapa precisa ter visibilidade pública para todos os participantes" }); return; }
          const ehImagem = (arq.mimeType ?? "").startsWith("image/")
            || /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(arq.fileName);
          if (!ehImagem) { cb?.({ ok: false, erro: "O mapa precisa ser uma imagem" }); return; }
          vtt.mapa = {
            fileId: m.fileId,
            nome: typeof m.nome === "string" ? m.nome.slice(0, 140) : "Mapa",
            largura: typeof m.largura === "number" && Number.isFinite(m.largura) ? m.largura : undefined,
            altura: typeof m.altura === "number" && Number.isFinite(m.altura) ? m.altura : undefined,
          };
        } else {
          cb?.({ ok: false, erro: "Ação inválida" }); return;
        }
        if (JSON.stringify(vtt).length > VTT_MAX_BYTES) { cb?.({ ok: false, erro: "Estado da mesa excede o limite" }); return; }
        await db.update(sessions).set({ vttState: vtt as never, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
        agendarAutosave(ctx.sessao.campaignId);
        await emitirVtt(sessionId, vtt);
        cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u!.id) });
      });
    });

    /** mesa:vtt:token {sessionId, acao, token} — mestre tudo; jogador só move o próprio. */
    socket.on("mesa:vtt:token", async (payload: {
      sessionId?: string; acao?: string;
      token?: Partial<TokenVtt> & { id?: string };
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      const ctx = await resolverCtx(socket, sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      // P1: espectador é somente leitura — nenhuma mutação de mapa ou token
      if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectador não pode alterar a mesa" }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
      await comLockVtt(async () => {
        // revalida dentro da seção crítica: membership/papel podem mudar durante a espera do lock
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectador não pode alterar a mesa" }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        const t = payload.token ?? {};
        const acao = payload.acao;
        const ehMestre = ctx.papel === "mestre";
        const idx = typeof t.id === "string" ? vtt.tokens.findIndex((x) => x.id === t.id) : -1;
        const existente = idx >= 0 ? vtt.tokens[idx] : undefined;

        if (acao === "criar") {
          if (!ehMestre) { cb?.({ ok: false, erro: "Somente o mestre cria tokens" }); return; }
          // idempotência: se o cliente reenviou um criar com id já existente, não duplica
          if (typeof t.id === "string" && vtt.tokens.some((x) => x.id === t.id)) {
            cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u.id), idempotente: true }); return;
          }
          if (vtt.tokens.length >= VTT_MAX_TOKENS) { cb?.({ ok: false, erro: `Limite de ${VTT_MAX_TOKENS} tokens por sessão atingido` }); return; }
          if (!posicaoValida(t.x, t.y)) { cb?.({ ok: false, erro: "Posição inválida" }); return; }
          // P7: nome precisa ser string válida quando informado
          if (t.nome !== undefined && !nomeValido(t.nome)) { cb?.({ ok: false, erro: "Nome de token inválido" }); return; }
          const nome = t.nome === undefined ? "Token" : (t.nome as string).trim().slice(0, VTT_MAX_NOME);
          const cor = corValida(t.cor) ? t.cor : "#888888";
          // P4: vínculos coerentes — personagem e usuário precisam ser do mesmo dono
          const vinc = await validarVinculo(ctx.sessao.campaignId, t.userId, t.personagemId);
          if (!vinc.ok) { cb?.({ ok: false, erro: vinc.erro }); return; }
          const idToken = typeof t.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(t.id) ? t.id : randomUUID();
          const novo: TokenVtt = {
            id: idToken, nome, cor, x: t.x as number, y: t.y as number,
            userId: vinc.userId, personagemId: vinc.personagemId, ativo: t.ativo !== false,
          };
          vtt.tokens.push(novo);
        } else if (acao === "atualizar" || acao === "mover") {
          if (!existente) { cb?.({ ok: false, erro: "Token não encontrado" }); return; }
          if (!posicaoValida(t.x ?? existente.x, t.y ?? existente.y)) { cb?.({ ok: false, erro: "Posição inválida" }); return; }
          if (ehMestre) {
            if (t.nome !== undefined) {
              if (!nomeValido(t.nome)) { cb?.({ ok: false, erro: "Nome de token inválido" }); return; }
              existente.nome = t.nome.trim().slice(0, VTT_MAX_NOME);
            }
            if (t.cor !== undefined) {
              if (!corValida(t.cor)) { cb?.({ ok: false, erro: "Cor inválida" }); return; }
              existente.cor = t.cor;
            }
            if (t.ativo !== undefined) existente.ativo = !!t.ativo;
            if (t.userId !== undefined || t.personagemId !== undefined) {
              // P4: reatribuição valida coerência usuário×personagem.
              // Campos não enviados mantêm o vínculo atual.
              const novoUser = t.userId !== undefined ? t.userId : existente.userId;
              const novoPers = t.personagemId !== undefined ? t.personagemId : existente.personagemId;
              const vinc = await validarVinculo(ctx.sessao.campaignId, novoUser, novoPers);
              if (!vinc.ok) { cb?.({ ok: false, erro: vinc.erro }); return; }
              existente.userId = vinc.userId;
              existente.personagemId = vinc.personagemId;
            }
          } else {
            // jogador: somente posição do próprio token — nada mais
            if (!(await tokenPertenceAoUsuario(sessionId, existente, u.id))) {
              cb?.({ ok: false, erro: "Token não pertence a você" }); return;
            }
          }
          existente.x = t.x ?? existente.x;
          existente.y = t.y ?? existente.y;
        } else if (acao === "remover") {
          if (!ehMestre) { cb?.({ ok: false, erro: "Somente o mestre remove tokens" }); return; }
          if (!existente) { cb?.({ ok: false, erro: "Token não encontrado" }); return; }
          vtt.tokens.splice(idx, 1);
        } else {
          cb?.({ ok: false, erro: "Ação inválida" }); return;
        }
        if (JSON.stringify(vtt).length > VTT_MAX_BYTES) { cb?.({ ok: false, erro: "Estado da mesa excede o limite" }); return; }
        await db.update(sessions).set({ vttState: vtt as never, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
        agendarAutosave(ctx.sessao.campaignId);
        await emitirVtt(sessionId, vtt);
        cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u.id) });
      });
    });

    /**
     * mesa:vtt:nevoa {sessionId, acao, traco?} — somente mestre (Etapa 2).
     * acoes: "revelar" (traco {raioX,raioY,pontos[]} → id gerado no servidor),
     * "desfazer" (remove o último traço), "ocultarTudo" (ativa névoa sem
     * regiões), "revelarTudo" (desativa névoa; traços são preservados para
     * eventual reativação futura — a névoa desativada não os utiliza).
     */
    socket.on("mesa:vtt:nevoa", async (payload: {
      sessionId?: string; acao?: string;
      traco?: { raioX?: number; raioY?: number; pontos?: { x: number; y: number }[] };
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      const ctx = await resolverCtx(socket, sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Somente o mestre pode alterar a névoa" }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
      await comLockVtt(async () => {
        // revalida dentro da seção crítica: membership/papel podem mudar durante a espera do lock
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Somente o mestre pode alterar a névoa" }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        if (!vtt.nevoa || typeof vtt.nevoa !== "object") vtt.nevoa = nevoaPadrao();
        const acao = payload.acao;
        if (acao === "revelar") {
          if (!vtt.nevoa.ativa) vtt.nevoa.ativa = true;
          const val = tracoRevelarValido(payload.traco);
          if (!val.ok) { cb?.({ ok: false, erro: val.erro }); return; }
          const totalAtual = vtt.nevoa.revelados.reduce((s, t) => s + t.pontos.length, 0);
          if (vtt.nevoa.revelados.length >= NEVOA_MAX_TRAÇOS) { cb?.({ ok: false, erro: `Limite de ${NEVOA_MAX_TRAÇOS} traços de névoa atingido` }); return; }
          if (totalAtual + val.traco.pontos.length > 1000) { cb?.({ ok: false, erro: "Limite de pontos de névoa atingido" }); return; }
          vtt.nevoa.revelados.push({ id: randomUUID(), ...val.traco });
        } else if (acao === "desfazer") {
          vtt.nevoa.revelados.pop();
        } else if (acao === "ocultarTudo") {
          vtt.nevoa = { ativa: true, revelados: [] };
        } else if (acao === "revelarTudo") {
          vtt.nevoa.ativa = false; // traços preservados; inertes enquanto desativada
        } else {
          cb?.({ ok: false, erro: "Ação inválida" }); return;
        }
        if (JSON.stringify(vtt).length > VTT_MAX_BYTES) { cb?.({ ok: false, erro: "Estado da mesa excede o limite" }); return; }
        await db.update(sessions).set({ vttState: vtt as never, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
        agendarAutosave(ctx.sessao.campaignId);
        await emitirVtt(sessionId, vtt);
        cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u.id) });
      });
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
      // Personagem arquivado não participa de novos testes — o histórico
      // de testes já realizados permanece intacto.
      if (char.status === "arquivado") { cb?.({ ok: false, erro: "Personagem arquivado — restaure-o para criar novos testes" }); return; }
      const [membroDono] = await db.select().from(memberships).where(eq(memberships.id, char.membershipId)).limit(1);
      if (!membroDono) { cb?.({ ok: false, erro: "Dono não encontrado" }); return; }

      // dados calculados no servidor: campoId → valor numérico da ficha; senão dadosCount explícito.
      // Testes de ficha (atributo/habilidade/ataque) são sempre D10 — o cliente não escolhe o dado.
      const dadosLados = payload.campoId ? 10 : (LADOS_VALIDOS.has(payload.dadosLados ?? 0) ? payload.dadosLados! : 20);
      let valorCampo: number | null = null;
      const base = payload.campoId
        ? (() => {
            const dados = (char.data ?? {}) as Record<string, unknown>;
            const v = dados[payload.campoId!];
            return typeof v === "number" && Number.isFinite(v) ? v : null;
          })()
        : null;
      if (payload.campoId) valorCampo = base;
      // Elegibilidade do campo de teste: com campoId, a estrutura publicada
      // da ficha é obrigatória e precisa passar no parse — sem ela não há
      // como provar elegibilidade, então a solicitação é rejeitada (o
      // cliente nunca é fonte de confiança para validar o próprio campo).
      if (payload.campoId) {
        let campo: CampoDef | undefined;
        let motivo = "";
        if (!char.templateVersionId) {
          motivo = "personagem sem versão de ficha";
        } else {
          const [ver] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, char.templateVersionId)).limit(1);
          if (!ver) {
            motivo = "versão de ficha não encontrada";
          } else {
            const parse = estruturaFichaSchema.safeParse(ver.structure);
            if (!parse.success) {
              motivo = `estrutura inválida (${parse.error.issues.length} problema(s) de schema)`;
            } else {
              campo = mapaCampos(parse.data).get(payload.campoId);
            }
          }
        }
        if (!campo || !campoElegivelParaTeste(campo)) {
          console.warn(`[mesa] teste:pedir rejeitado — ${motivo || "campo não elegível"} (campoId=${payload.campoId}, personagem=${char.id}, versao=${char.templateVersionId ?? "nenhuma"})`);
          cb?.({ ok: false, erro: "Campo não é elegível para teste" });
          return;
        }
      }
      // pool: base = dados positivos (valor do campo ou dadosCount); bonus/malus ajustam
      const positivos = Math.round((valorCampo ?? payload.dadosCount ?? 1) + (payload.bonus ?? 0));
      const negativos = Math.max(0, Math.round(payload.malus ?? 0));
      let count = Math.min(Math.max(0, positivos - negativos), 30);

      const id = payload.requestId ?? randomUUID();
      const agora = new Date();
      try {
        await db.insert(tests).values({
          id, campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id,
          characterId: char.id, requestedBy: u.id,
          skillRef: (payload.skillRef ?? (payload.campoId ? { campoId: payload.campoId, rotulo: payload.rotulo } : null)) as never,
          modifiers: { bonus: payload.bonus ?? 0, malus: negativos, valorCampo, positivos } as never,
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
      const pool = { positivos, negativos, dadosLados };
      const publico = {
        id, sessionId: ctx.sessao.id, characterId: char.id, characterName: nomeChar,
        requestedByName: nomeAutor, rotulo: payload.rotulo ?? null,
        skillRef: payload.skillRef ?? null, // skillRef pode ter nome; mínimo NÃO vai
        status: "pendente", createdAt: agora,
      };
      if (payload.visibilidade === "privada") {
        // privada: só dono do personagem + mestres recebem (com alvo/dados/pool)
        io.to(`usuario:${membroDono.userId}`).emit("mesa:teste", {
          ...publico, alvo: payload.minimo ?? null,
          dados: { lados: dadosLados, count }, pool, privado: true,
        });
        const mestresPriv = await mestresDaCampanha(ctx.sessao.campaignId);
        for (const mid of mestresPriv) io.to(`usuario:${mid}`).emit("mesa:teste", {
          ...publico, alvo: payload.minimo ?? null,
          dados: { lados: dadosLados, count }, pool, privado: true,
        });
      } else {
        // pública: composição do pool é visível; só o alvo (dificuldade) fica oculto
        io.to(`sessao:${ctx.sessao.id}`).emit("mesa:teste", { ...publico, alvo: null, dados: { lados: dadosLados, count }, pool });
        io.to(`usuario:${membroDono.userId}`).emit("mesa:teste", {
          ...publico, alvo: payload.minimo ?? null,
          dados: { lados: dadosLados, count }, pool, privado: false,
        });
        io.to(`sessao:${ctx.sessao.id}`).emit("mesa:teste:detalhe", { id, alvo: payload.minimo ?? null, dados: { lados: dadosLados, count }, pool });
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

      // Vitalidade: penalidade de dados aplicada no servidor a partir do
      // estado atual do personagem — o jogador não pode ignorá-la.
      // Incapacitado bloqueia ações de quem não é mestre (exceção do mestre).
      let vitalidade: { nivel: number; nome: string; penalidadeDados: number; dadosOriginais: number; dadosFinais: number; excecaoMestre?: boolean } | null = null;
      let countFinal = teste.diceCount;
      const regras = await carregarRegras(teste.campaignId);
      if (char) {
        const vit = resumoVitalidade(regras.config.vitalidade, (char.data ?? {}) as Record<string, unknown>);
        if (vit) {
          if (vit.bloqueiaAcoes && ctx.papel !== "mestre") {
            cb?.({ ok: false, erro: `Ação bloqueada: ${char.name} está ${vit.nome} e não pode agir normalmente` });
            return;
          }
          countFinal = Math.max(0, teste.diceCount - vit.penalidadeDados);
          vitalidade = {
            nivel: vit.nivel, nome: vit.nome, penalidadeDados: vit.penalidadeDados,
            dadosOriginais: teste.diceCount, dadosFinais: countFinal,
            excecaoMestre: vit.bloqueiaAcoes && ctx.papel === "mestre" ? true : undefined,
          };
        }
      }

      const resultados = rolarLados(teste.diceSides, countFinal);
      const total = resultados.reduce((a, b) => a + b, 0);

      // Desafio D10: sucessos/falhas calculados no servidor com a meta da
      // campanha — o navegador não pode alterar o mínimo de sucesso.
      let d10: { minimo: number; lancados: number; sucessos: number; falhas: number } | null = null;
      if (teste.diceSides === 10) {
        const minimo = regras.config.dados?.d10SucessoMinimo ?? 6;
        const sucessos = resultados.filter((v) => v >= minimo).length;
        d10 = { minimo, lancados: resultados.length, sucessos, falhas: resultados.length - sucessos };
      }

      const rollId = payload.requestId ?? randomUUID();
      const agora = new Date();
      try {
        await db.insert(rolls).values({
          id: rollId, campaignId: teste.campaignId, sessionId: teste.sessionId,
          characterId: teste.characterId, userId: u.id,
          dice: [{ sides: teste.diceSides, count: countFinal }] as never,
          results: { dados: resultados, total, soma: total, vitalidade, d10 } as never,
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
        dados: resultados, total, lados: teste.diceSides, count: countFinal,
        dadosOriginais: teste.diceCount, vitalidade, d10,
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
        content: `${await nomeUsuario(u.id)} rolou ${vitalidade ? `${vitalidade.dadosOriginais}d${teste.diceSides} → vitalidade ${vitalidade.nome} (−${vitalidade.penalidadeDados}) → ${countFinal}d${teste.diceSides}` : `${teste.diceCount}d${teste.diceSides}`} → ${resultados.length ? resultados.join(", ") : "(sem dados)"} = ${total}${d10 ? ` · D10: ${d10.sucessos}/${d10.lancados} sucessos (mín ${d10.minimo})` : ""}`,
        visibility: teste.visibility === "privada" ? "privada" : "publica",
        recipients: teste.visibility === "privada" && membroDono ? [membroDono.userId] : undefined,
      });
      cb?.({ ok: true, id: rollId, dados: resultados, total, count: countFinal, dadosOriginais: teste.diceCount, vitalidade, d10 });
    });

    // ---------- rolagem livre ----------
    socket.on("mesa:rolar", async (payload: {
      sessionId?: string; dados?: { sides: number; count: number }[];
      motivo?: string; visibilidade?: "publica" | "privada"; requestId?: string;
      d10?: { positivos?: number; negativos?: number; minimo?: number };
      modo?: string;
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

      // Lançador D10: dados negativos consomem positivos; sucessos = valor >= mínimo.
      let d10: { positivos: number; negativos: number; minimo: number; lancados: number; sucessos: number; falhas: number } | null = null;
      if (payload.d10) {
        const pos = Math.round(payload.d10.positivos ?? NaN);
        const neg = Math.round(payload.d10.negativos ?? NaN);
        const minimo = Math.round(payload.d10.minimo ?? NaN);
        if (!Number.isFinite(pos) || !Number.isFinite(neg) || pos < 0 || neg < 0 || pos > 30 || neg > 30
          || !Number.isFinite(minimo) || minimo < 2 || minimo > 10) {
          cb?.({ ok: false, erro: "Dados D10 inválidos" });
          return;
        }
        const efetivos = Math.max(0, pos - neg);
        const resD10 = grupos.length === 1 && grupos[0].sides === 10 ? grupos[0].resultados : null;
        if (!resD10 || resD10.length !== efetivos) {
          cb?.({ ok: false, erro: "Quantidade de dados D10 inconsistente com a rolagem" });
          return;
        }
        const sucessos = resD10.filter((v) => v >= minimo).length;
        d10 = { positivos: pos, negativos: neg, minimo, lancados: resD10.length, sucessos, falhas: resD10.length - sucessos };
      }

      // Modo explícito "dano": totalização genérica, sem contagem de sucessos D10.
      const modoDano = payload.modo === "dano" && !payload.d10 ? "dano" : null;
      const rollId = payload.requestId ?? randomUUID();
      const agora = new Date();
      const vis = payload.visibilidade === "privada" ? "privada" : "publica";
      try {
        await db.insert(rolls).values({
          id: rollId, campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id,
          characterId: null, userId: u.id,
          dice: dadosValidados as never,
          results: { grupos, total, d10, modo: modoDano } as never,
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
        total, motivo: payload.motivo ?? (modoDano ? "Dano" : null), visibility: vis, createdAt: agora, d10, modo: modoDano,
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
        content: `${rollPayload.rolador} rolou ${grupos.map((g) => `${g.count}d${g.sides}`).join(" + ")} → ${total}${payload.motivo ? ` (${payload.motivo})` : ""}${d10 ? ` · D10: ${d10.sucessos}/${d10.lancados} sucessos (mín ${d10.minimo})` : ""}`,
        visibility: vis === "privada" ? "privada" : "publica",
        recipients: vis === "privada" ? [u.id, ...(await mestresDaCampanha(ctx.sessao.campaignId))] : undefined,
      });
      cb?.({ ok: true, id: rollId, grupos, total, d10, modo: modoDano });
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

      // colunas explícitas: select() completo parsearia vtt_state (json) e
      // uma corrupção ali derrubaria o temporizador junto com a mesa virtual
      const [s] = await db.select({ id: sessions.id, campaignId: sessions.campaignId, timerState: sessions.timerState })
        .from(sessions).where(eq(sessions.id, payload.sessionId)).limit(1);
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
      // só as colunas do timer: vtt_state corrompido não pode parar o ticker
      const rodando = await db.select({ id: sessions.id, campaignId: sessions.campaignId, timerState: sessions.timerState }).from(sessions);
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
