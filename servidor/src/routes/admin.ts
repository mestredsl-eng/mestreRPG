import { Router } from "express";
import { eq, ne, asc } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { users, authSessions } from "../db/schema.js";
import { hashSenha, gerarToken, hashToken } from "../lib/password.js";
import { requireAdmin } from "../middleware/auth.js";

const db = getDb();
export const adminRouter = Router();
adminRouter.use(requireAdmin);

const novoUsuarioSchema = z.object({
  username: z.string().min(3).max(40),
  email: z.string().email().optional().or(z.literal("")),
  displayName: z.string().max(80).optional(),
  password: z.string().min(8).max(200),
  isAdmin: z.boolean().optional(),
});

function usuarioPublico(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    isAdmin: u.isAdmin,
    status: u.status,
    createdAt: u.createdAt,
  };
}

/** GET /api/admin/users — lista contas */
adminRouter.get("/users", async (_req, res) => {
  const lista = await db.select().from(users).orderBy(asc(users.username));
  res.json({ usuarios: lista.map(usuarioPublico) });
});

/** POST /api/admin/users — cria usuário (mestre/jogador/etc.; papel de campanha vem depois) */
adminRouter.post("/users", async (req, res) => {
  const body = novoUsuarioSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const { username, email, displayName, password, isAdmin } = body.data;
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
    email: email || null,
    displayName: displayName || null,
    passwordHash: await hashSenha(password),
    isAdmin: isAdmin ?? false,
    status: "ativo",
    createdAt: agora,
    updatedAt: agora,
  });
  const [criado] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  res.status(201).json({ usuario: usuarioPublico(criado) });
});

const atualizarSchema = novoUsuarioSchema.partial().extend({
  status: z.enum(["ativo", "bloqueado"]).optional(),
});

/** PATCH /api/admin/users/:id — edita, bloqueia/desbloqueia */
adminRouter.patch("/users/:id", async (req, res) => {
  const id = req.params.id;
  if (id === req.usuario!.id) {
    res.status(400).json({ erro: "Você não pode alterar a própria conta por aqui" });
    return;
  }
  const body = atualizarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const [alvo] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!alvo) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }
  const { username, email, displayName, password, isAdmin, status } = body.data;
  const dados: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (username !== undefined) dados.username = username;
  if (email !== undefined) dados.email = email || null;
  if (displayName !== undefined) dados.displayName = displayName || null;
  if (isAdmin !== undefined) dados.isAdmin = isAdmin;
  if (status !== undefined) dados.status = status;
  if (password !== undefined) dados.passwordHash = await hashSenha(password);

  if (username && username !== alvo.username) {
    const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (dup) {
      res.status(409).json({ erro: "Nome de usuário já está em uso" });
      return;
    }
  }
  await db.update(users).set(dados).where(eq(users.id, id));

  // Bloqueio ou troca de senha → derruba sessões ativas do usuário
  if (status === "bloqueado" || password !== undefined) {
    await db.delete(authSessions).where(eq(authSessions.userId, id));
  }
  const [atualizado] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  res.json({ usuario: usuarioPublico(atualizado) });
});

/** DELETE /api/admin/users/:id — remove conta (sem campanhas associadas nesta etapa) */
adminRouter.delete("/users/:id", async (req, res) => {
  const id = req.params.id;
  if (id === req.usuario!.id) {
    res.status(400).json({ erro: "Você não pode remover a própria conta" });
    return;
  }
  const [alvo] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!alvo) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }
  await db.delete(users).where(eq(users.id, id)); // cascade remove auth_sessions
  res.json({ ok: true });
});
