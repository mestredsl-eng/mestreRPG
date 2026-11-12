import { Router, type Request } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import {
  characters,
  inventoryEntries,
  equipmentEntries,
  vehicles,
  financialAccounts,
  moneyTransactions,
  itemTemplates,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { carregarPersonagemComAcesso } from "./personagens.js";
import { somenteEnviados } from "../lib/parcial.js";
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
  // Personagem arquivado: somente leitura — nenhuma rota de patrimônio
  // pode alterar inventário, equipamentos, veículos ou finanças.
  if (acesso.personagem.status === "arquivado" && req.method !== "GET") {
    res.status(403).json({ erro: "Personagem arquivado — restaure-o antes de alterar" });
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

// ---------- integridade inventário ↔ equipamentos ----------
// Regra do projeto: equipar separa EXATAMENTE 1 unidade do estoque.
// O equipamento carrega um snapshot completo do item para poder devolver
// a unidade ao inventário mesmo que a pilha original tenha zerado.

type ItemInventario = typeof inventoryEntries.$inferSelect;

function snapshotItem(item: ItemInventario) {
  return {
    name: item.name,
    description: item.description ?? undefined,
    category: item.category ?? undefined,
    location: item.location ?? undefined,
    condition: item.condition ?? undefined,
    weight: item.weight ?? undefined,
    data: (item.data ?? {}) as Record<string, unknown>,
  };
}

/** Devolve 1 unidade ao inventário dentro da transação: funde na pilha
 *  original se ela ainda existir, senão recria o item a partir do snapshot. */
function devolverUnidadeAoInventario(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  characterId: string,
  snap: ReturnType<typeof snapshotItem>,
  inventoryEntryId: string | undefined,
) {
  if (inventoryEntryId) {
    const [pilha] = tx.select().from(inventoryEntries)
      .where(and(eq(inventoryEntries.id, inventoryEntryId), eq(inventoryEntries.characterId, characterId)))
      .limit(1).all();
    if (pilha) {
      tx.update(inventoryEntries)
        .set({ quantity: pilha.quantity + 1, updatedAt: new Date() })
        .where(eq(inventoryEntries.id, pilha.id)).run();
      return;
    }
  }
  const agora = new Date();
  tx.insert(inventoryEntries).values({
    id: crypto.randomUUID(), characterId,
    name: snap.name, quantity: 1, description: snap.description ?? null,
    category: snap.category ?? null, location: snap.location ?? null,
    condition: snap.condition ?? null, weight: snap.weight ?? null,
    data: { ...(snap.data ?? {}), origemEquipamento: true },
    createdAt: agora, updatedAt: agora,
  }).run();
}

// Campos internos de procedência inventário↔equipamento: escritos
// EXCLUSIVAMENTE pelo fluxo oficial de equipar. O cliente nunca pode
// forjá-los (POST) nem alterá-los/apagá-los (PATCH).
const CAMPOS_PROCEDENCIA = ["origem", "inventoryEntryId", "itemSnapshot", "requestId"] as const;
function limparProcedencia(data: Record<string, unknown> | undefined) {
  if (!data) return data;
  const limpo = { ...data };
  for (const k of CAMPOS_PROCEDENCIA) delete limpo[k];
  return limpo;
}

// O sinalizador legado "equipped" em inventoryEntries.data é estado interno:
// DELETE/transferência o usam para impedir movimentações de itens equipados.
// O cliente não pode forjá-lo por POST/PATCH e bloquear o próprio item.
function limparEstadoInventario(data: Record<string, unknown> | undefined) {
  if (!data) return data;
  const limpo = { ...data };
  delete limpo.equipped;
  return limpo;
}

/** Quantos equipamentos do personagem referenciam este item de inventário
 *  (via data.inventoryEntryId) — usado para bloquear exclusão/transferência. */
function equipamentosDoItem(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  characterId: string,
  itemId: string,
) {
  return tx.select({ id: equipmentEntries.id }).from(equipmentEntries)
    .where(and(
      eq(equipmentEntries.characterId, characterId),
      sql`json_extract(${equipmentEntries.data}, '$.inventoryEntryId') = ${itemId}`,
    )).all();
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
    id, characterId: a.personagem.id, ...resto, data: { ...(limparEstadoInventario(data) ?? {}), valueCents, transferable, templateId }, createdAt: agora, updatedAt: agora,
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
  const d = somenteEnviados(body.data, req.body);
  // Releitura + validação de permissão + gravação na MESMA transação:
  // a redução de quantidade é comparada com o valor atual do banco,
  // não com um snapshot lido antes (sem corrida entre PATCHes).
  let item: typeof inventoryEntries.$inferSelect | undefined;
  let negado: "remover" | "editar" | null = null;
  let sumiu = false;
  const { data, valueCents, transferable, ...resto } = d;
  await db.transaction((tx) => {
    const [itemTx] = tx.select().from(inventoryEntries)
      .where(and(eq(inventoryEntries.id, req.params.itemId), eq(inventoryEntries.characterId, a.personagem.id)))
      .limit(1).all();
    if (!itemTx) { sumiu = true; return; }
    item = itemTx;
    if (!a.ehMestre) {
      const reduz = d.quantity !== undefined && d.quantity < itemTx.quantity;
      if (reduz && !config.patrimonio.jogadorRemoveItens) { negado = "remover"; return; }
      if (!reduz && !config.patrimonio.jogadorAdicionaItens) { negado = "editar"; return; }
    }
    const dataAtual = (itemTx.data ?? {}) as Record<string, unknown>;
    tx.update(inventoryEntries).set({
      ...resto,
      quantity: d.quantity ?? itemTx.quantity,
      data: { ...dataAtual, ...(limparEstadoInventario(data) ?? {}), ...(valueCents !== undefined ? { valueCents } : {}), ...(transferable !== undefined ? { transferable } : {}) },
      updatedAt: new Date(),
    }).where(eq(inventoryEntries.id, itemTx.id)).run();
  });
  if (sumiu) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  if (negado === "remover") { res.status(403).json({ erro: "Você não pode remover itens nesta campanha" }); return; }
  if (negado === "editar") { res.status(403).json({ erro: "Edição de itens não permitida" }); return; }
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
  // Releitura + verificação de vínculos + exclusão na MESMA transação:
  // um equipar concorrente não consegue criar vínculo enquanto a
  // exclusão é confirmada (e vice-versa).
  let bloqueado = false;
  let sumiu = false;
  await db.transaction((tx) => {
    const [itemTx] = tx.select().from(inventoryEntries)
      .where(and(eq(inventoryEntries.id, item.id), eq(inventoryEntries.characterId, a.personagem.id)))
      .limit(1).all();
    if (!itemTx) { sumiu = true; return; } // removido por operação concorrente
    const dadosItem = (itemTx.data ?? {}) as { equipped?: boolean };
    const vinculados = equipamentosDoItem(tx, a.personagem.id, itemTx.id);
    if (vinculados.length || dadosItem.equipped === true) { bloqueado = true; return; }
    tx.delete(inventoryEntries).where(eq(inventoryEntries.id, itemTx.id)).run();
  });
  if (sumiu) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  if (bloqueado) {
    res.status(409).json({ erro: "Item possui equipamento vinculado — desequipe ou exclua o equipamento antes" });
    return;
  }
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
  // A política de transferência é revalidada sobre o registro lido
  // dentro da transação; não confiar no snapshot anterior à transação.
  const [destino] = await db.select().from(characters).where(eq(characters.id, body.data.destinoCharacterId)).limit(1);
  if (!destino || destino.campaignId !== a.personagem.campaignId || destino.id === a.personagem.id) {
    res.status(400).json({ erro: "Destino inválido" }); return;
  }
  const qtdPedida = body.data.quantidade;

  // Releitura do item, verificação de vínculos/equipado e mutação na
  // MESMA transação — um equipar concorrente não cria vínculo no meio
  // da transferência, e vice-versa.
  let falha: "sumiu" | "qtd" | "equipado" | "vinculado" | "nao_transferivel" | "destino_arquivado" | "origem_arquivada" | null = null;
  await db.transaction((tx) => {
    // Personagem arquivado é somente leitura — a transferência é recusada
    // se QUALQUER lado estiver arquivado, sem débito/crédito parcial.
    const [origemTx0] = tx.select({ status: characters.status }).from(characters)
      .where(eq(characters.id, a.personagem.id)).limit(1).all();
    const [destinoTx0] = tx.select({ status: characters.status }).from(characters)
      .where(eq(characters.id, destino.id)).limit(1).all();
    if (origemTx0?.status === "arquivado") { falha = "origem_arquivada"; return; }
    if (!destinoTx0 || destinoTx0.status === "arquivado") { falha = "destino_arquivado"; return; }
    const [itemTx] = tx.select().from(inventoryEntries)
      .where(and(eq(inventoryEntries.id, item.id), eq(inventoryEntries.characterId, a.personagem.id)))
      .limit(1).all();
    if (!itemTx) { falha = "sumiu"; return; }
    const dadosItemTx = (itemTx.data ?? {}) as { transferable?: boolean };
    if (dadosItemTx.transferable === false && !a.ehMestre) { falha = "nao_transferivel"; return; }
    const qtd = qtdPedida ?? itemTx.quantity;
    if (qtd > itemTx.quantity) { falha = "qtd"; return; }
    const dadosItemTr = (itemTx.data ?? {}) as { equipped?: boolean };
    if (dadosItemTr.equipped === true) { falha = "equipado"; return; }
    if (equipamentosDoItem(tx, a.personagem.id, itemTx.id).length) { falha = "vinculado"; return; }

    if (qtd >= itemTx.quantity) {
      tx.delete(inventoryEntries).where(eq(inventoryEntries.id, itemTx.id)).run();
    } else {
      tx.update(inventoryEntries).set({ quantity: itemTx.quantity - qtd, updatedAt: new Date() }).where(eq(inventoryEntries.id, itemTx.id)).run();
    }
    const novoId = crypto.randomUUID();
    const agora = new Date();
    tx.insert(inventoryEntries).values({
      id: novoId, characterId: destino.id, name: itemTx.name, quantity: qtd,
      description: itemTx.description, category: itemTx.category, location: itemTx.location,
      condition: itemTx.condition, weight: itemTx.weight,
      data: { ...((itemTx.data ?? {}) as object), transferidoDe: a.personagem.id },
      createdAt: agora, updatedAt: agora,
    }).run();
  });
  if (falha === "sumiu") { res.status(404).json({ erro: "Item não encontrado" }); return; }
  if (falha === "origem_arquivada" || falha === "destino_arquivado") {
    res.status(409).json({ erro: "Personagem arquivado — restaure-o antes de transferir itens" }); return;
  }
  if (falha === "nao_transferivel") { res.status(403).json({ erro: "Este item não pode ser transferido" }); return; }
  if (falha === "qtd") { res.status(400).json({ erro: "Quantidade maior que a disponível" }); return; }
  if (falha === "equipado") { res.status(409).json({ erro: "Item equipado não pode ser transferido — desequipe antes" }); return; }
  if (falha === "vinculado") { res.status(409).json({ erro: "Item possui equipamento vinculado — não pode ser transferido" }); return; }
  await audit(req, "inventario.item.transferido", { de: a.personagem.id, para: destino.id, itemId: item.id, quantidade: qtdPedida ?? item.quantity });
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
  // Ocupação de slot verificada dentro da transação (consistência com
  // POST /equipar): dois cadastros simultâneos não tomam o mesmo slot.
  let slotOcupado: string | null = null;
  const id = crypto.randomUUID();
  const agora = new Date();
  db.transaction((tx) => {
    if (body.data.slot && body.data.equipped) {
      const [ocupado] = tx.select({ name: equipmentEntries.name }).from(equipmentEntries).where(and(
        eq(equipmentEntries.characterId, a.personagem.id),
        eq(equipmentEntries.slot, body.data.slot!),
        eq(equipmentEntries.equipped, true),
      )).limit(1).all();
      if (ocupado) { slotOcupado = ocupado.name; return; }
    }
    // Campos explícitos: nada de ...body.data — o cliente não pode
    // injetar procedência falsa via data/origem/inventoryEntryId.
    tx.insert(equipmentEntries).values({
      id, characterId: a.personagem.id,
      name: body.data.name, kind: body.data.kind ?? null,
      slot: body.data.slot ?? null, equipped: body.data.equipped,
      description: body.data.description ?? null,
      data: limparProcedencia(body.data.data) ?? {},
      createdAt: agora, updatedAt: agora,
    }).run();
  });
  if (slotOcupado !== null) {
    res.status(409).json({ erro: `Slot "${body.data.slot}" já ocupado por "${slotOcupado}"` }); return;
  }
  await audit(req, "equipamento.criado", { characterId: a.personagem.id, equipId: id });
  emitir(a.personagem);
  res.status(201).json({ id });
});

/** POST /api/characters/:id/inventario/:itemId/equipar — equipa 1 unidade do inventário */
patrimonioRouter.post("/inventario/:itemId/equipar", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const slot = typeof req.body?.slot === "string" ? req.body.slot : undefined;
  const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.slice(0, 120) : undefined;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaEquipamentos) {
    res.status(403).json({ erro: "Equipar não permitido" }); return;
  }
  // Fast-path de idempotência: o item pode já ter sido consumido pela
  // primeira requisição (estoque zerado → linha removida → 404 abaixo).
  // A checagem autoritativa continua dentro da transação.
  if (requestId) {
    const [existente] = await db.select({ id: equipmentEntries.id }).from(equipmentEntries)
      .where(and(
        eq(equipmentEntries.characterId, a.personagem.id),
        sql`json_extract(${equipmentEntries.data}, '$.requestId') = ${requestId}`,
      )).limit(1);
    if (existente) { res.status(200).json({ id: existente.id, deduplicado: true }); return; }
  }
  const [item] = await db.select().from(inventoryEntries).where(and(eq(inventoryEntries.id, req.params.itemId), eq(inventoryEntries.characterId, a.personagem.id))).limit(1);
  if (!item) { res.status(404).json({ erro: "Item não encontrado" }); return; }

  let novoEquipId: string | null = null;
  let jaExistia = false;
  let semEstoque = false;
  try {
    db.transaction((tx) => {
      // Idempotência: mesmo requestId → devolve o equipamento já criado,
      // sem consumir outra unidade do estoque.
      if (requestId) {
        const [existente] = tx.select({ id: equipmentEntries.id }).from(equipmentEntries)
          .where(and(
            eq(equipmentEntries.characterId, a.personagem.id),
            sql`json_extract(${equipmentEntries.data}, '$.requestId') = ${requestId}`,
          )).limit(1).all();
        if (existente) { novoEquipId = existente.id; jaExistia = true; return; }
      }

      // Re-lê o item dentro da transação: quantidade validada sobre o
      // valor atual (outra requisição pode ter consumido unidades antes).
      const [itemTx] = tx.select().from(inventoryEntries)
        .where(and(eq(inventoryEntries.id, item.id), eq(inventoryEntries.characterId, a.personagem.id)))
        .limit(1).all();
      if (!itemTx || itemTx.quantity < 1) { semEstoque = true; return; }

      if (slot) {
        const [ocupado] = tx.select({ id: equipmentEntries.id, name: equipmentEntries.name }).from(equipmentEntries)
          .where(and(
            eq(equipmentEntries.characterId, a.personagem.id),
            eq(equipmentEntries.slot, slot),
            eq(equipmentEntries.equipped, true),
          )).limit(1).all();
        if (ocupado) throw new Error(`slot_ocupado:${ocupado.name}`);
      }

      // Consome exatamente 1 unidade do estoque.
      const restante = itemTx.quantity - 1;
      if (restante <= 0) {
        tx.delete(inventoryEntries).where(eq(inventoryEntries.id, itemTx.id)).run();
      } else {
        tx.update(inventoryEntries).set({ quantity: restante, updatedAt: new Date() })
          .where(eq(inventoryEntries.id, itemTx.id)).run();
      }

      const snap = snapshotItem(itemTx);
      const id = crypto.randomUUID();
      const agora = new Date();
      tx.insert(equipmentEntries).values({
        id, characterId: a.personagem.id, name: itemTx.name, slot: slot ?? null,
        equipped: true, description: itemTx.description,
        data: {
          ...((itemTx.data ?? {}) as Record<string, unknown>),
          origem: "inventario",
          inventoryEntryId: itemTx.id,
          itemSnapshot: snap,
          ...(requestId ? { requestId } : {}),
        },
        createdAt: agora, updatedAt: agora,
      }).run();
      novoEquipId = id;
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("slot_ocupado:")) {
      res.status(409).json({ erro: `Slot "${slot}" já ocupado por "${msg.split("slot_ocupado:")[1]}"` }); return;
    }
    throw e;
  }
  if (semEstoque) { res.status(409).json({ erro: "Sem unidades disponíveis para equipar" }); return; }
  if (jaExistia) { res.status(200).json({ id: novoEquipId, deduplicado: true }); return; }
  await audit(req, "equipamento.vestido", { characterId: a.personagem.id, itemId: item.id, slot });
  emitir(a.personagem);
  res.status(201).json({ id: novoEquipId });
});

