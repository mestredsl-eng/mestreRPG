import type { Request } from "express";
import { getDb } from "../db/index.js";
import { auditLogs } from "../db/schema.js";

const db = getDb();

/** Registra ação administrativa/importante (spec §24 — registros de alterações). */
export async function audit(req: Request, action: string, detail?: unknown) {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId: req.usuario?.id ?? null,
      campaignId: (req.params.campaignId as string) ?? null,
      action,
      detail: detail ?? null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error("[audit] falha ao registrar:", e);
  }
}
