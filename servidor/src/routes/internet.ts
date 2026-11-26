// Internet diegética — contas, contatos e conversas (Issue #349/#350, v1.1.1).
// Autorização SEMPRE via contaAutorizadaPara (titularidade atual, sem
// bypass de mestre) — IDs do cliente nunca provam acesso. Mensagens
// privadas NUNCA entram em exportação (P9): exportarCampanha não
// enumera estas tabelas. P13: nenhum job de expurgo — prazo pendente.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, ne, or, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  internetAccounts, internetContacts, internetConversations,
  internetParticipantes, internetMessages, characters, memberships,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, vincularLeaseAoHandler } from "../lib/permissoes.js";
import {
  contaAutorizadaPara, contasDoUsuario, arestaContato, contatoBloqueadoEntre,
  contatoAceitoEntre, codificarCursor, decodificarCursor, bloqueiosEntreContas,
  participanteDaConta, participanteAtivo, mestreLeitorDaCampanha,
} from "../lib/conta-internet.js";
import { gateInternetDoPersonagem } from "../lib/gate-internet.js";
import { emitirUsuario } from "../lib/io.js";
import { audit } from "../lib/audit.js";

const db = getDb();
export const internetRouter = Router({ mergeParams: true });
internetRouter.use(requireAuth);

// ---------- helpers ----------

const campanhaId = (req: Request) => req.params.campaignId as string;

/** P11 — perfil público mínimo: handle + nome de exibição. Nada de
 *  personagem, usuário real, presença ou digitação por padrão. */
function contaPublica(c: typeof internetAccounts.$inferSelect) {
  return { id: c.id, handle: c.handle, displayName: c.displayName };
}

/** Gate completo da conta; null = negado (fail-closed, sem oráculo). */
async function exigirConta(req: Request, res: Response, contaId: string) {
  const auth = await contaAutorizadaPara(contaId, req.usuario!.id);
  if (!auth) {
    res.status(403).json({ erro: "Conta não autorizada" });
    return null;
  }
  return auth;
}

function erroHttp(res: Response, status: number, erro: string, extra?: Record<string, unknown>) {
  res.status(status).json({ erro, ...extra });
}

/** Resolve a conta de origem do requisitante: `origemContaId` explícito
 *  quando o usuário tem >1 conta; com exatamente 1, é implícita. */
async function resolverOrigem(req: Request, res: Response, origemContaId: string | undefined, cid: string) {
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const origem = origemContaId
    ? minhas.find((c) => c.id === origemContaId)
    : minhas.length === 1 ? minhas[0] : undefined;
  if (!origem) {
    erroHttp(res, 400, minhas.length > 1 ? "origemContaId obrigatório" : "Sem conta elegível");
    return null;
  }
  const auth = await contaAutorizadaPara(origem.id, req.usuario!.id);
  if (!auth) {
    erroHttp(res, 403, "Conta não autorizada");
    return null;
  }
  return { origem, auth, minhas };
}

// ---------- conta diegética ----------

const handleSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,24}$/, "handle inválido");

/** POST /api/campaigns/:campaignId/internet/account — opt-in do titular.
 *  Exige personagem próprio (não arquivado), membership ativa
 *  mestre|jogador e gate canônico de perícia+dispositivo (P5). */
internetRouter.post("/account", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = z.object({
    characterId: z.string().min(1),
    handle: handleSchema,
    displayName: z.string().trim().max(60).optional(),
  }).strict().safeParse(req.body);
  if (!body.success) {
    erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues });
    return;
  }
  const [personagem] = await db.select().from(characters)
    .where(and(eq(characters.id, body.data.characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!personagem) { erroHttp(res, 404, "Personagem não encontrado"); return; }
  // titularidade: o personagem precisa ser do requisitante (sem bypass)
  const [dono] = await db.select({ userId: memberships.userId, status: memberships.status }).from(memberships)
    .where(eq(memberships.id, personagem.membershipId)).limit(1);
  if (!dono || dono.status !== "ativo" || dono.userId !== req.usuario!.id) {
    erroHttp(res, 403, "Conta não autorizada"); return;
  }
  if (personagem.status === "arquivado") { erroHttp(res, 409, "Personagem arquivado"); return; }
  const [existente] = await db.select({ id: internetAccounts.id }).from(internetAccounts)
    .where(eq(internetAccounts.characterId, personagem.id)).limit(1);
  if (existente) { erroHttp(res, 409, "Personagem já possui conta", { contaId: existente.id }); return; }
  // P5 — gate canônico de habilidade + dispositivo
  if (!(await gateInternetDoPersonagem(personagem)).elegivel) {
    erroHttp(res, 403, "Personagem não elegível para Internet"); return;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  try {
    await db.insert(internetAccounts).values({
      id, campaignId: cid, characterId: personagem.id,
      handle: body.data.handle, displayName: body.data.displayName ?? null,
      status: "ativa", createdAt: agora, updatedAt: agora,
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { erroHttp(res, 409, "Handle já em uso"); return; }
    throw e;
  }
  await audit(req, "internet.conta_criada", { contaId: id, handle: body.data.handle, characterId: personagem.id });
  res.status(201).json({
    ok: true,
    conta: contaPublica({
      id, campaignId: cid, characterId: personagem.id, handle: body.data.handle,
      displayName: body.data.displayName ?? null, status: "ativa",
      mostrarPresenca: false, mostrarDigitando: false, createdAt: agora, updatedAt: agora,
    }),
  });
});

/** GET /api/campaigns/:campaignId/internet/account?characterId= — conta do
 *  personagem para o requisitante (null se ainda não optou). */
internetRouter.get("/account", async (req, res) => {
  const cid = campanhaId(req);
  const characterId = typeof req.query.characterId === "string" ? req.query.characterId : null;
  if (!characterId) { erroHttp(res, 400, "characterId obrigatório"); return; }
  const [personagem] = await db.select().from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid))).limit(1);
  if (!personagem) { erroHttp(res, 404, "Personagem não encontrado"); return; }
  const [dono] = await db.select({ userId: memberships.userId, status: memberships.status }).from(memberships)
    .where(eq(memberships.id, personagem.membershipId)).limit(1);
  if (!dono || dono.status !== "ativo" || dono.userId !== req.usuario!.id) {
    erroHttp(res, 403, "Conta não autorizada"); return;
  }
  const [conta] = await db.select().from(internetAccounts)
    .where(and(eq(internetAccounts.characterId, personagem.id), eq(internetAccounts.campaignId, cid))).limit(1);
  res.json({ conta: conta ? contaPublica(conta) : null });
});

