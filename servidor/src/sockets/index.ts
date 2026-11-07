import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

/**
 * Camada de tempo real (spec §16).
 *
 * Etapa 1: apenas o servidor Socket.IO é inicializado. Os namespaces e eventos
 * de jogo (chat, testes, rolagens, turnos) serão adicionados nas etapas
 * seguintes — a autenticação por sessão e a filtragem por visibilidade
 * (pública/privada/secreta) serão aplicadas aqui via middleware.
 */
export function configurarSockets(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  });

  io.on("connection", (socket) => {
    // Stub: handshake sem auth por enquanto. Nas próximas etapas, validar
    // sessão aqui e associar socket → userId/campaignId para roteamento
    // de mensagens privadas e rolagens secretas.
    socket.on("ping", (cb?: (v: string) => void) => cb?.("pong"));
  });

  return io;
}
