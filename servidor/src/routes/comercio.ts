// Comércio 1.1.0 (Issue #286): lojas, ofertas, checkout LOJA-A/LOJA-B.
// Titularidade real: caixa da loja vive em financial_accounts/money_transactions
// com shop_id (character_id NULL) — nunca NPC/personagem fictício.
// Tudo atômico em db.transaction + idempotente por requestId/fingerprint.
import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  campaigns, characters, financialAccounts, moneyTransactions,
  shopManagers, shopOffers, shopOrders, shops, memberships, inventoryEntries, equipmentEntries, itemTemplates,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, getMembership } from "../lib/permissoes.js";
import { carregarRegras } from "../lib/regras.js";
import { avaliarElegibilidadeInternet, chaveItemDe } from "../lib/internet.js";
import { estruturaFichaSchema, type EstruturaFicha } from "../lib/ficha.js";
import { sheetVersions } from "../db/schema.js";
import { emitirCampanha } from "../lib/io.js";
import { audit } from "../lib/audit.js";

const db = getDb();
// Dois mounts: gestão de lojas sob /api/campaigns/:campaignId/comercio e
// checkout/histórico sob /api/characters/:characterId/comercio.
export const comercioLojasRouter = Router({ mergeParams: true });
export const comercioPersonagemRouter = Router({ mergeParams: true });
comercioLojasRouter.use(requireAuth);
comercioPersonagemRouter.use(requireAuth);

// ---------- helpers ----------

const ESTRUTURA_VAZIA = { versao: 1, secoes: [], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } } as EstruturaFicha;

async function estruturaDoPersonagem(p: typeof characters.$inferSelect): Promise<EstruturaFicha> {
  if (!p.templateVersionId) return ESTRUTURA_VAZIA;
  const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, p.templateVersionId)).limit(1);
  if (!v) return ESTRUTURA_VAZIA;
  const parse = estruturaFichaSchema.safeParse(v.structure);
  return parse.success ? parse.data : ESTRUTURA_VAZIA;
}

/** Acesso de personagem para rotas /characters/:characterId (mesma regra do patrimônio). */
async function acessoPersonagem(req: Request) {
  const [p] = await db.select().from(characters).where(eq(characters.id, req.params.characterId)).limit(1);
  if (!p) return { erro: 404 as const };
  const membership = await getMembership(p.campaignId, req.usuario!.id);
  const ehMestre = membership?.role === "mestre";
  const [membroDono] = await db.select().from(memberships).where(eq(memberships.id, p.membershipId)).limit(1);
  const ehDono = membroDono?.userId === req.usuario!.id;
  if (!membership || membership.status !== "ativo" || (!ehMestre && !ehDono)) return { erro: 403 as const };
  if (p.status === "arquivado") return { erro: 409 as const, detalhe: "personagem_arquivado" };
  return { personagem: p, membership, ehMestre, ehDono };
}

/** Gate Internet fail-closed: estrutura+regras+patrimônio do personagem.
 *  Resolve templateId→catálogo (data.regra.key do template) para que item
 *  comprado de template de dispositivo também habilite — mesma regra da UI. */
async function gateInternet(p: typeof characters.$inferSelect) {
  const [estrutura, regras] = await Promise.all([estruturaDoPersonagem(p), carregarRegras(p.campaignId)]);
  const dados = (p.data ?? {}) as Record<string, unknown>;
  const itens = await db.select({ data: inventoryEntries.data }).from(inventoryEntries).where(eq(inventoryEntries.characterId, p.id));
  const equip = await db.select({ data: equipmentEntries.data }).from(equipmentEntries).where(eq(equipmentEntries.characterId, p.id));
  const todos = [...itens, ...equip];
  // coleta templateIds referenciados e resolve a chave canônica de cada um
  const templateIds = [...new Set(todos.map((i) => chaveItemDe(i.data).templateId).filter((x): x is string => !!x))];
  const chavesTemplate = new Map<string, string | undefined>();
  if (templateIds.length) {
    const tpls = await db.select({ id: itemTemplates.id, data: itemTemplates.data }).from(itemTemplates)
      .where(and(inArray(itemTemplates.id, templateIds), eq(itemTemplates.campaignId, p.campaignId)));
    for (const tpl of tpls) chavesTemplate.set(tpl.id, chaveItemDe(tpl.data).regraKey);
  }
  return avaliarElegibilidadeInternet(estrutura, dados, regras, todos, chavesTemplate);
}

