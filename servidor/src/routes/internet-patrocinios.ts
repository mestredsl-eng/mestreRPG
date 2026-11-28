// Internet pública 1.1.2 — patrocínio automático (veredito Dono
// 7232130363, modo AUTOMÁTICO; contrato PAI 7232312933; threat model
// INTERMEDIÁRIO M13–M23/M34–M45).
//
// Regras:
//  - Acordo é entidade própria (`internet_patrocinios`): partes,
//    campanha única, valor em centavos inteiros, condição de
//    liquidação verificável server-side e estado. A liquidação NÃO
//    cria economia paralela — gera as duas pernas em
//    `money_transactions` + updates de `financial_accounts` na MESMA
//    db.transaction do CAS de estado (padrão provado de
//    patrimonio.ts /financeiro/transferir, kind='pix_ficticio').
//  - Tudo server-derived: pagador = personagem do requisitante
//    titular da conta Internet; beneficiário = characterId com conta
//    Internet ativa na mesma campanha; contas financeiras validadas
//    por titular+campanha; valor = amountCents inteiro > 0.
//  - Consentimento bilateral: propor ≠ aceitar; aceite é endpoint
//    separado do titular do beneficiário; acordo aceito é imutável
//    (não há PATCH — renegociação = novo acordo, M35).
//  - Idempotência: propostaRequestId UNIQUE por campanha (replay
//    devolve o acordo); liquidação com requestId base por perna
//    (`patrocinios:<id>:out|:in`) + CAS `estado='aceito'` → retry ou
//    gatilho duplo nunca duplica pagamento (M15/M36/M39).
//  - Condições aceitas no 1.1.2: `imediato` e `data_alvo` — as únicas
//    prováveis pelo servidor hoje. `metrica_publicacao` fica
//    reservada no schema mas rejeitada na API até a fatia de
//    métricas existir (M35b — nada de condição não-verificável).
//  - Liquidação: gatilho primário = sweep server-side de 60s
//    (`processarLiquidacoesPendentes`, index.ts — decisão TG #401);
//    belt-and-suspenders = tentativa lazy na tx do aceite
//    (`imediato`) e em leituras dos próprios acordos (`aceito` +
//    condição satisfeita + não expirado). O gancho por evento entra
//    junto com a fatia de métricas.
//  - Visibilidade: contrato privado entre as partes — nunca entra
//    em feed/busca pública; detalhe só para titular de qualquer lado.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  auditLogs, characters, financialAccounts, internetAccounts,
  internetPatrocinios, moneyTransactions,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { carregarRegras, carregarRegrasSincrono } from "../lib/regras.js";
import {
  contaAutorizadaPara, contasDoUsuario,
} from "../lib/conta-internet.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";

const db = getDb();
export const internetPatrociniosRouter = Router({ mergeParams: true });
internetPatrociniosRouter.use(requireAuth);

const campanhaId = (req: Request) => req.params.campaignId as string;

function erroHttp(res: Response, status: number, erro: string) {
  res.status(status).json({ erro });
}

const limitePatrocinios = limiteUsuario({ nome: "internet-patrocinios", janelaMs: 60_000, max: 60 });

type Acordo = typeof internetPatrocinios.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const condicaoSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("imediato") }),
  z.object({
    tipo: z.literal("data_alvo"),
    em: z.string().datetime({ offset: true }),
  }),
]);

const proporSchema = z.object({
  characterId: z.string().min(1),          // personagem pagador (titular do requisitante)
  beneficiarioCharacterId: z.string().min(1),
  pagadorAccountId: z.string().min(1),     // conta financeira de origem (do pagador)
  amountCents: z.number().int().positive().max(2_000_000_000), // centavos, > 0
  condicao: condicaoSchema,
  expiresAt: z.string().datetime({ offset: true }).optional(),
  requestId: z.string().min(8).max(120).optional(),
}).strict();

const aceitarSchema = z.object({
  beneficiarioAccountId: z.string().min(1), // conta de recebimento (do beneficiário)
  requestId: z.string().min(8).max(120).optional(),
}).strict();

/** Conta Internet do personagem na campanha (mesma resolução de
 *  internet-perfis.ts: personagem → conta ativa → titular). */
async function contaAtivaDoPersonagem(cid: string, characterId: string) {
  const [conta] = await db.select().from(internetAccounts)
    .where(and(
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.characterId, characterId),
      eq(internetAccounts.status, "ativa"),
    )).limit(1);
  return conta ?? null;
}