/** GET /api/campaigns/:campaignId/internet/accounts — diretório mínimo da
 *  campanha (P11): handle + displayName das contas ativas de personagens
 *  não arquivados (conta de personagem arquivado não é contactável). */
internetRouter.get("/accounts", requirePapel("mestre", "jogador"), async (req, res) => {
  const rows = await db.select({ conta: internetAccounts }).from(internetAccounts)
    .innerJoin(characters, eq(internetAccounts.characterId, characters.id))
    .where(and(
      eq(internetAccounts.campaignId, campanhaId(req)),
      eq(internetAccounts.status, "ativa"),
      ne(characters.status, "arquivado"),
    ));
  res.json({ contas: rows.map((r) => contaPublica(r.conta)) });
});

// ---------- contatos (aresta dirigida) ----------

/** GET /api/campaigns/:campaignId/internet/contacts — arestas que tocam
 *  qualquer conta do usuário (enviadas e recebidas). */
internetRouter.get("/contacts", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  if (!minhas.length) { res.json({ contatos: [] }); return; }
  const ids = minhas.map((c) => c.id);
  const rows = await db.select().from(internetContacts)
    .where(and(
      eq(internetContacts.campaignId, cid),
      or(inArray(internetContacts.contaOrigemId, ids), inArray(internetContacts.contaDestinoId, ids)),
    ));
  const contaIds = [...new Set(rows.flatMap((r) => [r.contaOrigemId, r.contaDestinoId]))];
  const contas = contaIds.length
    ? await db.select().from(internetAccounts).where(inArray(internetAccounts.id, contaIds))
    : [];
  const porId = new Map(contas.map((c) => [c.id, contaPublica(c)]));
  res.json({
    contatos: rows.map((r) => ({
      id: r.id,
      status: r.status,
      origem: porId.get(r.contaOrigemId) ?? null,
      destino: porId.get(r.contaDestinoId) ?? null,
      souOrigem: ids.includes(r.contaOrigemId),
      createdAt: r.createdAt,
      respondedAt: r.respondedAt,
    })),
  });
});

const contatoBodySchema = z.object({
  contaId: z.string().min(1),
  origemContaId: z.string().min(1).optional(),
}).strict();

/** POST /api/campaigns/:campaignId/internet/contacts — pedido unilateral.
 *  Requer aresta inexistente e nenhum bloqueio em qualquer direção (P3). */
