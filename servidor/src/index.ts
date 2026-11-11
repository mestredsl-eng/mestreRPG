import { createServer } from "node:http";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { config } from "./config.js";
import { getDb, fecharBanco, CAMINHOS, RAIZ } from "./db/index.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { campanhasRouter } from "./routes/campanhas.js";
import { convitesRouter, convitesPublicoRouter } from "./routes/convites.js";
import { modelosRouter } from "./routes/modelos.js";
import { personagensRouter } from "./routes/personagens.js";
import { regrasRouter } from "./routes/regras.js";
import { patrimonioRouter } from "./routes/patrimonio.js";
import { catalogoRouter } from "./routes/catalogo.js";
import { sessoesRouter } from "./routes/sessoes.js";
import { anotacoesRouter } from "./routes/anotacoes.js";
import { snapshotsRouter } from "./routes/snapshots.js";
import { arquivosRouter } from "./routes/arquivos.js";
import { bibliotecaRouter } from "./routes/biblioteca.js";
import { campanhaIORouter } from "./routes/campanha-io.js";
import { novidadesRouter, novidadesAdminRouter } from "./routes/novidades.js";
import { servidorRouter } from "./routes/admin-servidor.js";
import { configurarSockets } from "./sockets/index.js";
import { errorHandler } from "./middleware/error.js";
import { headersSeguranca } from "./middleware/headers.js";
import { mkdirSync } from "node:fs";
import { log } from "./lib/logs.js";
import { verificarBackupAgendado } from "./lib/backup.js";
import { registrarDesligamento } from "./lib/ciclo-vida.js";
import { localRouter } from "./routes/desligar.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const app = express();

// Cabeçalhos de segurança em todas as respostas da API (R2)
app.use(headersSeguranca);

// Express 4 não encaminha rejeições de handlers async ao errorHandler —
// sem isso, uma exceção assíncrona deixa a requisição pendurada para sempre.
// blindar() envolve todos os handlers (rotas e middlewares de router) para
// que qualquer erro síncrono ou assíncrono chegue ao middleware central.
type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
function envolver(fn: Handler): Handler {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch(next);
      }
    } catch (e) {
      next(e);
    }
  };
}
function blindar(router: Router) {
  const stack = (router as unknown as { stack?: { route?: { stack: { handle: Handler }[] }; handle?: Handler }[] }).stack;
  for (const layer of stack ?? []) {
    if (layer.route?.stack) {
      for (const s of layer.route.stack) s.handle = envolver(s.handle);
    } else if (typeof layer.handle === "function") {
      layer.handle = envolver(layer.handle);
    }
  }
}

// pacotes de importação de campanha podem ser grandes (arquivos embutidos em base64)
app.use("/api/campaigns/importar", express.json({ limit: "80mb" }));
// acervo de livros: envelopes de importação podem trazer bibliotecas inteiras
app.use("/api/biblioteca/importar", express.json({ limit: "20mb" }));
app.use(express.json({ limit: "2mb" }));

// Rotas da API
const routers: Router[] = [
  healthRouter, authRouter, adminRouter, servidorRouter, localRouter,
  campanhasRouter, campanhaIORouter, convitesPublicoRouter, convitesRouter, modelosRouter,
  personagensRouter, regrasRouter, patrimonioRouter, catalogoRouter,
  sessoesRouter, anotacoesRouter, snapshotsRouter, arquivosRouter, bibliotecaRouter,
  novidadesRouter, novidadesAdminRouter,
];
for (const r of routers) blindar(r);

app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin/servidor", servidorRouter);
app.use("/api/local", localRouter);
app.use("/api/campaigns", campanhasRouter);
app.use("/api/campaigns", campanhaIORouter);
app.use("/api/convites", convitesPublicoRouter);
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
app.use("/api/biblioteca", bibliotecaRouter);
app.use("/api/novidades", novidadesRouter);
app.use("/api/admin/novidades", novidadesAdminRouter);

// 404 consistente para rotas de API inexistentes
app.use("/api", (_req, res) => {
  res.status(404).json({ erro: "Rota não encontrada" });
});

// SPA em produção (Etapa 15, Fase 6): o build do site (site/dist) é servido
// pelo próprio backend — um único processo/porta para acesso local, LAN e
// proxy reverso/túnel externo. Assets com hash do Vite recebem cache
// imutável; o index.html nunca é cacheado (sempre a versão mais recente).
const DIR_SITE = resolve(RAIZ, "site", "dist");
if (existsSync(resolve(DIR_SITE, "index.html"))) {
  app.use(
    express.static(DIR_SITE, {
      index: false,
      setHeaders(res, caminho) {
        if (caminho.includes(`${sep}assets${sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    })
  );
  app.get(/.*/, (req, res, next) => {
    if (req.method !== "GET" || !req.accepts("html")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(resolve(DIR_SITE, "index.html"));
  });
}

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
let dominioPublico = config.acesso.dominioPublico;
try {
  const { getDb } = await import("./db/index.js");
  const { serverSettings } = await import("./db/schema.js");
  const { eq } = await import("drizzle-orm");
  const row = await getDb().select().from(serverSettings).where(eq(serverSettings.key, "acesso")).get();
  // server_settings.value é text({mode:"json"}) — o Drizzle já devolve objeto;
  // aceitar string também cobre valores gravados como texto puro.
  const bruto = row?.value as unknown;
  const acessoSalvo = (typeof bruto === "string" ? JSON.parse(bruto) : bruto ?? {}) as Record<string, unknown>;
  if (typeof acessoSalvo.dominioPublico === "string") dominioPublico = acessoSalvo.dominioPublico;
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
const ioServer = configurarSockets(httpServer, { dominioPublico });

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
  // fecharBanco pode lançar se o close() do SQLite falhar — nesse caso a
  // trava permanece presa de propósito e o processo DEVE morrer (o SO
  // libera conexão e trava juntos), nunca seguir servindo sem trava.
  const encerrarBanco = () => {
    try {
      fecharBanco();
    } catch (e) {
      log("erro", "falha ao fechar o banco no encerramento — forçando saída com trava presa", { erro: String(e) });
      process.exit(1);
    }
  };
  httpServer.close(() => {
    log("info", "servidor encerrado", { sinal });
    encerrarBanco();
    process.exit(0);
  });
  // fallback: se conexões não drenarem, força após 8s
  setTimeout(() => {
    log("aviso", "encerramento graceful expirou — forçando saída", { sinal });
    encerrarBanco();
    process.exit(0);
  }, 8000).unref();
}
registrarDesligamento(() => desligar("admin"));
process.on("SIGINT", () => void desligar("SIGINT"));
process.on("SIGTERM", () => void desligar("SIGTERM"));
process.on("uncaughtException", (e) => { log("erro", "exceção não tratada", { erro: String(e?.stack ?? e) }); });
process.on("unhandledRejection", (e) => { log("erro", "promise rejeitada", { erro: String(e) }); });
