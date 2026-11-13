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
  sessoesAntes: string[] = [],
  sessoesDepois: string[] = [],
) {
  const antesPorUser = new Map(antes.map((m) => [m.userId, m]));
  const depoisPorUser = new Map(depois.map((m) => [m.userId, m]));
  const usersAfetados = new Set([...antesPorUser.keys(), ...depoisPorUser.keys()]);
  // salas de sessão que existiam antes da substituição e não existem
  // mais: sockets de usuários ainda autorizados não podem ficar
  // presos nelas (IDs antigos somem do banco — não dá para redescobri-las)
  const sessoesValidas = new Set(sessoesDepois);
  const salasAntigas = sessoesAntes
    .filter((id) => !sessoesValidas.has(id))
    .map((id) => `sessao:${id}`);
  const falhas: string[] = [];
  let revogados = 0;
  for (const userId of usersAfetados) {
    try {
      const d = depoisPorUser.get(userId);
      if (!d || d.status !== "ativo") {
        // revogado ou nunca existiu no estado restaurado: usa os dados
        // anteriores para papel/permissões do payload de revogação.
        // Expulsão cobre a UNIÃO dos IDs de sessão antes∪depois — as
        // salas antigas já não constam mais no banco.
        const a = antesPorUser.get(userId);
        await expulsarMembroDaCampanha(campaignId, userId, [...sessoesAntes, ...sessoesDepois]);
        notificarPermissaoAtualizada(campaignId, {
          userId,
          role: d?.role ?? a?.role ?? "jogador",
          status: "removido",
          permissions: d?.permissions ?? a?.permissions ?? {},
        });
        revogados += 1;
        continue;
      }
      // ativo: permanece na campanha, mas sai das salas de sessões que
      // a substituição eliminou — entra nas novas via mesa:entrar
      if (io && salasAntigas.length) {
        for (const socket of io.sockets.sockets.values()) {
          const u = socket.data.usuario as { id?: string } | undefined;
          if (u?.id !== userId) continue;
          for (const room of salasAntigas) socket.leave(room);
        }
      }
      notificarPermissaoAtualizada(campaignId, {
        userId, role: d.role, status: d.status, permissions: d.permissions,
      });
    } catch (e) {
      // falha parcial de limpeza NÃO pode passar em silêncio: registra
      // e reporta para o chamador decidir a resposta coerente
      falhas.push(userId);
      console.error(`[reconciliar] falha ao reconciliar userId=${userId} campanha=${campaignId}:`, e);
    }
  }
  return { notificados: usersAfetados.size - falhas.length, revogados, falhas };
}

/**
 * Remove o usuário de todas as rooms de uma campanha (campanha + sessões de
 * mesa), sem desconectar o socket — assim outras campanhas do mesmo usuário
 * no mesmo socket não são afetadas. Após a expulsão, `entrar-campanha` e
 * `mesa:entrar` rejeitam a entrada porque exigem membership ativa. A room
 * privada `usuario:${userId}` é preservada justamente para que a
 * notificação de revogação ainda chegue ao cliente.
 */
export async function expulsarMembroDaCampanha(campaignId: string, userId: string, sessoesExtras: string[] = []) {
  if (!io) return;
  const db = getDb();
  const sessoes = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.campaignId, campaignId));
  // união: sessões que ainda existem no banco + IDs capturados ANTES de
  // uma restauração (salas antigas que já não constam mais no banco)
  const ids = new Set([...sessoes.map((s) => s.id), ...sessoesExtras]);
  const rooms = [`campanha:${campaignId}`, ...[...ids].map((id) => `sessao:${id}`)];
  for (const socket of io.sockets.sockets.values()) {
    const u = socket.data.usuario as { id?: string } | undefined;
    if (u?.id !== userId) continue;
    for (const room of rooms) socket.leave(room);
  }
}