/** Loja pertence à campanha e o usuário é mestre da campanha ou gestor da loja.
 *  Semântica de papel (revisão #329 item 6): `shop_managers.role` aceita
 *  gestor|proprietario, mas NESTA fatia ambos têm permissões IDÊNTICAS de
 *  gestão — o campo existe para evolução futura (ex.: proprietações
 *  futuras), não para diferenciação de acesso atual. */
async function acessoLoja(req: Request, shopId: string) {
  const campaignId = req.params.campaignId as string;
  const [loja] = await db.select().from(shops).where(and(eq(shops.id, shopId), eq(shops.campaignId, campaignId))).limit(1);
  if (!loja) return { erro: 404 as const };
  const membership = await getMembership(campaignId, req.usuario!.id);
  if (!membership || membership.status !== "ativo") return { erro: 403 as const };
  if (membership.role === "mestre") return { loja, membership, gestor: true };
  const [gm] = await db.select().from(shopManagers).where(and(eq(shopManagers.shopId, shopId), eq(shopManagers.membershipId, membership.id))).limit(1);
  if (!gm) return { erro: 403 as const };
  return { loja, membership, gestor: true, papel: gm.role };
}

/** Conta de caixa da loja: marcada data.papel==="caixa" ou única conta da loja. */
function contaCaixaDaLoja(contas: (typeof financialAccounts.$inferSelect)[]) {
  const caixa = contas.find((c) => (c.data as Record<string, unknown>)?.papel === "caixa");
  if (caixa) return caixa;
  return contas.length === 1 ? contas[0] : null;
}

const fingerprint = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

class ErroComercio extends Error {
  constructor(public status: number, public codigo: string, public detalhes?: unknown) { super(codigo); }
}

function emitirPatrimonio(campaignId: string, characterId: string) {
  emitirCampanha(campaignId, "patrimonio:atualizado", { characterId });
}

// ---------- gestão de lojas (mestre ou gestor da loja) ----------

const lojaSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().max(60).optional(),
  location: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

/** GET /api/campaigns/:campaignId/comercio/lojas — vitrine (membros; vitrine não exige gate — o gate é do comprador na operação). */
comercioLojasRouter.get("/lojas", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const campaignId = req.params.campaignId as string;
  const lista = await db.select().from(shops).where(eq(shops.campaignId, campaignId));
  const ofertas = await db.select().from(shopOffers).where(and(eq(shopOffers.campaignId, campaignId), eq(shopOffers.isActive, true)));
  res.json({
    lojas: lista.map((l) => ({
      ...l,
      ofertas: ofertas.filter((o) => o.shopId === l.id).map((o) => ({ ...o, emEstoque: o.stockQty === null || o.stockQty > 0 })),
    })),
  });
});

comercioLojasRouter.post("/lojas", requirePapel("mestre"), async (req, res) => {
  const b = lojaSchema.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const id = crypto.randomUUID();
  const agora = new Date();
  await db.insert(shops).values({ id, campaignId: req.params.campaignId, ...b.data, createdAt: agora, updatedAt: agora });
  await audit(req, "comercio.loja.criada", { shopId: id, name: b.data.name });
  emitirCampanha(req.params.campaignId as string, "comercio:atualizado", { shopId: id });
  res.status(201).json({ id });
});

