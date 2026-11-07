import { Router, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import {
  characters,
  inventoryEntries,
  equipmentEntries,
  vehicles,
  financialAccounts,
  moneyTransactions,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { carregarPersonagemComAcesso } from "./personagens.js";
import { carregarRegras, configRegrasSchema } from "../lib/regras.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";

const db = getDb();
export const patrimonioRouter = Router({ mergeParams: true });
patrimonioRouter.use(requireAuth);

// ---------- helpers ----------

type Acesso = { personagem: typeof characters.$inferSelect; ehMestre: boolean; ehDono: boolean };

async function acessoOuErro(req: Request, res: import("express").Response): Promise<Acesso | null> {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return null;
  }
  return { personagem: acesso.personagem, ehMestre: acesso.ehMestre, ehDono: acesso.ehDono };
}

async function configPatrimonio(campaignId: string) {
  const regras = await carregarRegras(campaignId);
  return regras.config;
}

const paraCentavos = (valor: number, casas: number) => Math.round(valor * 10 ** casas);
const deCentavos = (cents: number, casas: number) => cents / 10 ** casas;

function emitir(personagem: typeof characters.$inferSelect) {
  emitirCampanha(personagem.campaignId, "patrimonio:atualizado", { characterId: personagem.id });
}

// =====================================================================
// INVENTÁRIO (spec §3, §9, §10)
// =====================================================================

const itemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().positive().max(1_000_000).default(1),
  description: z.string().max(4000).optional(),
  category: z.string().max(120).optional(),
  location: z.string().max(200).optional(),
  condition: z.string().max(120).optional(),
  weight: z.number().nonnegative().optional(),
  valueCents: z.number().int().optional(),
  transferable: z.boolean().default(true),
  templateId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

/** GET /api/characters/:id/inventario */
patrimonioRouter.get("/inventario", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const itens = await db.select().from(inventoryEntries).where(eq(inventoryEntries.characterId, a.personagem.id)).orderBy(inventoryEntries.name);
  const config = await configPatrimonio(a.personagem.campaignId);
  const pesoTotal = config.patrimonio.pesoAtivo
    ? itens.reduce((s, i) => s + (i.weight ?? 0) * i.quantity, 0)
    : null;
  res.json({
    itens,
    pesoTotal,
    pesoMaximo: config.patrimonio.pesoAtivo ? config.patrimonio.pesoMaximo : null,
    pesoExcedido: pesoTotal !== null && pesoTotal > config.patrimonio.pesoMaximo,
  });
});

/** POST /api/characters/:id/inventario */
patrimonioRouter.post("/inventario", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = itemSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorAdicionaItens) {
    res.status(403).json({ erro: "Você não pode adicionar itens nesta campanha" }); return;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  const { templateId, valueCents, transferable, data, ...resto } = body.data;
  await db.insert(inventoryEntries).values({
    id, characterId: a.personagem.id, ...resto, data: { ...data, valueCents, transferable, templateId }, createdAt: agora, updatedAt: agora,
  });
  await audit(req, "inventario.item.criado", { characterId: a.personagem.id, itemId: id, name: body.data.name });
  emitir(a.personagem);
  res.status(201).json({ id });
});

const itemPatchSchema = itemSchema.partial().omit({ templateId: true });

/** PATCH /api/characters/:id/inventario/:itemId */
patrimonioRouter.patch("/inventario/:itemId", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = itemPatchSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  const [item] = await db.select().from(inventoryEntries).where(and(eq(inventoryEntries.id, req.params.itemId), eq(inventoryEntries.characterId, a.personagem.id))).limit(1);
  if (!item) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  if (!a.ehMestre) {
    const dadosItem = (item.data ?? {}) as { transferable?: boolean };
    if (body.data.quantity !== undefined && body.data.quantity <= 0) {
      if (!config.patrimonio.jogadorRemoveItens) { res.status(403).json({ erro: "Você não pode remover itens nesta campanha" }); return; }
    } else if (!config.patrimonio.jogadorAdicionaItens) {
      res.status(403).json({ erro: "Edição de itens não permitida" }); return;
    }
    void dadosItem;
  }
  const { data, valueCents, transferable, ...resto } = body.data;
  const dataAtual = (item.data ?? {}) as Record<string, unknown>;
  await db.update(inventoryEntries).set({
    ...resto,
    quantity: body.data.quantity ?? item.quantity,
    data: { ...dataAtual, ...(data ?? {}), ...(valueCents !== undefined ? { valueCents } : {}), ...(transferable !== undefined ? { transferable } : {}) },
    updatedAt: new Date(),
  }).where(eq(inventoryEntries.id, item.id));
  emitir(a.personagem);
  res.json({ ok: true });
});

