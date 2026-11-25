// Gate de Internet aplicado fora das rotas HTTP: mesmo cálculo fail-closed
// de lib/internet.ts, com carga de estrutura/regras/patrimônio do banco.
// Usado pelas rotas de comércio (leituras/mutações gated) e pelo realtime
// (inscrição na sala Internet + revalidação antes de cada entrega).
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  characters, inventoryEntries, equipmentEntries, itemTemplates, sheetVersions, memberships,
} from "../db/schema.js";
import { carregarRegras } from "./regras.js";
import { avaliarElegibilidadeInternet, chaveItemDe } from "./internet.js";
import { estruturaFichaSchema, type EstruturaFicha } from "./ficha.js";

const db = getDb();

const ESTRUTURA_VAZIA = { versao: 1, secoes: [], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } } as EstruturaFicha;

async function estruturaDoPersonagem(p: typeof characters.$inferSelect): Promise<EstruturaFicha> {
  if (!p.templateVersionId) return ESTRUTURA_VAZIA;
  const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, p.templateVersionId)).limit(1);
  if (!v) return ESTRUTURA_VAZIA;
  const parse = estruturaFichaSchema.safeParse(v.structure);
  return parse.success ? parse.data : ESTRUTURA_VAZIA;
}

/** Gate Internet fail-closed: estrutura+regras+patrimonio do personagem.
 *  Resolve templateId→catálogo (data.regra.key do template) para que item
 *  comprado de template de dispositivo também habilite — mesma regra da UI. */
export async function gateInternetDoPersonagem(p: typeof characters.$inferSelect) {
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

/** Personagem existe, não arquivado e passa no gate cumulativo.
 *  Usado na inscrição realtime e na revalidação antes de cada entrega. */
export async function personagemElegivelInternet(characterId: string): Promise<boolean> {
  const [p] = await db.select().from(characters).where(eq(characters.id, characterId)).limit(1);
  if (!p || p.status === "arquivado") return false;
  return (await gateInternetDoPersonagem(p)).elegivel;
}

/**
 * Revalida a autorização completa do socket Internet em cada entrega:
 * membership ativa na campanha + titularidade atual (ou mestre) + gate
 * cumulativo. Impede que um ex-dono continue recebendo eventos depois de
 * uma transferência de personagem durante uma sessão já conectada.
 */
export async function personagemAutorizadoInternet(characterId: string, userId: string): Promise<boolean> {
  const [p] = await db.select().from(characters).where(eq(characters.id, characterId)).limit(1);
  if (!p || p.status === "arquivado") return false;

  const [m] = await db.select({ role: memberships.role }).from(memberships)
    .where(and(
      eq(memberships.campaignId, p.campaignId),
      eq(memberships.userId, userId),
      eq(memberships.status, "ativo"),
    ))
    .limit(1);
  if (!m) return false;

  if (m.role !== "mestre") {
    const [dono] = await db.select({ userId: memberships.userId }).from(memberships)
      .where(and(
        eq(memberships.id, p.membershipId),
        eq(memberships.campaignId, p.campaignId),
        eq(memberships.status, "ativo"),
      ))
      .limit(1);
    if (dono?.userId !== userId) return false;
  }

  return (await gateInternetDoPersonagem(p)).elegivel;
}