comercioLojasRouter.patch("/lojas/:shopId", requirePapel("mestre", "jogador"), async (req, res) => {
  const acesso = await acessoLoja(req, req.params.shopId);
  if ("erro" in acesso) { res.status(acesso.erro ?? 403).json({ erro: "Loja não encontrada ou sem permissão" }); return; }
  const b = lojaSchema.partial().extend({ isOpen: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  await db.update(shops).set({ ...b.data, updatedAt: new Date() }).where(eq(shops.id, req.params.shopId));
  await audit(req, "comercio.loja.atualizada", { shopId: req.params.shopId });
  emitirCampanha(req.params.campaignId as string, "comercio:atualizado", { shopId: req.params.shopId });
  res.json({ ok: true });
});

/** POST /lojas/:shopId/gestores — mestre vincula membership como gestor. */
comercioLojasRouter.post("/lojas/:shopId/gestores", requirePapel("mestre"), async (req, res) => {
  const [loja] = await db.select().from(shops).where(and(eq(shops.id, req.params.shopId), eq(shops.campaignId, req.params.campaignId as string))).limit(1);
  if (!loja) { res.status(404).json({ erro: "Loja não encontrada" }); return; }
  const b = z.object({ membershipId: z.string().min(1), role: z.enum(["gestor", "proprietario"]).default("gestor") }).safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const [m] = await db.select().from(memberships).where(and(eq(memberships.id, b.data.membershipId), eq(memberships.campaignId, loja.campaignId))).limit(1);
  if (!m || m.status !== "ativo") { res.status(404).json({ erro: "Membership não encontrada" }); return; }
  const id = crypto.randomUUID();
  try {
    await db.insert(shopManagers).values({ id, shopId: loja.id, campaignId: loja.campaignId, membershipId: m.id, role: b.data.role, createdAt: new Date() }).run();
  } catch {
    res.status(409).json({ erro: "Gestor já vinculado" }); return;
  }
  await audit(req, "comercio.gestor.vinculado", { shopId: loja.id, membershipId: m.id, role: b.data.role });
  res.status(201).json({ id });
});

comercioLojasRouter.delete("/lojas/:shopId/gestores/:managerId", requirePapel("mestre"), async (req, res) => {
  const [loja] = await db.select().from(shops).where(and(eq(shops.id, req.params.shopId), eq(shops.campaignId, req.params.campaignId as string))).limit(1);
  if (!loja) { res.status(404).json({ erro: "Loja não encontrada" }); return; }
  const r = await db.delete(shopManagers).where(and(eq(shopManagers.id, req.params.managerId), eq(shopManagers.shopId, loja.id))).run();
  if (!r.changes) { res.status(404).json({ erro: "Gestor não encontrado" }); return; }
  await audit(req, "comercio.gestor.removido", { shopId: loja.id, managerId: req.params.managerId });
  res.json({ ok: true });
});

const contaLojaSchema = z.object({
  type: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  balanceReais: z.number().finite().optional(),
  currency: z.string().max(10).optional(),
  papel: z.enum(["caixa", "reserva"]).default("caixa"),
});

/** POST /lojas/:shopId/contas — cria conta financeira DO ESTABELECIMENTO
 *  (character_id NULL, shop_id preenchido). Caixa privado: só gestores. */
comercioLojasRouter.post("/lojas/:shopId/contas", requirePapel("mestre", "jogador"), async (req, res) => {
  const acesso = await acessoLoja(req, req.params.shopId);
  if ("erro" in acesso) { res.status(acesso.erro ?? 403).json({ erro: "Loja não encontrada ou sem permissão" }); return; }
  const b = contaLojaSchema.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  if (b.data.papel === "caixa") {
    const existentes = await db.select({ id: financialAccounts.id, data: financialAccounts.data })
      .from(financialAccounts).where(eq(financialAccounts.shopId, acesso.loja.id));
    if (existentes.some((c) => (c.data as Record<string, unknown>)?.papel === "caixa")) {
      res.status(409).json({ erro: "caixa_ja_existe" }); return;
    }
  }
  const regras = await carregarRegras(req.params.campaignId as string);
  const casas = regras.config.financeiro.casasDecimais;
  const id = crypto.randomUUID();
  const agora = new Date();
  await db.insert(financialAccounts).values({
    id, characterId: null, shopId: acesso.loja.id, campaignId: req.params.campaignId as string,
    type: b.data.type, name: b.data.name, currency: b.data.currency ?? "BRL",
    balanceCents: Math.round((b.data.balanceReais ?? 0) * 10 ** casas),
    data: { papel: b.data.papel }, createdAt: agora, updatedAt: agora,
  }).run();
  await audit(req, "comercio.conta.criada", { shopId: acesso.loja.id, accountId: id });
  res.status(201).json({ id });
});

/** GET /lojas/:shopId/contas — caixa privado: gestores da loja ou mestre. */
comercioLojasRouter.get("/lojas/:shopId/contas", requirePapel("mestre", "jogador"), async (req, res) => {
  const acesso = await acessoLoja(req, req.params.shopId);
  if ("erro" in acesso) { res.status(acesso.erro ?? 403).json({ erro: "Loja não encontrada ou sem permissão" }); return; }
  const lista = await db.select().from(financialAccounts).where(eq(financialAccounts.shopId, acesso.loja.id));
  res.json({ contas: lista });
});

const ofertaSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  priceCents: z.number().int().positive(),
  currency: z.string().max(10).optional(),
  stockQty: z.number().int().nonnegative().nullable().optional(),
  itemTemplateId: z.string().optional(),
});

