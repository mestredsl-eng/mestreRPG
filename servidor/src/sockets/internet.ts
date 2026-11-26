// Socket.IO da Internet diegética (#350/#351 — contrato §6).
// ZERO rooms de conteúdo: `internet:conversa-entrar` só valida e devolve
// cursor/estado no ACK; `internet:mensagem:enviar` persiste primeiro
// (transação + idempotência) e o fan-out sai por emitirInternetConversa,
// que revalida contaAutorizadaPara por destinatário a cada entrega.
import type { Server as SocketIOServer, Socket } from "socket.io";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  internetAccounts, internetContacts, internetConversations, internetParticipantes,
  internetMessages,
} from "../db/schema.js";
import { contaAutorizadaPara, participanteAtivo,
  hashPayloadMensagem,
  LIMITE_CONTEUDO_CHARS, LIMITE_MSG_POR_MINUTO, JANELA_RATE_MS } from "../lib/conta-internet.js";
import { emitirInternetConversa } from "../lib/io.js";
import { barreiraRestauracaoAtiva } from "../lib/io.js";
import { criarLimitadorSocket } from "../lib/socket-rate-limit.js";

const db = getDb();

// Incremento F3 absorvido (#351): handshake de conversa é de baixa
// frequência legítima (~1/s por conversa aberta); burst cobre troca
// rápida de conversa em multi-aba. Por USUÁRIO — independente do P8
// (20 msg/min por CONTA no envio), que limita recurso diferente.
const limiteEntrar = criarLimitadorSocket({
  nome: "internet-conversa-entrar",
  capacidade: 20,
  porSegundo: 5,
});

type Ack = (res: Record<string, unknown>) => void;