internetRouter.post("/contacts", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = contatoBodySchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const [destino] = await db.select().from(internetAccounts)
    .where(and(eq(internetAccounts.id, body.data.contaId), eq(internetAccounts.campaignId, cid), eq(internetAccounts.status, "ativa"))).limit(1);
  if (!destino) { erroHttp(res, 404, "Conta não encontrada"); return; }
  const resolvido = await resolverOrigem(req, res, body.data.origemContaId, cid);
  if (!resolvido) return;
  const { origem } = resolvido;
  if (origem.id === destino.id) { erroHttp(res, 400, "Não é possível adicionar a si mesmo"); return; }
  if (await contatoBloqueadoEntre(db, cid, origem.id, destino.id)) {
    erroHttp(res, 403, "Contato bloqueado"); return;
  }
  // check-then-act DENTRO da tx síncrona: dois pedidos simultâneos em
  // direções opostas não podem ambos passar — o UNIQUE da aresta é por
  // direção, então sem isso nasceriam duas arestas pendentes espelhadas.
  // O bloqueio também é re-verificado aqui para fechar a janela.
  const agora = new Date();
  const id = crypto.randomUUID();
  const resultado = db.transaction((tx) => {
    const arestas = tx.select().from(internetContacts)
      .where(and(
        eq(internetContacts.campaignId, cid),
        or(
          and(eq(internetContacts.contaOrigemId, origem.id), eq(internetContacts.contaDestinoId, destino.id)),
          and(eq(internetContacts.contaOrigemId, destino.id), eq(internetContacts.contaDestinoId, origem.id)),
        ),
      ))
      .all();
    if (arestas.some((r) => r.status === "bloqueado")) return { erro: "bloqueado" as const };
    if (arestas.length) {
      const ex = arestas[0];
      if (arestas.length === 1 && ex.contaOrigemId === origem.id && ex.status === "pendente") {
        return { replay: ex };
      }
      return { conflito: ex.status };
    }
    tx.insert(internetContacts).values({
      id, campaignId: cid, contaOrigemId: origem.id, contaDestinoId: destino.id,
      status: "pendente", createdAt: agora, updatedAt: agora,
    }).run();
    return { criado: true as const };
  });
  if ("erro" in resultado) { erroHttp(res, 403, "Contato bloqueado"); return; }
  if ("conflito" in resultado) {
    erroHttp(res, 409, "Já existe aresta de contato", { status: resultado.conflito }); return;
  }
  if ("replay" in resultado && resultado.replay) {
    res.json({ ok: true, contato: { id: resultado.replay.id, status: "pendente" }, replay: true }); return;
  }
  await audit(req, "internet.contato_pedido", { contatoId: id, origem: origem.id, destino: destino.id });
  // notifica o destinatário pela sala privada (nunca room de conteúdo)
  const [destUser] = await db.select({ userId: memberships.userId }).from(internetAccounts)
    .innerJoin(characters, eq(internetAccounts.characterId, characters.id))
    .innerJoin(memberships, eq(characters.membershipId, memberships.id))
    .where(and(eq(internetAccounts.id, destino.id), eq(memberships.status, "ativo"))).limit(1);
  if (destUser) {
    emitirUsuario(destUser.userId, "internet:contato", {
      campanhaId: cid, contatoId: id, status: "pendente", de: contaPublica(origem),
    });
  }
  res.status(201).json({ ok: true, contato: { id, status: "pendente" } });
});

/** POST /api/campaigns/:campaignId/internet/contacts/:id/aceitar|recusar —
 *  somente o DONO da conta DESTINO decide um pedido pendente. */
async function responderContato(req: Request, res: Response, decisao: "aceito" | "remover") {
  const cid = campanhaId(req);
  const [contato] = await db.select().from(internetContacts)
    .where(and(eq(internetContacts.id, req.params.id), eq(internetContacts.campaignId, cid))).limit(1);
  if (!contato) { erroHttp(res, 404, "Contato não encontrado"); return; }
  const auth = await exigirConta(req, res, contato.contaDestinoId);
  if (!auth) return;
  if (contato.status !== "pendente") { erroHttp(res, 409, "Contato não está pendente"); return; }
  const agora = new Date();
  if (decisao === "aceito") {
    await db.update(internetContacts)
      .set({ status: "aceito", respondedAt: agora, updatedAt: agora })
      .where(eq(internetContacts.id, contato.id));
    await audit(req, "internet.contato_aceito", { contatoId: contato.id });
    res.json({ ok: true, status: "aceito" });
  } else {
    await db.delete(internetContacts).where(eq(internetContacts.id, contato.id));
    await audit(req, "internet.contato_recusado", { contatoId: contato.id });
    res.json({ ok: true, status: "removido" });
  }
}
internetRouter.post("/contacts/:id/aceitar", requirePapel("mestre", "jogador"), (req, res) => void responderContato(req, res, "aceito"));
internetRouter.post("/contacts/:id/recusar", requirePapel("mestre", "jogador"), (req, res) => void responderContato(req, res, "remover"));

/** POST /api/campaigns/:campaignId/internet/contacts/:id/bloquear —
 *  P3 (deliberação do proprietário): QUALQUER ponta da aresta pode
 *  iniciar o bloqueio — a direção origem→destino da solicitação não
 *  pode impedir metade dos usuários de bloquear. O iniciador fica
 *  registrado em `bloqueadoPorContaId` para auditoria e para autorizar
 *  a remoção da aresta bloqueada. */
internetRouter.post("/contacts/:id/bloquear", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const [contato] = await db.select().from(internetContacts)
    .where(and(eq(internetContacts.id, req.params.id), eq(internetContacts.campaignId, cid))).limit(1);
  if (!contato) { erroHttp(res, 404, "Contato não encontrado"); return; }
  const authOrigem = await contaAutorizadaPara(contato.contaOrigemId, req.usuario!.id);
  const iniciador = authOrigem ? contato.contaOrigemId
    : (await contaAutorizadaPara(contato.contaDestinoId, req.usuario!.id)) ? contato.contaDestinoId
    : null;
  if (!iniciador) { erroHttp(res, 403, "Conta não autorizada"); return; }
  if (contato.status === "bloqueado") { res.json({ ok: true, status: "bloqueado", replay: true }); return; }
  const agora = new Date();
  await db.update(internetContacts)
    .set({ status: "bloqueado", bloqueadoPorContaId: iniciador, respondedAt: agora, updatedAt: agora })
    .where(eq(internetContacts.id, contato.id));
  await audit(req, "internet.contato_bloqueado", { contatoId: contato.id, iniciadoPor: iniciador });
  res.json({ ok: true, status: "bloqueado" });
});

