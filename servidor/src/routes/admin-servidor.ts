import { Router } from "express";
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, CAMINHOS, RAIZ } from "../db/index.js";
import { backups, campaigns, serverSettings, users, sessions, authSessions } from "../db/schema.js";
import { requireAdmin } from "../middleware/auth.js";
import { audit } from "../lib/audit.js";
import { log, lerLogs } from "../lib/logs.js";
import { criarBackup, listarBackups, verificarBackup, prepararRestauracao, getConfigBackup, setConfigBackup, BACKUP_PADRAO, pastaBackups } from "../lib/backup.js";
import { solicitarDesligamento } from "../lib/ciclo-vida.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import { config } from "../config.js";

const db = getDb();
export const servidorRouter = Router();
servidorRouter.use(requireAdmin);

// Backups copiam banco + arquivos inteiros — operação pesada mesmo para admin (R4).
const limiteBackupCriar = limiteUsuario({ nome: "backup-criar", janelaMs: 5 * 60_000, max: 6 });
const limiteBackupVerificar = limiteUsuario({ nome: "backup-verificar", janelaMs: 5 * 60_000, max: 10 });
const limiteBackupRestaurar = limiteUsuario({ nome: "backup-restaurar", janelaMs: 10 * 60_000, max: 3 });

function tamanhoDir(dir: string): number {
  let total = 0;
  const andar = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) andar(p); else total += statSync(p).size;
    }
  };
  try { andar(dir); } catch { }
  return total;
}

/** GET /api/admin/servidor/status — painel global do servidor */
servidorRouter.get("/status", async (_req, res) => {
  const inicio = Date.now() - process.uptime() * 1000;
  void inicio;
  let dbOk = true;
  try { await db.select({ n: count() }).from(users); } catch { dbOk = false; }
  const arquivosOk = existsSync(CAMINHOS.arquivos);
  let discoLivre = 0, discoTotal = 0;
  try {
    const s = statfsSync(RAIZ);
    discoLivre = Number(s.bavail) * Number(s.bsize);
    discoTotal = Number(s.blocks) * Number(s.bsize);
  } catch { }
  const ultimos = await listarBackups();
  const ultimo = ultimos[0] ?? null;
  const agora = Date.now();
  const ativasRows = await db.select().from(authSessions);
  const sessoesAtivas = ativasRows.filter((s) => Number(s.expiresAt) > agora).length;
  const sessoesMesa = (await db.select({ n: count() }).from(sessions)).length;

  const alertas: string[] = [];
  if (!dbOk) alertas.push("banco_inacessivel");
  if (!arquivosOk) alertas.push("diretorio_arquivos_indisponivel");
  if (discoLivre > 0 && discoTotal > 0 && discoLivre / discoTotal < 0.1) alertas.push("pouco_espaco_disco");
  if (ultimo && ultimo.sucesso === false) alertas.push("ultimo_backup_falhou");
  if (!ultimo) alertas.push("nenhum_backup");

  res.json({
    servidor: {
      status: alertas.length ? "avisos" : "ok",
      uptimeSegundos: Math.floor(process.uptime()),
      versao: lerVersaoServidor(),
      node: process.version,
      plataforma: `${process.platform} ${process.arch}`,
    },
    banco: { acessivel: dbOk },
    arquivos: { diretorioOk: arquivosOk, tamanhoBytes: tamanhoDir(CAMINHOS.arquivos) },
    disco: { livreBytes: discoLivre, totalBytes: discoTotal },
    contagens: {
      campanhas: Number((await db.select({ n: count() }).from(campaigns))[0].n),
      usuarios: Number((await db.select({ n: count() }).from(users))[0].n),
      sessoesMesa: sessoesMesa, sessoesLoginAtivas: sessoesAtivas,
    },
    backup: ultimo ? { id: ultimo.id, criadoEm: ultimo.createdAt, tamanhoBytes: ultimo.sizeBytes, sucesso: ultimo.sucesso } : null,
    alertas,
  });
});

function lerVersaoServidor() {
  try { return JSON.parse(readFileSync(resolve(RAIZ, "package.json"), "utf-8")).version ?? "0.0.0"; } catch { return "0.0.0"; }
}

const configSchema = z.object({
  nomeInstalacao: z.string().max(120).optional(),
  backup: z.object({
    agenda: z.enum(["diario", "semanal", "ambos", "manual"]),
    hora: z.string().regex(/^\d{2}:\d{2}$/),
    retencaoDiarios: z.number().int().min(1).max(365),
    retencaoSemanais: z.number().int().min(1).max(104),
    pasta: z.string().min(1).max(500),
  }).partial().optional(),
  acesso: z.object({
    dominioPublico: z.string().max(253).optional(),
    proxyHops: z.number().int().min(0).max(10).optional(),
    https: z.boolean().optional(),
  }).partial().optional(),
  arquivos: z.object({
    tamanhoMaxMb: z.number().min(1).max(4096).optional(),
  }).optional(),
});

