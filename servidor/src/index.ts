import { createServer } from "node:http";
import express from "express";
import { config } from "./config.js";
import { criarBanco, CAMINHOS } from "./db/index.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { configurarSockets } from "./sockets/index.js";
import { errorHandler } from "./middleware/error.js";
import { mkdirSync } from "node:fs";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Rotas da API
app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);

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