/** DELETE /api/characters/:id/inventario/:itemId — remove o item por completo */
patrimonioRouter.delete("/inventario/:itemId", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  const [item] = await db.select().from(inventoryEntries).where(and(eq(inventoryEntries.id, req.params.itemId), eq(inventoryEntries.characterId, a.personagem.id))).limit(1);
  if (!item) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  if (!a.ehMestre && !config.patrimonio.jogadorRemoveItens) {
    res.status(403).json({ erro: "Você não pode remover itens nesta campanha" }); return;
  }
  await db.delete(inventoryEntries).where(eq(inventoryEntries.id, item.id));
  await audit(req, "inventario.item.removido", { characterId: a.personagem.id, itemId: item.id, name: item.name });
  emitir(a.personagem);
  res.json({ ok: true });
});

const transferirSchema = z.object({
  destinoCharacterId: z.string().min(1),
  quantidade: z.number().positive().optional(),
});

/** POST /api/characters/:id/inventario/:itemId/transferir — move item (ou parte) para outro personagem da mesma campanha */
patrimonioRouter.post("/inventario/:itemId/transferir", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = transferirSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const [item] = await db.select().from(inventoryEntries).where(and(eq(inventoryEntries.id, req.params.itemId), eq(inventoryEntries.characterId, a.personagem.id))).limit(1);
  if (!item) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  const dadosItem = (item.data ?? {}) as { transferable?: boolean };
  if (dadosItem.transferable === false && !a.ehMestre) {
    res.status(403).json({ erro: "Este item não pode ser transferido" }); return;
  }
  const [destino] = await db.select().from(characters).where(eq(characters.id, body.data.destinoCharacterId)).limit(1);
  if (!destino || destino.campaignId !== a.personagem.campaignId || destino.id === a.personagem.id) {
    res.status(400).json({ erro: "Destino inválido" }); return;
  }
  const qtd = body.data.quantidade ?? item.quantity;
  if (qtd > item.quantity) { res.status(400).json({ erro: "Quantidade maior que a disponível" }); return; }

  await db.transaction((tx) => {
    if (qtd >= item.quantity) {
      tx.delete(inventoryEntries).where(eq(inventoryEntries.id, item.id)).run();
    } else {
      tx.update(inventoryEntries).set({ quantity: item.quantity - qtd, updatedAt: new Date() }).where(eq(inventoryEntries.id, item.id)).run();
    }
    const novoId = crypto.randomUUID();
    const agora = new Date();
    tx.insert(inventoryEntries).values({
      id: novoId, characterId: destino.id, name: item.name, quantity: qtd,
      description: item.description, category: item.category, location: item.location,
      condition: item.condition, weight: item.weight,
      data: { ...((item.data ?? {}) as object), transferidoDe: a.personagem.id },
      createdAt: agora, updatedAt: agora,
    }).run();
  });
  await audit(req, "inventario.item.transferido", { de: a.personagem.id, para: destino.id, itemId: item.id, quantidade: qtd });
  emitir(a.personagem);
  emitir(destino);
  res.json({ ok: true });
});

// =====================================================================
// EQUIPAMENTOS (spec §4, §5)
// =====================================================================

const equipSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().max(60).optional(),
  slot: z.string().max(60).optional(),
  equipped: z.boolean().default(false),
  description: z.string().max(4000).optional(),
  inventoryEntryId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

patrimonioRouter.get("/equipamentos", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const itens = await db.select().from(equipmentEntries).where(eq(equipmentEntries.characterId, a.personagem.id));
  const config = await configPatrimonio(a.personagem.campaignId);
  res.json({ equipamentos: itens, slots: config.patrimonio.slotsEquipamento });
});

