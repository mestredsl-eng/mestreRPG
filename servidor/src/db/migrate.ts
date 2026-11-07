import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { criarBanco, CAMINHOS } from "./index.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "..", "..", "migrations");

const db = criarBanco(CAMINHOS.banco);
migrate(db, { migrationsFolder });
console.log(`[db] Migrações aplicadas em ${CAMINHOS.banco}`);