/** DELETE /api/campaigns/:campaignId/internet/contacts/:id — remove a aresta
 *  (qualquer ponta). Histórico de conversas preservado (P12). */
internetRouter.delete("/contacts/:id", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const [contato] = await db.select().from(internetContacts)
    .where(and(eq(internetContacts.id, req.params.id), eq(internetContacts.campaignId, cid))).limit(1);
  if (!contato) { erroHttp(res, 404, "Contato não encontrado"); return; }
  // P3: aresta `bloqueado` só pode ser removida por QUEM a bloqueou
  // (`bloqueadoPorContaId`; fallback `contaDestinoId` para arestas
  // gravadas antes da coluna existir). Demais status: qualquer ponta.
  if (contato.status === "bloqueado") {
    const quemBloqueou = contato.bloqueadoPorContaId ?? contato.contaDestinoId;
    const okBloqueador = await contaAutorizadaPara(quemBloqueou, req.usuario!.id);
    if (!okBloqueador) { erroHttp(res, 403, "Conta não autorizada"); return; }
  } else {
    const ok1 = await contaAutorizadaPara(contato.contaOrigemId, req.usuario!.id);
    const ok2 = ok1 ? null : await contaAutorizadaPara(contato.contaDestinoId, req.usuario!.id);
    if (!ok1 && !ok2) { erroHttp(res, 403, "Conta não autorizada"); return; }
  }
  await db.delete(internetContacts).where(eq(internetContacts.id, contato.id));
  await audit(req, "internet.contato_removido", { contatoId: contato.id });
  res.json({ ok: true });
});

// ---------- conversas ----------

function conversaPublica(
  c: typeof internetConversations.$inferSelect,
  partes: (typeof internetParticipantes.$inferSelect)[],
  contas: Map<string, ReturnType<typeof contaPublica>>,
) {
  return {
    id: c.id, tipo: c.tipo, nome: c.nome, status: c.status,
    participantes: partes.map((p) => ({
      id: p.id, // id da linha internet_participantes — necessário para
      // POST /participants/:pid/responder (aceite de convite de grupo)
      contaId: p.contaId,
      conta: contas.get(p.contaId) ?? null,
      papel: p.papel, status: p.status,
      lastReadCreatedAt: p.lastReadCreatedAt,
      lastReadMessageId: p.lastReadMessageId,
    })),
    createdAt: c.createdAt,
  };
}

async function carregarConversasDoUsuario(cid: string, userId: string) {
  const minhas = await contasDoUsuario(cid, userId);
  const meuIds = new Set(minhas.map((c) => c.id));
  if (!meuIds.size) return { minhas, meuIds, rows: [] as (typeof internetConversations.$inferSelect)[], partes: [] as (typeof internetParticipantes.$inferSelect)[], contas: new Map<string, ReturnType<typeof contaPublica>>() };
  const partes = await db.select().from(internetParticipantes)
    .where(and(inArray(internetParticipantes.contaId, [...meuIds]), sql`${internetParticipantes.status} != 'saiu'`));
  const conversaIds = [...new Set(partes.map((p) => p.conversaId))];
  const rows = conversaIds.length
    ? await db.select().from(internetConversations)
        .where(and(eq(internetConversations.campaignId, cid), inArray(internetConversations.id, conversaIds)))
    : [];
  // participantes de TODAS as conversas listadas (para exibir o outro lado)
  const todasPartes = conversaIds.length
    ? await db.select().from(internetParticipantes).where(inArray(internetParticipantes.conversaId, conversaIds))
    : [];
  const contaIds = [...new Set(todasPartes.map((p) => p.contaId))];
  const contasRows = contaIds.length ? await db.select().from(internetAccounts).where(inArray(internetAccounts.id, contaIds)) : [];
  return {
    minhas, meuIds, rows, partes: todasPartes,
    contas: new Map(contasRows.map((c) => [c.id, contaPublica(c)])),
  };
}

/** GET /api/campaigns/:campaignId/internet/conversations — minhas conversas. */
internetRouter.get("/conversations", requirePapel("mestre", "jogador"), async (req, res) => {
  const { rows, partes, contas, meuIds } = await carregarConversasDoUsuario(campanhaId(req), req.usuario!.id);
  res.json({
    conversas: rows.map((c) => {
      const partesConv = partes.filter((p) => p.conversaId === c.id);
      const meu = partesConv.find((p) => meuIds.has(p.contaId));
      return {
        ...conversaPublica(c, partesConv, contas),
        meuContaId: meu?.contaId ?? null,
        meuPapel: meu?.papel ?? null,
        meuStatus: meu?.status ?? null,
      };
    }),
  });
});

const criarConversaSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("direta"),
    contaDestinoId: z.string().min(1),
    origemContaId: z.string().min(1).optional(),
  }).strict(),
  z.object({
    tipo: z.literal("grupo"),
    nome: z.string().trim().max(80).optional(),
    origemContaId: z.string().min(1),
    contaIds: z.array(z.string().min(1)).min(1).max(50),
  }).strict(),
]);

/** POST /api/campaigns/:campaignId/internet/conversations — cria direta
 *  (parKey único resolve concorrência) ou grupo (dono = criador; demais
 *  nascem `convidado`). Exige contato aceito com cada convidado (P4) e
 *  ausência de bloqueio bilateral (P3). */
