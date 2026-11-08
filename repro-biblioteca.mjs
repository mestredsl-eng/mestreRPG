// Reprodução do erro "Dados inválidos" ao criar elementos na biblioteca.
// Roda contra CÓPIA isolada do banco — nunca toca o definitivo.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/repro-biblioteca";
const BANCO = `${DIR}/mestre-rpg-teste.db`;
mkdirSync(DIR, { recursive: true });
for (const suf of ["", "-wal", "-shm"]) rmSync(BANCO + suf, { force: true });
{
  const orig = new Database("banco/mestre-rpg.db", { readonly: true });
  orig.prepare(`VACUUM INTO '${BANCO.replace(/\\/g, "/")}'`).run();
  orig.close();
}

function portaLivre() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function esperar(base, proc) {
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { }
    if (proc.exitCode !== null) throw new Error("morreu");
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("timeout");
}
function sessaoDb() {
  const db = new Database(BANCO);
  const u = db.prepare("select id from users where username='administrador'").get();
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
const proc = spawn("node", ["servidor/dist/index.js"], {
  env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: DIR + "/arq", MESTRE_BACKUPS: DIR + "/bks" },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stderr.on("data", (d) => process.stderr.write("[srv!] " + d));
await esperar(BASE, proc);
const cookie = sessaoDb();

const camp = await req(BASE, "POST", "/campaigns", { cookie, body: { name: "Repro Biblioteca" } });
const cid = camp.json.campanha.id;
console.log("campanha:", cid, camp.status);

// Payload EXATO que o formulário envia com tudo vazio (Força/Vigor típicos)
const formVazio = (kind, key, name) => ({
  kind, key, name,
  category: undefined,
  definition: {
    descricao: undefined,
    custoPontos: undefined,
    custoProgressivo: undefined,
    minimo: undefined,
    maximo: undefined,
    grupoExclusividade: undefined,
    gruposExclusividade: [],
    formulas: undefined,
    reservaPontos: undefined,
    prerequisitos: [],
    obrigatorios: [],
    niveis: undefined,
    disponivel: true,
  },
});

const casos = [
  ["Força mínima", formVazio("atributo", "forca", "Força")],
  ["Vigor mínima", formVazio("atributo", "vigor", "Vigor")],
  ["key com ç", { ...formVazio("atributo", "força", "Força") }],
  ["key com espaço", { ...formVazio("atributo", "for ca", "Força") }],
  ["custoPontos decimal-vírgula (NaN->null)", { ...formVazio("atributo", "destreza", "Destreza"), definition: { ...formVazio("atributo","d","D").definition, custoPontos: null } }],
  ["niveis com custo null", { ...formVazio("defeito", "covardia", "Covardia"), definition: { ...formVazio("d","d","D").definition, niveis: [{}] } }],
  ["prereq malformado minLevel null", { ...formVazio("poder", "fogo", "Fogo"), definition: { ...formVazio("d","d","D").definition, prerequisitos: [{ kind: "atributo", key: "forca", minLevel: null }] } }],
];

for (const [nome, payload] of casos) {
  const r = await req(BASE, "POST", `/campaigns/${cid}/regras/elementos`, { cookie, body: payload });
  console.log(`\n### ${nome}\nstatus=${r.status}`);
  console.log(JSON.stringify(r.json, null, 1)?.slice(0, 900));
}

proc.kill();