comercioLojasRouter.post("/lojas/:shopId/ofertas", requirePapel("mestre", "jogador"), async (req, res) => {
  const acesso = await acessoLoja(req, req.params.shopId);
  if ("erro" in acesso) { res.status(acesso.erro ?? 403).json({ erro: "Loja não encontrada ou sem permissão" }); return; }
  const b = ofertaSchema.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  if (b.data.itemTemplateId) {
    const [tpl] = await db.select({ id: itemTemplates.id, campaignId: itemTemplates.campaignId }).from(itemTemplates).where(eq(itemTemplates.id, b.data.itemTemplateId)).limit(1);
    if (!tpl || tpl.campaignId !== req.params.campaignId) { res.status(400).json({ erro: "Template inexistente nesta campanha" }); return; }
  }
  const id = crypto.randomUUID();
  const agora = new Date();
  await db.insert(shopOffers).values({ id, shopId: req.params.shopId, campaignId: req.params.campaignId as string, ...b.data, createdAt: agora, updatedAt: agora });
  await audit(req, "comercio.oferta.criada", { shopId: req.params.shopId, offerId: id });
  emitirCampanha(req.params.campaignId as string, "comercio:atualizado", { shopId: req.params.shopId });
  res.status(201).json({ id });
});

comercioLojasRouter.patch("/lojas/:shopId/ofertas/:offerId", requirePapel("mestre", "jogador"), async (req, res) => {
  const acesso = await acessoLoja(req, req.params.shopId);
  if ("erro" in acesso) { res.status(acesso.erro ?? 403).json({ erro: "Loja não encontrada ou sem permissão" }); return; }
  const b = ofertaSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const [of] = await db.select().from(shopOffers).where(and(eq(shopOffers.id, req.params.offerId), eq(shopOffers.shopId, req.params.shopId))).limit(1);
  if (!of) { res.status(404).json({ erro: "Oferta não encontrada" }); return; }
  await db.update(shopOffers).set({ ...b.data, updatedAt: new Date() }).where(eq(shopOffers.id, of.id));
  emitirCampanha(req.params.campaignId as string, "comercio:atualizado", { shopId: req.params.shopId });
  res.json({ ok: true });
});

// ---------- checkout do comprador (LOJA-A) e venda para a loja (LOJA-B) ----------

const itemCompraSchema = z.object({
  offerId: z.string().min(1),
  qty: z.number().int().positive().max(999),
  expectedUnitCents: z.number().int().nonnegative().optional(),
});

const comprarSchema = z.object({
  shopId: z.string().min(1),
  accountId: z.string().min(1), // conta do comprador que paga
  items: z.array(itemCompraSchema).min(1).max(50),
  requestId: z.string().min(8).max(120),
});

/** POST /api/characters/:characterId/comercio/comprar — LOJA-A.
 *  Efeitos atômicos: débito comprador + crédito caixa loja + baixa estoque +
 *  entrega no inventário + recibo shop_orders + 2 money_transactions. */
