import { and, eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db/index.js";
import { guildMembers, guilds } from "../db/schema.js";
import { ehAdminPrincipal, idAdminPrincipal } from "./adminPrincipal.js";

const db = getDb();

export type PapelGuilda = "gm" | "membro";

export interface GuildMembershipInfo {
  id: string;
  guildId: string;
  userId: string;
  role: PapelGuilda;
  status: string;
}

/** Vínculo ativo do usuário com a guilda (qualquer papel), ou null. */
export async function getGuildMembership(
  guildId: string,
  userId: string
): Promise<GuildMembershipInfo | null> {
  const [m] = await db
    .select()
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .limit(1);
  if (!m || m.status !== "ativo") return null;
  return {
    id: m.id,
    guildId: m.guildId,
    userId: m.userId,
    role: m.role as PapelGuilda,
    status: m.status,
  };
}

/** O usuário é GM ativo da guilda informada? */
export async function ehGM(guildId: string, userId: string): Promise<boolean> {
  const m = await getGuildMembership(guildId, userId);
  return m?.role === "gm";
}

/** O usuário é ADMIN global da plataforma (is_admin = true). */
export function ehAdmin(req: Request): boolean {
  return req.usuario?.isAdmin === true;
}

/** O usuário é o ADMIN principal/root protegido pela instalação. */
export async function ehAdminPrincipalReq(req: Request): Promise<boolean> {
  if (!req.usuario) return false;
  return ehAdminPrincipal(req.usuario.id);
}

/** Guildas ativas das quais o usuário é membro, com o papel efetivo. */
export async function guildasDoUsuario(userId: string) {
  const rows = await db
    .select({ guild: guilds, membership: guildMembers })
    .from(guildMembers)
    .innerJoin(guilds, eq(guildMembers.guildId, guilds.id))
    .where(and(eq(guildMembers.userId, userId), eq(guildMembers.status, "ativo")))
    .orderBy(guilds.name);
  return rows
    .filter((r) => r.guild.status === "ativa")
    .map((r) => ({
      guildId: r.guild.id,
      nome: r.guild.name,
      role: r.membership.role,
      souGM: r.membership.role === "gm",
    }));
}

/** Contagem de GMs ativos da guilda (proteção do último GM). */
export async function contarGMs(guildId: string): Promise<number> {
  const rows = await db
    .select({ id: guildMembers.id })
    .from(guildMembers)
    .where(
      and(
        eq(guildMembers.guildId, guildId),
        eq(guildMembers.role, "gm"),
        eq(guildMembers.status, "ativo")
      )
    );
  return rows.length;
}

/**
 * Middleware: leitura de guilda — membro ativo OU admin global.
 * `req.guildMembership` recebe o vínculo quando existir.
 */
export function requireGuildAcesso() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    const guildId = req.params.guildId;
    if (!usuario || !guildId) {
      res.status(401).json({ erro: "Não autenticado" });
      return;
    }
    const m = await getGuildMembership(guildId, usuario.id);
    if (!m && !usuario.isAdmin) {
      res.status(403).json({ erro: "Sem acesso a esta guilda" });
      return;
    }
    req.guildMembership = m ?? undefined;
    next();
  };
}

/**
 * Middleware: gestão de guilda — GM ativo DA guilda OU admin global.
 * GM de outra guilda recebe 403 (IDOR fechado no backend).
 */
export function requireGuildGestao() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    const guildId = req.params.guildId;
    if (!usuario || !guildId) {
      res.status(401).json({ erro: "Não autenticado" });
      return;
    }
    const m = await getGuildMembership(guildId, usuario.id);
    const pode = usuario.isAdmin || m?.role === "gm";
    if (!pode) {
      res.status(403).json({ erro: "Sem permissão de gestão nesta guilda" });
      return;
    }
    req.guildMembership = m ?? undefined;
    next();
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      guildMembership?: GuildMembershipInfo;
    }
  }
}