patrimonioRouter.post("/equipamentos", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = equipSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaEquipamentos) {
    res.status(403).json({ erro: "Edição de equipamentos não permitida" }); return;
  }
  if (body.data.slot && body.data.equipped) {
    const ocupado = await db.select().from(equipmentEntries).where(and(
      eq(equipmentEntries.characterId, a.personagem.id),
      eq(equipmentEntries.slot, body.data.slot),
      eq(equipmentEntries.equipped, true),
    )).limit(1);
    if (ocupado.length) { res.status(409).json({ erro: `Slot "${body.data.slot}" já ocupado` }); return; }
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(equipmentEntries).values({ id, characterId: a.personagem.id, ...body.data, createdAt: agora, updatedAt: agora });
  await audit(req, "equipamento.criado", { characterId: a.personagem.id, equipId: id });
  emitir(a.personagem);
  res.status(201).json({ id });
});

/** POST /api/characters/:id/inventario/:itemId/equipar — equipa item do inventário */
patrimonioRouter.post("/inventario/:itemId/equipar", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const slot = typeof req.body?.slot === "string" ? req.body.slot : undefined;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaEquipamentos) {
    res.status(403).json({ erro: "Equipar não permitido" }); return;
  }
  const [item] = await db.select().from(inventoryEntries).where(and(eq(inventoryEntries.id, req.params.itemId), eq(inventoryEntries.characterId, a.personagem.id))).limit(1);
  if (!item) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  if (slot) {
    const ocupado = await db.select().from(equipmentEntries).where(and(
      eq(equipmentEntries.characterId, a.personagem.id), eq(equipmentEntries.slot, slot), eq(equipmentEntries.equipped, true),
    )).limit(1);
    if (ocupado.length) { res.status(409).json({ erro: `Slot "${slot}" já ocupado por "${ocupado[0].name}"` }); return; }
  }
  const dadosItem = (item.data ?? {}) as Record<string, unknown>;
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(equipmentEntries).values({
    id, characterId: a.personagem.id, name: item.name, slot: slot ?? null,
    equipped: true, description: item.description,
    data: { ...dadosItem, inventoryEntryId: item.id },
    createdAt: agora, updatedAt: agora,
  });
  await db.update(inventoryEntries).set({ data: { ...dadosItem, equipado: true }, updatedAt: agora }).where(eq(inventoryEntries.id, item.id));
  await audit(req, "equipamento.vestido", { characterId: a.personagem.id, itemId: item.id, slot });
  emitir(a.personagem);
  res.status(201).json({ id });
});

/** POST /api/characters/:id/equipamentos/:equipId/desequipar */
patrimonioRouter.post("/equipamentos/:equipId/desequipar", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaEquipamentos) {
    res.status(403).json({ erro: "Desequipar não permitido" }); return;
  }
  const [eqp] = await db.select().from(equipmentEntries).where(and(eq(equipmentEntries.id, req.params.equipId), eq(equipmentEntries.characterId, a.personagem.id))).limit(1);
  if (!eqp) { res.status(404).json({ erro: "Equipamento não encontrado" }); return; }
  await db.update(equipmentEntries).set({ equipped: false, updatedAt: new Date() }).where(eq(equipmentEntries.id, eqp.id));
  const invId = (eqp.data as { inventoryEntryId?: string })?.inventoryEntryId;
  if (invId) {
    const [item] = await db.select().from(inventoryEntries).where(eq(inventoryEntries.id, invId)).limit(1);
    if (item) {
      const d = { ...((item.data ?? {}) as Record<string, unknown>) };
      delete d.equipped;
      await db.update(inventoryEntries).set({ data: d, updatedAt: new Date() }).where(eq(inventoryEntries.id, item.id));
    }
  }
  await audit(req, "equipamento.desequipado", { characterId: a.personagem.id, equipId: eqp.id });
  emitir(a.personagem);
  res.json({ ok: true });
});

