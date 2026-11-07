import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { autenticarHandshake, type UsuarioAutenticado } from "../middleware/auth.js";

/**
 * Camada de tempo real (spec §16).
 *
 * Etapa 2: handshake autenticado via cookie de sessão. Os namespaces e eventos
 * de jogo (chat, testes, rolagens, turnos) serão adicionados nas próximas
 * etapas — aqui já fica a base para rotear mensagens por usuário/campanha e
 * filtrar conteúdo por visibilidade (pública/privada/secreta, spec §11/§12).
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

  // Autenticação no handshake: rejeita conexões sem sessão válida.
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
  });

  return io;
}