internetRouter.post("/conversations", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = criarConversaSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }
  const resolvido = await resolverOrigem(req, res, body.data.origemContaId, cid);
  if (!resolvido) return;
  const { origem } = resolvido;
  const agora = new Date();

  if (body.data.tipo === "direta") {
    const [destino] = await db.select().from(internetAccounts)
      .where(and(eq(internetAccounts.id, body.data.contaDestinoId), eq(internetAccounts.campaignId, cid), eq(internetAccounts.status, "ativa"))).limit(1);
    if (!destino) { erroHttp(res, 404, "Conta não encontrada"); return; }
    if (destino.id === origem.id) { erroHttp(res, 400, "Conversa direta exige outro participante"); return; }
    const parKey = [origem.id, destino.id].sort().join("|");
    const [existente] = await db.select().from(internetConversations)
      .where(and(eq(internetConversations.campaignId, cid), eq(internetConversations.parKey, parKey))).limit(1);
    if (existente) {
      // replay: reativa minha participação se eu tinha saído
      const meu = await participanteDaConta(existente.id, origem.id);
      if (meu?.status === "saiu") {
        await db.update(internetParticipantes)
          .set({ status: "ativo", saiuEm: null, decididoEm: agora, updatedAt: agora })
          .where(eq(internetParticipantes.id, meu.id));
      }
      res.json({ ok: true, conversa: existente.id, replay: true }); return;
    }
    if (!(await contatoAceitoEntre(db, cid, origem.id, destino.id))) {
      erroHttp(res, 403, "Contato não aceito"); return;
    }
    if (await contatoBloqueadoEntre(db, cid, origem.id, destino.id)) {
      erroHttp(res, 403, "Contato bloqueado"); return;
    }
    const cidConv = crypto.randomUUID();
    try {
      // better-sqlite3: transaction é SÍNCRONA — inserts via .run()
      db.transaction((tx) => {
        tx.insert(internetConversations).values({
          id: cidConv, campaignId: cid, tipo: "direta", parKey,
          status: "ativa", createdByContaId: origem.id, createdAt: agora, updatedAt: agora,
        }).run();
        tx.insert(internetParticipantes).values([
          { id: crypto.randomUUID(), conversaId: cidConv, contaId: origem.id, papel: "dono", status: "ativo", convidadoEm: agora, decididoEm: agora, createdAt: agora, updatedAt: agora },
          { id: crypto.randomUUID(), conversaId: cidConv, contaId: destino.id, papel: "membro", status: "ativo", convidadoPorContaId: origem.id, convidadoEm: agora, decididoEm: agora, createdAt: agora, updatedAt: agora },
        ]).run();
      });
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        const [conv] = await db.select().from(internetConversations)
          .where(and(eq(internetConversations.campaignId, cid), eq(internetConversations.parKey, parKey))).limit(1);
        res.json({ ok: true, conversa: conv?.id, replay: true }); return;
      }
      throw e;
    }
    await audit(req, "internet.conversa_criada", { conversaId: cidConv, tipo: "direta" });
    res.status(201).json({ ok: true, conversa: cidConv });
    return;
  }

  // grupo — P4: contato aceito + sem bloqueio com CADA convidado, dentro da tx
  const dadosGrupo = body.data; // narrowing fora do closure da tx
  const contaIds = [...new Set(dadosGrupo.contaIds)].filter((x) => x !== origem.id);
  if (!contaIds.length) { erroHttp(res, 400, "Grupo exige ao menos um convidado"); return; }
  const contas = await db.select().from(internetAccounts)
    .where(and(eq(internetAccounts.campaignId, cid), inArray(internetAccounts.id, contaIds), eq(internetAccounts.status, "ativa")));
  if (contas.length !== contaIds.length) { erroHttp(res, 404, "Conta não encontrada"); return; }
  // P4/P3 — checagens assíncronas ANTES da tx síncrona do better-sqlite3
  for (const alvoId of contaIds) {
    if (!(await contatoAceitoEntre(db, cid, origem.id, alvoId))) {
      erroHttp(res, 403, "Contato não aceito", { contaId: alvoId }); return;
    }
    if (await contatoBloqueadoEntre(db, cid, origem.id, alvoId)) {
      erroHttp(res, 403, "Contato bloqueado", { contaId: alvoId }); return;
    }
  }
  const cidConv = crypto.randomUUID();
  db.transaction((tx) => {
    tx.insert(internetConversations).values({
      id: cidConv, campaignId: cid, tipo: "grupo",
      nome: dadosGrupo.nome ?? null, status: "ativa",
      createdByContaId: origem.id, createdAt: agora, updatedAt: agora,
    }).run();
    tx.insert(internetParticipantes).values([
      { id: crypto.randomUUID(), conversaId: cidConv, contaId: origem.id, papel: "dono", status: "ativo", convidadoEm: agora, decididoEm: agora, createdAt: agora, updatedAt: agora },
      ...contaIds.map((contaId) => ({
        id: crypto.randomUUID(), conversaId: cidConv, contaId, papel: "membro",
        status: "convidado", convidadoPorContaId: origem.id, convidadoEm: agora,
        createdAt: agora, updatedAt: agora,
      })),
    ]).run();
  });
  await audit(req, "internet.conversa_criada", { conversaId: cidConv, tipo: "grupo", convidados: contaIds.length });
  res.status(201).json({ ok: true, conversa: cidConv });
});