/** POST /api/characters/:id/equipamentos/:equipId/desequipar —
 *  Equipamento originado do inventário: devolve a unidade à pilha e remove
 *  o registro (a unidade volta a ser item comum). Equipamento manual sem
 *  origem mantém o comportamento anterior (fica "Guardado"). */
patrimonioRouter.post("/equipamentos/:equipId/desequipar", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  if (!a.ehMestre && !config.patrimonio.jogadorEditaEquipamentos) {
    res.status(403).json({ erro: "Desequipar não permitido" }); return;
  }
  const [eqp] = await db.select().from(equipmentEntries).where(and(eq(equipmentEntries.id, req.params.equipId), eq(equipmentEntries.characterId, a.personagem.id))).limit(1);
  if (!eqp) { res.status(404).json({ erro: "Equipamento não encontrado" }); return; }

  const dados = (eqp.data ?? {}) as { origem?: string; inventoryEntryId?: string; itemSnapshot?: ReturnType<typeof snapshotItem> };

  // Releitura + reivindicação dentro da transação: duas chamadas
  // simultâneas não podem devolver a unidade duas vezes — só a que
  // remover o registro (changes === 1) executa a devolução.
  let jaProcessado = false;
  await db.transaction((tx) => {
    const [eqpTx] = tx.select().from(equipmentEntries)
      .where(and(eq(equipmentEntries.id, eqp.id), eq(equipmentEntries.characterId, a.personagem.id)))
      .limit(1).all();
    if (!eqpTx) { jaProcessado = true; return; }
    const dTx = (eqpTx.data ?? {}) as typeof dados;
    const veioDoInventario = dTx.origem === "inventario" && !!dTx.itemSnapshot;

    if (veioDoInventario) {
      // Reivindica o registro primeiro: se outra requisição já o removeu,
      // changes === 0 e nenhuma unidade é devolvida.
      const del = tx.delete(equipmentEntries).where(eq(equipmentEntries.id, eqpTx.id)).run();
      if (del.changes !== 1) { jaProcessado = true; return; }
      devolverUnidadeAoInventario(tx, a.personagem.id, dTx.itemSnapshot!, dTx.inventoryEntryId);
    } else {
      const upd = tx.update(equipmentEntries).set({ equipped: false, updatedAt: new Date() })
        .where(and(eq(equipmentEntries.id, eqpTx.id), eq(equipmentEntries.equipped, true))).run();
      if (upd.changes !== 1) { jaProcessado = true; return; }
      const invId = dTx.inventoryEntryId;
      if (invId) {
        const [item] = tx.select().from(inventoryEntries).where(eq(inventoryEntries.id, invId)).limit(1).all();
        if (item) {
          const d = { ...((item.data ?? {}) as Record<string, unknown>) };
          delete d.equipped;
          tx.update(inventoryEntries).set({ data: d, updatedAt: new Date() }).where(eq(inventoryEntries.id, item.id)).run();
        }
      }
    }
  });
  if (jaProcessado) { res.json({ ok: true, jaProcessado: true }); return; }
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
  // Releitura + validação de slot + atualização na MESMA transação:
  // dois PATCH simultâneos não ocupam o mesmo slot ao mesmo tempo.
  const d = somenteEnviados(body.data, req.body);
  let slotOcupado: string | null = null;
  let sumiu = false;
  await db.transaction((tx) => {
    const [eqpTx] = tx.select().from(equipmentEntries)
      .where(and(eq(equipmentEntries.id, eqp.id), eq(equipmentEntries.characterId, a.personagem.id)))
      .limit(1).all();
    if (!eqpTx) { sumiu = true; return; }
    const slotFinal = d.slot !== undefined ? d.slot : eqpTx.slot;
    const equipadoFinal = d.equipped !== undefined ? d.equipped : eqpTx.equipped;
    if (slotFinal && equipadoFinal) {
      const [ocupado] = tx.select({ id: equipmentEntries.id, name: equipmentEntries.name }).from(equipmentEntries).where(and(
        eq(equipmentEntries.characterId, a.personagem.id),
        eq(equipmentEntries.slot, slotFinal),
        eq(equipmentEntries.equipped, true),
        sql`${equipmentEntries.id} != ${eqpTx.id}`,
      )).limit(1).all();
      if (ocupado) { slotOcupado = ocupado.name; return; }
    }
    // Lista explícita de campos editáveis — o cliente não pode alterar
    // nem apagar a procedência (origem/inventoryEntryId/itemSnapshot/
    // requestId), que é mesclada preservando os valores do servidor.
    const { data: dataEnviada, ...resto } = d;
    const dataFinal = dataEnviada !== undefined
      ? { ...((eqpTx.data ?? {}) as Record<string, unknown>), ...limparProcedencia(dataEnviada) }
      : eqpTx.data;
    tx.update(equipmentEntries).set({
      name: resto.name ?? eqpTx.name,
      kind: resto.kind !== undefined ? resto.kind : eqpTx.kind,
      slot: resto.slot !== undefined ? resto.slot : eqpTx.slot,
      equipped: resto.equipped !== undefined ? resto.equipped : eqpTx.equipped,
      description: resto.description !== undefined ? resto.description : eqpTx.description,
      ...(dataEnviada !== undefined ? { data: dataFinal } : {}),
      updatedAt: new Date(),
    }).where(eq(equipmentEntries.id, eqpTx.id)).run();
  });
  if (sumiu) { res.status(404).json({ erro: "Equipamento não encontrado" }); return; }
  if (slotOcupado !== null) {
    const slotFinal = d.slot !== undefined ? d.slot : eqp.slot;
    res.status(409).json({ erro: `Slot "${slotFinal}" já ocupado por "${slotOcupado}"` }); return;
  }
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
  // Equipamento originado do inventário: a unidade volta ao estoque antes
  // de remover o registro — nada é perdido nem duplicado. A reivindicação
  // é atômica: só a requisição que remove o registro (changes === 1)
  // devolve a unidade; chamadas simultâneas não duplicam.
  let jaRemovido = false;
  await db.transaction((tx) => {
    const [eqpTx] = tx.select().from(equipmentEntries)
      .where(and(eq(equipmentEntries.id, eqp.id), eq(equipmentEntries.characterId, a.personagem.id)))
      .limit(1).all();
    if (!eqpTx) { jaRemovido = true; return; }
    const dTx = (eqpTx.data ?? {}) as { origem?: string; inventoryEntryId?: string; itemSnapshot?: ReturnType<typeof snapshotItem> };
    const del = tx.delete(equipmentEntries).where(eq(equipmentEntries.id, eqpTx.id)).run();
    if (del.changes !== 1) { jaRemovido = true; return; }
    if (dTx.origem === "inventario" && dTx.itemSnapshot) {
      devolverUnidadeAoInventario(tx, a.personagem.id, dTx.itemSnapshot, dTx.inventoryEntryId);
    }
  });
  if (jaRemovido) { res.json({ ok: true, jaRemovido: true }); return; }
  await audit(req, "equipamento.removido", { characterId: a.personagem.id, equipId: eqp.id });
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
  const { valueCents, data, ...resto } = somenteEnviados(body.data, req.body);
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
  const limiteCreditoCents = body.data.creditLimitReais !== undefined
    ? paraCentavos(body.data.creditLimitReais, cfg.casasDecimais)
    : 0;
  // A política vale também para a abertura da conta: saldo negativo não
  // pode entrar por um atalho que contorne as validações de movimentação.
  const pisoInicial = cfg.permitirSaldoNegativo
    ? -Infinity
    : body.data.type === "cartao_credito" ? -limiteCreditoCents : 0;
  if (saldoInicial < pisoInicial) {
    res.status(400).json({
      erro: body.data.type === "cartao_credito"
        ? "Saldo inicial ultrapassa o limite de crédito permitido"
        : "Saldo inicial negativo não permitido nesta campanha",
    });
    return;
  }
  // Conta e lançamento de abertura formam uma única operação contábil.
  // Se qualquer insert falhar, o SQLite desfaz ambos.
  db.transaction((tx) => {
    tx.insert(financialAccounts).values({
      id, characterId: a.personagem.id, campaignId: a.personagem.campaignId,
      type: body.data.type, name: body.data.name, institution: body.data.institution ?? null,
      agency: body.data.agency ?? null, accountNumber: body.data.accountNumber ?? null,
      holder: body.data.holder ?? null, currency: moeda, balanceCents: saldoInicial,
      creditLimitCents: body.data.creditLimitReais !== undefined ? limiteCreditoCents : null,
      data: body.data.data, createdAt: agora, updatedAt: agora,
    }).run();
    if (saldoInicial !== 0) {
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: a.personagem.id, campaignId: a.personagem.campaignId,
        kind: "saldo_inicial", amount: deCentavos(saldoInicial, cfg.casasDecimais), currency: moeda, account: body.data.type,
        accountId: id, amountCents: saldoInicial, balanceBeforeCents: 0, balanceAfterCents: saldoInicial,
        description: "Saldo inicial", createdBy: req.usuario!.id, createdAt: agora,
      }).run();
    }
  });
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
  if (body.data.currency !== undefined) {
    const config = await configPatrimonio(a.personagem.campaignId);
    const moedaPermitida = body.data.currency === config.financeiro.moedaPrincipal
      || config.financeiro.moedas.some((m) => m.codigo === body.data.currency);
    if (!moedaPermitida) {
      res.status(400).json({ erro: `Moeda "${body.data.currency}" não configurada na campanha` });
      return;
    }
    if (body.data.currency !== conta.currency) {
      res.status(400).json({ erro: "A moeda de uma conta não pode ser alterada após a criação. Crie outra conta na moeda desejada para preservar o saldo e o histórico." });
      return;
    }
  }
  // Jogador só edita metadados da própria conta; limite de crédito só mestre
  const dados = somenteEnviados(body.data, req.body) as Record<string, unknown>;
  if (!a.ehMestre) delete dados.creditLimitReais;
  const dp = somenteEnviados(body.data, req.body);
  await db.update(financialAccounts).set({
    name: dp.name ?? conta.name,
    institution: dp.institution ?? conta.institution,
    agency: dp.agency ?? conta.agency,
    accountNumber: dp.accountNumber ?? conta.accountNumber,
    holder: dp.holder ?? conta.holder,
    currency: dp.currency ?? conta.currency,
    data: dp.data ?? conta.data,
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

  const requestId = body.data.requestId ?? crypto.randomUUID();
  const txId = crypto.randomUUID();
  const agora = new Date();
  let novoSaldo = 0;
  let saldoInsuficiente = false;
  try {
    db.transaction((tx) => {
      // Re-lê a conta dentro da transação: saldo, tipo e limite são validados
      // sobre o valor atual, não sobre uma leitura anterior (evita lost update).
      const [contaTx] = tx.select().from(financialAccounts)
        .where(and(eq(financialAccounts.id, conta.id), eq(financialAccounts.characterId, a.personagem.id)))
        .limit(1).all();
      if (!contaTx) throw new Error("conta_sumiu");
      const saldoNovo = contaTx.balanceCents + sinal * cents;
      const limiteCredito = contaTx.type === "cartao_credito" ? (contaTx.creditLimitCents ?? 0) : 0;
      const piso = cfg.permitirSaldoNegativo ? -Infinity : -limiteCredito;
      if (saldoNovo < piso) { saldoInsuficiente = true; return; }
      tx.insert(moneyTransactions).values({
        id: txId, characterId: a.personagem.id, campaignId: a.personagem.campaignId,
        kind: body.data.tipo === "ajuste" ? "ajuste_mestre" : body.data.tipo,
        amount: deCentavos(sinal * cents, casas), currency: contaTx.currency, account: contaTx.type,
        accountId: contaTx.id, amountCents: sinal * cents,
        balanceBeforeCents: contaTx.balanceCents, balanceAfterCents: saldoNovo,
        description: body.data.descricao ?? null, requestId,
        createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: saldoNovo, updatedAt: agora }).where(eq(financialAccounts.id, contaTx.id)).run();
      novoSaldo = saldoNovo;
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { res.status(409).json({ erro: "Operação já registrada (requestId duplicado)" }); return; }
    if (String(e).includes("conta_sumiu")) { res.status(404).json({ erro: "Conta não encontrada" }); return; }
    throw e;
  }
  if (saldoInsuficiente) {
    const [contaAtual] = await db.select().from(financialAccounts).where(eq(financialAccounts.id, conta.id)).limit(1);
    const disponivel = contaAtual ? contaAtual.balanceCents + (contaAtual.type === "cartao_credito" ? (contaAtual.creditLimitCents ?? 0) : 0) : 0;
    res.status(400).json({ erro: `Saldo insuficiente (disponível: ${deCentavos(disponivel, casas)})` });
    return;
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

  const kind = entrePersonagens ? "pix_ficticio" : "transferencia";
  const requestId = body.data.requestId ?? crypto.randomUUID();
  const agora = new Date();
  let saldoInsuficiente = false;

  try {
    db.transaction((tx) => {
      // Re-lê as duas contas dentro da transação: débitos/créditos são
      // calculados sobre saldos atuais, nunca sobre leituras anteriores.
      const [origemTx] = tx.select().from(financialAccounts)
        .where(eq(financialAccounts.id, origem.id)).limit(1).all();
      const [destinoTx] = tx.select().from(financialAccounts)
        .where(eq(financialAccounts.id, destino.id)).limit(1).all();
      if (!origemTx || !destinoTx) throw new Error("conta_sumiu");
      if (origemTx.currency !== destinoTx.currency) throw new Error("moedas_divergentes");
      // Personagem arquivado é somente leitura — se qualquer lado da
      // transferência (PIX fictício entre personagens) estiver arquivado,
      // a operação inteira é recusada: sem débito, crédito ou histórico.
      const charIds = [...new Set([origemTx.characterId, destinoTx.characterId])];
      const arquivados = tx.select({ id: characters.id }).from(characters)
        .where(and(inArray(characters.id, charIds), eq(characters.status, "arquivado"))).all();
      if (arquivados.length) throw new Error("personagem_arquivado");

      const novoOrigem = origemTx.balanceCents - cents;
      const pisoOrigem = cfg.permitirSaldoNegativo ? -Infinity : -(origemTx.type === "cartao_credito" ? (origemTx.creditLimitCents ?? 0) : 0);
      if (novoOrigem < pisoOrigem) { saldoInsuficiente = true; return; }
      const novoDestino = destinoTx.balanceCents + cents;

      // Saída na origem
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: origemTx.characterId, campaignId: origemTx.campaignId,
        kind, amount: deCentavos(-cents, casas), currency: origemTx.currency, account: origemTx.type,
        accountId: origemTx.id, amountCents: -cents, balanceBeforeCents: origemTx.balanceCents, balanceAfterCents: novoOrigem,
        counterpartyCharacterId: destinoTx.characterId, counterparty: destinoTx.name,
        description: body.data.descricao ?? null, requestId: `${requestId}:out`,
        createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoOrigem, updatedAt: agora }).where(eq(financialAccounts.id, origemTx.id)).run();
      // Entrada no destino
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: destinoTx.characterId, campaignId: destinoTx.campaignId,
        kind, amount: deCentavos(cents, casas), currency: destinoTx.currency, account: destinoTx.type,
        accountId: destinoTx.id, amountCents: cents, balanceBeforeCents: destinoTx.balanceCents, balanceAfterCents: novoDestino,
        counterpartyCharacterId: origemTx.characterId, counterparty: origemTx.name,
        description: body.data.descricao ?? null, requestId: `${requestId}:in`,
        createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: novoDestino, updatedAt: agora }).where(eq(financialAccounts.id, destinoTx.id)).run();
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("UNIQUE")) { res.status(409).json({ erro: "Operação já registrada (requestId duplicado)" }); return; }
    if (msg.includes("conta_sumiu")) { res.status(404).json({ erro: "Conta não encontrada" }); return; }
    if (msg.includes("moedas_divergentes")) { res.status(400).json({ erro: "Moedas diferentes — conversão entre contas ainda não suportada em transferências" }); return; }
    if (msg.includes("personagem_arquivado")) { res.status(409).json({ erro: "Personagem arquivado — restaure-o antes de transferir valores" }); return; }
    throw e;
  }
  if (saldoInsuficiente) {
    res.status(400).json({ erro: "Saldo insuficiente na conta de origem" });
    return;
  }
  await audit(req, "financeiro.transferencia", { de: origem.id, para: destino.id, cents });
  emitirCampanha(a.personagem.campaignId, "patrimonio:atualizado", { characterId: destino.characterId });
  emitir(a.personagem);
  res.status(201).json({ ok: true, tipo: kind });
});

