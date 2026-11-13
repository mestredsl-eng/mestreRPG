import { Router } from "express";
import { eq, ne, and, asc } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { users, authSessions } from "../db/schema.js";
import { hashSenha, gerarToken, hashToken } from "../lib/password.js";
import { requireAdmin } from "../middleware/auth.js";
import { ehAdminPrincipal, idAdminPrincipal } from "../lib/adminPrincipal.js";
import { desconectarUsuario } from "../lib/io.js";
import { audit } from "../lib/audit.js";
import { guildMembers, guilds } from "../db/schema.js";

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

function usuarioPublico(u: typeof users.$inferSelect, adminPrincipalId: string | null = null) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    isAdmin: u.isAdmin,
    adminPrincipal: u.id === adminPrincipalId,
    status: u.status,
    createdAt: u.createdAt,
  };
}

/** GET /api/admin/users — lista contas (com guildas onde cada um é GM ativo) */
adminRouter.get("/users", async (req, res) => {
  const [lista, principalId, gms] = await Promise.all([
    db.select().from(users).orderBy(asc(users.username)),
    idAdminPrincipal(),
    db
      .select({ userId: guildMembers.userId, guildId: guilds.id, nome: guilds.name })
      .from(guildMembers)
      .innerJoin(guilds, eq(guildMembers.guildId, guilds.id))
      .where(and(eq(guildMembers.role, "gm"), eq(guildMembers.status, "ativo"), eq(guilds.status, "ativa"))),
  ]);
  const gmPorUsuario = new Map<string, { guildId: string; nome: string }[]>();
  for (const g of gms) {
    const arr = gmPorUsuario.get(g.userId) ?? [];
    arr.push({ guildId: g.guildId, nome: g.nome });
    gmPorUsuario.set(g.userId, arr);
  }
  res.json({
    usuarios: lista.map((u) => ({ ...usuarioPublico(u, principalId), gmDe: gmPorUsuario.get(u.id) ?? [] })),
    souAdminPrincipal: req.usuario?.id === principalId,
  });
});

/** POST /api/admin/users — cria usuário (mestre/jogador/etc.; papel de campanha vem depois) */
adminRouter.post("/users", async (req, res) => {
  const body = novoUsuarioSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const { username, email, displayName, password, isAdmin } = body.data;
  // Privilégio administrativo global é exclusivo da conta protegida
  // (admin_principal + triggers). Nenhum fluxo cria outro admin.
  if (isAdmin === true) {
    res.status(400).json({ erro: "Somente a conta administradora original pode ser administradora" });
    return;
  }
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
    isAdmin: false,
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
  const alvoProtegido = await ehAdminPrincipal(alvo.id);
  // Multi-ADMIN (Issue #65): somente o ADMIN principal concede/revoga o
  // privilégio global; o alvo nunca pode ser a própria conta raiz.
  if (isAdmin !== undefined) {
    if (!(await ehAdminPrincipal(req.usuario!.id))) {
      res.status(403).json({ erro: "Somente o administrador principal pode conceder ou revogar ADMIN" });
      return;
    }
    if (alvoProtegido) {
      res.status(403).json({ erro: "O privilégio do administrador principal não pode ser alterado" });
      return;
    }
    if (isAdmin === alvo.isAdmin) {
      res.status(400).json({ erro: "O usuário já possui este privilégio" });
      return;
    }
  }
  if (alvoProtegido && status === "bloqueado") {
    res.status(403).json({ erro: "A conta administradora original não pode ser bloqueada" });
    return;
  }
  const dados: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (username !== undefined) dados.username = username;
  if (email !== undefined) dados.email = email || null;
  if (displayName !== undefined) dados.displayName = displayName || null;
  if (status !== undefined) dados.status = status;
  if (password !== undefined) dados.passwordHash = await hashSenha(password);
  if (isAdmin !== undefined) dados.isAdmin = isAdmin;

  if (username && username !== alvo.username) {
    const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (dup) {
      res.status(409).json({ erro: "Nome de usuário já está em uso" });
      return;
    }
  }
  await db.update(users).set(dados).where(eq(users.id, id));

  // Trilha de auditoria da concessão/revogação de ADMIN (Issue #65).
  if (isAdmin !== undefined) {
    await audit(req, isAdmin ? "admin.conceder" : "admin.revogar", { userId: id, username: alvo.username });
  }

  // Bloqueio, troca de senha ou REVOGAÇÃO de ADMIN → derruba sessões
  // ativas do usuário (HTTP e sockets — sessões revogadas não podem
  // continuar conectadas; o privilégio reduzido vale já, sem reload).
  if (status === "bloqueado" || password !== undefined || isAdmin === false) {
    await db.delete(authSessions).where(eq(authSessions.userId, id));
    desconectarUsuario(id);
  }
  const [atualizado] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  res.json({ usuario: usuarioPublico(atualizado, await idAdminPrincipal()) });
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
  if (await ehAdminPrincipal(alvo.id)) {
    res.status(403).json({ erro: "A conta administradora original não pode ser excluída" });
    return;
  }
  try {
    await db.delete(users).where(eq(users.id, id)); // cascade remove auth_sessions/memberships
    desconectarUsuario(id);
  } catch (e) {
    // O usuário é referenciado por histórico que deve ser preservado
    // (mensagens de chat, campanhas, arquivos, anotações etc.) — FKs sem cascade.
    if (String(e).includes("FOREIGN KEY")) {
      res.status(409).json({
        erro: "Conta possui histórico vinculado a campanhas (mensagens, arquivos, anotações ou registros). Para preservar o histórico, bloqueie a conta em vez de excluí-la.",
      });
      return;
    }
    throw e;
  }
  res.json({ ok: true });
});
