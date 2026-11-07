import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { and, eq } from "drizzle-orm";
import { autenticarHandshake, type UsuarioAutenticado } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { memberships } from "../db/schema.js";
import { setIo } from "../lib/io.js";

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
    usuario?: UsuarioAutenticado;
  }
}

export function configurarSockets(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  });
  setIo(io);
  const db = getDb();

  io.use(async (socket, next) => {
    const headers = socket.handshake.headers;
    const usuario = await autenticarHandshake(headers.cookie, headers.authorization);
    if (!usuario) {
      next(new Error("Não autenticado"));
      return;
    }
    socket.data.usuario = usuario;
    next();
  });

  io.on("connection", (socket) => {
    socket.on("ping", (cb?: (v: string) => void) => cb?.("pong"));

    // Entrar na sala de uma campanha (somente membros não-removidos)
    socket.on("entrar-campanha", async (campaignId: string, cb?: (ok: boolean) => void) => {
      const usuario = socket.data.usuario;
      if (!usuario || typeof campaignId !== "string") {
        cb?.(false);
        return;
      }
      const [m] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.campaignId, campaignId),
            eq(memberships.userId, usuario.id)
          )
        )
        .limit(1);
      const ok = !!m;
      if (ok) socket.join(`campanha:${campaignId}`);
      cb?.(ok);
    });

    socket.on("sair-campanha", (campaignId: string) => {
      socket.leave(`campanha:${campaignId}`);
    });
  });

  return io;
}
