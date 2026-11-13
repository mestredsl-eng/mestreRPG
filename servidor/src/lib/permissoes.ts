import { and, eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { memberships } from "../db/schema.js";
import { adquirirOperacaoCampanha } from "./io.js";

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
    // Lease de operação para MUTATIONS HTTP: o lease é mantido até a
    // resposta terminar (finish/close) — cobre leitura, validação,
    // gravação e emissões do ciclo inteiro. A restauração drena estes
    // leases antes de capturar o estado. Rotas que gerenciam a própria
    // barreira (restaurar/importar) são excluídas para não deadlockar.
    if (req.method !== "GET" && !/restaurar|importar/i.test(req.path)) {
      const liberar = adquirirOperacaoCampanha(campaignId);
      if (!liberar) {
        res.status(409).json({ erro: "Campanha em restauração — tente novamente em instantes" });
        return;
      }
      const soltar = () => liberar();
      res.on("finish", soltar);
      res.on("close", soltar);
    }
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

// ---- Permissões individuais do membro (Etapa 13 — modo espectador) ----

export interface PermissoesMembro {
  /** Espectador pode enviar mensagens no chat (padrão: não). */
  enviarMensagens?: boolean;
  /** Espectador pode ver a biblioteca de arquivos (padrão: sim, se a campanha permitir). */
  verBiblioteca?: boolean;
  /** Espectador pode consultar o histórico detalhado de sessões (padrão: sim). */
  verHistorico?: boolean;
}

export const permissoesMembroSchema = z.object({
  enviarMensagens: z.boolean().optional(),
  verBiblioteca: z.boolean().optional(),
  verHistorico: z.boolean().optional(),
}).strict();

/** Lê as permissões do membro de forma segura (JSON arbitrário → objeto tipado). */
export function permissoesDe(m: { permissions: unknown } | null | undefined): PermissoesMembro {
  const p = m?.permissions;
  if (!p || typeof p !== "object" || Array.isArray(p)) return {};
  return p as PermissoesMembro;
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