const operacaoSchema = z.object({
  tipo: z.enum(["compra", "venda"]),
  // Obrigatórios quando há movimentação financeira. Na compra,
  // pagar=false dispensa conta e valor vira apenas referência opcional.
  accountId: z.string().min(1).optional(),
  valor: z.number().positive().optional(),
  pagar: z.boolean().default(true),
  descricao: z.string().max(500).optional(),
  // compra: dados do item (ou templateId do catálogo); venda: itemId do inventário
  itemId: z.string().optional(),
  item: itemSchema.optional(),
  templateId: z.string().optional(),
  quantidade: z.number().positive().optional(),
  contraparte: z.string().max(160).optional(),
  requestId: z.string().max(120).optional(),
});

/** Metadados persistidos na movimentação para rastreio e estorno. */
interface OperacaoMeta {
  tipo: "compra" | "venda" | "estorno";
  quantidade: number;
  valorCents: number;
  moeda: string;
  contaId: string;
  itemId: string | null;
  itemNome: string | null;
  semPagamento?: boolean;
  estornoDe?: string;
  operacaoOriginal?: OperacaoMeta | null;
  item?: ReturnType<typeof snapshotItem>;
}

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
  const isCompra = body.data.tipo === "compra";
  // Venda sempre movimenta (crédito); compra admite pagar=false — sem
  // débito fictício, sem conta e sem transação financeira.
  const semPagamento = isCompra && body.data.pagar === false;
  if (!isCompra && body.data.pagar === false) {
    res.status(400).json({ erro: "Venda requer conta de recebimento" }); return;
  }
  if (!semPagamento && !body.data.accountId) {
    res.status(400).json({ erro: "Conta financeira obrigatória" }); return;
  }
  if (!semPagamento && body.data.valor === undefined) {
    res.status(400).json({ erro: "Valor obrigatório quando há pagamento" }); return;
  }

  const [conta] = body.data.accountId
    ? await db.select().from(financialAccounts).where(and(eq(financialAccounts.id, body.data.accountId), eq(financialAccounts.characterId, a.personagem.id))).limit(1)
    : [undefined];
  if (!semPagamento && !conta) { res.status(404).json({ erro: "Conta não encontrada" }); return; }

  const casas = cfg.casasDecimais;
  // semPagamento: valor é referência opcional (preço de tabela) — não
  // movimenta nada; com pagamento o valor é obrigatório e positivo.
  const cents = paraCentavos(body.data.valor ?? 0, casas);
  if (!semPagamento && (!Number.isFinite(cents) || cents <= 0)) {
    res.status(400).json({ erro: "Valor inválido ou abaixo da menor unidade monetária" });
    return;
  }
  if (semPagamento && body.data.valor !== undefined && (!Number.isFinite(cents) || cents < 0)) {
    res.status(400).json({ erro: "Valor de referência inválido" });
    return;
  }
  const sinal = isCompra ? -1 : 1;

  // Pré-leitura apenas para erros amigáveis (404/400). A validação
  // autoritativa de saldo e estoque acontece DENTRO da transação.
  if (!isCompra) {
    if (!body.data.itemId) { res.status(400).json({ erro: "Venda requer itemId" }); return; }
    const [it] = await db.select().from(inventoryEntries).where(and(eq(inventoryEntries.id, body.data.itemId), eq(inventoryEntries.characterId, a.personagem.id))).limit(1);
    if (!it) { res.status(404).json({ erro: "Item não encontrado" }); return; }
    if ((body.data.quantidade ?? it.quantity) > it.quantity) {
      res.status(400).json({ erro: `Quantidade indisponível (estoque: ${it.quantity})` });
      return;
    }
  } else if (!body.data.item && !body.data.templateId) {
    res.status(400).json({ erro: "Compra requer dados do item ou templateId do catálogo" }); return;
  }

  const requestId = body.data.requestId ?? crypto.randomUUID();
  const agora = new Date();
  let novoSaldo = 0;
  let saldoInsuficiente = false;
  let estoqueInsuficiente = false;
  let operacaoDuplicada = false;
  let itemCriadoId: string | null = null;
  // ID do template EFETIVAMENTE validado na transação — única fonte
  // autorizada para data.templateId e para a auditoria.
  let templateValidado: string | null = null;
  try {
    db.transaction((tx) => {
      // 0) Idempotência da operação em si: o requestId identifica a
      //    compra/venda mesmo quando não há movimentação financeira
      //    (o UNIQUE de money_transactions não cobre esse caso).
      const [opExistente] = tx.select({ id: inventoryEntries.id }).from(inventoryEntries)
        .where(and(
          eq(inventoryEntries.characterId, a.personagem.id),
          sql`json_extract(${inventoryEntries.data}, '$.operacaoId') = ${requestId}`,
        )).limit(1).all();
      const [txExistente] = tx.select({ id: moneyTransactions.id }).from(moneyTransactions)
        .where(and(eq(moneyTransactions.campaignId, a.personagem.campaignId), eq(moneyTransactions.requestId, requestId))).limit(1).all();
      if (opExistente || txExistente) { operacaoDuplicada = true; return; }

      // 1) Re-lê a conta dentro da transação: saldo calculado sobre o
      // valor atual, nunca sobre leitura anterior (evita lost update).
      let contaTx: typeof financialAccounts.$inferSelect | null = null;
      let saldoNovo = 0;
      if (!semPagamento) {
        const [c] = tx.select().from(financialAccounts)
          .where(and(eq(financialAccounts.id, body.data.accountId!), eq(financialAccounts.characterId, a.personagem.id)))
          .limit(1).all();
        if (!c) throw new Error("conta_sumiu");
        contaTx = c;
        saldoNovo = contaTx.balanceCents + sinal * cents;
        const piso = cfg.permitirSaldoNegativo ? -Infinity : -(contaTx.type === "cartao_credito" ? (contaTx.creditLimitCents ?? 0) : 0);
        if (saldoNovo < piso) { saldoInsuficiente = true; return; }
      }

      // 2) Re-lê o item/template dentro da transação: estoque atual e
      //    dados do catálogo são lidos no momento da escrita — um item
      //    do catálogo desativado ou alterado não é confiado do cliente.
      let itemTx: typeof inventoryEntries.$inferSelect | null = null;
      let tplTx: typeof itemTemplates.$inferSelect | null = null;
      let qtdVenda = 0;
      if (!isCompra) {
        const [it] = tx.select().from(inventoryEntries)
          .where(and(eq(inventoryEntries.id, body.data.itemId!), eq(inventoryEntries.characterId, a.personagem.id)))
          .limit(1).all();
        if (!it) throw new Error("item_sumiu");
        qtdVenda = body.data.quantidade ?? it.quantity;
        if (qtdVenda > it.quantity) { estoqueInsuficiente = true; return; }
        itemTx = it;
      } else if (body.data.templateId) {
        const [tpl] = tx.select().from(itemTemplates)
          .where(and(eq(itemTemplates.id, body.data.templateId), eq(itemTemplates.campaignId, a.personagem.campaignId), eq(itemTemplates.isActive, true)))
          .limit(1).all();
        if (!tpl) throw new Error("template_sumiu");
        tplTx = tpl;
        templateValidado = tpl.id;
      }

      // 3) Movimentação financeira — apenas quando há pagamento/
      //    recebimento. A transação carrega o vínculo explícito com o
      //    item e os metadados necessários ao estorno.
      let novoItemId: string | null = null;
      if (isCompra) {
        const tplData = (tplTx?.data ?? {}) as Record<string, unknown>;
        const itemDados = body.data.item;
        const qtd = body.data.quantidade ?? itemDados?.quantity ?? 1;
        novoItemId = crypto.randomUUID();
        itemCriadoId = novoItemId;
        // Referência de preço unitário só existe quando cents/qtd é
        // inteiro na menor unidade — totais ínfimos por unidade
        // (ex.: 1 centavo por 2 un) não viram sugestão de revenda.
        const unitExato = cents / qtd;
        const unitCents = Number.isInteger(unitExato) ? unitExato : null;
        const itemNome = itemDados?.name ?? tplTx?.name ?? "item";
        tx.insert(inventoryEntries).values({
          id: novoItemId, characterId: a.personagem.id,
          name: itemNome, quantity: qtd,
          description: itemDados?.description ?? tplTx?.description ?? undefined,
          category: itemDados?.category ?? tplTx?.category ?? undefined,
          location: itemDados?.location, condition: itemDados?.condition,
          weight: itemDados?.weight ?? (tplData.weight as number | undefined),
          data: (() => {
            // Mescla rasa e consciente: dados do template são a base e a
            // personalização do item sobrescreve campo a campo — o schema
            // aplica default {} em item.data, então nunca usar
            // `item.data ?? tplData` ({} não é ausência).
            const mesclado: Record<string, unknown> = { ...tplData, ...(itemDados?.data ?? {}) };
            // Sanitização explícita: templateId nunca é aceito de
            // item.data, item.templateId ou tplData — só tplTx.id
            // (template relido e validado na transação) pode persistir.
            delete mesclado.templateId;
            if (tplTx) mesclado.templateId = tplTx.id;
            // Campos internos sempre definidos pelo servidor.
            mesclado.valueCents = unitCents ?? undefined;
            mesclado.totalValueCents = cents > 0 ? cents : undefined;
            mesclado.aquisicao = {
              formato: "unitario-v1", unitCents, totalCents: cents, qtdOriginal: qtd,
              ...(semPagamento ? { semPagamento: true } : {}),
            };
            mesclado.origem = "compra";
            mesclado.operacaoId = requestId;
            return mesclado;
          })(),
          createdAt: agora, updatedAt: agora,
        }).run();
      }
      if (contaTx) {
        const meta: OperacaoMeta = {
          tipo: isCompra ? "compra" : "venda",
          quantidade: isCompra ? (body.data.quantidade ?? body.data.item?.quantity ?? 1) : qtdVenda,
          valorCents: cents, moeda: contaTx.currency, contaId: contaTx.id,
          itemId: isCompra ? novoItemId : itemTx!.id,
          itemNome: isCompra
            ? (body.data.item?.name ?? (tplTx ? (tplTx as { name?: string }).name : null) ?? null)
            : itemTx!.name,
          ...(semPagamento ? { semPagamento: true } : {}),
          ...(!isCompra && itemTx ? { item: snapshotItem(itemTx) } : {}),
        };
        tx.insert(moneyTransactions).values({
          id: crypto.randomUUID(), characterId: a.personagem.id, campaignId: a.personagem.campaignId,
          kind: isCompra ? "compra" : "venda",
          amount: deCentavos(sinal * cents, casas), currency: contaTx.currency, account: contaTx.type,
          accountId: contaTx.id, amountCents: sinal * cents,
          balanceBeforeCents: contaTx.balanceCents, balanceAfterCents: saldoNovo,
          counterparty: body.data.contraparte ?? (itemTx ? itemTx.name : null),
          description: body.data.descricao ?? (isCompra
            ? `Compra: ${meta.itemNome ?? "item"}`
            : `Venda: ${itemTx?.name ?? "item"}`),
          requestId, inventoryItemId: meta.itemId, operacao: meta,
          createdBy: req.usuario!.id, createdAt: agora,
        }).run();
        tx.update(financialAccounts).set({ balanceCents: saldoNovo, updatedAt: agora }).where(eq(financialAccounts.id, contaTx.id)).run();
      }

      // 4) Baixa de estoque da venda — condicional: só afeta linhas se o
      //    estoque atual ainda comportar a quantidade (corrida perdida
      //    → changes===0 → rollback de tudo).
      if (!isCompra && itemTx) {
        if (qtdVenda >= itemTx.quantity) {
          const del = tx.delete(inventoryEntries)
            .where(and(eq(inventoryEntries.id, itemTx.id), eq(inventoryEntries.quantity, itemTx.quantity)))
            .run();
          if (del.changes !== 1) throw new Error("estoque_mudou");
        } else {
          const upd = tx.update(inventoryEntries)
            .set({ quantity: sql`${inventoryEntries.quantity} - ${qtdVenda}`, updatedAt: agora })
            .where(and(eq(inventoryEntries.id, itemTx.id), gte(inventoryEntries.quantity, qtdVenda)))
            .run();
          if (upd.changes !== 1) throw new Error("estoque_mudou");
        }
      }
      novoSaldo = saldoNovo;
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("UNIQUE")) { res.status(409).json({ erro: "Operação já registrada" }); return; }
    if (msg.includes("conta_sumiu")) { res.status(404).json({ erro: "Conta não encontrada" }); return; }
    if (msg.includes("item_sumiu")) { res.status(404).json({ erro: "Item não encontrado" }); return; }
    if (msg.includes("template_sumiu")) { res.status(404).json({ erro: "Item do catálogo não encontrado ou inativo" }); return; }
    if (msg.includes("estoque_mudou")) { res.status(409).json({ erro: "Estoque alterado por outra operação — tente novamente" }); return; }
    throw e;
  }
  if (operacaoDuplicada) {
    res.status(409).json({ erro: "Operação já registrada (requestId duplicado)" }); return;
  }
  if (saldoInsuficiente) {
    res.status(400).json({ erro: "Saldo insuficiente" });
    return;
  }
  if (estoqueInsuficiente) {
    res.status(400).json({ erro: "Quantidade indisponível no estoque" });
    return;
  }
  await audit(req, "financeiro.operacao", {
    characterId: a.personagem.id, tipo: body.data.tipo, cents: sinal * cents, requestId,
    itemId: body.data.itemId ?? itemCriadoId, templateId: templateValidado,
    semMovimentacao: semPagamento || undefined,
  });
  emitir(a.personagem);
  res.status(201).json({
    ok: true,
    saldo: semPagamento ? null : deCentavos(novoSaldo, casas),
    semMovimentacao: semPagamento || undefined,
  });
});