comercioPersonagemRouter.post("/comprar", async (req, res) => {
  const acesso = await acessoPersonagem(req);
  if ("erro" in acesso) {
    const st = acesso.erro === 404 ? 404 : acesso.erro === 409 ? 409 : 403;
    res.status(st).json({ erro: st === 404 ? "Personagem não encontrado" : st === 409 ? "Personagem arquivado" : "Sem acesso" });
    return;
  }
  const { personagem } = acesso;
  const campaignId = personagem.campaignId;
  const b = comprarSchema.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: b.error.issues }); return; }

  // Gate Internet — validado antes de qualquer efeito
  const gate = await gateInternet(personagem);
  if (!gate.elegivel) { res.status(403).json({ erro: "internet_indisponivel", motivos: gate.motivos }); return; }

  const fp = fingerprint({ op: "comprar", buyer: personagem.id, shopId: b.data.shopId, accountId: b.data.accountId, items: b.data.items });
  const pedidoExistente = await db.select().from(shopOrders)
    .where(and(eq(shopOrders.campaignId, campaignId), eq(shopOrders.requestId, b.data.requestId))).limit(1);
  if (pedidoExistente[0]) {
    const fpAnt = (pedidoExistente[0].data as Record<string, unknown>)?.fingerprint;
    if (fpAnt === fp) { res.json({ id: pedidoExistente[0].id, replay: true }); return; }
    res.status(409).json({ erro: "request_id_divergente" });
    return;
  }

  const [loja] = await db.select().from(shops).where(and(eq(shops.id, b.data.shopId), eq(shops.campaignId, campaignId))).limit(1);
  if (!loja) { res.status(404).json({ erro: "Loja não encontrada" }); return; }
  if (!loja.isOpen) { res.status(409).json({ erro: "loja_fechada" }); return; }

  const regras = await carregarRegras(campaignId);
  const agora = new Date();
  const orderId = crypto.randomUUID();
  const txIds: string[] = [];
  const itensEntregues: { offerId: string; name: string; qty: number; unitCents: number }[] = [];
  let totalCents = 0;

  try {
    db.transaction((tx) => {
      // conta do comprador (re-lê dentro da tx)
      const [contaComprador] = tx.select().from(financialAccounts)
        .where(and(eq(financialAccounts.id, b.data.accountId), eq(financialAccounts.characterId, personagem.id), eq(financialAccounts.campaignId, campaignId))).limit(1).all();
      if (!contaComprador) throw new ErroComercio(404, "conta_nao_encontrada");

      // caixa da loja
      const contasLoja = tx.select().from(financialAccounts).where(eq(financialAccounts.shopId, loja.id)).all();
      const caixa = contaCaixaDaLoja(contasLoja);
      if (!caixa) throw new ErroComercio(409, "loja_sem_caixa");

      // valida ofertas/estoque/preço e baixa estoque
      const linhas: { oferta: typeof shopOffers.$inferSelect; qty: number }[] = [];
      for (const item of b.data.items) {
        const [of] = tx.select().from(shopOffers)
          .where(and(eq(shopOffers.id, item.offerId), eq(shopOffers.shopId, loja.id), eq(shopOffers.isActive, true))).limit(1).all();
        if (!of) throw new ErroComercio(409, "oferta_indisponivel", { offerId: item.offerId });
        if (item.expectedUnitCents !== undefined && item.expectedUnitCents !== of.priceCents) {
          throw new ErroComercio(409, "preco_divergente", { offerId: of.id, precoAtualCents: of.priceCents });
        }
        if (of.stockQty !== null) {
          if (of.stockQty < item.qty) throw new ErroComercio(409, "estoque_insuficiente", { offerId: of.id });
          const upd = tx.update(shopOffers).set({ stockQty: of.stockQty - item.qty, updatedAt: agora })
            .where(and(eq(shopOffers.id, of.id), eq(shopOffers.stockQty, of.stockQty))).run();
          // changes===1 garantido pela leitura+escrita na mesma tx síncrona
          if ((upd as { changes?: number }).changes !== 1) throw new ErroComercio(409, "estoque_insuficiente", { offerId: of.id });
        }
        if (of.currency && of.currency !== contaComprador.currency) {
          throw new ErroComercio(409, "moeda_divergente", { offerId: of.id, oferta: of.currency, conta: contaComprador.currency });
        }
        linhas.push({ oferta: of, qty: item.qty });
        totalCents += of.priceCents * item.qty;
      }

      // moeda: conta do comprador deve bater com a moeda da oferta/caixa
      const moedas = new Set([contaComprador.currency, caixa.currency]);
      if (moedas.size > 1) throw new ErroComercio(409, "moedas_divergentes");

      // saldo do comprador
      const novoComprador = contaComprador.balanceCents - totalCents;
      const piso = regras.config.financeiro.permitirSaldoNegativo ? -Infinity
        : -(contaComprador.type === "cartao_credito" ? (contaComprador.creditLimitCents ?? 0) : 0);
      if (novoComprador < piso) throw new ErroComercio(422, "saldo_insuficiente");
      const novoCaixa = caixa.balanceCents + totalCents;

      const casas = regras.config.financeiro.casasDecimais;
      const txOut = crypto.randomUUID(); const txIn = crypto.randomUUID();
      txIds.push(txOut, txIn);
      tx.insert(moneyTransactions).values({
        id: txOut, characterId: personagem.id, shopId: loja.id, campaignId,
        kind: "compra", amount: -(totalCents / 10 ** casas), currency: contaComprador.currency,
        account: contaComprador.type, accountId: contaComprador.id, amountCents: -totalCents,
        balanceBeforeCents: contaComprador.balanceCents, balanceAfterCents: novoComprador,
        counterparty: `Loja: ${loja.name}`, description: `Compra na loja ${loja.name}`,
        requestId: `${b.data.requestId}:out`, createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.insert(moneyTransactions).values({
        id: txIn, shopId: loja.id, campaignId, kind: "venda",
        amount: totalCents / 10 ** casas, currency: caixa.currency,
        account: caixa.type, accountId: caixa.id, amountCents: totalCents,
        balanceBeforeCents: caixa.balanceCents, balanceAfterCents: novoCaixa,
        counterparty: `Personagem: ${personagem.name}`, description: `Venda na loja ${loja.name}`,
        requestId: `${b.data.requestId}:in`, createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoComprador, updatedAt: agora }).where(eq(financialAccounts.id, contaComprador.id)).run();
      tx.update(financialAccounts).set({ balanceCents: novoCaixa, updatedAt: agora }).where(eq(financialAccounts.id, caixa.id)).run();

      // entrega: uma inventory_entry por linha
      for (const { oferta, qty } of linhas) {
        let dataItem: Record<string, unknown> = {};
        if (oferta.itemTemplateId) {
          const [tpl] = tx.select().from(itemTemplates).where(eq(itemTemplates.id, oferta.itemTemplateId)).limit(1).all();
          dataItem = { ...(tpl?.data as Record<string, unknown> ?? {}), templateId: oferta.itemTemplateId };
        }
        dataItem = {
          ...dataItem,
          aquisicao: { formato: "unitario-v1", origem: "loja", shopId: loja.id, offerId: oferta.id, orderId, requestId: b.data.requestId, unitCents: oferta.priceCents, totalCents: oferta.priceCents * qty, qtdOriginal: qty },
        };
        const itemId = crypto.randomUUID();
        tx.insert(inventoryEntries).values({
          id: itemId, characterId: personagem.id, name: oferta.name, quantity: qty,
          description: oferta.description ?? null, category: null, location: null,
          condition: null, weight: null, data: dataItem, createdAt: agora, updatedAt: agora,
        }).run();
        itensEntregues.push({ offerId: oferta.id, name: oferta.name, qty, unitCents: oferta.priceCents });
      }

      tx.insert(shopOrders).values({
        id: orderId, campaignId, shopId: loja.id, requestId: b.data.requestId,
        buyerCharacterId: personagem.id, items: itensEntregues, totalCents, currency: contaComprador.currency,
        status: "concluido", moneyTransactionIds: txIds,
        data: { fingerprint: fp, direction: "compra" }, createdAt: agora,
      }).run();
    });
  } catch (e) {
    if (e instanceof ErroComercio) { res.status(e.status).json({ erro: e.codigo, detalhes: e.detalhes }); return; }
    throw e;
  }

  await audit(req, "comercio.compra", { shopId: loja.id, orderId, totalCents, itens: itensEntregues.length });
  emitirPatrimonio(campaignId, personagem.id);
  emitirCampanha(campaignId, "comercio:atualizado", { shopId: loja.id, orderId });
  res.status(201).json({ id: orderId, totalCents, itens: itensEntregues });
});

