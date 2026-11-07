import { Router } from "express";
import { eq, count } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { users, authSessions } from "../db/schema.js";
import { hashSenha, verificarSenha, gerarToken, hashToken } from "../lib/password.js";
import {
  requireAuth,
  definirCookieSessao,
  limparCookieSessao,
  resolverUsuario,
  extrairCookie,
  COOKIE_SESSAO,
} from "../middleware/auth.js";
import { limitador, limiteUsuario } from "../lib/ratelimit.js";

const db = getDb();
export const authRouter = Router();

const DURACAO_SESSAO_MS = 30 * 24 * 3600 * 1000;

// Rate limit (Etapa 15, R4): 10 tentativas/5min por IP efetivo + 20/5min por
// username — rotacionar X-Forwarded-For não permite força bruta ilimitada
// numa conta específica. O limitador envia Retry-After junto com o 429.
const limiteLoginIp = limitador({ nome: "login-ip", janelaMs: 5 * 60_000, max: 10 });
const limiteLoginUsuario = limitador({
  nome: "login-user",
  janelaMs: 5 * 60_000,
  max: 20,
  chave: (req) => `user:${String(req.body?.username ?? "").toLowerCase().slice(0, 64) || "?"}`,
});
const limiteTrocaSenha = limiteUsuario({ nome: "troca-senha", janelaMs: 5 * 60_000, max: 10 });

const credenciaisSchema = z.object({
  username: z.string().min(3).max(40),
  password: z.string().min(8).max(200),
});

/**
 * POST /api/auth/setup — cria a conta administrativa inicial.
 * Só funciona enquanto não existir nenhum admin (spec §2/§3).
 */
authRouter.post("/setup", async (req, res) => {
  const [{ total }] = await db.select({ total: count() }).from(users).where(eq(users.isAdmin, true));
  if (total > 0) {
    res.status(403).json({ erro: "A conta administrativa já foi criada." });
    return;
  }
  const body = credenciaisSchema
    .extend({ displayName: z.string().max(80).optional(), email: z.string().email().optional() })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const { username, password, displayName, email } = body.data;
  const [existente] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existente) {
    res.status(409).json({ erro: "Nome de usuário já está em uso" });
    return;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username,
    email: email ?? null,
    displayName: displayName ?? null,
    passwordHash: await hashSenha(password),
    isAdmin: true,
    status: "ativo",
    createdAt: agora,
    updatedAt: agora,
  });
  res.status(201).json({ ok: true, id });
});

/** POST /api/auth/login */
authRouter.post("/login", limiteLoginIp, limiteLoginUsuario, async (req, res) => {
  const body = credenciaisSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Usuário e senha são obrigatórios" });
    return;
  }
  const ip = req.ip ?? "desconhecido";
  const { username, password } = body.data;
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const senhaOk = user ? await verificarSenha(password, user.passwordHash) : false;
  if (!user || !senhaOk) {
    res.status(401).json({ erro: "Credenciais inválidas" });
    return;
  }
  if (user.status !== "ativo") {
    res.status(403).json({ erro: "Conta bloqueada. Fale com o administrador." });
    return;
  }

  const token = gerarToken();
  const agora = new Date();
  await db.insert(authSessions).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: hashToken(token),
    userAgent: req.headers["user-agent"] ?? null,
    ip,
    expiresAt: new Date(agora.getTime() + DURACAO_SESSAO_MS),
    createdAt: agora,
  });
  definirCookieSessao(res, token, req);
  res.json({
    usuario: {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
    },
  });
});

/** POST /api/auth/logout */
authRouter.post("/logout", requireAuth, async (req, res) => {
  const auth = req.headers.authorization;
  const cookie = extrairCookie(req.headers.cookie, COOKIE_SESSAO);
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : cookie;
  if (token) {
    await db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
  }
  limparCookieSessao(res);
  res.json({ ok: true });
});

/** GET /api/auth/me */
authRouter.get("/me", async (req, res) => {
  const usuario = await resolverUsuario(req);
  if (!usuario) {
    res.status(401).json({ erro: "Não autenticado" });
    return;
  }
  res.json({ usuario });
});

const senhaSchema = z.object({ senhaAtual: z.string().min(1), novaSenha: z.string().min(8).max(200) });

/** POST /api/auth/change-password */
authRouter.post("/change-password", requireAuth, limiteTrocaSenha, async (req, res) => {
  const body = senhaSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Senha atual e nova senha (mín. 8 caracteres) são obrigatórias" });
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, req.usuario!.id)).limit(1);
  if (!user || !(await verificarSenha(body.data.senhaAtual, user.passwordHash))) {
    res.status(400).json({ erro: "Senha atual incorreta" });
    return;
  }
  await db
    .update(users)
    .set({ passwordHash: await hashSenha(body.data.novaSenha), updatedAt: new Date() })
    .where(eq(users.id, user.id));
  res.json({ ok: true });
});