/** GET /api/campaigns/:campaignId/internet/conversations/:id — detalhe. */
internetRouter.get("/conversations/:id", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const [conversa] = await db.select().from(internetConversations)
    .where(and(eq(internetConversations.id, req.params.id), eq(internetConversations.campaignId, cid))).limit(1);
  if (!conversa) { erroHttp(res, 404, "Conversa não encontrada"); return; }
  // mesmo gate do histórico: participante ativo da conta autorizada,
  // ou mestre da campanha (P10 — leitura auditada). `convidado` também
  // lê o detalhe — precisa ver o convite para aceitar/recusar; o
  // histórico de mensagens segue restrito a `ativo`. Sem gate, o
  // endpoint vazaria composição e cursores de leitura de terceiros.
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  let autorizado = false;
  for (const conta of minhas) {
    const parte = await participanteDaConta(conversa.id, conta.id);
    if (parte && (parte.status === "ativo" || parte.status === "convidado")
      && await contaAutorizadaPara(conta.id, req.usuario!.id)) {
      autorizado = true; break;
    }
  }
  const leituraMestre = !autorizado && await mestreLeitorDaCampanha(cid, req.usuario!.id);
  if (!autorizado && !leituraMestre) { erroHttp(res, 403, "Sem acesso à conversa"); return; }
  if (leituraMestre) {
    await audit(req, "internet.leitura_mestre", {
      conversaId: conversa.id, operacao: "detalhe",
    });
  }
  const partes = await db.select().from(internetParticipantes).where(eq(internetParticipantes.conversaId, conversa.id));
  const contaIds = [...new Set(partes.map((p) => p.contaId))];
  const contasRows = contaIds.length ? await db.select().from(internetAccounts).where(inArray(internetAccounts.id, contaIds)) : [];
  const contas = new Map(contasRows.map((c) => [c.id, contaPublica(c)]));
  res.json({ conversa: conversaPublica(conversa, partes, contas) });
});

/** GET /api/campaigns/:campaignId/internet/conversations/:id/messages?cursor&limit
 *  — histórico keyset (createdAt,id). Participante ativo OU mestre da
 *  campanha (P10: leitura auditada, somente leitura). */
internetRouter.get("/conversations/:id/messages", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const [conversa] = await db.select().from(internetConversations)
    .where(and(eq(internetConversations.id, req.params.id), eq(internetConversations.campaignId, cid))).limit(1);
  if (!conversa) { erroHttp(res, 404, "Conversa não encontrada"); return; }

  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  // TODAS as contas do usuário que são participantes ativos autorizados
  // — o filtro par-a-par do histórico é por conta leitora (multi-personagem).
  const leitoraIds: string[] = [];
  for (const conta of minhas) {
    if (await participanteAtivo(conversa.id, conta.id)
      && await contaAutorizadaPara(conta.id, req.usuario!.id)) {
      leitoraIds.push(conta.id);
    }
  }
  const autorizado = leitoraIds.length > 0;
  const leituraMestre = !autorizado && await mestreLeitorDaCampanha(cid, req.usuario!.id);
  if (!autorizado && !leituraMestre) { erroHttp(res, 403, "Sem acesso à conversa"); return; }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const cursor = typeof req.query.cursor === "string" ? decodificarCursor(req.query.cursor) : null;
  if (typeof req.query.cursor === "string" && !cursor) { erroHttp(res, 400, "Cursor inválido"); return; }

  const conds = [eq(internetMessages.conversaId, conversa.id)];
  if (cursor) {
    conds.push(or(
      gt(internetMessages.createdAt, cursor.createdAt),
      and(eq(internetMessages.createdAt, cursor.createdAt), gt(internetMessages.id, cursor.messageId)),
    )!);
  }
  const rows = await db.select().from(internetMessages)
    .where(and(...conds))
    .orderBy(internetMessages.createdAt, internetMessages.id)
    .limit(limit + 1);
  // P3 par-a-par com corte temporal: mensagem é ocultada do leitor
  // somente se TODAS as suas contas leitoras têm aresta `bloqueado`
  // contra o autor com marco ANTERIOR ao createdAt da mensagem.
  // Pré-bloqueio permanece visível (P12); leitura mestre P10 não filtra.
  const janela = rows.slice(0, limit);
  // P3 par-a-par com corte temporal: mensagem é ocultada do leitor
  // somente se TODAS as suas contas leitoras têm aresta `bloqueado`
  // contra o autor com marco ANTERIOR ao createdAt da mensagem.
  // Pré-bloqueio permanece visível (P12); leitura mestre P10 não filtra.
  // O filtro incide só na janela — o cursor avança pelo raw, sem
  // reexpor nem pular mensagens visíveis nas páginas seguintes.
  let pagina = janela;
  if (autorizado) {
    const bloqueios = await bloqueiosEntreContas(cid, leitoraIds);
    pagina = janela.filter((m) => {
      const t = m.createdAt;
      for (const rid of leitoraIds) {
        const corte = bloqueios.get(rid)?.get(m.autorContaId);
        if (!corte || t <= corte) return true;
      }
      return false;
    });
  }
  const temMais = rows.length > limit;
  const proximoCursor = temMais && janela.length
    ? codificarCursor(janela[janela.length - 1].createdAt, janela[janela.length - 1].id)
    : null;

  const autorIds = [...new Set(pagina.map((m) => m.autorContaId))];
  const autores = autorIds.length
    ? await db.select({ id: internetAccounts.id, handle: internetAccounts.handle, displayName: internetAccounts.displayName })
        .from(internetAccounts).where(inArray(internetAccounts.id, autorIds))
    : [];
  const autorPorId = new Map(autores.map((a) => [a.id, a]));

  if (leituraMestre) {
    // P10 — leitura privilegiada auditada (ator, campanha, conversa,
    // momento, operação). ADMIN global não passa: só role mestre.
    await audit(req, "internet.leitura_mestre", {
      conversaId: conversa.id, operacao: "historico", pagina: pagina.length,
    });
  }

  res.json({
    mensagens: pagina.map((m) => ({
      id: m.id, conversaId: m.conversaId, contaId: m.autorContaId,
      autor: autorPorId.get(m.autorContaId) ?? null,
      conteudo: m.conteudo, createdAt: m.createdAt,
    })),
    proximoCursor,
    leituraMestre,
  });
});