/** Autorização de escrita do personagem: o requisitante precisa ser
 *  titular atual da conta Internet do personagem (gate cumulativo —
 *  mestre não propõe/aceita/cancela em nome de jogador). */
async function titularDoPersonagem(
  cid: string, characterId: string, userId: string,
): Promise<{ conta: typeof internetAccounts.$inferSelect; personagem: typeof characters.$inferSelect } | null> {
  const conta = await contaAtivaDoPersonagem(cid, characterId);
  if (!conta) return null;
  const auth = await contaAutorizadaPara(conta.id, userId);
  if (!auth) return null;
  const [personagem] = await db.select().from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!personagem) return null;
  return { conta, personagem };
}

/** Acordo só é visível às partes (M34 — IDOR devolve 404 uniforme). */
function acordoDasPartes(acordo: Acordo, ids: Set<string>): boolean {
  return ids.has(acordo.pagadorCharacterId) || ids.has(acordo.beneficiarioCharacterId);
}

async function personagemIdsDoUsuario(cid: string, userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const conta of await contasDoUsuario(cid, userId)) {
    const auth = await contaAutorizadaPara(conta.id, userId);
    if (auth?.conta.characterId) ids.add(auth.conta.characterId);
  }
  return ids;
}

function serializar(acordo: Acordo, agora = new Date()) {
  // Dono #401: expiresAt só limita a PROPOSTA (janela de aceite).
  // Acordo já aceito bilateralmente NUNCA aparece "expirado" —
  // data_alvo segue liquidável no momento-alvo.
  const expirado = acordo.estado === "proposto"
    && !!acordo.expiresAt && acordo.expiresAt.getTime() <= agora.getTime();
  return {
    id: acordo.id,
    estado: expirado ? "expirado" : acordo.estado,
    estadoReal: acordo.estado,
    proponenteCharacterId: acordo.proponenteCharacterId,
    pagadorCharacterId: acordo.pagadorCharacterId,
    beneficiarioCharacterId: acordo.beneficiarioCharacterId,
    amountCents: acordo.amountCents,
    currency: acordo.currency,
    condicaoTipo: acordo.condicaoTipo,
    condicao: acordo.condicaoJson,
    expiresAt: acordo.expiresAt ? acordo.expiresAt.toISOString() : null,
    propostoEm: acordo.propostoEm.toISOString(),
    aceitoEm: acordo.aceitoEm ? acordo.aceitoEm.toISOString() : null,
    canceladoEm: acordo.canceladoEm ? acordo.canceladoEm.toISOString() : null,
    liquidadoEm: acordo.liquidadoEm ? acordo.liquidadoEm.toISOString() : null,
    falhaMotivo: acordo.falhaMotivo,
    criadoEm: acordo.createdAt.toISOString(),
  };
}

function auditTx(tx: Tx, userId: string | undefined, cid: string, action: string, detail: Record<string, unknown>) {
  tx.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: userId ?? null,
    campaignId: cid,
    guildId: null,
    action,
    detail,
    createdAt: new Date(),
  }).run();
}

/** Condição satisfeita? `imediato` sempre; `data_alvo` quando now>=em.
 *  Dono #401 (adjudicação TG 7233180172): expiresAt NÃO entra aqui —
 *  ele só limita a proposta não aceita (gate no POST /aceitar).
 *  Depois do aceite bilateral, data_alvo liquida no momento-alvo
 *  mesmo com expiresAt vencido. */
function condicaoSatisfeita(acordo: Acordo, agora: Date): boolean {
  const c = acordo.condicaoJson as { tipo?: string; em?: string };
  if (acordo.condicaoTipo === "imediato") return true;
  if (acordo.condicaoTipo === "data_alvo" && c.em) {
    const alvo = Date.parse(c.em);
    return Number.isFinite(alvo) && agora.getTime() >= alvo;
  }
  return false; // tipo desconhecido/reservado → fail-closed
}

/** Liquidação atômica de UM acordo (M16/M36/M40): re-lê tudo dentro da
 *  tx, CAS de estado, pernas financeiras idempotentes, audit na mesma
 *  tx. Saldo insuficiente → `falha_liquidacao` sem débito órfão (M42).
 *  Retorna true se liquidou nesta chamada. */
