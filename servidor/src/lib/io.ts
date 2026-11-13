import type { Server as SocketIOServer } from "socket.io";
import { and, eq, inArray } from "drizzle-orm";
import { agendarAutosave } from "./autosave.js";
import { getDb } from "../db/index.js";
import { sessions, memberships } from "../db/schema.js";

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

// ---------- exclusividade de restauração por campanha ----------
// Uma campanha admite NO MÁXIMO uma restauração por vez. A barreira é
// identificada por restoreId: somente o proprietário pode liberá-la.
// Operações normais podem adquirir um "lease" (contador por campanha);
// a restauração drena os leases em voo antes de capturar o estado.
type Barreira = { restoreId: string; evacuados: Map<string, string[]> };
const barreiras = new Map<string, Barreira>();
const opsEmAndamento = new Map<string, number>();
const DRENAGEM_MS = 15000;

export function barreiraRestauracaoAtiva(campaignId: string): boolean {
  return barreiras.has(campaignId);
}

/**
 * Autorização temporária de operação normal sobre a campanha. Retorna
 * a função de liberação ou null quando há restauração em andamento —
 * o chamador deve abortar nesse caso. O lease deve ser mantido até o
 * fim da mutação E das emissões associadas.
 */
export function adquirirOperacaoCampanha(campaignId: string): (() => void) | null {
  if (barreiras.has(campaignId)) return null;
  opsEmAndamento.set(campaignId, (opsEmAndamento.get(campaignId) ?? 0) + 1);
  let liberada = false;
  return () => {
    if (liberada) return;
    liberada = true;
    const n = (opsEmAndamento.get(campaignId) ?? 1) - 1;
    if (n <= 0) opsEmAndamento.delete(campaignId); else opsEmAndamento.set(campaignId, n);
  };
}

/**
 * Inicia a restauração de forma EXCLUSIVA: a barreira é marcada
 * sincronamente (antes de qualquer await) e uma segunda chamada na
 * mesma campanha retorna null — o chamador deve responder 409.
 * Em seguida drena operações em voo (leases) antes de evacuar as
 * salas e devolver o restoreId proprietário.
 */
export async function iniciarBarreiraRestauracao(campaignId: string): Promise<string | null> {
  if (barreiras.has(campaignId)) return null;
  const restoreId = crypto.randomUUID();
  const b: Barreira = { restoreId, evacuados: new Map() };
  barreiras.set(campaignId, b); // atômico: novas operações já falham aqui
  if (!io) return restoreId;
  // drena operações normais em voo: elas concluem mutação+emissão
  // (emissões são descartadas pelo guard da barreira) antes da captura
  const limite = Date.now() + DRENAGEM_MS;
  while ((opsEmAndamento.get(campaignId) ?? 0) > 0 && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const db = getDb();
  const ss = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId));
  const salas = [`campanha:${campaignId}`, ...ss.map((s) => `sessao:${s.id}`)];
  for (const room of salas) {
    const roomObj = io.sockets.adapter.rooms.get(room);
    if (!roomObj) continue;
    for (const sid of [...roomObj]) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      sock.leave(room);
      const lista = b.evacuados.get(sid) ?? [];
      lista.push(room);
      b.evacuados.set(sid, lista);
    }
  }
  return restoreId;
}

/**
 * Libera a barreira SOMENTE para o proprietário (restoreId exato).
 * Retorna false em qualquer tentativa com identificador divergente —
 * nenhuma liberação genérica pode apagar a barreira de outra operação.
 * - "falha": a transação foi revertida — readiciona cada socket às
 *   salas EXATAS de onde foi evacuado (sessões antigas ainda válidas).
 * - "sucesso": somente salas válidas do banco pós-restore voltam, e
 *   apenas para memberships ATIVAS atuais.
 */
export async function liberarBarreiraRestauracao(campaignId: string, restoreId: string, modo: "sucesso" | "falha"): Promise<boolean> {
  const b = barreiras.get(campaignId);
  if (!b || b.restoreId !== restoreId) return false; // não é o dono
  barreiras.delete(campaignId);
  if (!io) return true;
  if (modo === "falha") {
    for (const [sid, rooms] of b.evacuados) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      for (const r of rooms) s.join(r);
    }
    return true;
  }
  const db = getDb();
  const ativos = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), eq(memberships.status, "ativo")));
  const set = new Set(ativos.map((a) => a.userId));
  // sessões que AINDA existem depois da substituição: só elas voltam a
  // ser reconstituídas — IDs substituídos nunca são reabertos por
  // inferência (o cliente entra de novo via mesa:entrar)
  const ssDepois = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId));
  const salasValidas = new Set(ssDepois.map((s) => `sessao:${s.id}`));
  const salaCampanha = `campanha:${campaignId}`;
  for (const [sid, rooms] of b.evacuados) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    const u = s.data.usuario as { id?: string } | undefined;
    if (!u?.id || !set.has(u.id)) continue; // revogado/inativo: só usuario:*
    for (const r of rooms) {
      if (r === salaCampanha || salasValidas.has(r)) s.join(r);
    }
  }
  return true;
}

/**
 * Emissão privada centralizada (usuario:*): revalida a barreira e a
 * membership ATIVA de cada destinatário DEPOIS da consulta assíncrona
 * e emite sem nenhum await entre a validação final e o emit — um
 * destinatário revogado entre a montagem da lista e o envio não
 * recebe o conteúdo. `papeis`, quando informado, restringe ainda por
 * role atual (ex.: só "mestre").
 */
export async function emitirPrivadoCampanha(
  campaignId: string,
  userIds: string[],
  evento: string,
  payload: unknown,
  papeis?: string[],
): Promise<void> {
  if (barreiraRestauracaoAtiva(campaignId) || !io || !userIds.length) return;
  const db = getDb();
  const rows = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(
      eq(memberships.campaignId, campaignId),
      eq(memberships.status, "ativo"),
      inArray(memberships.userId, [...new Set(userIds)]),
    ));
  const ok = new Set(rows.filter((r) => !papeis || papeis.includes(r.role)).map((r) => r.userId));
  // validação FINAL imediatamente antes do emit — sem await adiante
  if (barreiraRestauracaoAtiva(campaignId)) return;
  for (const uid of userIds) {
    if (ok.has(uid)) io.to(`usuario:${uid}`).emit(evento, payload);
  }
}

// ---------- gancho determinístico de teste (somente NODE_ENV=test) ----------
// Se MESTRE_PAUSA_FLAG aponta para um arquivo existente E o payload
// contém MESTRE_PAUSA_MATCH, o handler pausa até o arquivo-servo
// MESTRE_PAUSA_FLAG.pausado aparecer; o teste apaga o flag para
// liberar. Inerte em produção (guarda dupla de ambiente).
export async function pausaTesteEmit(marcador: string): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const flag = process.env.MESTRE_PAUSA_FLAG;
  const match = process.env.MESTRE_PAUSA_MATCH;
  if (!flag || !match || !marcador.includes(match)) return;
  const fs = await import("node:fs");
  if (!fs.existsSync(flag)) return;
  fs.writeFileSync(`${flag}.pausado`, String(Date.now()));
  const limite = Date.now() + 20000;
  while (fs.existsSync(flag) && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 50));
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