patrimonioRouter.patch("/equipamentos/:equipId", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaEquipamentos) {
    res.status(403).json({ erro: "Edição não permitida" }); return;
  }
  const body = equipSchema.partial().safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const [eqp] = await db.select().from(equipmentEntries).where(and(eq(equipmentEntries.id, req.params.equipId), eq(equipmentEntries.characterId, a.personagem.id))).limit(1);
  if (!eqp) { res.status(404).json({ erro: "Equipamento não encontrado" }); return; }
  await db.update(equipmentEntries).set({ ...body.data, updatedAt: new Date() }).where(eq(equipmentEntries.id, eqp.id));
  emitir(a.personagem);
  res.json({ ok: true });
});

patrimonioRouter.delete("/equipamentos/:equipId", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorRemoveItens) {
    res.status(403).json({ erro: "Remoção não permitida" }); return;
  }
  const [eqp] = await db.select().from(equipmentEntries).where(and(eq(equipmentEntries.id, req.params.equipId), eq(equipmentEntries.characterId, a.personagem.id))).limit(1);
  if (!eqp) { res.status(404).json({ erro: "Equipamento não encontrado" }); return; }
  await db.delete(equipmentEntries).where(eq(equipmentEntries.id, eqp.id));
  emitir(a.personagem);
  res.json({ ok: true });
});

// =====================================================================
// VEÍCULOS (spec §6)
// =====================================================================

const veiculoSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().max(60).optional(),
  brand: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  year: z.number().int().min(1800).max(2200).optional(),
  color: z.string().max(60).optional(),
  plate: z.string().max(30).optional(),
  serialNumber: z.string().max(120).optional(),
  condition: z.string().max(120).optional(),
  valueCents: z.number().int().optional(),
  fuel: z.string().max(120).optional(),
  capacity: z.string().max(120).optional(),
  ownership: z.enum(["propriedade", "compartilhado"]).default("propriedade"),
  data: z.record(z.string(), z.unknown()).default({}),
});

patrimonioRouter.get("/veiculos", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const lista = await db.select().from(vehicles).where(eq(vehicles.characterId, a.personagem.id));
  res.json({ veiculos: lista });
});

patrimonioRouter.post("/veiculos", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = veiculoSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaVeiculos) {
    res.status(403).json({ erro: "Edição de veículos não permitida" }); return;
  }
  const { valueCents, data, ...resto } = body.data;
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(vehicles).values({ id, characterId: a.personagem.id, campaignId: a.personagem.campaignId, ...resto, data: { ...data, valueCents }, createdAt: agora, updatedAt: agora });
  await audit(req, "veiculo.criado", { characterId: a.personagem.id, veiculoId: id, name: body.data.name });
  emitir(a.personagem);
  res.status(201).json({ id });
});

patrimonioRouter.patch("/veiculos/:veiculoId", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaVeiculos) {
    res.status(403).json({ erro: "Edição não permitida" }); return;
  }
  const body = veiculoSchema.partial().safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const [v] = await db.select().from(vehicles).where(and(eq(vehicles.id, req.params.veiculoId), eq(vehicles.characterId, a.personagem.id))).limit(1);
  if (!v) { res.status(404).json({ erro: "Veículo não encontrado" }); return; }
  const { valueCents, data, ...resto } = body.data;
  const dAtual = (v.data ?? {}) as Record<string, unknown>;
  await db.update(vehicles).set({
    ...resto,
    data: { ...dAtual, ...(data ?? {}), ...(valueCents !== undefined ? { valueCents } : {}) },
    updatedAt: new Date(),
  }).where(eq(vehicles.id, v.id));
  emitir(a.personagem);
  res.json({ ok: true });
});

patrimonioRouter.delete("/veiculos/:veiculoId", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorRemoveItens) {
    res.status(403).json({ erro: "Remoção não permitida" }); return;
  }
  const [v] = await db.select().from(vehicles).where(and(eq(vehicles.id, req.params.veiculoId), eq(vehicles.characterId, a.personagem.id))).limit(1);
  if (!v) { res.status(404).json({ erro: "Veículo não encontrado" }); return; }
  await db.delete(vehicles).where(eq(vehicles.id, v.id));
  emitir(a.personagem);
  res.json({ ok: true });
});

// =====================================================================
// FINANCEIRO (spec §7, §8, §9)
// =====================================================================