function liquidarAcordoTx(tx: Tx, acordo: Acordo, userId: string | undefined, cid: string, agora: Date): boolean {
  if (acordo.estado !== "aceito") return false;
  if (!condicaoSatisfeita(acordo, agora)) return false;

  const [pagadorConta] = tx.select().from(financialAccounts)
    .where(eq(financialAccounts.id, acordo.pagadorAccountId)).limit(1).all();
  const [beneficiarioConta] = acordo.beneficiarioAccountId
    ? tx.select().from(financialAccounts)
        .where(eq(financialAccounts.id, acordo.beneficiarioAccountId)).limit(1).all()
    : [undefined];
  if (!pagadorConta || !beneficiarioConta) throw new Error("conta_sumiu");
  if (pagadorConta.campaignId !== cid || beneficiarioConta.campaignId !== cid) throw new Error("conta_fora_campanha");
  if (pagadorConta.currency !== beneficiarioConta.currency || pagadorConta.currency !== acordo.currency) {
    throw new Error("moedas_divergentes");
  }
  // Personagem arquivado é somente leitura (mesma regra da rota
  // canônica de transferência). Morto RECEBE — patrimônio persiste;
  // herança é regra da campanha, fora do escopo (contrato §7).
  const charIds = [acordo.pagadorCharacterId, acordo.beneficiarioCharacterId];
  const arquivados = tx.select({ id: characters.id }).from(characters)
    .where(and(inArray(characters.id, charIds), eq(characters.status, "arquivado"))).all();
  if (arquivados.length) {
    // terminal? não — acordo volta a poder liquidar se o char for
    // restaurado; registra falha transitória sem débito.
    tx.update(internetPatrocinios).set({ falhaMotivo: "personagem_arquivado", updatedAt: agora })
      .where(and(eq(internetPatrocinios.id, acordo.id), eq(internetPatrocinios.estado, "aceito"))).run();
    return false;
  }

  // Leitura dentro da tx (mesma disciplina da rota canônica): regras
  // vigentes no momento da liquidação, nunca cache.
  const regrasTx = carregarRegrasSincrono(tx, cid);
  const permitirNegativo = regrasTx?.config?.financeiro?.permitirSaldoNegativo ?? false;
  const pisoOrigem = permitirNegativo ? -Infinity
    : -(pagadorConta.type === "cartao_credito" ? (pagadorConta.creditLimitCents ?? 0) : 0);
  const novoPagador = pagadorConta.balanceCents - acordo.amountCents;
  const novoBeneficiario = beneficiarioConta.balanceCents + acordo.amountCents;

  if (novoPagador < pisoOrigem) {
    // M42: falha registrada, estado terminal de liquidação, zero débito.
    tx.update(internetPatrocinios).set({
      estado: "falha_liquidacao", falhaMotivo: "saldo_insuficiente",
      liquidadoEm: null, updatedAt: agora,
    }).where(and(eq(internetPatrocinios.id, acordo.id), eq(internetPatrocinios.estado, "aceito"))).run();
    auditTx(tx, userId, cid, "patrocinio.falha_liquidacao", {
      acordoId: acordo.id, motivo: "saldo_insuficiente", amountCents: acordo.amountCents,
    });
    return false;
  }

  // CAS: só um gatilho vence aceito→liquidado (M36). Quem perder faz
  // rollback da tx inteira — pernas nunca duplicam.
  const cas = tx.update(internetPatrocinios).set({
    estado: "liquidado", liquidadoEm: agora, falhaMotivo: null, updatedAt: agora,
  }).where(and(eq(internetPatrocinios.id, acordo.id), eq(internetPatrocinios.estado, "aceito"))).run();
  if (cas.changes === 0) throw new Error("estado_divergente");

  const baseReq = acordo.liquidacaoRequestId ?? `patrocinios:${acordo.id}`;
  const descricao = `Patrocínio ${acordo.id}`;
  const agoraDate = new Date();
  // Perna de saída (débito do pagador)
  tx.insert(moneyTransactions).values({
    id: crypto.randomUUID(), characterId: pagadorConta.characterId, campaignId: cid,
    kind: "pix_ficticio", amount: -acordo.amountCents / 100, currency: pagadorConta.currency,
    account: pagadorConta.type, accountId: pagadorConta.id,
    amountCents: -acordo.amountCents,
    balanceBeforeCents: pagadorConta.balanceCents, balanceAfterCents: novoPagador,
    counterpartyCharacterId: acordo.beneficiarioCharacterId,
    counterparty: beneficiarioConta.name ?? null,
    description: descricao, requestId: `${baseReq}:out`,
    operacao: { acordoId: acordo.id },
    createdBy: userId ?? null, createdAt: agoraDate,
  }).run();
  tx.update(financialAccounts).set({ balanceCents: novoPagador, updatedAt: agora })
    .where(eq(financialAccounts.id, pagadorConta.id)).run();
  // Perna de entrada (crédito do beneficiário)
  tx.insert(moneyTransactions).values({
    id: crypto.randomUUID(), characterId: beneficiarioConta.characterId, campaignId: cid,
    kind: "pix_ficticio", amount: acordo.amountCents / 100, currency: beneficiarioConta.currency,
    account: beneficiarioConta.type, accountId: beneficiarioConta.id,
    amountCents: acordo.amountCents,
    balanceBeforeCents: beneficiarioConta.balanceCents, balanceAfterCents: novoBeneficiario,
    counterpartyCharacterId: acordo.pagadorCharacterId,
    counterparty: pagadorConta.name ?? null,
    description: descricao, requestId: `${baseReq}:in`,
    operacao: { acordoId: acordo.id },
    createdBy: userId ?? null, createdAt: agoraDate,
  }).run();
  tx.update(financialAccounts).set({ balanceCents: novoBeneficiario, updatedAt: agora })
    .where(eq(financialAccounts.id, beneficiarioConta.id)).run();

  auditTx(tx, userId, cid, "patrocinio.liquidar", {
    acordoId: acordo.id, pagador: acordo.pagadorCharacterId,
    beneficiario: acordo.beneficiarioCharacterId, amountCents: acordo.amountCents,
    requestId: baseReq,
  });
  return true;
}

