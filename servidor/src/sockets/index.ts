import type { Server as HttpServer, IncomingMessage } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { and, eq } from "drizzle-orm";
import { autenticarHandshake } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { memberships, characters } from "../db/schema.js";
import { setIo, barreiraRestauracaoAtiva } from "../lib/io.js";
import { personagemElegivelInternet } from "../lib/gate-internet.js";
import { origemPermitida } from "../lib/origens.js";
import { registrarMesa } from "./mesa.js";
import { registrarSangue } from "./sangue.js";

/**
 * Camada de tempo real (spec §16).
 *
 * Etapa 3: handshake autenticado + rooms por campanha. O cliente entra na
 * room `campanha:{id}` mediante o evento `entrar-campanha`, que valida a
 * participação no banco — assim eventos como `membros:atualizados` só chegam
 * a quem faz parte da campanha.
 */
declare module "socket.io" {
  interface SocketData {
    usuario?: import("../middleware/auth.js").UsuarioAutenticado;
    /** Id da sessão HTTP que autenticou o handshake — vínculo de logout. */
    sessaoId?: string;
  }
}

export interface OpcoesSockets {
  /** domínio público configurado — libera essa origem no handshake (R3) */
  dominioPublico?: string;
}

export function configurarSockets(httpServer: HttpServer, opcoes: OpcoesSockets = {}): SocketIOServer {
  const dominio = opcoes.dominioPublico;
  const io = new SocketIOServer(httpServer, {
    // R3: origem explícita — localhost, IPs privados/LAN e o domínio público
    // configurado. Clientes sem Origin (não-browser) passam; a autenticação
    // por sessão continua obrigatória no middleware abaixo.
    cors: {
      origin: (origin, cb) => cb(null, origemPermitida(origin, dominio)),
      credentials: true,
    },
    // WebSocket não passa por CORS — allowRequest valida a origem também no
    // handshake WS (encaminhado ao engine.io pelo socket.io).
    allowRequest: (req: IncomingMessage, cb: (err: string | null, success: boolean) => void) => {
      cb(null, origemPermitida(req.headers.origin, dominio));
    },
    path: "/socket.io",
  });
  setIo(io);
  const db = getDb();
  registrarMesa(io);
  registrarSangue(io);

  io.use(async (socket, next) => {
    const headers = socket.handshake.headers;
    const auth = await autenticarHandshake(headers.cookie, headers.authorization);
    if (!auth) {
      next(new Error("Não autenticado"));
      return;
    }
    socket.data.usuario = auth.usuario;
    socket.data.sessaoId = auth.sessaoId;
    // sala privada do usuário — o cliente nunca escolhe a sala; eventos
    // direcionados (ex.: novidade:publicada) só chegam a conexões autenticadas
    socket.join(`usuario:${auth.usuario.id}`);
    // sala privada da SESSÃO — o logout revoga só os sockets que foram
    // autenticados por aquela sessão, preservando outras sessões da conta
    socket.join(`sessao:${auth.sessaoId}`);
    next();
  });

  io.on("connection", (socket) => {
    socket.on("ping", (cb?: (v: string) => void) => cb?.("pong"));

    // Entrar na sala de uma campanha (somente membros não-removidos)
    socket.on("entrar-campanha", async (campaignId: string, cb?: (ok: boolean) => void) => {
      const usuario = socket.data.usuario;
      if (!usuario || typeof campaignId !== "string" || barreiraRestauracaoAtiva(campaignId)) {
        cb?.(false);
        return;
      }
      const [m] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.campaignId, campaignId),
            eq(memberships.userId, usuario.id),
            eq(memberships.status, "ativo")
          )
        )
        .limit(1);
      const ok = !!m;
      // revalidação ATÔMICA imediatamente antes do join: sem await
      // entre a checagem e o ingresso — uma restauração que começou
      // durante a consulta de membership não deixa o socket escapar
      // da evacuação
      if (ok && !barreiraRestauracaoAtiva(campaignId)) socket.join(`campanha:${campaignId}`);
      cb?.(ok && !barreiraRestauracaoAtiva(campaignId));
    });

    socket.on("sair-campanha", (campaignId: string) => {
      socket.leave(`campanha:${campaignId}`);
    });

    // Inscrição no canal IC/comércio (bloqueio P1 #329/7152569806).
    // Autorização servidor-side: sessão (já no handshake), membership ativa,
    // personagem da campanha, titularidade (dono do personagem ou mestre)
    // e gate Internet cumulativo revalidado NO MOMENTO do join. O cliente
    // nunca escolhe a sala — só recebe `internet:{campaignId}:{characterId}`
    // se passar em tudo; caso contrário cb(false) e nenhum evento chega.
    socket.on("entrar-internet", async (payload: unknown, cb?: (ok: boolean) => void) => {
      const usuario = socket.data.usuario;
      const p = payload as { campaignId?: unknown; characterId?: unknown } | null;
      const campaignId = typeof p?.campaignId === "string" ? p.campaignId : null;
      const characterId = typeof p?.characterId === "string" ? p.characterId : null;
      if (!usuario || !campaignId || !characterId || barreiraRestauracaoAtiva(campaignId)) {
        cb?.(false);
        return;
      }
      const sala = `internet:${campaignId}:${characterId}`;
      try {
        const [m] = await db
          .select({ id: memberships.id, role: memberships.role })
          .from(memberships)
          .where(and(
            eq(memberships.campaignId, campaignId),
            eq(memberships.userId, usuario.id),
            eq(memberships.status, "ativo"),
          ))
          .limit(1);
        if (!m) { cb?.(false); return; }
        const [personagem] = await db.select().from(characters)
          .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId)))
          .limit(1);
        if (!personagem || personagem.status === "arquivado") { cb?.(false); return; }
        // titularidade: dono do personagem (membership da ficha) ou mestre
        if (m.role !== "mestre") {
          const [dono] = await db.select({ userId: memberships.userId }).from(memberships)
            .where(eq(memberships.id, personagem.membershipId)).limit(1);
          if (dono?.userId !== usuario.id) { cb?.(false); return; }
        }
        // gate cumulativo revalidado na inscrição — inelegível nem entra
        if (!(await personagemElegivelInternet(characterId))) { cb?.(false); return; }
        if (!barreiraRestauracaoAtiva(campaignId)) socket.join(sala);
        cb?.(!barreiraRestauracaoAtiva(campaignId));
      } catch {
        cb?.(false);
      }
    });

    socket.on("sair-internet", (payload: unknown) => {
      const p = payload as { campaignId?: unknown; characterId?: unknown } | null;
      if (typeof p?.campaignId === "string" && typeof p?.characterId === "string") {
        socket.leave(`internet:${p.campaignId}:${p.characterId}`);
      }
    });
  });

  return io;
}
