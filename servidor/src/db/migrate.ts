import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { existsSync, statSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

function temposMigrations(): number[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  if (!Array.isArray(journal?.entries) || !journal.entries.every((e: unknown) =>
    !!e && typeof e === "object" && Number.isFinite((e as { when?: unknown }).when)
  )) {
    throw new Error("journal de migrations inválido: timestamps ausentes ou não finitos");
  }
  return journal.entries.map((e: { when: number }) => e.when);
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
    const tempos = temposMigrations();
    const sqlite = new Database(caminho);
    try {
      const tabelas = sqlite.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
      const usuario = tabelas.filter((t) => !t.name.startsWith("sqlite_") && t.name !== "__drizzle_migrations");
      const temDrizzle = tabelas.some((t) => t.name === "__drizzle_migrations");
      const aplicadas = temDrizzle
        ? (sqlite.prepare("select count(*) as c from __drizzle_migrations").get() as { c: number }).c
        : 0;
      if (usuario.length === 0) return aplicadas > 0 ? "parcial" : "vazio";

      // Alinhar o preflight ao critério REAL do Drizzle ORM 0.45.4:
      // ele lê a linha de maior created_at e executa cada migration cujo
      // folderMillis é maior que esse watermark. COUNT(*) não é suficiente:
      // duplicatas podem produzir uma contagem "completa" mesmo com uma
      // migration pendente, levando a executar SQL sem backup prévio.
      const ultima = temDrizzle
        ? sqlite.prepare("select created_at from __drizzle_migrations order by created_at desc limit 1").get() as { created_at: unknown } | undefined
        : undefined;
      const ultimoQuando = ultima ? Number(ultima.created_at) : Number.NEGATIVE_INFINITY;
      const temPendente = tempos.some((quando) => ultimoQuando < quando);
      return temPendente ? "pendente" : "em-dia";
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

// ---------- Issue #380: reconhecedor fail-closed + identidade L4 ----------
// Gate pré-migrate: bancos com tabelas de usuário (pendente/em-dia) são
// reconhecidos ANTES de qualquer mutação — journal, hash, estrutura,
// sentinelas e identidade precisam formar prova coerente. Falha = exit 1
// sem tocar no banco (o backup pré-migration já foi criado acima quando
// cabia). Bancos vazio/parcial/indeterminado seguem o fluxo anterior
// (backup + classificação própria) — não há schema reconhecível a gatear.
async function gateReconhecimentoPreMigration(): Promise<void> {
  try {
    const { reconhecerSchema } = await import("../lib/schema-reconhecedor.js");
    const {
      carregarEstadoExterno, recuperarIntencaoPendente,
    } = await import("../lib/identidade-banco.js");

    // 1. Reconhecimento L1–L4 do candidato como está AGORA — produz
    //    também REFERENCIA(k) (assinaturaSchema), exigida pela validação
    //    fase-aware da intenção pendente (ramo B3 do Adendo A1).
    const v = await reconhecerSchema(CAMINHOS.banco, migrationsFolder, process.env);
    if (!v.ok) {
      console.error(`[db] schema não reconhecido (${v.motivo})${v.detalhe ? ` — ${v.detalhe}` : ""} — migrações NÃO aplicadas.`);
      process.exit(1);
    }

    // 2. Intenção de vínculo pendente (crash no meio do ciclo
    //    intenção→linha→recibo→consumo): recupera convergindo ou bloqueia.
    const estado = await carregarEstadoExterno();
    if (estado) {
      const sqlite = new Database(CAMINHOS.banco);
      try {
        const rec = recuperarIntencaoPendente({
          estado, sqlite, env: process.env, referenciaSchema: v.assinaturaSchema,
        });
        if (rec.status === "bloqueada") {
          console.error(`[db] identidade do banco bloqueada (${rec.motivo})${rec.detalhe ? ` — ${rec.detalhe}` : ""} — migrações NÃO aplicadas.`);
          process.exit(1);
        }
      } finally {
        sqlite.close();
      }
    }

    console.log(`[db] schema reconhecido: ${v.familia} (${v.migrations} migrations, identidade ${v.evidencias.identidadeBanco})`);
  } catch (e) {
    // Falha do próprio gate (módulo indisponível, I/O) é fail-closed.
    console.error(`[db] gate de reconhecimento falhou (${String(e)}) — migrações NÃO aplicadas.`);
    process.exit(1);
  }
}

// ---------- Issue #380: verify-once + refresh do recibo (P1-3) ----------
// Após migrate bem-sucedido, com recibo de instalação concluída:
//   - recibo legado sem id + banco sem id ⇒ verify-once (TOFU declarado):
//     intenção → linha SQLite → recibo atualizado → consumo;
//   - ids já vinculados ⇒ só regrava assinaturaSchema/instalacaoIdBanco
//     (boot subsequente a migrate legítimo nunca bloqueia por recibo
//     defasado — propriedade exigida pelo Adendo A1 P1-3).
async function posMigracaoIdentidade(sqlite: Database.Database): Promise<void> {
  const { carregarEstadoExterno } = await import("../lib/identidade-banco.js");
  const estado = await carregarEstadoExterno();
  if (!estado) return;
  const recibo = estado.lerReciboInstalacao(RAIZ, process.env);
  if (recibo.status !== "ok") return; // primeiro bootstrap: vínculo no listen

  const {
    lerInstalacaoIdBanco, gravarInstalacaoIdBanco, instalacaoIdBancoValido,
    prepararIntencao, concluirIntencao,
  } = await import("../lib/identidade-banco.js");
  const { assinaturaSchemaCorrente } = await import("../lib/schema-reconhecedor.js");

  let dbId = lerInstalacaoIdBanco(sqlite);
  const recId = typeof recibo.dados?.instalacaoIdBanco === "string"
    ? (recibo.dados.instalacaoIdBanco as string)
    : null;

  if (!instalacaoIdBancoValido(dbId) && !recId) {
    // Verify-once: recibo legado sem id + banco sem id.
    const idFixo = randomUUID();
    prepararIntencao({ estado, tipo: "vinculacao-inicial", idFixo, env: process.env });
    gravarInstalacaoIdBanco(sqlite, idFixo);
    dbId = idFixo;
    // O patch carrega id + assinaturaSchema juntos: mantém o recibo no
    // estado convergido (ramo B3) se houver crash antes do consumo.
    const upd = estado.atualizarReciboInstalacao(RAIZ, process.env, {
      instalacaoIdBanco: idFixo,
      assinaturaSchema: assinaturaSchemaCorrente(migrationsFolder).hash,
    });
    // Retorno verificado (anti-autobloqueio): recibo não gravado ⇒
    // intenção NÃO é consumida — a recuperação converge na próxima
    // passada. Falha propaga ⇒ exit 1 pelo catch do chamador.
    if (!upd.atualizado) {
      throw new Error(`recibo não atualizado no verify-once (${upd.motivo ?? "sem motivo"})`);
    }
    concluirIntencao({ estado, env: process.env });
    console.log("[db] identidade do banco atribuída (verify-once — TOFU declarado)");
  } else if (instalacaoIdBancoValido(dbId) && recId && dbId !== recId) {
    console.error("[db] instalacaoIdBanco do banco diverge do recibo — bloqueio fail-closed.");
    process.exit(1);
  }

  // P1-3: recibo sempre reflete o schema corrente pós-migrate.
  const { hash } = assinaturaSchemaCorrente(migrationsFolder);
  const idVigente = instalacaoIdBancoValido(dbId) ? dbId : recId;
  const updRefresh = estado.atualizarReciboInstalacao(RAIZ, process.env, {
    assinaturaSchema: hash,
    ...(idVigente ? { instalacaoIdBanco: idVigente } : {}),
  });
  if (!updRefresh.atualizado) {
    throw new Error(`recibo não atualizado pós-migrate (${updRefresh.motivo ?? "sem motivo"})`);
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

// Issue #380: gate fail-closed DEPOIS do backup (o snapshot forense do
// estado anômalo é preservado) e ANTES de qualquer mutação no banco.
if (classe === "pendente" || classe === "em-dia") {
  await gateReconhecimentoPreMigration();
}

// Instância ÚNICA: getDb() reutiliza a conexão que o backup
// pré-migration abriu via lib/backup.ts (getDb no topo do módulo)
// — sem isso, o caminho com backup abria DUAS conexões SQLite para
// o mesmo arquivo, com a primeira segurando a trava de instância.
// Sem backup, getDb() simplesmente abre a primeira e única conexão.
const db = getDb();
// Rebuilds de tabela (DROP+CREATE gerado pelo drizzle-kit) precisam de
// FK off: o migrator envolve TODAS as migrations pendentes num único
// BEGIN/COMMIT e `PRAGMA foreign_keys` dentro de transação é no-op no
// SQLite — os PRAGMAs emitidos no .sql não desligam nada de fato.
// Sem isto, `DROP TABLE financial_accounts` falha com FOREIGN KEY
// constraint failed em qualquer base que já tenha money_transactions
// (reproduzido na fixture rica #335 / E2E de adoção legada).
// Desligamos na conexão antes do migrate e religamos + verificamos
// integridade referencial depois — fail-closed.
const sqlite = db.$client;
sqlite.pragma("foreign_keys = OFF");
try {
  migrate(db, { migrationsFolder });
} finally {
  sqlite.pragma("foreign_keys = ON");
}
const violacoesFk = sqlite.pragma("foreign_key_check") as unknown[];
if (violacoesFk.length > 0) {
  throw new Error(`[db] foreign_key_check falhou após migrações: ${violacoesFk.length} violação(ões)`);
}
// Issue #380: verify-once/refresh do recibo + assinaturaSchema pós-migrate.
// Falha aqui é fail-closed — o migrate já aplicou, mas boot não pode
// seguir com identidade/recibo inconsistente.
try {
  await posMigracaoIdentidade(sqlite);
} catch (e) {
  console.error(`[db] identidade pós-migration falhou (${String(e)}) — interrompendo.`);
  process.exit(1);
}
console.log(`[db] Migrações aplicadas em ${CAMINHOS.banco}`);