/** TG adjudicação #401: sweeper server-side — gatilho PRIMÁRIO de
 *  liquidação `data_alvo` (lazy-on-read não cumpre a letra do
 *  veredito Dono). Seleciona acordos `aceito` e, para cada um com
 *  condição satisfeita, abre tx própria RELENDO o acordo (nunca
 *  objeto stale) e delega a `liquidarAcordoTx` — CAS
 *  `aceito→liquidado` + requestId por perna tornam a corrida com
 *  aceite/GET serializável e idempotente. Erros por acordo são
 *  engolidos (transitórios retentam no próximo sweep); o evento
 *  `patrimonio:atualizado` sai uma vez por campanha liquidada. */
export async function processarLiquidacoesPendentes(): Promise<number> {
  const agora = new Date();
  const pendentes = await db.select().from(internetPatrocinios)
    .where(eq(internetPatrocinios.estado, "aceito"));
  const campanhas = new Set<string>();
  for (const a of pendentes) {
    if (!condicaoSatisfeita(a, agora)) continue;
    try {
      const resultado = db.transaction((tx): boolean => {
        const [fresco] = tx.select().from(internetPatrocinios)
          .where(eq(internetPatrocinios.id, a.id)).limit(1).all();
        if (!fresco) return false;
        return liquidarAcordoTx(tx, fresco, undefined, a.campaignId, new Date());
      });
      if (resultado) campanhas.add(a.campaignId);
    } catch { /* falha transitória/corrida — próximo sweep retenta */ }
  }
  for (const cid of campanhas) emitirCampanha(cid, "patrimonio:atualizado", {});
  return campanhas.size;
}

