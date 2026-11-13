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

/** Emite um evento para todos os membros conectados de uma campanha. */
export function emitirCampanha(campaignId: string, evento: string, dados: unknown) {
  io?.to(`campanha:${campaignId}`).emit(evento, dados);
  // Etapa 12: qualquer mutação propagada por socket também agenda salvamento automático
  agendarAutosave(campaignId);
}

/**
 * Notifica APENAS os sockets do usuário afetado (room privada
 * `usuario:${userId}`) que seu papel/status/permissões mudaram numa
 * campanha — disparado SOMENTE após a persistência da alteração.
 * O payload não contém dados de outros membros.
 */
export function notificarPermissaoAtualizada(
  campaignId: string,
  m: { userId: string; role: string; status: string; permissions: unknown },
) {
  io?.to(`usuario:${m.userId}`).emit("mesa:permissao:atualizada", {
    campaignId,
    papel: m.role,
    status: m.status,
    permissoes: m.permissions ?? {},
  });
}

/**
 * Reconcilia memberships após uma operação que SUBSTITUI o estado da
 * campanha (restauração de snapshot, importação modo substituir).
 * Compara por userId — a restauração pode gerar membershipIds novos.
 *
 * - usuário presente antes e ausente depois → revogado: expulsa das
 *   salas campanha/sessão e notifica status "removido" com o último
 *   papel/permissões conhecidos.
 * - presente depois com status ≠ ativo → expulsa + notifica valores
 *   persistidos atuais.
 * - presente depois ativo → notifica valores persistidos atuais.
 *
 * Deve ser chamada SOMENTE após a transação de restauração concluir.
 * A room privada usuario:* é preservada em todos os casos.
 */
export async function reconciliarMembrosAposRestauracao(
  campaignId: string,
  antes: { userId: string; role: string; status: string; permissions: unknown }[],
  depois: { userId: string; role: string; status: string; permissions: unknown }[],
) {
  const antesPorUser = new Map(antes.map((m) => [m.userId, m]));
  const depoisPorUser = new Map(depois.map((m) => [m.userId, m]));
  const usersAfetados = new Set([...antesPorUser.keys(), ...depoisPorUser.keys()]);
  for (const userId of usersAfetados) {
    const d = depoisPorUser.get(userId);
    if (!d || d.status !== "ativo") {
      // revogado ou nunca existiu no estado restaurado: usa os dados
      // anteriores para papel/permissões do payload de revogação
      const a = antesPorUser.get(userId);
      await expulsarMembroDaCampanha(campaignId, userId);
      notificarPermissaoAtualizada(campaignId, {
        userId,
        role: d?.role ?? a?.role ?? "jogador",
        status: "removido",
        permissions: d?.permissions ?? a?.permissions ?? {},
      });
      continue;
    }
    notificarPermissaoAtualizada(campaignId, {
      userId, role: d.role, status: d.status, permissions: d.permissions,
    });
  }
}

/**
 * Remove o usuário de todas as rooms de uma campanha (campanha + sessões de
 * mesa), sem desconectar o socket — assim outras campanhas do mesmo usuário
 * no mesmo socket não são afetadas. Após a expulsão, `entrar-campanha` e
 * `mesa:entrar` rejeitam a entrada porque exigem membership ativa. A room
 * privada `usuario:${userId}` é preservada justamente para que a
 * notificação de revogação ainda chegue ao cliente.
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
