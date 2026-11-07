import { and, eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db/index.js";
import { memberships } from "../db/schema.js";

export type PapelCampanha = "mestre" | "jogador" | "espectador";
export type StatusMembro = "pendente" | "ativo" | "bloqueado" | "removido";

export interface MembershipInfo {
  id: string;
  campaignId: string;
  userId: string;
  role: PapelCampanha;
  status: StatusMembro;
  permissions: unknown;
}

const db = getDb();

export async function getMembership(
  campaignId: string,
  userId: string
): Promise<MembershipInfo | null> {
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId)))
    .limit(1);
  if (!m) return null;
  return {
    id: m.id,
    campaignId: m.campaignId,
    userId: m.userId,
    role: m.role as PapelCampanha,
    status: m.status as StatusMembro,
    permissions: m.permissions,
  };
}

/**
 * Middleware: exige que o usuário autenticado seja membro ativo da campanha
 * com um dos papéis informados. Admin global NÃO tem acesso automático
 * (spec §4: ser admin não torna mestre de todas as campanhas).
 */
export function requirePapel(...papeis: PapelCampanha[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    const campaignId = req.params.campaignId ?? req.params.id;
    if (!usuario || !campaignId) {
      res.status(401).json({ erro: "Não autenticado" });
      return;
    }
    const m = await getMembership(campaignId, usuario.id);
    if (!m || m.status !== "ativo" || !papeis.includes(m.role)) {
      res.status(403).json({ erro: "Sem permissão nesta campanha" });
      return;
    }
    req.membership = m;
    next();
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      membership?: MembershipInfo;
    }
  }
}

/** Conta mestres ativos de uma campanha (para impedir campanha sem responsável). */
export async function contarMestres(campaignId: string): Promise<number> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.campaignId, campaignId),
        eq(memberships.role, "mestre"),
        eq(memberships.status, "ativo")
      )
    );
  return rows.length;
}
