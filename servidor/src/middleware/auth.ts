import type { Request, Response, NextFunction } from "express";
import { eq, and, gt } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { authSessions, users } from "../db/schema.js";
import { hashToken } from "../lib/password.js";

export const COOKIE_SESSAO = "mestre_rpg_session";
const db = getDb();

export interface UsuarioAutenticado {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
  preferences?: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioAutenticado;
      sessaoId?: string;
    }
  }
}

export function extrairCookie(header: string | undefined, nome: string): string | undefined {
  if (!header) return undefined;
  for (const parte of header.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined; // percent-encoding malformado → trata como ausente
      }
    }
  }
  return undefined;
}

export function definirCookieSessao(res: Response, token: string, req: Request) {
  // req.secure já considera trust proxy + X-Forwarded-Proto: Secure só é
  // emitido quando a conexão é realmente HTTPS (direta ou via proxy
  // confiável) — o header cru não é confiável por si só (Fase 6).
  const seguro = req.secure;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_SESSAO}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${seguro ? "; Secure" : ""}`
  );
}

export function limparCookieSessao(res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE_SESSAO}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Resolve o usuário a partir do cookie de sessão (ou header Authorization: Bearer). */
export async function resolverUsuario(req: Request): Promise<UsuarioAutenticado | null> {
  let token: string | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) token = auth.slice(7);
  if (!token) token = extrairCookie(req.headers.cookie, COOKIE_SESSAO);
  if (!token) return null;

  const [sessao] = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, new Date())))
    .limit(1);
  if (!sessao) return null;

  const [user] = await db.select().from(users).where(eq(users.id, sessao.userId)).limit(1);
  if (!user || user.status !== "ativo") return null;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    preferences: (user.preferences ?? {}) as Record<string, unknown>,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const usuario = await resolverUsuario(req);
  if (!usuario) {
    res.status(401).json({ erro: "Não autenticado" });
    return;
  }
  req.usuario = usuario;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, () => {
    if (!req.usuario?.isAdmin) {
      res.status(403).json({ erro: "Acesso restrito ao administrador" });
      return;
    }
    next();
  });
}

/** Para o handshake do Socket.IO: devolve o usuário autenticado ou null. */
export async function autenticarHandshake(
  cookieHeader: string | undefined,
  authorization: string | undefined
): Promise<UsuarioAutenticado | null> {
  const req = {
    headers: { cookie: cookieHeader, authorization },
  } as Request;
  return resolverUsuario(req);
}