async function getJsonSetting<T>(key: string, padrao: T): Promise<T> {
  const [r] = await db.select().from(serverSettings).where(eq(serverSettings.key, key)).limit(1);
  return (r?.value as T) ?? padrao;
}

/** GET /api/admin/servidor/config */
servidorRouter.get("/config", async (_req, res) => {
  res.json({
    nomeInstalacao: await getJsonSetting("nomeInstalacao", "Mestre RPG"),
    backup: await getConfigBackup(),
    acesso: await getJsonSetting("acesso", { dominioPublico: "", proxyHops: 1, https: false }),
    arquivos: await getJsonSetting("arquivos", { tamanhoMaxMb: config.arquivos.tamanhoMaxMb }),
    servidorJson: config,
  });
});

/** PUT /api/admin/servidor/config */
servidorRouter.put("/config", async (req, res) => {
  const body = configSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Configuração inválida", detalhes: body.error.issues }); return; }
  const d = body.data;
  const gravar = async (key: string, valor: unknown) => {
    await db.insert(serverSettings).values({ key, value: valor as never, updatedAt: new Date() })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: valor as never, updatedAt: new Date() } });
  };
  if (d.nomeInstalacao !== undefined) await gravar("nomeInstalacao", d.nomeInstalacao);
  if (d.backup) await setConfigBackup(d.backup);
  if (d.acesso) {
    const atual = await getJsonSetting("acesso", { dominioPublico: "", proxyHops: 1, https: false });
    await gravar("acesso", { ...atual, ...d.acesso });
  }
  if (d.arquivos) {
    const atual = await getJsonSetting("arquivos", { tamanhoMaxMb: config.arquivos.tamanhoMaxMb });
    await gravar("arquivos", { ...atual, ...d.arquivos });
  }
  await audit(req, "servidor.config.atualizada", { campos: Object.keys(d) });
  log("info", "configuração do servidor atualizada", { campos: Object.keys(d) });
  res.json({ ok: true });
});

/** GET /api/admin/servidor/logs */
servidorRouter.get("/logs", async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 200, 1000);
  res.json({ logs: lerLogs(limite) });
});

/** GET /api/admin/servidor/backups */
servidorRouter.get("/backups", async (_req, res) => {
  res.json({ backups: await listarBackups(), padrao: BACKUP_PADRAO });
});

/** POST /api/admin/servidor/backups — backup manual imediato */
servidorRouter.post("/backups", limiteBackupCriar, async (req, res) => {
  const nota = typeof (req.body as { nota?: string })?.nota === "string" ? (req.body as { nota: string }).nota.slice(0, 300) : undefined;
  const r = await criarBackup("manual", nota);
  await audit(req, r.sucesso ? "backup.criado" : "backup.falhou", { id: r.id, erros: r.erros });
  res.status(r.sucesso ? 201 : 500).json(r);
});

/** POST /api/admin/servidor/backups/:id/verificar */
servidorRouter.post("/backups/:id/verificar", limiteBackupVerificar, async (req, res) => {
  const r = await verificarBackup(req.params.id);
  res.json(r);
});

const restaurarSchema = z.object({
  confirmacao: z.literal("RESTAURAR"),
  modo: z.enum(["preparar", "agora"]).default("preparar"),
});

/** POST /api/admin/servidor/backups/:id/restaurar — somente admin global */
servidorRouter.post("/backups/:id/restaurar", limiteBackupRestaurar, async (req, res) => {
  const body = restaurarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: 'Confirmação obrigatória: { "confirmacao": "RESTAURAR" }' }); return; }
  const r = await prepararRestauracao(req.params.id, req.usuario!.id);
  if ("erro" in r) { res.status(r.status ?? 400).json({ erro: r.erro }); return; }
  await audit(req, "backup.restauracao_preparada", { backupId: req.params.id, seguranca: r.seguranca.id });
  log("aviso", "restauração de backup preparada", { backupId: req.params.id, usuario: req.usuario!.username });

  if (body.data.modo === "agora") {
    // encerra graciosamente; o iniciar-mestre-rpg.bat aplica a restauração antes de subir
    res.json({ ok: true, mensagem: "Restauração agendada. Reinicie o servidor (iniciar-mestre-rpg.bat) para aplicar.", seguranca: r.seguranca.id });
    solicitarDesligamento();
    return;
  }
  res.json({ ok: true, seguranca: r.seguranca.id, proximoPasso: "Execute o iniciar-mestre-rpg.bat — a restauração será aplicada antes da inicialização." });
});

/** POST /api/admin/servidor/desligar — encerramento gracioso solicitado pelo admin global */
servidorRouter.post("/desligar", async (req, res) => {
  const ok = solicitarDesligamento();
  if (!ok) { res.status(409).json({ erro: "Encerramento já em andamento ou indisponível" }); return; }
  await audit(req, "servidor.desligamento_solicitado", {});
  log("aviso", "encerramento do servidor solicitado pelo admin", { usuario: req.usuario!.username });
  res.json({ ok: true, mensagem: "Encerrando servidor…" });
});
