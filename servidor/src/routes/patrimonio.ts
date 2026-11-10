import { Router, type Request } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
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
  const d = somenteEnviados(body.data, req.body);
  if (!a.ehMestre) {
    const dadosItem = (item.data ?? {}) as { transferable?: boolean };
    if (d.quantity !== undefined && d.quantity <= 0) {
      if (!config.patrimonio.jogadorRemoveItens) { res.status(403).json({ erro: "Você não pode remover itens nesta campanha" }); return; }
    } else if (!config.patrimonio.jogadorAdicionaItens) {
      res.status(403).json({ erro: "Edição de itens não permitida" }); return;
    }
    void dadosItem;
  }
  const { data, valueCents, transferable, ...resto } = d;
  const dataAtual = (item.data ?? {}) as Record<string, unknown>;
  await db.update(inventoryEntries).set({
    ...resto,
    quantity: d.quantity ?? item.quantity,
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
  const dadosItem = (item.data ?? {}) as { transferable?: boolean };
  if (dadosItem.transferable === false && !a.ehMestre) {
    res.status(403).json({ erro: "Este item não pode ser transferido" }); return;
  }
  const [destino] = await db.select().from(characters).where(eq(characters.id, body.data.destinoCharacterId)).limit(1);
  if (!destino || destino.campaignId !== a.personagem.campaignId || destino.id === a.personagem.id) {
    res.status(400).json({ erro: "Destino inválido" }); return;
  }
  const qtdPedida = body.data.quantidade;

  // Releitura do item, verificação de vínculos/equipado e mutação na
  // MESMA transação — um equipar concorrente não cria vínculo no meio
  // da transferência, e vice-versa.
  let falha: "sumiu" | "qtd" | "equipado" | "vinculado" | null = null;
  await db.transaction((tx) => {
    const [itemTx] = tx.select().from(inventoryEntries)
      .where(and(eq(inventoryEntries.id, item.id), eq(inventoryEntries.characterId, a.personagem.id)))
      .limit(1).all();
    if (!itemTx) { falha = "sumiu"; return; }
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
  } else if (!body.data.item) {
    res.status(400).json({ erro: "Compra requer dados do item" }); return;
  }

  const requestId = body.data.requestId ?? crypto.randomUUID();
  const agora = new Date();
  let novoSaldo = 0;
  let saldoInsuficiente = false;
  let estoqueInsuficiente = false;
  try {
    db.transaction((tx) => {
      // 1) Re-lê a conta dentro da transação: saldo calculado sobre o
      // valor atual, nunca sobre leitura anterior (evita lost update).
      const [contaTx] = tx.select().from(financialAccounts)
        .where(and(eq(financialAccounts.id, body.data.accountId), eq(financialAccounts.characterId, a.personagem.id)))
        .limit(1).all();
      if (!contaTx) throw new Error("conta_sumiu");
      const saldoNovo = contaTx.balanceCents + sinal * cents;
      const piso = cfg.permitirSaldoNegativo ? -Infinity : -(contaTx.type === "cartao_credito" ? (contaTx.creditLimitCents ?? 0) : 0);
      if (saldoNovo < piso) { saldoInsuficiente = true; return; }

      // 2) Re-lê o item dentro da transação (venda): estoque atual.
      let itemTx: typeof inventoryEntries.$inferSelect | null = null;
      let qtdVenda = 0;
      if (!isCompra) {
        const [it] = tx.select().from(inventoryEntries)
          .where(and(eq(inventoryEntries.id, body.data.itemId!), eq(inventoryEntries.characterId, a.personagem.id)))
          .limit(1).all();
        if (!it) throw new Error("item_sumiu");
        qtdVenda = body.data.quantidade ?? it.quantity;
        if (qtdVenda > it.quantity) { estoqueInsuficiente = true; return; }
        itemTx = it;
      }

      // 3) Movimentação financeira (requestId → idempotência por UNIQUE)
      tx.insert(moneyTransactions).values({
        id: crypto.randomUUID(), characterId: a.personagem.id, campaignId: a.personagem.campaignId,
        kind: isCompra ? "compra" : "venda",
        amount: (sinal * cents) / 100, currency: contaTx.currency, account: contaTx.type,
        accountId: contaTx.id, amountCents: sinal * cents,
        balanceBeforeCents: contaTx.balanceCents, balanceAfterCents: saldoNovo,
        counterparty: body.data.contraparte ?? null,
        description: body.data.descricao ?? (isCompra ? "Compra" : "Venda"),
        requestId, createdBy: req.usuario!.id, createdAt: agora,
      }).run();
      tx.update(financialAccounts).set({ balanceCents: saldoNovo, updatedAt: agora }).where(eq(financialAccounts.id, contaTx.id)).run();

      // 4) Inventário
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
      } else if (itemTx) {
        // Baixa condicional: só afeta linhas se o estoque atual ainda
        // comportar a quantidade — changes===0 indica corrida perdida.
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
    if (msg.includes("estoque_mudou")) { res.status(409).json({ erro: "Estoque alterado por outra operação — tente novamente" }); return; }
    throw e;
  }
  if (saldoInsuficiente) {
    res.status(400).json({ erro: "Saldo insuficiente" });
    return;
  }
  if (estoqueInsuficiente) {
    res.status(400).json({ erro: "Quantidade indisponível no estoque" });
    return;
  }
  await audit(req, "financeiro.operacao", { characterId: a.personagem.id, tipo: body.data.tipo, cents: sinal * cents });
  emitir(a.personagem);
  res.status(201).json({ ok: true, saldo: deCentavos(novoSaldo, casas) });
});
