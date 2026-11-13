import type { Server as SocketIOServer } from "socket.io";
import { eq } from "drizzle-orm";
import { agendarAutosave } from "./autosave.js";
import { getDb } from "../db/index.js";
import { sessions } from "../db/schema.js";

/** Instância do Socket.IO para emissão de eventos fora do handshake. */
let io: SocketIOServer | null = null;

export function setIo(instancia: SocketIOServer) {
  io = instancia;
}

/** Emite um evento para a sala privada de um usuário autenticado. */
export function emitirUsuario(userId: string, evento: string, dados: unknown) {
  io?.to(`usuario:${userId}`).emit(evento, dados);
}

/**
 * Desconecta todos os sockets autenticados por uma sessão HTTP específica
 * (logout). Outras sessões independentes da mesma conta não são afetadas.
 */
export function desconectarSessao(sessaoId: string) {
  io?.in(`sessao:${sessaoId}`).disconnectSockets();
}

/** Desconecta todos os sockets do usuário — uso quando TODAS as sessões
 *  da conta foram revogadas (bloqueio, troca de senha, exclusão). */
export function desconectarUsuario(userId: string) {
  io?.in(`usuario:${userId}`).disconnectSockets();
}

/** Emite um evento para todos os membros conectados de uma campanha. */
export function emitirCampanha(campaignId: string, evento: string, dados: unknown) {
  io?.to(`campanha:${campaignId}`).emit(evento, dados);
  // Etapa 12: qualquer mutação propagada por socket também agenda salvamento automático
  agendarAutosave(campaignId);
}

/**
 * Remove o usuário de todas as rooms de uma campanha (campanha + sessões de
 * mesa), sem desconectar o socket — assim outras campanhas do mesmo usuário
 * no mesmo socket não são afetadas. Após a expulsão, `entrar-campanha` e
 * `mesa:entrar` rejeitam a entrada porque exigem membership ativa.
 */
export async function expulsarMembroDaCampanha(campaignId: string, userId: string) {
  if (!io) return;
  const db = getDb();
  const sessoes = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.campaignId, campaignId));
  const rooms = [`campanha:${campaignId}`, ...sessoes.map((s) => `sessao:${s.id}`)];
  for (const socket of io.sockets.sockets.values()) {
    const u = socket.data.usuario as { id?: string } | undefined;
    if (u?.id !== userId) continue;
    for (const room of rooms) socket.leave(room);
  }
}
