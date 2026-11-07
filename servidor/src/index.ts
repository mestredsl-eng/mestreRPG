import { createServer } from "node:http";
import express from "express";
import { config } from "./config.js";
import { criarBanco, CAMINHOS } from "./db/index.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { campanhasRouter } from "./routes/campanhas.js";
import { convitesRouter } from "./routes/convites.js";
import { modelosRouter } from "./routes/modelos.js";
import { personagensRouter } from "./routes/personagens.js";
import { regrasRouter } from "./routes/regras.js";
import { patrimonioRouter } from "./routes/patrimonio.js";
import { catalogoRouter } from "./routes/catalogo.js";
import { sessoesRouter } from "./routes/sessoes.js";
import { anotacoesRouter } from "./routes/anotacoes.js";
import { snapshotsRouter } from "./routes/snapshots.js";
import { arquivosRouter } from "./routes/arquivos.js";
import { servidorRouter } from "./routes/admin-servidor.js";
import { configurarSockets } from "./sockets/index.js";
import { errorHandler } from "./middleware/error.js";
import { mkdirSync } from "node:fs";
import { log } from "./lib/logs.js";
import { criarBackup, getConfigBackup } from "./lib/backup.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Rotas da API
app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin/servidor", servidorRouter);
app.use("/api/campaigns", campanhasRouter);
app.use("/api/convites", convitesRouter);
app.use("/api/campaigns/:campaignId/sheet-templates", modelosRouter);
app.use("/api/campaigns/:campaignId/characters", personagensRouter);
app.use("/api/campaigns/:campaignId/regras", regrasRouter);
app.use("/api/characters/:characterId", patrimonioRouter);
app.use("/api/campaigns/:campaignId/inventario", catalogoRouter);
app.use("/api/campaigns/:campaignId/sessoes", sessoesRouter);
app.use("/api/campaigns/:campaignId/anotacoes", anotacoesRouter);
app.use("/api/campaigns/:campaignId/snapshots", snapshotsRouter);
app.use("/api/campaigns/:campaignId/arquivos", arquivosRouter);
app.use("/api/characters", personagensRouter);

app.use(errorHandler);

// Garante diretórios de dados
for (const dir of [CAMINHOS.arquivos, CAMINHOS.backups]) mkdirSync(dir, { recursive: true });

// Banco (cria arquivo na primeira execução; migrações via `npm run db:migrate`)
criarBanco(CAMINHOS.banco);

// proxy confiável: valor efetivo = servidor.json + ajuste salvo pelo admin (server_settings)
try {
  const { getDb } = await import("./db/index.js");
  const { serverSettings } = await import("./db/schema.js");
  const { eq } = await import("drizzle-orm");
  const row = await getDb().select().from(serverSettings).where(eq(serverSettings.key, "acesso")).get();
  const acessoSalvo = typeof row?.value === "string" ? JSON.parse(row.value) : {};
  const proxyHops = Math.min(10, Math.max(0, Number(acessoSalvo.proxyHops ?? config.acesso.proxyHops) || 0));
  if (proxyHops > 0) app.set("trust proxy", proxyHops);
} catch {
  if (config.acesso.proxyHops > 0) app.set("trust proxy", config.acesso.proxyHops);
}

const httpServer = createServer(app);
httpServer.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[erro] porta ${config.porta} já está em uso — outra instância do Mestre RPG está rodando?`);
    log("erro", "porta já em uso ao iniciar", { porta: config.porta });
  } else {
    log("erro", "erro no servidor HTTP", { erro: String(e) });
  }
  process.exit(1);
});
const ioServer = configurarSockets(httpServer);

httpServer.listen(config.porta, config.host, () => {
  console.log("============================================");
  console.log("  MESTRE RPG — servidor iniciado");
  console.log(`  API:    http://${config.host}:${config.porta}`);
  console.log(`  Health: http://${config.host}:${config.porta}/api/health`);
  console.log("============================================");
  log("info", "servidor iniciado", { porta: config.porta });
});

// ---------- backup automático agendado (Etapa 10) ----------
let ultimoBackupDiario = "";
let ultimoBackupSemanal = "";
async function tickBackup() {
  try {
    const cfg = await getConfigBackup();
    if (cfg.agenda === "manual") return;
    const agora = new Date();
    const [hh, mm] = cfg.hora.split(":").map(Number);
    const chave = `${agora.getFullYear()}-${agora.getMonth()}-${agora.getDate()}_${hh}:${mm}`;
    const diaSemana = agora.getDay(); // 0=domingo
    const ehHora = agora.getHours() === hh && agora.getMinutes() === mm;
    if (!ehHora) return;
    const querDiario = (cfg.agenda === "diario" || cfg.agenda === "ambos") && ultimoBackupDiario !== chave;
    const querSemanal = cfg.agenda === "semanal" && diaSemana === 0 && ultimoBackupSemanal !== chave;
    if (querDiario || querSemanal) {
      if (querDiario) ultimoBackupDiario = chave;
      if (querSemanal) ultimoBackupSemanal = chave;
      await criarBackup("automatico", `Agendado ${cfg.agenda}`);
    }
  } catch (e) {
    log("erro", "falha no agendador de backup", { erro: String(e) });
  }
}
setInterval(() => void tickBackup(), 60_000);

// ---------- encerramento controlado ----------
let encerrando = false;
async function desligar(sinal: string) {
  if (encerrando) return;
  encerrando = true;
  log("info", "encerramento solicitado", { sinal });
  console.log(`\n[sinal ${sinal}] Encerrando Mestre RPG…`);
  try { ioServer?.close(); } catch { }
  httpServer.close(() => {
    log("info", "servidor encerrado");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => void desligar("SIGINT"));
process.on("SIGTERM", () => void desligar("SIGTERM"));
process.on("uncaughtException", (e) => { log("erro", "exceção não tratada", { erro: String(e?.stack ?? e) }); });
process.on("unhandledRejection", (e) => { log("erro", "promise rejeitada", { erro: String(e) }); });