const venderSchema = z.object({
  shopId: z.string().min(1),
  inventoryEntryId: z.string().min(1),
  qty: z.number().positive().max(999),
  accountId: z.string().min(1), // conta do vendedor que recebe
  expectedUnitCents: z.number().int().nonnegative().optional(),
  requestId: z.string().min(8).max(120),
});

/** POST /api/characters/:characterId/comercio/vender — LOJA-B: personagem vende
 *  item do inventário à loja. Cinco efeitos atômicos: débito caixa loja,
 *  crédito vendedor, baixa do item, 2 money_transactions, recibo. */
comercioPersonagemRouter.post("/vender", async (req, res) => {
  const acesso = await acessoPersonagem(req);
  if ("erro" in acesso) {
    const st = acesso.erro === 404 ? 404 : acesso.erro === 409 ? 409 : 403;
    res.status(st).json({ erro: st === 404 ? "Personagem não encontrado" : st === 409 ? "Personagem arquivado" : "Sem acesso" });
    return;
  }
  const { personagem } = acesso;
  const campaignId = personagem.campaignId;
  const b = venderSchema.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: b.error.issues }); return; }

  const gate = await gateInternet(personagem);
  if (!gate.elegivel) { res.status(403).json({ erro: "internet_indisponivel", motivos: gate.motivos }); return; }

  const fp = fingerprint({ op: "vender", seller: personagem.id, shopId: b.data.shopId, accountId: b.data.accountId, item: b.data.inventoryEntryId, qty: b.data.qty });
  const pedidoExistente = await db.select().from(shopOrders)
    .where(and(eq(shopOrders.campaignId, campaignId), eq(shopOrders.requestId, b.data.requestId))).limit(1);
  if (pedidoExistente[0]) {
    const fpAnt = (pedidoExistente[0].data as Record<string, unknown>)?.fingerprint;
    if (fpAnt === fp) { res.json({ id: pedidoExistente[0].id, replay: true }); return; }
    res.status(409).json({ erro: "request_id_divergente" });
    return;
  }

  const [loja] = await db.select().from(shops).where(and(eq(shops.id, b.data.shopId), eq(shops.campaignId, campaignId))).limit(1);
  if (!loja) { res.status(404).json({ erro: "Loja não encontrada" }); return; }
  if (!loja.isOpen) { res.status(409).json({ erro: "loja_fechada" }); return; }

  const regras = await carregarRegras(campaignId);
  const agora = new Date();
  const orderId = crypto.randomUUID();
  const txIds: string[] = [];
  let totalCents = 0;
  let nomeItem = "";

  try {
    db.transaction((tx) => {
      const [item] = tx.select().from(inventoryEntries)
        .where(and(eq(inventoryEntries.id, b.data.inventoryEntryId), eq(inventoryEntries.characterId, personagem.id))).limit(1).all();
      if (!item) throw new ErroComercio(404, "item_nao_encontrado");
      // item equipado/vinculado a equipamento não pode ser vendido
      const dadosItem = (item.data ?? {}) as Record<string, unknown>;
      if (dadosItem.equipped === true) throw new ErroComercio(409, "item_equipado");
      const equipVinculado = tx.select({ id: equipmentEntries.id }).from(equipmentEntries)
        .where(and(
          eq(equipmentEntries.characterId, personagem.id),
          sql`json_extract(${equipmentEntries.data}, '$.inventoryEntryId') = ${item.id}`,
        )).all();
      if (equipVinculado.length) throw new ErroComercio(409, "item_equipado");
      if (item.quantity < b.data.qty) throw new ErroComercio(409, "quantidade_insuficiente");

      // preço unitário AUTORITATIVO: somente aquisicao.unitCents (gravado
      // pelo servidor na compra). valueCents é semântica ambígua (pode ser
      // total do stack) — não serve de unitário para qty>1 (revisão #329).
      const aquisicao = dadosItem.aquisicao as Record<string, unknown> | undefined;
      const valorUnit = typeof aquisicao?.unitCents === "number" ? aquisicao.unitCents : null;
      if (valorUnit === null) throw new ErroComercio(422, "item_sem_valor");
      if (b.data.expectedUnitCents !== undefined && b.data.expectedUnitCents !== valorUnit) {
        throw new ErroComercio(409, "preco_divergente", { precoAtualCents: valorUnit });
      }
      totalCents = Math.round(valorUnit * b.data.qty);
      nomeItem = item.name;

      // contas
      const [contaVendedor] = tx.select().from(financialAccounts)
        .where(and(eq(financialAccounts.id, b.data.accountId), eq(financialAccounts.characterId, personagem.id), eq(financialAccounts.campaignId, campaignId))).limit(1).all();
      if (!contaVendedor) throw new ErroComercio(404, "conta_nao_encontrada");
      const contasLoja = tx.select().from(financialAccounts).where(eq(financialAccounts.shopId, loja.id)).all();
      const caixa = contaCaixaDaLoja(contasLoja);
      if (!caixa) throw new ErroComercio(409, "loja_sem_caixa");
      const moedas = new Set([contaVendedor.currency, caixa.currency]);
      if (moedas.size > 1) throw new ErroComercio(409, "moedas_divergentes");

      // saldo do caixa da loja (pode ficar negativo só se config permitir)
      const novoCaixa = caixa.balanceCents - totalCents;
      const pisoCaixa = regras.config.financeiro.permitirSaldoNegativo ? -Infinity : 0;
      if (novoCaixa < pisoCaixa) throw new ErroComercio(422, "caixa_insuficiente");
      const novoVendedor = contaVendedor.balanceCents + totalCents;

      const casas = regras.config.financeiro.casasDecimais;
      const txOut = crypto.randomUUID(); const txIn = crypto.randomUUID();
      txIds.push(txOut, txIn);
      // perna da loja: sai dinheiro (compra para revenda)
      tx.insert(moneyTransactions).values({
        id: txOut, shopId: loja.id, campaignId, kind: "compra",
        amount: -totalCents / 10 ** casas, currency: caixa.currency,
        account: caixa.type, accountId: caixa.id, amountCents: -totalCents,
        balanceBeforeCents: caixa.balanceCents, balanceAfterCents: novoCaixa,
        counterparty: `Personagem: ${personagem.name}`, description: `Compra de ${item.name} na loja`,
        requestId: `${b.data.requestId}:out`, createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      // perna do vendedor: entra dinheiro (venda)
      tx.insert(moneyTransactions).values({
        id: txIn, characterId: personagem.id, shopId: loja.id, campaignId, kind: "venda",
        amount: totalCents / 10 ** casas, currency: contaVendedor.currency,
        account: contaVendedor.type, accountId: contaVendedor.id, amountCents: totalCents,
        balanceBeforeCents: contaVendedor.balanceCents, balanceAfterCents: novoVendedor,
        counterparty: `Loja: ${loja.name}`, description: `Venda de ${item.name} para ${loja.name}`,
        requestId: `${b.data.requestId}:in`, createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoCaixa, updatedAt: agora }).where(eq(financialAccounts.id, caixa.id)).run();
      tx.update(financialAccounts).set({ balanceCents: novoVendedor, updatedAt: agora }).where(eq(financialAccounts.id, contaVendedor.id)).run();

      // baixa do item: reduz quantidade; zera → remove a linha
      const novaQtd = item.quantity - b.data.qty;
      if (novaQtd <= 1e-9) {
        tx.delete(inventoryEntries).where(eq(inventoryEntries.id, item.id)).run();
      } else {
        tx.update(inventoryEntries).set({ quantity: novaQtd, updatedAt: agora }).where(eq(inventoryEntries.id, item.id)).run();
      }

      tx.insert(shopOrders).values({
        id: orderId, campaignId, shopId: loja.id, requestId: b.data.requestId,
        buyerCharacterId: personagem.id, items: [{ inventoryEntryId: item.id, name: nomeItem, qty: b.data.qty, unitCents: valorUnit }],
        totalCents, currency: contaVendedor.currency, status: "concluido", moneyTransactionIds: txIds,
        data: { fingerprint: fp, direction: "venda_para_loja" }, createdAt: agora,
      }).run();
    });
  } catch (e) {
    if (e instanceof ErroComercio) { res.status(e.status).json({ erro: e.codigo, detalhes: e.detalhes }); return; }
    throw e;
  }

  await audit(req, "comercio.venda_loja", { shopId: loja.id, orderId, totalCents, item: nomeItem });
  emitirPatrimonio(campaignId, personagem.id);
  emitirCampanha(campaignId, "comercio:atualizado", { shopId: loja.id, orderId });
  res.status(201).json({ id: orderId, totalCents });
});

