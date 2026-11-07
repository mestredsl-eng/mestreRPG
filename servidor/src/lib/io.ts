import type { Server as SocketIOServer } from "socket.io";

/** Instância do Socket.IO para emissão de eventos fora do handshake. */
let io: SocketIOServer | null = null;

export function setIo(instancia: SocketIOServer) {
  io = instancia;
}

/** Emite um evento para todos os membros conectados de uma campanha. */
export function emitirCampanha(campaignId: string, evento: string, dados: unknown) {
  io?.to(`campanha:${campaignId}`).emit(evento, dados);
}