const contaSchema = z.object({
  type: z.enum(["especie", "banco", "cartao_debito", "cartao_credito", "pre_pago", "pix", "outro"]),
  name: z.string().min(1).max(160),
  institution: z.string().max(160).optional(),
  agency: z.string().max(60).optional(),
  accountNumber: z.string().max(80).optional(),
  holder: z.string().max(160).optional(),
  currency: z.string().max(10).optional(),
  balanceReais: z.number().optional(), // saldo inicial (só na criação)
  creditLimitReais: z.number().nonnegative().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

/** GET /api/characters/:id/financeiro — contas + histórico recente */
patrimonioRouter.get("/financeiro", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  const contas = await db.select().from(financialAccounts).where(eq(financialAccounts.characterId, a.personagem.id));
  const historico = await db.select().from(moneyTransactions)
    .where(eq(moneyTransactions.characterId, a.personagem.id))
    .orderBy(desc(moneyTransactions.createdAt)).limit(100);
  res.json({
    config: config.financeiro,
    contas: contas.map((c) => ({ ...c, saldo: deCentavos(c.balanceCents, config.financeiro.casasDecimais) })),
    historico,
  });
});

/** POST /api/characters/:id/financeiro/contas */
patrimonioRouter.post("/financeiro/contas", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = contaSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorCriaContas) {
    res.status(403).json({ erro: "Criação de contas não permitida" }); return;
  }
  const cfg = config.financeiro;
  const moeda = body.data.currency ?? cfg.moedaPrincipal;
  if (!cfg.moedas.some((m) => m.codigo === moeda) && moeda !== cfg.moedaPrincipal) {
    res.status(400).json({ erro: `Moeda "${moeda}" não configurada na campanha` }); return;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  const saldoInicial = paraCentavos(body.data.balanceReais ?? 0, cfg.casasDecimais);
  await db.insert(financialAccounts).values({
    id, characterId: a.personagem.id, campaignId: a.personagem.campaignId,
    type: body.data.type, name: body.data.name, institution: body.data.institution ?? null,
    agency: body.data.agency ?? null, accountNumber: body.data.accountNumber ?? null,
    holder: body.data.holder ?? null, currency: moeda, balanceCents: saldoInicial,
    creditLimitCents: body.data.creditLimitReais !== undefined ? paraCentavos(body.data.creditLimitReais, cfg.casasDecimais) : null,
    data: body.data.data, createdAt: agora, updatedAt: agora,
  });
  if (saldoInicial !== 0) {
    await db.insert(moneyTransactions).values({
      id: crypto.randomUUID(), characterId: a.personagem.id, campaignId: a.personagem.campaignId,
      kind: "saldo_inicial", amount: saldoInicial / 100, currency: moeda, account: body.data.type,
      accountId: id, amountCents: saldoInicial, balanceBeforeCents: 0, balanceAfterCents: saldoInicial,
      description: "Saldo inicial", createdBy: req.usuario!.id, createdAt: agora,
    });
  }
  await audit(req, "financeiro.conta.criada", { characterId: a.personagem.id, contaId: id, type: body.data.type });
  emitir(a.personagem);
  res.status(201).json({ id });
});

const contaPatchSchema = contaSchema.partial().omit({ type: true, balanceReais: true, creditLimitReais: true });

patrimonioRouter.patch("/financeiro/contas/:contaId", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = contaPatchSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const [conta] = await db.select().from(financialAccounts).where(and(eq(financialAccounts.id, req.params.contaId), eq(financialAccounts.characterId, a.personagem.id))).limit(1);
  if (!conta) { res.status(404).json({ erro: "Conta não encontrada" }); return; }
  // Jogador só edita metadados da própria conta; limite de crédito só mestre
  const dados = { ...body.data } as Record<string, unknown>;
  if (!a.ehMestre) delete dados.creditLimitReais;
  await db.update(financialAccounts).set({
    name: body.data.name ?? conta.name,
    institution: body.data.institution ?? conta.institution,
    agency: body.data.agency ?? conta.agency,
    accountNumber: body.data.accountNumber ?? conta.accountNumber,
    holder: body.data.holder ?? conta.holder,
    currency: body.data.currency ?? conta.currency,
    data: body.data.data ?? conta.data,
    updatedAt: new Date(),
  }).where(eq(financialAccounts.id, conta.id));
  emitir(a.personagem);
  res.json({ ok: true });
});

