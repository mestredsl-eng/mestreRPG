// Infra compartilhada das suítes de teste da Etapa 2.
// Cria um banco SQLite NOVO em diretório temporário, aplica as
// migrations do servidor e semeia fixtures 100% sintéticas via API
// e INSERTs diretos — nunca copia banco/mestre-rpg.db nem usa
// contas/campanhas reais.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { hashSenha, hashToken } from "./servidor/dist/lib/password.js";

export function dirTeste(nome) {
  return mkdtempSync(join(tmpdir(), `mrpg-${nome}-`));
}

/** Cria banco vazio e aplica todas as migrations do servidor. */
export async function prepararBanco(banco) {
  for (const suf of ["", "-wal", "-shm"]) rmSync(banco + suf, { force: true });
  await new Promise((res, rej) => {
    const p = spawn("node", ["servidor/dist/db/migrate.js"], {
      env: { ...process.env, MESTRE_BANCO: banco },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => code === 0 ? res() : rej(new Error(`migrate falhou (${code}): ${err}`)));
  });
}

export function portaLivre() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

export function subirServidor(porta, { banco, arquivos, backups }) {
  return spawn("node", ["servidor/dist/index.js"], {
    env: {
      ...process.env,
      MESTRE_PORTA: String(porta),
      MESTRE_BANCO: banco,
      MESTRE_ARQUIVOS: arquivos,
      MESTRE_BACKUPS: backups,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function esperarSaudavel(base, proc, timeoutMs = 30000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { }
    if (proc.exitCode !== null) throw new Error("servidor morreu: " + proc.exitCode);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("timeout aguardando /api/health");
}

export function comDb(banco, fn) {
  const db = new Database(banco, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

/**
 * Encerra o processo do servidor e AGUARDA a saída (com timeout de
 * segurança). Garante que handles do SQLite/WAL são liberados antes da
 * limpeza do diretório — essencial no Windows.
 */
export async function encerrarServidor(proc, timeoutMs = 10000) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  proc.kill();
  await new Promise((res) => {
    const limite = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { } res(); }, timeoutMs);
    proc.once("exit", () => { clearTimeout(limite); res(); });
  });
}

/** Remove o diretório temporário da suíte com retentativas (Windows/AV). */
export function limparDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  } catch { /* melhor esforço — tmpdir do SO limpa depois */ }
}

export function abrirDb(banco) {
  return new Database(banco);
}

export async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** Sessão autenticada direta no banco (sem passar por login HTTP). */
export function sessao(banco, userId) {
  const db = abrirDb(banco);
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "teste", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}

/**
 * Cria o cenário mínimo via API real:
 * - admin pelo POST /api/auth/setup (único caminho que cria admin
 *   respeitando admin_principal/triggers);
 * - campanha via POST /api/campaigns (cria membership mestre);
 * - jogadores via INSERT direto (is_admin=0) + membership.
 * Retorna ids e cookies. `opts.financeiro`/`opts.hp`/`opts.vitalidade`
 * ajustam o config do rule_set ativo da campanha.
 */
export async function criarCenario(base, banco, opts = {}) {
  const setup = await req(base, "POST", "/auth/setup", {
    body: { username: "mestre_teste", password: "senha-forte-123", displayName: "Mestre Teste" },
  });
  if (setup.status !== 201) throw new Error("setup admin falhou: " + JSON.stringify(setup.json));
  const adminId = comDb(banco, (db) => db.prepare("select id from users where username='mestre_teste'").get().id);
  const cookieMestre = sessao(banco, adminId);

  const camp = await req(base, "POST", "/campaigns", {
    cookie: cookieMestre,
    body: { name: opts.campanha ?? "Campanha Teste" },
  });
  if (camp.status !== 201 && camp.status !== 200) throw new Error("criar campanha falhou: " + JSON.stringify(camp.json));
  const campId = camp.json?.campanha?.id;

  // Ajusta config do rule_set ativo (criado sob demanda por carregarRegras;
  // garantimos a linha aqui para os testes não dependerem de lazy-init).
  const db = abrirDb(banco);
  const agora = Date.now();
  let rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
  if (!rs) {
    const id = crypto.randomUUID();
    db.prepare("insert into rule_sets (id,campaign_id,name,version,is_active,config,created_at,updated_at) values (?,?,?,?,1,?,?,?)")
      .run(id, campId, "Regras da campanha", 1, "{}", agora, agora);
    rs = { id, config: "{}" };
  }
  const cfg = JSON.parse(rs.config || "{}");
  if (opts.config) {
    for (const [k, v] of Object.entries(opts.config)) cfg[k] = v;
  }
  db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);

  // Jogadores sintéticos
  const jogadores = {};
  for (const [apelido, username] of Object.entries(opts.jogadores ?? { jogador1: "jogador_um", jogador2: "jogador_dois" })) {
    const uid = crypto.randomUUID();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, `Jogador ${apelido}`, await hashSenha("senha-jogador-123"), agora, agora);
    const mid = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(mid, campId, uid, agora, agora, agora);
    jogadores[apelido] = { id: uid, membershipId: mid, cookie: sessao(banco, uid), username };
  }
  // membership do mestre (owner já tem como mestre via criação da campanha)
  const membMestre = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(campId, adminId).id;

  // Template de ficha publicado (opcional, com campo "for" para HP)
  let templateVersionId = null;
  if (opts.ficha !== false) {
    const estrutura = {
      versao: 1,
      secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" }] }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
    db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
      .run(tplId, campId, "Ficha Teste", null, adminId, agora, agora);
    db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
      .run(verId, tplId, JSON.stringify(estrutura), agora, agora);
    db.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
    templateVersionId = verId;
  }

  const novoPersonagem = (membershipId, nome, dataExtra = {}) => {
    const w = abrirDb(banco);
    try {
      const id = crypto.randomUUID();
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, campId, membershipId, templateVersionId, nome,
          JSON.stringify({ for: 5, ...dataExtra }), "{}", "aprovada", 0, agora, agora);
      return id;
    } finally { w.close(); }
  };

  const personagemMestre = opts.personagemMestre === false ? null : novoPersonagem(membMestre, "Mestre Herói");
  db.close();
  return {
    adminId, cookieMestre, campId, jogadores, membMestre, novoPersonagem,
    personagemMestre,
  };
}
