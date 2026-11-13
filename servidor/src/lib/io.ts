import type { Server as SocketIOServer } from "socket.io";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { agendarAutosave } from "./autosave.js";
import { getDb } from "../db/index.js";
import { sessions, memberships } from "../db/schema.js";

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
          // status efetivamente restaurado: pendente/bloqueado no
          // snapshot são notificados como tal — "removido" só quando o
          // membro não existe no estado restaurado. Status ≠ ativo não
          // concede acesso: a expulsão das salas acima já ocorreu.
          status: d?.status ?? "removido",
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
type Barreira = { restoreId: string; evacuados: Map<string, string[]>; pendente?: "sucesso" | "falha"; recuperando?: Promise<boolean> };
const barreiras = new Map<string, Barreira>();
const opsEmAndamento = new Map<string, number>();
const DRENAGEM_MS = 15000;

/**
 * Contexto de operação por chamada assíncrona (AsyncLocalStorage):
 * handlers Socket.IO rodam dentro de `opCampanhaALS.run({})`; cada
 * lease é registrado por campaignId — resolverCtx e registrarChat
 * REUTILIZAM o lease da mesma campanha dentro da operação e o wrapper
 * libera todos no finally (uma aquisição, uma liberação por campanha).
 */
export const opCampanhaALS = new AsyncLocalStorage<{ ops: Map<string, () => void> }>();

/**
 * Retorna o lease da campanha dentro do contexto ALS atual —
 * reutilizando um já adquirido por ESTA operação ou adquirindo um
 * novo (registrado para liberação única no finally do wrapper).
 * Retorna null quando há barreira de restauração.
 */
export function leaseOperacaoALS(campaignId: string): (() => void) | null {
  const store = opCampanhaALS.getStore();
  if (store?.ops.has(campaignId)) return () => {}; // já coberto pela operação
  const liberar = adquirirOperacaoCampanha(campaignId);
  if (!liberar) return null;
  if (store) store.ops.set(campaignId, liberar);
  return liberar;
}

/** Libera todos os leases registrados no contexto ALS atual. */
export function liberarLeasesALS(): void {
  const store = opCampanhaALS.getStore();
  if (!store) return;
  for (const liberar of store.ops.values()) liberar();
  store.ops.clear();
}

export function barreiraRestauracaoAtiva(campaignId: string): boolean {
  return barreiras.has(campaignId);
}

/**
 * Gancho determinístico de falha — SOMENTE NODE_ENV=test. O arquivo-
 * sinal MESTRE_FALHA_FLAG contém o NOME do ponto a falhar (ex.:
 * "init-sessoes", "rejoins-members"); ao falhar o arquivo é consumido
 * (one-shot), permitindo nova tentativa sem nova injeção. Inerte em
 * produção e sem efeito quando a env não existe.
 */