/**
 * POST /api/characters/:id/financeiro/operacoes/:opId/estornar
 * Estorno atômico de uma compra/venda: reverte o saldo na mesma conta,
 * devolve/remove o item do inventário e registra transação "estorno"
 * com requestId `${opId}:estorno` (idempotente pelo UNIQUE da campanha).
 * Nunca apaga o histórico: a movimentação original permanece.
 */
patrimonioRouter.post("/financeiro/operacoes/:opId/estornar", async (req, res) => {
  const a = await acessoOuErro(req, res); if (!a) return;
  const config = await configPatrimonio(a.personagem.campaignId);
  const cfg = config.financeiro;
  if (!a.ehMestre && !cfg.jogadorCompraVenda) {
    res.status(403).json({ erro: "Operações financeiras não permitidas para jogadores" }); return;
  }
  const opId = req.params.opId;
  const casas = cfg.casasDecimais;

  // Localiza a operação original: requestId = operacaoId. O escopo do
  // personagem é garantido pela rota; a campanha pelo requestId único.
  const [txOriginal] = await db.select().from(moneyTransactions)
    .where(and(
      eq(moneyTransactions.campaignId, a.personagem.campaignId),
      eq(moneyTransactions.requestId, opId),
      eq(moneyTransactions.characterId, a.personagem.id),
    )).limit(1);
  const tipoOriginal = txOriginal && (txOriginal.kind === "compra" || txOriginal.kind === "venda") ? txOriginal.kind : null;
  if (txOriginal && !tipoOriginal) {
    res.status(400).json({ erro: "Apenas compras e vendas podem ser estornadas" }); return;
  }

  // Compra sem pagamento não gera transação: localiza pelo item.
  const [itemSemPag] = txOriginal ? [undefined] : await db.select().from(inventoryEntries)
    .where(and(
      eq(inventoryEntries.characterId, a.personagem.id),
      sql`json_extract(${inventoryEntries.data}, '$.operacaoId') = ${opId}`,
    )).limit(1);
  if (!txOriginal && !itemSemPag) {
    res.status(404).json({ erro: "Operação não encontrada" }); return;
  }
  if (itemSemPag) {
    const dSemPag = (itemSemPag.data ?? {}) as { aquisicao?: { semPagamento?: boolean } };
    if (dSemPag.aquisicao?.semPagamento !== true) {
      res.status(404).json({ erro: "Operação não encontrada" }); return;
    }
  }

  let saldoInsuficiente = false;
  let jaEstornada = false;
  let itemMovimentado = false;
  let semMetadados = false;
  let itemSumiu = false;
  let novoSaldo = 0;
  const agora = new Date();
  const requestIdEstorno = `${opId}:estorno`;

  try {
    db.transaction((tx) => {
      // Idempotência: estorno já registrado para esta operação?
      const [estornoExistente] = tx.select({ id: moneyTransactions.id }).from(moneyTransactions)
        .where(and(eq(moneyTransactions.campaignId, a.personagem.campaignId), eq(moneyTransactions.requestId, requestIdEstorno))).limit(1).all();
      if (estornoExistente) { jaEstornada = true; return; }

      if (!txOriginal) {
        // ---- Estorno de compra sem pagamento: remove o item intacto ----
        const [itemTx] = tx.select().from(inventoryEntries)
          .where(and(eq(inventoryEntries.id, itemSemPag!.id), eq(inventoryEntries.characterId, a.personagem.id)))
          .limit(1).all();
        if (!itemTx) { itemSumiu = true; return; }
        const d = (itemTx.data ?? {}) as { aquisicao?: { qtdOriginal?: number } };
        const qtdOriginal = d.aquisicao?.qtdOriginal ?? itemTx.quantity;
        if (itemTx.quantity !== qtdOriginal) { itemMovimentado = true; return; }
        tx.delete(inventoryEntries).where(eq(inventoryEntries.id, itemTx.id)).run();
        return;
      }

      const meta = (txOriginal.operacao ?? null) as OperacaoMeta | null;
      const amountCents = txOriginal.amountCents ?? 0;
      const contaId = meta?.contaId ?? txOriginal.accountId;
      if (!contaId) throw new Error("sem_conta");

      // Re-lê a conta dentro da transação e valida o piso — o estorno
      // de uma venda pode exigir saldo que já foi gasto.
      const [contaTx] = tx.select().from(financialAccounts)
        .where(and(eq(financialAccounts.id, contaId), eq(financialAccounts.characterId, a.personagem.id)))
        .limit(1).all();
      if (!contaTx) throw new Error("conta_sumiu");
      const saldoNovoTx = contaTx.balanceCents - amountCents; // inverte o sinal do original
      const piso = cfg.permitirSaldoNegativo ? -Infinity : -(contaTx.type === "cartao_credito" ? (contaTx.creditLimitCents ?? 0) : 0);
      if (saldoNovoTx < piso) { saldoInsuficiente = true; return; }

      if (tipoOriginal === "compra") {
        // ---- Estorno de compra: remove as unidades adquiridas ----
        const itemId = meta?.itemId ?? txOriginal.inventoryItemId;
        let itemTx: typeof inventoryEntries.$inferSelect | undefined;
        if (itemId) {
          [itemTx] = tx.select().from(inventoryEntries)
            .where(and(eq(inventoryEntries.id, itemId), eq(inventoryEntries.characterId, a.personagem.id)))
            .limit(1).all();
        }
        if (!itemTx) {
          [itemTx] = tx.select().from(inventoryEntries)
            .where(and(
              eq(inventoryEntries.characterId, a.personagem.id),
              sql`json_extract(${inventoryEntries.data}, '$.operacaoId') = ${opId}`,
            )).limit(1).all();
        }
        if (!itemTx) { itemSumiu = true; return; }
        const d = (itemTx.data ?? {}) as { aquisicao?: { qtdOriginal?: number } };
        const qtd = meta?.quantidade ?? d.aquisicao?.qtdOriginal;
        if (qtd === undefined) { semMetadados = true; return; }
        if (itemTx.quantity < qtd) { itemMovimentado = true; return; }
        if (itemTx.quantity === qtd) {
          tx.delete(inventoryEntries).where(eq(inventoryEntries.id, itemTx.id)).run();
        } else {
          tx.update(inventoryEntries).set({ quantity: itemTx.quantity - qtd, updatedAt: agora }).where(eq(inventoryEntries.id, itemTx.id)).run();
        }
      } else {
        // ---- Estorno de venda: devolve as unidades vendidas ----
        const qtd = meta?.quantidade;
        if (qtd === undefined || !meta?.item) { semMetadados = true; return; }
        const itemId = meta.itemId ?? txOriginal.inventoryItemId;
        let devolvido = false;
        if (itemId) {
          const upd = tx.update(inventoryEntries)
            .set({ quantity: sql`${inventoryEntries.quantity} + ${qtd}`, updatedAt: agora })
            .where(and(eq(inventoryEntries.id, itemId), eq(inventoryEntries.characterId, a.personagem.id)))
            .run();
          devolvido = upd.changes === 1;
        }
        if (!devolvido) {
          // pilha original não existe mais — recria a partir do snapshot
          const snap = meta.item;
          tx.insert(inventoryEntries).values({
            id: crypto.randomUUID(), characterId: a.personagem.id,
            name: snap.name, quantity: qtd,
            description: snap.description ?? null, category: snap.category ?? null,
            location: snap.location ?? null, condition: snap.condition ?? null,
            weight: snap.weight ?? null,
            data: { ...(snap.data ?? {}), estornoDe: opId },
            createdAt: agora, updatedAt: agora,
          }).run();
        }
      }

      // Movimentação de estorno: sinal oposto ao original, mesma conta.
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: a.personagem.id, campaignId: a.personagem.campaignId,
        kind: "estorno",
        amount: deCentavos(-amountCents, casas), currency: contaTx.currency, account: contaTx.type,
        accountId: contaTx.id, amountCents: -amountCents,
        balanceBeforeCents: contaTx.balanceCents, balanceAfterCents: saldoNovoTx,
        counterparty: "Estorno",
        description: `Estorno ${tipoOriginal}: ${meta?.itemNome ?? txOriginal.description ?? ""}`.trim(),
        requestId: requestIdEstorno, inventoryItemId: meta?.itemId ?? txOriginal.inventoryItemId ?? null,
        operacao: { estornoDe: opId, tipo: "estorno", operacaoOriginal: meta },
        createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: saldoNovoTx, updatedAt: agora }).where(eq(financialAccounts.id, contaTx.id)).run();
      novoSaldo = saldoNovoTx;
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("UNIQUE")) { jaEstornada = true; }
    else if (msg.includes("conta_sumiu")) { res.status(404).json({ erro: "Conta não encontrada" }); return; }
    else if (msg.includes("sem_conta")) { res.status(400).json({ erro: "Operação sem conta vinculada" }); return; }
    else throw e;
  }
  if (jaEstornada) { res.status(409).json({ erro: "Operação já estornada" }); return; }
  if (saldoInsuficiente) { res.status(400).json({ erro: "Saldo insuficiente para estornar (valor já utilizado)" }); return; }
  if (itemMovimentado) { res.status(409).json({ erro: "Item já foi movimentado/vendido — estorno indisponível, ajuste manual necessário" }); return; }
  if (semMetadados) { res.status(409).json({ erro: "Operação antiga sem metadados de estorno — ajuste manual necessário" }); return; }
  if (itemSumiu) { res.status(409).json({ erro: "Item não está mais no inventário — estorno indisponível" }); return; }

  await audit(req, "financeiro.operacao.estornada", {
    characterId: a.personagem.id, opId, tipo: tipoOriginal ?? "compra_sem_pagamento",
    semMovimentacao: !txOriginal || undefined,
  });
  emitir(a.personagem);
  res.json({ ok: true, saldo: txOriginal ? deCentavos(novoSaldo, casas) : null, semMovimentacao: !txOriginal || undefined });
});