// ---------- movimentações ----------

const movimentarSchema = z.object({
  accountId: z.string().min(1),
  tipo: z.enum(["entrada", "saida", "ajuste"]),
  valor: z.number().positive(),
  descricao: z.string().max(500).optional(),
  requestId: z.string().max(120).optional(), // idempotência do cliente
});

/** POST /api/characters/:id/financeiro/movimentar — entrada/saída/ajuste */
patrimonioRouter.post("/financeiro/movimentar", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = movimentarSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  const cfg = config.financeiro;
  const [conta] = await db.select().from(financialAccounts).where(and(eq(financialAccounts.id, body.data.accountId), eq(financialAccounts.characterId, a.personagem.id))).limit(1);
  if (!conta) { res.status(404).json({ erro: "Conta não encontrada" }); return; }
  if (body.data.tipo === "ajuste" && !a.ehMestre) {
    res.status(403).json({ erro: "Ajustes financeiros são exclusivos do mestre" }); return;
  }
  if (!a.ehMestre && !cfg.jogadorCompraVenda && body.data.tipo !== "ajuste") {
    res.status(403).json({ erro: "Operações financeiras não permitidas para jogadores" }); return;
  }

  const casas = cfg.casasDecimais;
  const cents = paraCentavos(body.data.valor, casas);
  const sinal = body.data.tipo === "saida" ? -1 : 1;
  const novoSaldo = conta.balanceCents + sinal * cents;

  // Saldo negativo: bloqueado salvo config ou limite de cartão de crédito
  const limiteCredito = conta.type === "cartao_credito" ? (conta.creditLimitCents ?? 0) : 0;
  const piso = cfg.permitirSaldoNegativo ? -Infinity : -limiteCredito;
  if (novoSaldo < piso) {
    res.status(400).json({ erro: `Saldo insuficiente (disponível: ${deCentavos(conta.balanceCents + limiteCredito, casas)})` });
    return;
  }

  const requestId = body.data.requestId ?? crypto.randomUUID();
  const txId = crypto.randomUUID();
  const agora = new Date();
  try {
    db.transaction((tx) => {
      tx.insert(moneyTransactions).values({
        id: txId, characterId: a.personagem.id, campaignId: a.personagem.campaignId,
        kind: body.data.tipo === "ajuste" ? "ajuste_mestre" : body.data.tipo,
        amount: (sinal * cents) / 100, currency: conta.currency, account: conta.type,
        accountId: conta.id, amountCents: sinal * cents,
        balanceBeforeCents: conta.balanceCents, balanceAfterCents: novoSaldo,
        description: body.data.descricao ?? null, requestId,
        createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoSaldo, updatedAt: agora }).where(eq(financialAccounts.id, conta.id)).run();
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { res.status(409).json({ erro: "Operação já registrada (requestId duplicado)" }); return; }
    throw e;
  }
  await audit(req, "financeiro.movimentacao", { characterId: a.personagem.id, contaId: conta.id, tipo: body.data.tipo, cents: sinal * cents });
  emitir(a.personagem);
  res.status(201).json({ id: txId, saldo: deCentavos(novoSaldo, casas) });
});

const transferirFinanceiroSchema = z.object({
  origemAccountId: z.string().min(1),
  destinoAccountId: z.string().min(1),
  valor: z.number().positive(),
  descricao: z.string().max(500).optional(),
  requestId: z.string().max(120).optional(),
});

/** POST /api/characters/:id/financeiro/transferir — entre contas; entre personagens = PIX fictício */
patrimonioRouter.post("/financeiro/transferir", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = transferirFinanceiroSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  const cfg = config.financeiro;

  const [origem] = await db.select().from(financialAccounts).where(and(eq(financialAccounts.id, body.data.origemAccountId), eq(financialAccounts.characterId, a.personagem.id))).limit(1);
  if (!origem) { res.status(404).json({ erro: "Conta de origem não encontrada" }); return; }
  const [destino] = await db.select().from(financialAccounts).where(eq(financialAccounts.id, body.data.destinoAccountId)).limit(1);
  if (!destino) { res.status(404).json({ erro: "Conta de destino não encontrada" }); return; }
  if (destino.campaignId !== a.personagem.campaignId) { res.status(400).json({ erro: "Conta de destino fora da campanha" }); return; }
  if (origem.id === destino.id) { res.status(400).json({ erro: "Origem e destino iguais" }); return; }

  const entrePersonagens = origem.characterId !== destino.characterId;
  if (entrePersonagens && !a.ehMestre && !cfg.jogadorPix) {
    res.status(403).json({ erro: "Transferências PIX fictícias não permitidas para jogadores" }); return;
  }
  if (!a.ehMestre && !cfg.jogadorCompraVenda && !entrePersonagens) {
    res.status(403).json({ erro: "Operações financeiras não permitidas" }); return;
  }
  // Jogador só envia das próprias contas; mestre pode usar qualquer conta da campanha
  if (!a.ehMestre && destino.characterId !== a.personagem.id) {
    // destino é de outro jogador — permitido via PIX fictício (config.jogadorPix já checado)
  } else if (!a.ehMestre) {
    // destino próprio ok
  }

  const casas = cfg.casasDecimais;
  const cents = paraCentavos(body.data.valor, casas);
  if (origem.currency !== destino.currency) {
    res.status(400).json({ erro: "Moedas diferentes — conversão entre contas ainda não suportada em transferências" }); return;
  }

  const novoOrigem = origem.balanceCents - cents;
  const pisoOrigem = cfg.permitirSaldoNegativo ? -Infinity : -(origem.type === "cartao_credito" ? (origem.creditLimitCents ?? 0) : 0);
  if (novoOrigem < pisoOrigem) {
    res.status(400).json({ erro: "Saldo insuficiente na conta de origem" }); return;
  }
  const novoDestino = destino.balanceCents + cents;
  const kind = entrePersonagens ? "pix_ficticio" : "transferencia";
  const requestId = body.data.requestId ?? crypto.randomUUID();
  const agora = new Date();

  try {
    db.transaction((tx) => {
      // Saída na origem
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: origem.characterId, campaignId: origem.campaignId,
        kind, amount: -cents / 100, currency: origem.currency, account: origem.type,
        accountId: origem.id, amountCents: -cents, balanceBeforeCents: origem.balanceCents, balanceAfterCents: novoOrigem,
        counterpartyCharacterId: destino.characterId, counterparty: destino.name,
        description: body.data.descricao ?? null, requestId: `${requestId}:out`,
        createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoOrigem, updatedAt: agora }).where(eq(financialAccounts.id, origem.id)).run();
      // Entrada no destino
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: destino.characterId, campaignId: destino.campaignId,
        kind, amount: cents / 100, currency: destino.currency, account: destino.type,
        accountId: destino.id, amountCents: cents, balanceBeforeCents: destino.balanceCents, balanceAfterCents: novoDestino,
        counterpartyCharacterId: origem.characterId, counterparty: origem.name,
        description: body.data.descricao ?? null, requestId: `${requestId}:in`,
        createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoDestino, updatedAt: agora }).where(eq(financialAccounts.id, destino.id)).run();
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { res.status(409).json({ erro: "Operação já registrada (requestId duplicado)" }); return; }
    throw e;
  }
  await audit(req, "financeiro.transferencia", { de: origem.id, para: destino.id, cents });
  emitirCampanha(a.personagem.campaignId, "patrimonio:atualizado", { characterId: destino.characterId });
  emitir(a.personagem);
  res.status(201).json({ ok: true, tipo: kind });
});