function payloadStr(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

/** Payload mínimo do evento de mensagem (contrato §6): sempre com
 *  conversaId + contaId do DESTINATÁRIO para roteamento no cliente. */
function eventoMensagem(m: typeof internetMessages.$inferSelect, conta: typeof internetAccounts.$inferSelect) {
  return {
    mensagemId: m.id,
    conversaId: m.conversaId,
    contaId: conta.id, // conta do AUTOR — o fan-out sobrescreve com a do destinatário
    autor: { contaId: conta.id, handle: conta.handle, displayName: conta.displayName },
    conteudo: m.conteudo,
    createdAt: m.createdAt,
    requestId: m.requestId,
  };
}

export function registrarInternet(io: SocketIOServer) {
  io.on("connection", (socket: Socket) => {
    const usuarioId = () => socket.data.usuario?.id as string | undefined;

    /** Handshake de conversa: revalida conta/titularidade/participação e
     *  devolve SOMENTE cursor/estado — nunca conteúdo (contrato §6/§9). */
    socket.on("internet:conversa-entrar", async (payload: unknown, cb?: Ack) => {
      const uid = usuarioId();
      const p = payload as { conversaId?: unknown; contaId?: unknown } | null;
      const conversaId = payloadStr(p?.conversaId);
      const contaId = payloadStr(p?.contaId);
      if (!uid || !conversaId || !contaId) {
        cb?.({ ok: false });
        return;
      }
      const limite = limiteEntrar.consumir(uid);
      if (!limite.permitido) {
        cb?.({ ok: false, erro: "rate_limit", retryAfterMs: limite.retryAfterMs });
        return;
      }
      try {
        const auth = await contaAutorizadaPara(contaId, uid);
        if (!auth) { cb?.({ ok: false }); return; }
        const [conversa] = await db.select().from(internetConversations)
          .where(and(eq(internetConversations.id, conversaId), eq(internetConversations.campaignId, auth.conta.campaignId)))
          .limit(1);
        if (!conversa || conversa.status !== "ativa") { cb?.({ ok: false }); return; }
        if (barreiraRestauracaoAtiva(conversa.campaignId)) { cb?.({ ok: false }); return; }
        const parte = await participanteAtivo(conversaId, contaId);
        if (!parte) { cb?.({ ok: false }); return; }
        cb?.({
          ok: true,
          conversaId,
          contaId,
          cursor: {
            lastReadCreatedAt: parte.lastReadCreatedAt?.getTime() ?? null,
            lastReadMessageId: parte.lastReadMessageId ?? null,
          },
          papel: parte.papel,
        });
      } catch {
        cb?.({ ok: false });
      }
    });

    socket.on("internet:conversa-sair", (payload: unknown, cb?: Ack) => {
      // estado de participação vem do banco — o evento é só sinalização
      // de UX; nenhuma autorização depende dele.
      cb?.({ ok: true });
    });

    /** Envio de mensagem: validação completa → tx idempotente → ACK →
     *  fan-out individual revalidado. Rate limit P8: 4000 chars e
     *  20 msg/min por conta, avaliado dentro da transação. */
    socket.on("internet:mensagem:enviar", async (payload: unknown, cb?: Ack) => {
      const uid = usuarioId();
      const p = payload as { conversaId?: unknown; contaId?: unknown; requestId?: unknown; conteudo?: unknown } | null;
      const conversaId = payloadStr(p?.conversaId);
      const contaId = payloadStr(p?.contaId);
      const requestId = payloadStr(p?.requestId);
      const conteudo = typeof p?.conteudo === "string" ? p.conteudo : null;
      if (!uid || !conversaId || !contaId || !requestId || conteudo === null) {
        cb?.({ ok: false, erro: "payload_invalido" });
        return;
      }
      if (conteudo.trim().length === 0) { cb?.({ ok: false, erro: "conteudo_vazio" }); return; }
      if (conteudo.length > LIMITE_CONTEUDO_CHARS) {
        cb?.({ ok: false, erro: "conteudo_longo", limite: LIMITE_CONTEUDO_CHARS }); return;
      }
      try {
        const auth = await contaAutorizadaPara(contaId, uid);
        if (!auth) { cb?.({ ok: false, erro: "conta_nao_autorizada" }); return; }
        const cid = auth.conta.campaignId;
        if (barreiraRestauracaoAtiva(cid)) { cb?.({ ok: false, erro: "campanha_em_restauracao" }); return; }

        const [conversa] = await db.select().from(internetConversations)
          .where(and(eq(internetConversations.id, conversaId), eq(internetConversations.campaignId, cid))).limit(1);
        if (!conversa || conversa.status !== "ativa") { cb?.({ ok: false, erro: "conversa_nao_encontrada" }); return; }

        const parte = await participanteAtivo(conversaId, contaId);
        if (!parte) { cb?.({ ok: false, erro: "nao_participante" }); return; }

        const payloadHash = hashPayloadMensagem(conteudo);
        const agora = new Date();
        const janela = new Date(agora.getTime() - JANELA_RATE_MS);

        // better-sqlite3: transaction é SÍNCRONA — leituras via .all()/.get(),
        // escritas via .run(). Tudo dentro da tx para não haver corrida
        // entre checagem de bloqueio/rate-limit e a gravação.
        const resultado = db.transaction((tx) => {
          // idempotência PRIMEIRO: retry de mensagem já persistida deve
          // retornar replay/uso_conflito mesmo se o autor ficou sem
          // elegíveis ou estourou o rate limit depois do ACK original.
          const existente = tx.select().from(internetMessages)
            .where(and(
              eq(internetMessages.conversaId, conversaId),
              eq(internetMessages.autorContaId, contaId),
              eq(internetMessages.requestId, requestId),
            ))
            .limit(1)
            .get();
          if (existente) {
            if (existente.payloadHash === payloadHash) {
              return { replay: true as const, mensagem: existente };
            }
            return { erro: "uso_conflito" as const };
          }
          // P3 par-a-par (deliberação do proprietário): a mensagem é
          // persistida se o autor tem AO MENOS UM destinatário elegível
          // (participante ativo sem aresta `bloqueado` contra ele).
          // Em direta, o único outro é o par — bloqueado ⇒ 0 elegíveis
          // ⇒ rejeição equivalente à anterior. Em grupo, o autor segue
          // falando com os não-bloqueados; o filtro de entrega/leitura
          // acontece no fan-out e no histórico.
          // NOTA (comportamento aceito, parecer P3): grupo sem nenhum
          // destinatário elegível — todos bloqueados ou todos saíram —
          // retorna `contato_bloqueado` por vacuidade, não por bloqueio.
          const outros = tx.select({ contaId: internetParticipantes.contaId })
            .from(internetParticipantes)
            .where(and(eq(internetParticipantes.conversaId, conversaId), eq(internetParticipantes.status, "ativo")))
            .all();
          let elegiveis = 0;
          for (const o of outros) {
            if (o.contaId === contaId) continue;
            const arestas = tx.select({ status: internetContacts.status })
              .from(internetContacts)
              .where(and(
                eq(internetContacts.campaignId, cid),
                or(
                  and(eq(internetContacts.contaOrigemId, contaId), eq(internetContacts.contaDestinoId, o.contaId)),
                  and(eq(internetContacts.contaOrigemId, o.contaId), eq(internetContacts.contaDestinoId, contaId)),
                ),
              ))
              .all();
            if (!arestas.some((r) => r.status === "bloqueado")) elegiveis++;
          }
          if (elegiveis === 0) {
            return { erro: "contato_bloqueado" as const };
          }
          // rate limit P8 — conta quantas mensagens a conta enviou na janela
          const r = tx.select({ c: sql<number>`count(*)` })
            .from(internetMessages)
            .where(and(eq(internetMessages.autorContaId, contaId), gt(internetMessages.createdAt, janela)))
            .get();
          if (Number(r?.c ?? 0) >= LIMITE_MSG_POR_MINUTO) {
            return { erro: "rate_limit" as const, retryAfterMs: JANELA_RATE_MS };
          }
          const id = crypto.randomUUID();
          tx.insert(internetMessages).values({
            id, conversaId, campaignId: cid, autorContaId: contaId,
            requestId, payloadHash, conteudo, createdAt: agora,
          }).run();
          return {
            replay: false as const,
            mensagem: {
              id, conversaId, campaignId: cid, autorContaId: contaId,
              requestId, payloadHash, conteudo, createdAt: agora,
            },
          };
        });

        if ("erro" in resultado && resultado.erro) {
          const retry = "retryAfterMs" in resultado ? resultado.retryAfterMs : undefined;
          cb?.({ ok: false, erro: resultado.erro, ...(retry ? { retryAfterMs: retry } : {}) });
          return;
        }
        const msg = resultado.mensagem;
        const [autor] = await db.select().from(internetAccounts).where(eq(internetAccounts.id, contaId)).limit(1);
        // ACK primeiro — o cliente nunca depende do fan-out para confirmar
        cb?.({
          ok: true,
          mensagemId: msg.id,
          conversaId,
          contaId,
          createdAt: msg.createdAt,
          requestId: msg.requestId,
          replay: resultado.replay,
        });
        if (!resultado.replay) {
          // fan-out individual revalidado por destinatário (contrato §6)
          await emitirInternetConversa(conversaId, "internet:mensagem", eventoMensagem(msg, autor!), contaId);
        }
      } catch (e) {
        console.error("[internet] falha no envio de mensagem:", e);
        cb?.({ ok: false, erro: "falha_interna" });
      }
    });
  });
}