/** POST /patrocinios — propor acordo (só o titular do pagador). */
internetPatrociniosRouter.post("/patrocinios", limitePatrocinios, async (req, res) => {
  const cid = campanhaId(req);
  const body = proporSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const b = body.data;
  if (b.characterId === b.beneficiarioCharacterId) { erroHttp(res, 400, "Pagador e beneficiário iguais"); return; }

  // Replay idempotente: mesmo requestId na campanha → devolve o acordo.
  if (b.requestId) {
    const [existente] = await db.select().from(internetPatrocinios)
      .where(and(eq(internetPatrocinios.campaignId, cid), eq(internetPatrocinios.propostaRequestId, b.requestId)))
      .limit(1);
    if (existente) {
      const ids = await personagemIdsDoUsuario(cid, req.usuario!.id);
      if (!acordoDasPartes(existente, ids)) { erroHttp(res, 404, "Acordo não encontrado"); return; }
      res.status(200).json({ acordo: serializar(existente) });
      return;
    }
  }

  const titular = await titularDoPersonagem(cid, b.characterId, req.usuario!.id);
  if (!titular) { erroHttp(res, 404, "Personagem não elegível"); return; }

  // Beneficiário precisa de conta Internet ativa na mesma campanha.
  const contaBeneficiario = await contaAtivaDoPersonagem(cid, b.beneficiarioCharacterId);
  if (!contaBeneficiario) { erroHttp(res, 404, "Beneficiário não encontrado"); return; }
  const [beneficiario] = await db.select().from(characters)
    .where(and(eq(characters.id, b.beneficiarioCharacterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!beneficiario) { erroHttp(res, 404, "Beneficiário não encontrado"); return; }
  // Dono #401: arquivado é somente leitura — não pode ser alvo de
  // proposta (criaria acordo zumbi). Pagador/aceitante já são
  // cobertos por contaAutorizadaPara; aqui é só o destinatário.
  if (beneficiario.status === "arquivado") { erroHttp(res, 400, "beneficiario_arquivado"); return; }

  // Conta de origem: do pagador, na campanha, tipo utilizável.
  const [contaOrigem] = await db.select().from(financialAccounts)
    .where(and(
      eq(financialAccounts.id, b.pagadorAccountId),
      eq(financialAccounts.characterId, b.characterId),
      eq(financialAccounts.campaignId, cid),
    )).limit(1);
  if (!contaOrigem) { erroHttp(res, 404, "Conta de origem não encontrada"); return; }
  if (contaOrigem.shopId) { erroHttp(res, 400, "Conta de estabelecimento não pode patrocinar"); return; }

  // Mesmo gate da transferência canônica: PIX fictício entre
  // personagens exige financeiro.jogadorPix na campanha.
  const regras = await carregarRegras(cid);
  if (!regras.config.financeiro.jogadorPix) {
    erroHttp(res, 403, "Transferências entre personagens desabilitadas nesta campanha");
    return;
  }

  const agora = new Date();
  const expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= agora.getTime()) { erroHttp(res, 400, "Expiração no passado"); return; }

  const id = crypto.randomUUID();
  const liquidacaoRequestId = `patrocinios:${id}`;
  try {
    db.transaction((tx) => {
      tx.insert(internetPatrocinios).values({
        id, campaignId: cid,
        proponenteCharacterId: b.characterId,
        pagadorCharacterId: b.characterId,
        beneficiarioCharacterId: b.beneficiarioCharacterId,
        pagadorAccountId: contaOrigem.id,
        beneficiarioAccountId: null,
        amountCents: b.amountCents,
        currency: contaOrigem.currency,
        condicaoTipo: b.condicao.tipo,
        condicaoJson: b.condicao,
        estado: "proposto",
        propostaRequestId: b.requestId ?? null,
        liquidacaoRequestId,
        propostoEm: agora,
        expiresAt,
        createdAt: agora,
        updatedAt: agora,
      }).run();
      auditTx(tx, req.usuario!.id, cid, "patrocinio.propor", {
        acordoId: id, pagador: b.characterId, beneficiario: b.beneficiarioCharacterId,
        amountCents: b.amountCents, condicao: b.condicao.tipo,
      });
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      // corrida de requestId — relê e devolve o vencedor
      if (b.requestId) {
        const [vencedor] = await db.select().from(internetPatrocinios)
          .where(and(eq(internetPatrocinios.campaignId, cid), eq(internetPatrocinios.propostaRequestId, b.requestId)))
          .limit(1);
        if (vencedor) {
          // Dono #401: corrida de requestId não pode vazar acordo de
          // terceiro — mesma regra IDOR do replay sequencial.
          const ids = await personagemIdsDoUsuario(cid, req.usuario!.id);
          if (!acordoDasPartes(vencedor, ids)) { erroHttp(res, 404, "Acordo não encontrado"); return; }
          res.status(200).json({ acordo: serializar(vencedor) }); return;
        }
      }
      erroHttp(res, 409, "Proposta duplicada");
      return;
    }
    throw e;
  }
  await audit(req, "patrocinio.propor", { acordoId: id }, { campaignId: cid });
  res.status(201).json({ acordo: { id, estado: "proposto" } });
});

/** GET /patrocinios — acordos onde o requisitante é parte. */
internetPatrociniosRouter.get("/patrocinios", async (req, res) => {
  const cid = campanhaId(req);
  const ids = await personagemIdsDoUsuario(cid, req.usuario!.id);
  if (!ids.size) { res.json({ acordos: [] }); return; }
  const agora = new Date();
  const lista = await db.select().from(internetPatrocinios)
    .where(and(
      eq(internetPatrocinios.campaignId, cid),
      or(
        inArray(internetPatrocinios.pagadorCharacterId, [...ids]),
        inArray(internetPatrocinios.beneficiarioCharacterId, [...ids]),
      ),
    ))
    .orderBy(desc(internetPatrocinios.createdAt)).limit(100);
  // Lazy settlement: acordos aceitos com condição satisfeita tentam
  // liquidar aqui (leitura dos envolvidos dispara o gatilho).
  const acordos = [];
  for (const a of lista) {
    let atual = a;
    if (a.estado === "aceito" && condicaoSatisfeita(a, agora)) {
      try {
        db.transaction((tx) => { liquidarAcordoTx(tx, a, req.usuario!.id, cid, new Date()); });
        const [depois] = await db.select().from(internetPatrocinios)
          .where(eq(internetPatrocinios.id, a.id)).limit(1);
        if (depois) atual = depois;
      } catch { /* falha de liquidação não derruba a leitura */ }
    }
    acordos.push(serializar(atual, agora));
  }
  if (acordos.some((a, i) => a.estado !== serializar(lista[i], agora).estado)) {
    emitirCampanha(cid, "patrimonio:atualizado", {});
  }
  res.json({ acordos });
});

/** GET /patrocinios/:id — detalhe só para as partes (404 uniforme). */
internetPatrociniosRouter.get("/patrocinios/:id", async (req, res) => {
  const cid = campanhaId(req);
  const [acordo] = await db.select().from(internetPatrocinios)
    .where(and(eq(internetPatrocinios.id, req.params.id), eq(internetPatrocinios.campaignId, cid)))
    .limit(1);
  if (!acordo) { erroHttp(res, 404, "Acordo não encontrado"); return; }
  const ids = await personagemIdsDoUsuario(cid, req.usuario!.id);
  if (!acordoDasPartes(acordo, ids)) { erroHttp(res, 404, "Acordo não encontrado"); return; }
  let atual = acordo;
  if (acordo.estado === "aceito" && condicaoSatisfeita(acordo, new Date())) {
    try {
      db.transaction((tx) => { liquidarAcordoTx(tx, acordo, req.usuario!.id, cid, new Date()); });
      const [depois] = await db.select().from(internetPatrocinios)
        .where(eq(internetPatrocinios.id, acordo.id)).limit(1);
      if (depois) atual = depois;
    } catch { /* idem lista */ }
  }
  res.json({ acordo: serializar(atual) });
});

/** POST /patrocinios/:id/aceitar — só o titular do beneficiário (M34).
 *  Fixa a conta de recebimento; `imediato` liquida na mesma tx. */
internetPatrociniosRouter.post("/patrocinios/:id/aceitar", limitePatrocinios, async (req, res) => {
  const cid = campanhaId(req);
  const body = aceitarSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }

  const [acordo] = await db.select().from(internetPatrocinios)
    .where(and(eq(internetPatrocinios.id, req.params.id), eq(internetPatrocinios.campaignId, cid)))
    .limit(1);
  if (!acordo) { erroHttp(res, 404, "Acordo não encontrado"); return; }

  // Só o beneficiário aceita — e só o titular da conta dele.
  const titularBenef = await titularDoPersonagem(cid, acordo.beneficiarioCharacterId, req.usuario!.id);
  if (!titularBenef) { erroHttp(res, 404, "Acordo não encontrado"); return; }

  // Conta de recebimento: do beneficiário, na campanha, mesma moeda
  // da conta de origem (conversão não suportada — mesma regra da
  // rota canônica).
  const [contaDestino] = await db.select().from(financialAccounts)
    .where(and(
      eq(financialAccounts.id, body.data.beneficiarioAccountId),
      eq(financialAccounts.characterId, acordo.beneficiarioCharacterId),
      eq(financialAccounts.campaignId, cid),
    )).limit(1);
  if (!contaDestino) { erroHttp(res, 404, "Conta de destino não encontrada"); return; }
  const [contaOrigem] = await db.select().from(financialAccounts)
    .where(eq(financialAccounts.id, acordo.pagadorAccountId)).limit(1);
  if (!contaOrigem || contaOrigem.currency !== contaDestino.currency) {
    erroHttp(res, 400, "Moedas diferentes — conversão não suportada"); return;
  }

  const agora = new Date();
  // expirado derivado bloqueia aceite (M38)
  if (acordo.expiresAt && acordo.expiresAt.getTime() <= agora.getTime()) {
    erroHttp(res, 409, "Acordo expirado"); return;
  }
  if (acordo.estado !== "proposto") { erroHttp(res, 409, "Acordo não está proposta"); return; }

  try {
    let liquidou = false;
    db.transaction((tx) => {
      // CAS proposto→aceito: corridas perdem aqui.
      const cas = tx.update(internetPatrocinios).set({
        estado: "aceito", beneficiarioAccountId: contaDestino.id,
        aceitoEm: agora, aceitoPor: req.usuario!.id, updatedAt: agora,
      }).where(and(
        eq(internetPatrocinios.id, acordo.id),
        eq(internetPatrocinios.estado, "proposto"),
      )).run();
      if (cas.changes === 0) throw new Error("estado_divergente");
      auditTx(tx, req.usuario!.id, cid, "patrocinio.aceitar", {
        acordoId: acordo.id, beneficiarioAccountId: contaDestino.id,
      });
      // `imediato`: liquida na mesma tx — aceite+pagamento atômicos.
      const fresco = { ...acordo, estado: "aceito" as const, beneficiarioAccountId: contaDestino.id };
      liquidou = liquidarAcordoTx(tx, fresco, req.usuario!.id, cid, new Date());
    });
    await audit(req, "patrocinio.aceitar", { acordoId: acordo.id, liquidou }, { campaignId: cid });
    if (liquidou) emitirCampanha(cid, "patrimonio:atualizado", {});
    res.status(200).json({ ok: true, liquidado: liquidou });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("estado_divergente")) { erroHttp(res, 409, "Acordo já respondido"); return; }
    if (msg.includes("conta_sumiu") || msg.includes("conta_fora_campanha")) { erroHttp(res, 404, "Conta não encontrada"); return; }
    if (msg.includes("moedas_divergentes")) { erroHttp(res, 400, "Moedas diferentes"); return; }
    if (msg.includes("UNIQUE")) { erroHttp(res, 409, "Liquidação já registrada"); return; }
    throw e;
  }
});