const operacaoSchema = z.object({
  tipo: z.enum(["compra", "venda"]),
  accountId: z.string().min(1),
  valor: z.number().positive(),
  descricao: z.string().max(500).optional(),
  // compra: dados do item; venda: itemId do inventário
  itemId: z.string().optional(),
  item: itemSchema.optional(),
  quantidade: z.number().positive().optional(),
  contraparte: z.string().max(160).optional(),
  requestId: z.string().max(120).optional(),
});

/** POST /api/characters/:id/financeiro/operacao — compra/venda atômica (spec §9) */
patrimonioRouter.post("/financeiro/operacao", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const body = operacaoSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const config = await configPatrimonio(a.personagem.campaignId);
  const cfg = config.financeiro;
  if (!a.ehMestre && !cfg.jogadorCompraVenda) {
    res.status(403).json({ erro: "Compras/vendas não permitidas para jogadores" }); return;
  }
  const [conta] = await db.select().from(financialAccounts).where(and(eq(financialAccounts.id, body.data.accountId), eq(financialAccounts.characterId, a.personagem.id))).limit(1);
  if (!conta) { res.status(404).json({ erro: "Conta não encontrada" }); return; }

  const casas = cfg.casasDecimais;
  const cents = paraCentavos(body.data.valor, casas);
  const isCompra = body.data.tipo === "compra";
  const sinal = isCompra ? -1 : 1;
  const novoSaldo = conta.balanceCents + sinal * cents;
  const piso = cfg.permitirSaldoNegativo ? -Infinity : -(conta.type === "cartao_credito" ? (conta.creditLimitCents ?? 0) : 0);
  if (novoSaldo < piso) {
    res.status(400).json({ erro: "Saldo insuficiente" }); return;
  }

  let itemAlvo: typeof inventoryEntries.$inferSelect | null = null;
  if (!isCompra) {
    if (!body.data.itemId) { res.status(400).json({ erro: "Venda requer itemId" }); return; }
    const [it] = await db.select().from(inventoryEntries).where(and(eq(inventoryEntries.id, body.data.itemId), eq(inventoryEntries.characterId, a.personagem.id))).limit(1);
    if (!it) { res.status(404).json({ erro: "Item não encontrado" }); return; }
    itemAlvo = it;
  } else if (!body.data.item) {
    res.status(400).json({ erro: "Compra requer dados do item" }); return;
  }

  const requestId = body.data.requestId ?? crypto.randomUUID();
  const agora = new Date();
  try {
    db.transaction((tx) => {
      // 1) movimentação financeira
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: a.personagem.id, campaignId: a.personagem.campaignId,
        kind: isCompra ? "compra" : "venda",
        amount: (sinal * cents) / 100, currency: conta.currency, account: conta.type,
        accountId: conta.id, amountCents: sinal * cents,
        balanceBeforeCents: conta.balanceCents, balanceAfterCents: novoSaldo,
        counterparty: body.data.contraparte ?? null,
        description: body.data.descricao ?? (isCompra ? "Compra" : "Venda"),
        requestId, createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoSaldo, updatedAt: agora }).where(eq(financialAccounts.id, conta.id)).run();

      // 2) inventário
      if (isCompra && body.data.item) {
        const qtd = body.data.quantidade ?? body.data.item.quantity ?? 1;
        tx.insert(inventoryEntries).values({
          id: crypto.randomUUID(), characterId: a.personagem.id,
          name: body.data.item.name, quantity: qtd, description: body.data.item.description,
          category: body.data.item.category, location: body.data.item.location,
          condition: body.data.item.condition, weight: body.data.item.weight,
          data: { ...body.data.item.data, valueCents: cents, origem: "compra" },
          createdAt: agora, updatedAt: agora,
        }).run();
      } else if (itemAlvo) {
        const qtd = body.data.quantidade ?? itemAlvo.quantity;
        if (qtd >= itemAlvo.quantity) {
          tx.delete(inventoryEntries).where(eq(inventoryEntries.id, itemAlvo.id)).run();
        } else {
          tx.update(inventoryEntries).set({ quantity: itemAlvo.quantity - qtd, updatedAt: agora }).where(eq(inventoryEntries.id, itemAlvo.id)).run();
        }
      }
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { res.status(409).json({ erro: "Operação já registrada" }); return; }
    throw e;
  }
  await audit(req, "financeiro.operacao", { characterId: a.personagem.id, tipo: body.data.tipo, cents: sinal * cents });
  emitir(a.personagem);
  res.status(201).json({ ok: true, saldo: deCentavos(novoSaldo, casas) });
});
