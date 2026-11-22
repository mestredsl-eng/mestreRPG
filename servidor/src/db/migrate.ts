import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, CAMINHOS, RAIZ } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Override existe para testes isolarem fixtures de journal sem tocar
// nos arquivos versionados em servidor/migrations. Produção nunca seta.
const migrationsFolder = resolve(
  process.env.MESTRE_MIGRATIONS_FOLDER ?? join(__dirname, "..", "..", "migrations"),
);

// P10-B: o backup pré-migration e o diagnóstico de bootstrap são
// importados SOB DEMANDA (dynamic import). O grafo estático anterior
// (migrate → backup-pre-update → lib/backup → getDb()) avaliava
// `const db = getDb()` no topo de backup.ts ANTES do preflight —
// abrindo DB, tomando a trava de instância e até criando o arquivo
// de banco, o que tornava a classificação "banco ausente" impossível
// de observar. Com import preguiçoso, o preflight roda primeiro e o
// backup.ts só é avaliado quando um backup é realmente necessário.

function totalMigrations(): number {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  return Array.isArray(journal?.entries) ? journal.entries.length : 0;
}

type ClasseBanco = "vazio" | "parcial" | "pendente" | "em-dia" | "indeterminado";

/**
 * Classifica o banco ANTES de qualquer conexão operacional:
 * - "vazio": arquivo ausente, 0 bytes ou SQLite válido sem nenhuma
 *   tabela de usuário e sem migrations aplicadas — zero dado a perder;
 * - "parcial": sem tabelas de usuário MAS com __drizzle_migrations
 *   populada — estado anômalo (restauração parcial/corrupção) que
 *   NÃO pode seguir o fast-path sem backup;
 * - "pendente": tabelas de usuário presentes e migrations do journal
 *   à frente do aplicado — caso legítimo de upgrade;
 * - "em-dia": nada a migrar;
 * - "indeterminado": leitura falhou — fail-closed ⇒ backup.
 * A conexão do preflight é curta e sempre fechada; nunca cria o
 * arquivo (guarda existsSync/statSync antes de abrir).
 */
function classificarBanco(caminho: string): ClasseBanco {
  try {
    if (!existsSync(caminho) || statSync(caminho).size === 0) return "vazio";
    const total = totalMigrations();
    const sqlite = new Database(caminho);
    try {
      const tabelas = sqlite.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
      const usuario = tabelas.filter((t) => !t.name.startsWith("sqlite_") && t.name !== "__drizzle_migrations");
      const temDrizzle = tabelas.some((t) => t.name === "__drizzle_migrations");
      const aplicadas = temDrizzle
        ? (sqlite.prepare("select count(*) as c from __drizzle_migrations").get() as { c: number }).c
        : 0;
      if (usuario.length === 0) return aplicadas > 0 ? "parcial" : "vazio";
      return aplicadas < total ? "pendente" : "em-dia";
    } finally {
      sqlite.close();
    }
  } catch {
    return "indeterminado";
  }
}

/** Diagnóstico do estado de instalação (scripts/estado-externo.mjs)
 *  via import dinâmico de specifier não-literal — o módulo é JS sem
 *  tipos e fora do rootDir do pacote; nunca deve ser avaliado no
 *  caminho feliz. Retorno null = diagnóstico indisponível ⇒ tratado
 *  como não reconhecido (fail-closed). */
async function diagnosticoBootstrap(repoDir: string): Promise<string | null> {
  try {
    const href = new URL("../../../scripts/estado-externo.mjs", import.meta.url).href;
    const mod = await import(href);
    return typeof mod.diagnosticarBootstrap === "function"
      ? mod.diagnosticarBootstrap(repoDir, process.env)
      : null;
  } catch {
    return null;
  }
}

// Estados que legitimam seguir SEM backup num banco vazio: bootstrap
// autorizado/em curso ou bootstrap interrompido (a migração faz parte
// da conclusão). "instalacao-concluida" NÃO está aqui de propósito:
// recibo prova que a instalação existiu — banco vazio nesse estado é
// PERDA, e migrar recriaria um schema vazio mascarando o desastre.
// Bloqueia fail-closed (mesma regra do restaurador: banco perdido).
const ESTADOS_SEM_BACKUP_VAZIO = new Set([
  "primeiro-bootstrap",
  "bootstrap-interrompido",
]);

const classe = classificarBanco(CAMINHOS.banco);
let precisaBackup = false;
if (classe === "pendente" || classe === "parcial" || classe === "indeterminado") {
  precisaBackup = true;
} else if (classe === "vazio") {
  // Fast-path de banco vazio SÓ com autorização explícita de bootstrap:
  // a ausência de dados sozinha não prova que a instalação é legítima.
  const diag = await diagnosticoBootstrap(RAIZ);
  if (!ESTADOS_SEM_BACKUP_VAZIO.has(diag ?? "")) {
    console.error(
      `[db] Banco ausente/vazio sem estado de instalação reconhecido ` +
      `(diagnóstico: ${diag ?? "indisponível"}) — migrações NÃO aplicadas. ` +
      `Provisione explicitamente: node scripts/autorizar-bootstrap.mjs --confirmar-provisionamento`,
    );
    process.exit(1);
  }
}

if (precisaBackup) {
  try {
    const { criarBackupPreUpdate } = await import("./backup-pre-update.js");
    const r = await criarBackupPreUpdate({ fase: "pre-migration" }, "Backup pré-migration automático");
    const manifestoOk = r.sucesso === true && existsSync(join(r.dir, "manifesto.json"));
    if (!manifestoOk) {
      console.error(`[db] Backup pré-migration FALHOU (${(r.erros ?? []).join("; ") || "sem detalhe"}) — migrações NÃO aplicadas.`);
      process.exit(1);
    }
    console.log(`[db] Backup pré-migration criado e validado: ${r.dir}`);
  } catch (e) {
    console.error(`[db] Backup pré-migration lançou exceção (${String(e)}) — migrações NÃO aplicadas.`);
    process.exit(1);
  }
}

// Instância ÚNICA: getDb() reutiliza a conexão que o backup
// pré-migration abriu via lib/backup.ts (getDb no topo do módulo)
// — sem isso, o caminho com backup abria DUAS conexões SQLite para
// o mesmo arquivo, com a primeira segurando a trava de instância.
// Sem backup, getDb() simplesmente abre a primeira e única conexão.
const db = getDb();
migrate(db, { migrationsFolder });
console.log(`[db] Migrações aplicadas em ${CAMINHOS.banco}`);