/** POST /patrocinios/:id/cancelar — qualquer parte, antes de liquidar
 *  (M37: cancel e liquidação serializam na mesma tx via CAS). */
internetPatrociniosRouter.post("/patrocinios/:id/cancelar", limitePatrocinios, async (req, res) => {
  const cid = campanhaId(req);
  const [acordo] = await db.select().from(internetPatrocinios)
    .where(and(eq(internetPatrocinios.id, req.params.id), eq(internetPatrocinios.campaignId, cid)))
    .limit(1);
  if (!acordo) { erroHttp(res, 404, "Acordo não encontrado"); return; }
  const ids = await personagemIdsDoUsuario(cid, req.usuario!.id);
  if (!acordoDasPartes(acordo, ids)) { erroHttp(res, 404, "Acordo não encontrado"); return; }
  if (acordo.estado === "liquidado" || acordo.estado === "cancelado" || acordo.estado === "falha_liquidacao") {
    erroHttp(res, 409, "Acordo já encerrado"); return;
  }
  const agora = new Date();
  try {
    db.transaction((tx) => {
      const cas = tx.update(internetPatrocinios).set({
        estado: "cancelado", canceladoEm: agora, canceladoPor: req.usuario!.id, updatedAt: agora,
      }).where(and(
        eq(internetPatrocinios.id, acordo.id),
        or(eq(internetPatrocinios.estado, "proposto"), eq(internetPatrocinios.estado, "aceito")),
      )).run();
      if (cas.changes === 0) throw new Error("estado_divergente");
      auditTx(tx, req.usuario!.id, cid, "patrocinio.cancelar", { acordoId: acordo.id });
    });
    await audit(req, "patrocinio.cancelar", { acordoId: acordo.id }, { campaignId: cid });
    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes("estado_divergente")) { erroHttp(res, 409, "Acordo já encerrado"); return; }
    throw e;
  }
});
