import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { campaigns, snapshots } from "../db/schema.js";
import { exportarCampanha } from "./estado.js";

const db = getDb();

/** Janela de debounce: mudanças em sequência geram um único snapshot automático. */
const DEBOUNCE_MS = 15_000;
/** Quantos snapshots automáticos manter por campanha (os mais antigos são removidos). */
const MAX_AUTOMATICOS = 20;

const pendentes = new Map<string, NodeJS.Timeout>();
const emAndamento = new Set<string>();

/**
 * Agenda um snapshot automático da campanha (Etapa 12 — salvamento automático).
 * Chamado a partir de emitirCampanha: qualquer mutação visível por socket agenda
 * um ponto de recuperação; rajadas de eventos colapsam numa única gravação.
 */
export function agendarAutosave(campaignId: string) {
  const atual = pendentes.get(campaignId);
  if (atual) clearTimeout(atual);
  pendentes.set(campaignId, setTimeout(() => {
    pendentes.delete(campaignId);
    void executarAutosave(campaignId).catch((e) => console.error("[autosave] falha:", e));
  }, DEBOUNCE_MS));
  // não segura o processo vivo só por causa do autosave
  pendentes.get(campaignId)!.unref?.();
}

async function executarAutosave(campaignId: string) {
  if (emAndamento.has(campaignId)) return;
  emAndamento.add(campaignId);
  try {
    const dados = await exportarCampanha(campaignId);
    const [campanha] = await db.select({ ownerId: campaigns.ownerId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campanha) return;
    const id = crypto.randomUUID();
    await db.insert(snapshots).values({
      id, campaignId, kind: "automatico",
      description: `Automático — ${new Date().toLocaleString("pt-BR")}`,
      data: dados as never, createdBy: campanha.ownerId,
      createdAt: new Date(),
    });
    // retenção: mantém apenas os MAX_AUTOMATICOS mais recentes
    const antigos = await db.select({ id: snapshots.id }).from(snapshots)
      .where(and(eq(snapshots.campaignId, campaignId), eq(snapshots.kind, "automatico")))
      .orderBy(desc(snapshots.createdAt));
    for (const s of antigos.slice(MAX_AUTOMATICOS)) {
      await db.delete(snapshots).where(eq(snapshots.id, s.id));
    }
  } finally {
    emAndamento.delete(campaignId);
  }
}