function pontoFalha(nome: string): void {
  if (process.env.NODE_ENV !== "test") return;
  const flag = process.env.MESTRE_FALHA_FLAG;
  if (!flag || !existsSync(flag)) return;
  const ponto = readFileSync(flag, "utf8").trim();
  if (ponto !== nome) return;
  unlinkSync(flag); // one-shot: a próxima execução passa
  throw new Error(`falha injetada: ${nome}`);
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
 * Se houver uma barreira com liberação PENDENTE (falha anterior na
 * reconstrução), tenta concluir a recuperação do MESMO restoreId
 * antes de aceitar a nova operação — nunca acumula barreiras.
 * Em seguida drena operações em voo (leases) até o contador zerar;
 * se o prazo estourar, a restauração ABORTA ("timeout") sem capturar
 * estado, sem commit e sem evacuar salas — a barreira própria é
 * liberada em modo falha e a campanha volta a aceitar operações.
 */
export async function iniciarBarreiraRestauracao(campaignId: string): Promise<string | "timeout" | "falha" | null> {
  const existente = barreiras.get(campaignId);
  if (existente) {
    if (!existente.pendente) return null; // restauração realmente ativa → 409
    // liberação pendente do restoreId anterior: UMA recuperação por vez.
    // Chamadas concorrentes aguardam a MESMA promise — nunca executam
    // calcularRejoins/joins em paralelo nem trocam o proprietário.
    if (!existente.recuperando) {
      existente.recuperando = liberarBarreiraRestauracao(campaignId, existente.restoreId, existente.pendente)
        .finally(() => { existente.recuperando = undefined; });
    }
    const ok = await existente.recuperando;
    if (!ok) return null; // recuperação falhou de novo → fail-closed (409)
    // outra tentativa pode ter assumido a campanha durante a espera
    if (barreiras.get(campaignId)) return null;
  }
  const restoreId = crypto.randomUUID();
  const b: Barreira = { restoreId, evacuados: new Map() };
  barreiras.set(campaignId, b); // atômico: novas operações já falham aqui
  try {
    // drena operações normais em voo: cada lease cobre o ciclo inteiro
    // (leitura→validação→mutação→emissão). O restore SÓ avança com o
    // contador efetivamente zerado — nunca com operações pendentes.
    // A drenagem ocorre MESMO sem Socket.IO: leases HTTP também contam.
    const limite = Date.now() + DRENAGEM_MS;
    while ((opsEmAndamento.get(campaignId) ?? 0) > 0) {
      if (Date.now() >= limite) {
        // timeout de drenagem: aborta ANTES de capturar/evacuar —
        // libera a própria barreira (nada foi evacuado ainda) e o
        // chamador responde 503; as operações em voo terminam
        // normalmente porque nenhum commit ocorreu
        console.error(`[barreira] timeout de drenagem campanha=${campaignId} restore=${restoreId} leases=${opsEmAndamento.get(campaignId)}`);
        await liberarBarreiraRestauracao(campaignId, restoreId, "falha").catch(() => false);
        return "timeout";
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    pontoFalha("init-sessoes"); // gancho de teste: falha na consulta de sessões
    const db = getDb();
    const ss = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId));
    pontoFalha("init-salas"); // gancho de teste: falha na enumeração de salas
    const salas = [`campanha:${campaignId}`, ...ss.map((s) => `sessao:${s.id}`)];
    if (io) {
      let primeiro = true;
      for (const room of salas) {
        const roomObj = io.sockets.adapter.rooms.get(room);
        if (!roomObj) continue;
        for (const sid of [...roomObj]) {
          const sock = io.sockets.sockets.get(sid);
          if (!sock) continue;
          sock.leave(room);
          // cada saída é registrada IMEDIATAMENTE: uma falha no meio
          // da evacuação preserva a lista exata do que já saiu
          const lista = b.evacuados.get(sid) ?? [];
          lista.push(room);
          b.evacuados.set(sid, lista);
          if (primeiro) { primeiro = false; pontoFalha("init-evacuar"); }
        }
      }
    }
    return restoreId;
  } catch (e) {
    // falha na inicialização: tenta recuperar em modo "falha" (nada
    // foi commitado; as salas evacuadas voltam se ainda válidas).
    // Se a recuperação falhar, a barreira PERMANECE pendente —
    // fail-closed e retomável pelo mesmo restoreId.
    console.error(`[barreira] inicialização falhou campanha=${campaignId} restore=${restoreId}:`, e);
    await liberarBarreiraRestauracao(campaignId, restoreId, "falha").catch(() => false);
    return "falha";
  }
}

/**
 * Calcula as salas que cada socket evacuado pode reocupar, conforme o
 * modo — executado com a barreira AINDA ATIVA.
 * - "falha" (transação revertida): somente salas antigas que continuam
 *   existindo no banco E usuário ainda membro ativo.
 * - "sucesso" (commit aplicado): somente campanha:* e sessao:* que
 *   existem no estado pós-restore, para membros ativos.
 */
async function calcularRejoins(campaignId: string, b: Barreira, modo: "sucesso" | "falha"): Promise<Map<string, string[]>> {
  const db = getDb();
  pontoFalha("rejoins-members"); // gancho de teste
  const ativos = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), eq(memberships.status, "ativo")));
  const set = new Set(ativos.map((a) => a.userId));
  pontoFalha("rejoins-sessoes"); // gancho de teste
  const ss = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId));
  const salasValidas = new Set(ss.map((s) => `sessao:${s.id}`));
  const salaCampanha = `campanha:${campaignId}`;
  const rejoins = new Map<string, string[]>();
  for (const [sid, rooms] of b.evacuados) {
    const s = io?.sockets.sockets.get(sid);
    if (!s) continue;
    const u = s.data.usuario as { id?: string } | undefined;
    if (!u?.id || !set.has(u.id)) continue; // revogado/inativo: só usuario:*
    const liberadas: string[] = [];
    for (const r of rooms) {
      if (r === salaCampanha) liberadas.push(r);
      else if (salasValidas.has(r)) liberadas.push(r); // só IDs que ainda existem
    }
    if (liberadas.length) rejoins.set(sid, liberadas);
  }
  return rejoins;
}

/**
 * Libera a barreira SOMENTE para o proprietário (restoreId exato).
 * A barreira permanece ATIVA durante toda a recuperação: consultas de
 * memberships/sessões, cálculo e reinserção nos sockets acontecem
 * antes da remoção — que é a ÚLTIMA operação, sem await entre a
 * revalidação de propriedade e o delete.
 * Se qualquer etapa falhar, a barreira PERMANECE (b.pendente=modo) —
 * a campanha segue fail-closed e uma nova tentativa de restauração
 * retoma a recuperação do mesmo restoreId.
 */
export async function liberarBarreiraRestauracao(campaignId: string, restoreId: string, modo: "sucesso" | "falha"): Promise<boolean> {
  const b = barreiras.get(campaignId);
  if (!b || b.restoreId !== restoreId) return false; // não é o dono
  try {
    // gancho determinístico (teste): pausa no início da recuperação —
    // permite provar que retomadas concorrentes dividem a MESMA execução
    await pausaTesteEmit("barreira:recovery");
    const rejoins = await calcularRejoins(campaignId, b, modo);
    if (io) {
      for (const [sid, rooms] of rejoins) {
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        for (const r of rooms) {
          pontoFalha("rejoins-join"); // gancho de teste
          s.join(r); // joins são síncronos
        }
      }
    }
    // remoção final: revalida o dono e apaga sem await intermediário
    const atual = barreiras.get(campaignId);
    if (!atual || atual.restoreId !== restoreId) return false;
    barreiras.delete(campaignId);
    return true;
  } catch (e) {
    b.pendente = modo; // fail-closed: barreira permanece, recuperação retomável
    console.error(`[barreira] liberação falhou campanha=${campaignId} restore=${restoreId} modo=${modo}:`, e);
    return false;
  }
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
  if (!flag) return;
  const fs = await import("node:fs");
  if (!fs.existsSync(flag)) return;
  // o conteúdo do flag também é um marcador válido (ex.: campaignId)
  const conteudo = fs.readFileSync(flag, "utf8").trim();
  if (!(match && marcador.includes(match)) && !(conteudo && marcador.includes(conteudo))) return;
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