/** GET /elegibilidade — veredito do servidor para a UI do módulo Internet.
 *  Mesma função fail-closed usada nas mutações; nunca decide por nome. */
comercioPersonagemRouter.get("/elegibilidade", async (req, res) => {
  const acesso = await acessoPersonagem(req);
  if ("erro" in acesso) {
    const st = acesso.erro === 404 ? 404 : acesso.erro === 409 ? 409 : 403;
    res.status(st).json({ erro: st === 404 ? "Personagem não encontrado" : st === 409 ? "Personagem arquivado" : "Sem acesso" });
    return;
  }
  const gate = await gateInternet(acesso.personagem);
  res.json({ elegivel: gate.elegivel, motivos: gate.motivos });
});

/** GET /api/characters/:characterId/comercio/pedidos — histórico do personagem.
 *  `buyerCharacterId` é sobrecarregado: em LOJA-B guarda o VENDEDOR (a loja
 *  é a compradora). A resposta expõe `direcao` (compra|venda_para_loja)
 *  derivada de data.direction, e `?direcao=` filtra — a UI não deve inferir
 *  direção pelo nome do campo (revisão #329). */
comercioPersonagemRouter.get("/pedidos", async (req, res) => {
  const acesso = await acessoPersonagem(req);
  if ("erro" in acesso) { res.status(acesso.erro === 404 ? 404 : 403).json({ erro: "Sem acesso" }); return; }
  const { personagem } = acesso;
  const filtro = typeof req.query.direcao === "string" ? req.query.direcao : null;
  if (filtro && filtro !== "compra" && filtro !== "venda_para_loja") {
    res.status(400).json({ erro: "direcao_invalida" }); return;
  }
  const lista = await db.select().from(shopOrders)
    .where(and(eq(shopOrders.campaignId, personagem.campaignId), eq(shopOrders.buyerCharacterId, personagem.id)))
    .orderBy(shopOrders.createdAt);
  const pedidos = lista
    .map((o) => ({ ...o, direcao: (o.data as Record<string, unknown>)?.direction ?? "compra" }))
    .filter((o) => !filtro || o.direcao === filtro);
  res.json({ pedidos });
});