/** POST /api/campaigns/:campaignId/internet/conversations/:id/read —
 *  marca leitura: avança o cursor do participante (monotônico).
 *  Idempotente. */
internetRouter.post("/conversations/:id/read", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = z.object({
    contaId: z.string().min(1),
    ateCreatedAt: z.number().int().positive(),
    ateMessageId: z.string().min(1),
  }).strict().safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const auth = await exigirConta(req, res, body.data.contaId);
  if (!auth) return;
  const [conversa] = await db.select().from(internetConversations)
    .where(and(eq(internetConversations.id, req.params.id), eq(internetConversations.campaignId, cid))).limit(1);
  if (!conversa) { erroHttp(res, 404, "Conversa não encontrada"); return; }
  const parte = await participanteAtivo(conversa.id, body.data.contaId);
  if (!parte) { erroHttp(res, 403, "Não participante"); return; }
  // o cursor só pode apontar para mensagem REAL desta conversa — e o
  // createdAt autoritativo é o da própria mensagem (o cliente informa
  // a tupla, mas nunca forja o timestamp persistido).
  const [msgCursor] = await db.select({ id: internetMessages.id, createdAt: internetMessages.createdAt }).from(internetMessages)
    .where(and(eq(internetMessages.id, body.data.ateMessageId), eq(internetMessages.conversaId, conversa.id))).limit(1);
  if (!msgCursor) { erroHttp(res, 400, "Mensagem de cursor inválida"); return; }
  const novo = msgCursor.createdAt;
  const atual = parte.lastReadCreatedAt?.getTime() ?? 0;
  if (novo.getTime() <= atual) { res.json({ ok: true, replay: true }); return; }
  await db.update(internetParticipantes).set({
    lastReadCreatedAt: novo, lastReadMessageId: body.data.ateMessageId, updatedAt: new Date(),
  }).where(eq(internetParticipantes.id, parte.id));
  res.json({ ok: true });
});

/** POST /api/campaigns/:campaignId/internet/conversations/:id/participants —
 *  convite para grupo: somente o DONO ativo; alvo precisa de contato
 *  aceito com o dono e não pode estar bloqueado (P4/P3). */
internetRouter.post("/conversations/:id/participants", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = contatoBodySchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const [conversa] = await db.select().from(internetConversations)
    .where(and(eq(internetConversations.id, req.params.id), eq(internetConversations.campaignId, cid), eq(internetConversations.tipo, "grupo"))).limit(1);
  if (!conversa) { erroHttp(res, 404, "Conversa não encontrada"); return; }
  const resolvido = await resolverOrigem(req, res, body.data.origemContaId, cid);
  if (!resolvido) return;
  const { origem } = resolvido;
  const meu = await participanteDaConta(conversa.id, origem.id);
  if (!meu || meu.status !== "ativo" || meu.papel !== "dono") {
    erroHttp(res, 403, "Somente o dono convida"); return;
  }
  const [alvo] = await db.select().from(internetAccounts)
    .where(and(eq(internetAccounts.id, body.data.contaId), eq(internetAccounts.campaignId, cid), eq(internetAccounts.status, "ativa"))).limit(1);
  if (!alvo) { erroHttp(res, 404, "Conta não encontrada"); return; }
  if (!(await contatoAceitoEntre(db, cid, origem.id, alvo.id))) {
    erroHttp(res, 403, "Contato não aceito"); return;
  }
  if (await contatoBloqueadoEntre(db, cid, origem.id, alvo.id)) {
    erroHttp(res, 403, "Contato bloqueado"); return;
  }
  const existente = await participanteDaConta(conversa.id, alvo.id);
  const agora = new Date();
  if (existente) {
    // reconvite: reativação transacional preservando a linha + trilha em audit
    if (existente.status === "saiu" || existente.status === "recusado" || existente.status === "cancelado") {
      await db.update(internetParticipantes).set({
        status: "convidado", papel: "membro", convidadoPorContaId: origem.id,
        convidadoEm: agora, decididoEm: null, saiuEm: null, updatedAt: agora,
      }).where(eq(internetParticipantes.id, existente.id));
      await audit(req, "internet.convite_reenviado", { conversaId: conversa.id, contaId: alvo.id });
      res.json({ ok: true, status: "convidado", replay: true }); return;
    }
    res.json({ ok: true, status: existente.status, replay: true }); return;
  }
  await db.insert(internetParticipantes).values({
    id: crypto.randomUUID(), conversaId: conversa.id, contaId: alvo.id,
    papel: "membro", status: "convidado", convidadoPorContaId: origem.id,
    convidadoEm: agora, createdAt: agora, updatedAt: agora,
  });
  await audit(req, "internet.convite_enviado", { conversaId: conversa.id, contaId: alvo.id });
  res.status(201).json({ ok: true, status: "convidado" });
});

