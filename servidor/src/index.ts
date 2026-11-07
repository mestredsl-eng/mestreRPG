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
import { configurarSockets } from "./sockets/index.js";
import { errorHandler } from "./middleware/error.js";
import { mkdirSync } from "node:fs";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Rotas da API
app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/campaigns", campanhasRouter);
app.use("/api/convites", convitesRouter);
app.use("/api/campaigns/:campaignId/sheet-templates", modelosRouter);
app.use("/api/campaigns/:campaignId/characters", personagensRouter);
app.use("/api/campaigns/:campaignId/regras", regrasRouter);
app.use("/api/characters/:characterId", patrimonioRouter);
app.use("/api/campaigns/:campaignId/inventario", catalogoRouter);
app.use("/api/campaigns/:campaignId/sessoes", sessoesRouter);
app.use("/api/characters", personagensRouter);

app.use(errorHandler);

// Garante diretórios de dados
for (const dir of [CAMINHOS.arquivos, CAMINHOS.backups]) mkdirSync(dir, { recursive: true });

// Banco (cria arquivo na primeira execução; migrações via `npm run db:migrate`)
criarBanco(CAMINHOS.banco);

const httpServer = createServer(app);
configurarSockets(httpServer);

httpServer.listen(config.porta, config.host, () => {
  console.log("============================================");
  console.log("  MESTRE RPG — servidor iniciado");
  console.log(`  API:    http://${config.host}:${config.porta}`);
  console.log(`  Health: http://${config.host}:${config.porta}/api/health`);
  console.log("============================================");
});
