import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { criarBanco, CAMINHOS, RAIZ } from "./index.js";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "..", "..", "migrations");

// Gate 0 (Issue #155 W13): migrate NUNCA cria banco sobre estado
// ambíguo — banco perdido com instalação registrada, state dir
// perdido, journals corrompidos ou evidência de instalação anterior
// sem banco bloqueiam aqui também (avaliação somente-leitura; o
// produtor de autorização/marcador é scripts/bootstrap-install.mjs
// via iniciar-mestre-rpg.bat).
try {
  const portao = await import(pathToFileURL(join(RAIZ, "scripts", "bootstrap-install.mjs")).href) as {
    verificarPortao(opts?: { repoDir?: string }): Promise<{ seguroIniciar: boolean; motivo?: string; instrucao?: string }>;
  };
  const v = await portao.verificarPortao({ repoDir: RAIZ });
  if (!v.seguroIniciar) {
    console.error(`[db] Boot bloqueado pelo Gate 0: ${v.motivo ?? "estado-ambiguo"}`);
    if (v.instrucao) console.error(`[db] ${v.instrucao}`);
    process.exit(2);
  }
} catch (e) {
  // Falha ao carregar o portão não pode virar bypass silencioso.
  console.error(`[db] Gate 0 indisponível (${String(e)}) — abortando por segurança.`);
  process.exit(2);
}

const db = criarBanco(CAMINHOS.banco);
migrate(db, { migrationsFolder });
console.log(`[db] Migrações aplicadas em ${CAMINHOS.banco}`);

// Adoção tardia (W13): um migrate concluído prova instalação inicializada.
// Se o marcador de proveniência ainda não existe (ex.: primeiro boot de
// uma instalação nova), grava-o AGORA — fora do state dir — para que a
// prova sobreviva mesmo à perda posterior de banco/ e do state dir.
// Idempotente: não regrava marcador/recibo já válidos (preserva criadoEm)
// e limpa bootstrap-em-andamento residual.
try {
  const ee = await import(pathToFileURL(join(RAIZ, "scripts", "estado-externo.mjs")).href) as {
    lerMarcadorInstalacao(repoDir: string, env?: NodeJS.ProcessEnv): { status: string };
    gravarMarcadorInstalacao(repoDir: string, env?: NodeJS.ProcessEnv, dadosExtra?: Record<string, unknown>): unknown;
    lerReciboInstalacao(repoDir: string, env?: NodeJS.ProcessEnv): { status: string };
    gravarReciboInstalacao(repoDir: string, env?: NodeJS.ProcessEnv, dadosExtra?: Record<string, unknown>): unknown;
    limparBootstrapAndamento(repoDir: string, env?: NodeJS.ProcessEnv): void;
    estadoRealCompartilhado?(env?: NodeJS.ProcessEnv): boolean;
  };
  if (ee.lerMarcadorInstalacao(RAIZ, process.env).status !== "ok") {
    ee.gravarMarcadorInstalacao(RAIZ, process.env, { origem: "migrate-concluido" });
  }
  // Recibo/andamento vivem no state dir: sob MESTRE_HOME sem
  // MESTRE_STATE_DIR esse diretório é o REAL da instalação — não escrever.
  if (!ee.estadoRealCompartilhado?.(process.env)) {
    if (ee.lerReciboInstalacao(RAIZ, process.env).status !== "ok") {
      ee.gravarReciboInstalacao(RAIZ, process.env, { origem: "migrate-concluido" });
    }
    ee.limparBootstrapAndamento(RAIZ, process.env);
  }
} catch (e) {
  // Falha na gravação do marcador não pode derrubar o migrate já
  // concluído — o próximo gate refaz a adoção (banco válido é prova).
  console.warn(`[db] aviso: marcador de proveniência não gravado (${String(e)})`);
}