/** POST /api/campaigns/:campaignId/internet/conversations/:id/participants/:pid/responder
 *  — o INVITADO aceita (→ativo) ou recusa (→recusado). */
internetRouter.post("/conversations/:id/participants/:pid/responder", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = z.object({ aceitar: z.boolean() }).strict().safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const [parte] = await db.select().from(internetParticipantes)
    .where(and(eq(internetParticipantes.id, req.params.pid), eq(internetParticipantes.conversaId, req.params.id))).limit(1);
  if (!parte) { erroHttp(res, 404, "Convite não encontrado"); return; }
  const auth = await exigirConta(req, res, parte.contaId);
  if (!auth) return;
  if (parte.status !== "convidado") { erroHttp(res, 409, "Convite já respondido"); return; }
  const agora = new Date();
  await db.update(internetParticipantes).set({
    status: body.data.aceitar ? "ativo" : "recusado",
    decididoEm: agora, updatedAt: agora,
  }).where(eq(internetParticipantes.id, parte.id));
  await audit(req, body.data.aceitar ? "internet.convite_aceito" : "internet.convite_recusado",
    { conversaId: req.params.id, contaId: parte.contaId });
  res.json({ ok: true, status: body.data.aceitar ? "ativo" : "recusado" });
});

/** POST /api/campaigns/:campaignId/internet/conversations/:id/leave — sai da
 *  conversa. P6: se o DONO de grupo sai, a propriedade é transferida para
 *  outro membro elegível (contaAutorizadaPara); sem sucessor, o grupo é
 *  arquivado. Direta: status saiu (reversível via POST /conversations). */
internetRouter.post("/conversations/:id/leave", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = z.object({ contaId: z.string().min(1) }).strict().safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const auth = await exigirConta(req, res, body.data.contaId);
  if (!auth) return;
  const [conversa] = await db.select().from(internetConversations)
    .where(and(eq(internetConversations.id, req.params.id), eq(internetConversations.campaignId, cid))).limit(1);
  if (!conversa) { erroHttp(res, 404, "Conversa não encontrada"); return; }
  const parte = await participanteAtivo(conversa.id, body.data.contaId);
  if (!parte) { erroHttp(res, 403, "Não participante ativo"); return; }
  const agora = new Date();

  if (conversa.tipo === "grupo" && parte.papel === "dono") {
    // P6 — sucessor elegível: membro ativo ≠ quem sai E contaAutorizadaPara
    const candidatos = await db.select().from(internetParticipantes)
      .where(and(
        eq(internetParticipantes.conversaId, conversa.id),
        eq(internetParticipantes.status, "ativo"),
        sql`${internetParticipantes.contaId} != ${body.data.contaId}`,
      ));
    let sucessorId: string | null = null;
    for (const cand of candidatos) {
      // resolve o dono atual da conta candidata e revalida o gate inteiro
      const [donoCand] = await db.select({ userId: memberships.userId }).from(internetAccounts)
        .innerJoin(characters, eq(internetAccounts.characterId, characters.id))
        .innerJoin(memberships, eq(characters.membershipId, memberships.id))
        .where(and(eq(internetAccounts.id, cand.contaId), eq(memberships.status, "ativo"))).limit(1);
      if (donoCand && await contaAutorizadaPara(cand.contaId, donoCand.userId)) {
        sucessorId = cand.id; break;
      }
    }
    if (sucessorId) {
      await db.update(internetParticipantes).set({ papel: "dono", updatedAt: agora })
        .where(eq(internetParticipantes.id, sucessorId));
      await audit(req, "internet.grupo_propriedade_transferida", {
        conversaId: conversa.id, de: body.data.contaId, para: candidatos.find((c) => c.id === sucessorId)?.contaId,
      });
    } else {
      // sem sucessor elegível: arquiva o grupo (P6 — nunca deixa dono inelegível)
      await db.update(internetConversations).set({ status: "arquivada", updatedAt: agora })
        .where(eq(internetConversations.id, conversa.id));
      await audit(req, "internet.grupo_arquivado_sem_sucessor", { conversaId: conversa.id });
    }
  }

  await db.update(internetParticipantes).set({ status: "saiu", saiuEm: agora, updatedAt: agora })
    .where(eq(internetParticipantes.id, parte.id));
  await audit(req, "internet.participante_saiu", { conversaId: conversa.id, contaId: body.data.contaId });
  res.json({ ok: true });
});

vincularLeaseAoHandler(internetRouter);
