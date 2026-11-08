// Testes — criação/edição de elementos da biblioteca de regras (correção "Dados inválidos")
// Roda contra CÓPIA isolada do banco em porta livre — nunca toca o definitivo.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-biblioteca";
const BANCO = `${DIR}/mestre-rpg-teste.db`;
mkdirSync(DIR, { recursive: true });
for (const suf of ["", "-wal", "-shm"]) rmSync(BANCO + suf, { force: true });
{
  const orig = new Database("banco/mestre-rpg.db", { readonly: true });
  orig.prepare(`VACUUM INTO '${BANCO.replace(/\\/g, "/")}'`).run();
  orig.close();
}

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

function portaLivre() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function esperarSaudavel(base, proc) {
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { }
    if (proc.exitCode !== null) throw new Error("servidor morreu: " + proc.exitCode);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("timeout");
}
function subir(porta) {
  return spawn("node", ["servidor/dist/index.js"], {
    env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: DIR + "/arq", MESTRE_BACKUPS: DIR + "/bks" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
const elemento = (kind, key, name, definition = {}) => ({ kind, key, name, definition });

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc = subir(porta);
await esperarSaudavel(BASE, proc);
const cookie = sessaoDb();
const camp = await req(BASE, "POST", "/campaigns", { cookie, body: { name: "Teste Biblioteca" } });
const cid = camp.json.campanha.id;
const ep = `/campaigns/${cid}/regras/elementos`;
console.log(`servidor teste em ${BASE} — campanha ${cid}`);

let ids = {};
try {
  sec("Atributos básicos (Força, Destreza, Vigor, Inteligência)");
  for (const [key, nome] of [["forca", "Força"], ["destreza", "Destreza"], ["vigor", "Vigor"], ["inteligencia", "Inteligência"]]) {
    const r = await req(BASE, "POST", ep, { cookie, body: elemento("atributo", key, nome, { minimo: 1, maximo: 5 }) });
    t(`criar ${nome}`, r.status === 201, JSON.stringify(r.json).slice(0, 200));
    ids[key] = r.json?.id;
  }

  sec("Campos opcionais vazios / null");
  {
    const r = await req(BASE, "POST", ep, {
      cookie,
      body: {
        kind: "talento", key: "lere", name: "Ler",
        category: null, parentKey: null,
        definition: {
          descricao: null, custoPontos: null, custoProgressivo: null,
          minimo: null, maximo: null, grupoExclusividade: null,
          gruposExclusividade: null, formulas: null, reservaPontos: null,
          prerequisitos: null, obrigatorios: null, niveis: null,
          disponivel: true,
        },
      },
    });
    t("nulls tratados como ausentes", r.status === 201, JSON.stringify(r.json).slice(0, 300));
  }

  sec("Níveis graduados e custo negativo");
  {
    const r = await req(BASE, "POST", ep, {
      cookie,
      body: elemento("defeito", "covardia", "Covardia", {
        niveis: [
          { descricao: "Medo leve", custo: -1 },
          { descricao: "Medo moderado", custo: -2 },
          { descricao: "Pavor", custo: -3 },
        ],
        reservaPontos: "vantagens",
      }),
    });
    t("defeito com 3 níveis e custos negativos", r.status === 201, JSON.stringify(r.json).slice(0, 200));

    const r2 = await req(BASE, "POST", ep, {
      cookie,
      body: elemento("vantagem", "sorte", "Sorte", { custoPontos: -2, custoProgressivo: ["-1", "-2"] }),
    });
    t("vantagem custo negativo + progressivo string", r2.status === 201, JSON.stringify(r2.json).slice(0, 200));

    // confere persistência dos valores
    const lista = await req(BASE, "GET", ep, { cookie });
    const cov = lista.json.elementos.find((e) => e.key === "covardia");
    const sorte = lista.json.elementos.find((e) => e.key === "sorte");
    t("niveis persistidos", cov?.definition?.niveis?.length === 3 && cov.definition.niveis[2].custo === -3);
    t("custo negativo persistido", sorte?.definition?.custoPontos === -2);
    t("progressivo convertido", JSON.stringify(sorte?.definition?.custoProgressivo) === "[-1,-2]");
  }

  sec("Decimal com vírgula (payload real de formulário pt-BR)");
  {
    const r = await req(BASE, "POST", ep, {
      cookie,
      body: elemento("habilidade", "furtividade", "Furtividade", { custoPontos: "2,5", minimo: "1,5", maximo: "4" }),
    });
    t("string decimal-vírgula aceita", r.status === 201, JSON.stringify(r.json).slice(0, 300));
    const lista = await req(BASE, "GET", ep, { cookie });
    const f = lista.json.elementos.find((e) => e.key === "furtividade");
    t("valores convertidos", f?.definition?.custoPontos === 2.5 && f?.definition?.minimo === 1.5 && f?.definition?.maximo === 4);
  }

  sec("Rejeições legítimas preservadas");
  {
    const casos = [
      ["key com acento", elemento("atributo", "força", "Força")],
      ["key maiúscula", elemento("atributo", "Forca", "Força")],
      ["key com espaço", elemento("atributo", "for ca", "Força")],
      ["custoPontos texto", elemento("atributo", "x1", "X1", { custoPontos: "abc" })],
      ["minimo NaN", elemento("atributo", "x2", "X2", { minimo: "abc" })],
      ["6 níveis", elemento("defeito", "x3", "X3", { niveis: [1, 2, 3, 4, 5, 6].map(() => ({})) })],
      ["minLevel texto", elemento("poder", "x4", "X4", { prerequisitos: [{ kind: "atributo", key: "forca", minLevel: "abc" }] })],
      ["kind inválido", { kind: "magia", key: "x5", name: "X5" }],
    ];
    for (const [nome, payload] of casos) {
      const r = await req(BASE, "POST", ep, { cookie, body: payload });
      t(`rejeita ${nome}`, r.status === 400 && Array.isArray(r.json?.detalhes), `status=${r.status}`);
    }
  }

  sec("Edição de elemento existente");
  {
    const lista = await req(BASE, "GET", ep, { cookie });
    const forca = lista.json.elementos.find((e) => e.key === "forca");
    const r = await req(BASE, "PATCH", `${ep}/${forca.id}`, {
      cookie,
      body: { name: "Força Física", category: "Atributos", definition: { descricao: "Potência muscular", custoPontos: 1 } },
    });
    t("editar nome/categoria/definição", r.status === 200, JSON.stringify(r.json).slice(0, 200));
    const depois = await req(BASE, "GET", ep, { cookie });
    const f = depois.json.elementos.find((e) => e.key === "forca");
    t("edição persistida", f?.name === "Força Física" && f?.category === "Atributos" && f?.definition?.descricao === "Potência muscular");
  }
} finally {
  proc.kill();
}

sec("Persistência após restart");
{
  proc = subir(porta);
  await esperarSaudavel(BASE, proc);
  const lista = await req(BASE, "GET", `/campaigns/${cid}/regras`, { cookie: sessaoDb() });
  const chaves = (lista.json?.elementos ?? []).map((e) => e.key);
  t("elementos sobrevivem ao restart", ["forca", "destreza", "vigor", "inteligencia", "covardia", "sorte", "furtividade"].every((k) => chaves.includes(k)), chaves.join(","));
  proc.kill();
}

console.log(`\n==== RESULTADO: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
