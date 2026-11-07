import { createServer } from "node:http";
import express from "express";
import { config } from "./config.js";
import { getDb, fecharBanco, CAMINHOS, RAIZ } from "./db/index.js";
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
import { verificarBackupAgendado } from "./lib/backup.js";
import { registrarDesligamento } from "./lib/ciclo-vida.js";
import { localRouter } from "./routes/desligar.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Rotas da API
app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin/servidor", servidorRouter);
app.use("/api/local", localRouter);
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

// Segredo local (configuracao/local.json — não versionado) usado pelo script de
// encerramento do Windows: só aceita conexão originada do próprio computador.
const ARQ_LOCAL = resolve(RAIZ, "configuracao", "local.json");
try {
  mkdirSync(resolve(RAIZ, "configuracao"), { recursive: true });
  if (!existsSync(ARQ_LOCAL)) {
    writeFileSync(ARQ_LOCAL, JSON.stringify({ segredoLocal: randomBytes(24).toString("hex") }, null, 2));
  }
} catch (e) {
  log("aviso", "não foi possível criar configuracao/local.json", { erro: String(e) });
}

// Banco (instância única compartilhada; migrações via `npm run db:migrate`)
getDb();

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
  // recuperação de agendamentos de backup perdidos — não bloqueia a subida
  setImmediate(() => void verificarBackupAgendado(true));
});

// ---------- backup automático agendado (Etapa 10) ----------
// verificarBackupAgendado cobre tanto o disparo no horário quanto a recuperação
// de agendamentos perdidos (PC desligado). Chave de cobertura fica persistida.
const timerBackup = setInterval(() => void verificarBackupAgendado(), 60_000);
timerBackup.unref();

// ---------- encerramento controlado ----------
let encerrando = false;
async function desligar(sinal: string) {
  if (encerrando) return;
  encerrando = true;
  log("info", "encerramento solicitado", { sinal });
  console.log(`\n[${sinal}] Encerrando Mestre RPG…`);
  clearInterval(timerBackup);
  // para de aceitar novas conexões e desconecta sockets existentes
  try { ioServer?.close(); } catch { }
  try { httpServer.closeIdleConnections?.(); } catch { }
  httpServer.close(() => {
    log("info", "servidor encerrado", { sinal });
    fecharBanco();
    process.exit(0);
  });
  // fallback: se conexões não drenarem, força após 8s
  setTimeout(() => {
    log("aviso", "encerramento graceful expirou — forçando saída", { sinal });
    fecharBanco();
    process.exit(0);
  }, 8000).unref();
}
registrarDesligamento(() => desligar("admin"));
process.on("SIGINT", () => void desligar("SIGINT"));
process.on("SIGTERM", () => void desligar("SIGTERM"));
process.on("uncaughtException", (e) => { log("erro", "exceção não tratada", { erro: String(e?.stack ?? e) }); });
process.on("unhandledRejection", (e) => { log("erro", "promise rejeitada", { erro: String(e) }); });
