// Testes — POST /regras/simulacao (simulador da prévia do editor de fichas).
// Cobre: pontos fictícios, custos de atributo, defeitos que concedem pontos,
// poderes×defeitos, dependências, limites de pool, rejeições e — crítico —
// que NADA é gravado (contagens do banco antes/depois). Cópia isolada.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-simulador";
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
function contagens() {
  const db = new Database(BANCO, { readonly: true });
  const out = {};
  for (const tb of ["characters", "rule_definitions", "sheet_versions", "sheet_templates"]) {
    out[tb] = db.prepare(`select count(*) c from ${tb}`).get().c;
  }
  db.close();
  return out;
}

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc = subir(porta);
await esperarSaudavel(BASE, proc);
const M = sessaoDb();
const camp = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "Teste Simulador" } });
const cid = camp.json.campanha.id;
console.log(`servidor teste em ${BASE} — campanha ${cid}`);

// Estrutura de ficha de teste: atributo + defeitos (níveis) + poderes
const F_FORCA = "f-forca", F_DEF = "f-def", F_POD = "f-pod";
const ESTRUTURA = {
  versao: 1,
  secoes: [{
    id: "s1", titulo: "Principal", ordem: 0, campos: [
      { id: F_FORCA, label: "Força", tipo: "inteiro", semantico: "atributo", minimo: 0, maximo: 5 },
      { id: F_DEF, label: "Defeitos", tipo: "selecao_nivel", regraKind: "defeito" },
      { id: F_POD, label: "Poderes", tipo: "selecao_multipla", regraKind: "poder" },
    ],
  }],
  pontos: { habilitado: true, pontosIniciais: 10, pools: [], custos: { atributo: [1, 2, 3, 4, 5] } },
};
const SIM = (dados, extra = {}) =>
  req(BASE, "POST", `/campaigns/${cid}/regras/simulacao`, { cookie: M, body: { estrutura: ESTRUTURA, dados, ...extra } });
const poolPrincipal = (j) => j?.pontos?.pools?.find((p) => p.id === "principal");
const temErro = (j, frag) => j?.erros?.some((e) => e.mensagem.includes(frag));

try {
  sec("Setup: biblioteca + config");
  {
    const ep = `/campaigns/${cid}/regras/elementos`;
    const d = await req(BASE, "POST", ep, {
      cookie: M,
      body: { kind: "defeito", key: "covardia", name: "Covardia", definition: { niveis: [{ descricao: "Medo leve", custo: -1 }, { descricao: "Pavor", custo: -2 }] } },
    });
    t("criar defeito graduado", d.status === 201, JSON.stringify(d.json).slice(0, 200));
    const dm = await req(BASE, "POST", ep, {
      cookie: M,
      body: { kind: "defeito", key: "manco", name: "Manco", definition: { custoPontos: -1, dependencias: [{ kind: "defeito", key: "covardia" }] } },
    });
    t("criar defeito c/ dependência", dm.status === 201, JSON.stringify(dm.json).slice(0, 200));
    const p = await req(BASE, "POST", ep, { cookie: M, body: { kind: "poder", key: "fogo", name: "Manipular Fogo", definition: { custoPontos: 3 } } });
    t("criar poder", p.status === 201);
    const cfg = await req(BASE, "PUT", `/campaigns/${cid}/regras/config`, {
      cookie: M,
      body: {
        poderes: { exigirDefeito: true },
        hp: { habilitado: true, base: 100, porNivel: 20, campoId: F_FORCA, edicaoPor: "ambos" },
        vitalidade: {
          edicaoPor: "ambos",
          niveis: [
            { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
            { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
            { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
          ],
        },
      },
    });
    t("config exigirDefeito + hp + vitalidade", cfg.status === 200, JSON.stringify(cfg.json?.detalhes ?? "").slice(0, 200));
  }
  const antesSim = contagens(); // snapshot APÓS o setup — simulação não pode alterar nada

  sec("Simulação: pontos e custos");
  {
    const r0 = await SIM({});
    t("simulação vazia -> 200", r0.status === 200, JSON.stringify(r0.json).slice(0, 300));
    t("pontos habilitados", r0.json?.pontos?.habilitado === true);
    t("saldo inicial 10", poolPrincipal(r0.json)?.saldo === 10, `saldo=${poolPrincipal(r0.json)?.saldo}`);
    t("pontosCfg efetiva retornada", r0.json?.pontosCfg?.habilitado === true);

    const r1 = await SIM({ [F_FORCA]: 3 });
    // custos atributo [1,2,3,4,5]: níveis 0->3 = 1+2+3 = 6
    t("Força 3 custa 6 -> saldo 4", poolPrincipal(r1.json)?.saldo === 4, `saldo=${poolPrincipal(r1.json)?.saldo}`);
    t("detalhe de custo do campo", r1.json?.pontos?.detalhes?.some((d) => d.campoId === F_FORCA && d.custo === 6));

    const r2 = await SIM({ [F_FORCA]: 3, [F_DEF]: [{ key: "covardia", nivel: 2 }] });
    // defeito nv2: -1 + -2 = -3 pontos concedidos -> saldo 4 + 3 = 7
    t("defeito nv2 concede 3 -> saldo 7", poolPrincipal(r2.json)?.saldo === 7, `saldo=${poolPrincipal(r2.json)?.saldo}`);
    t("sem erros com defeito", r2.json?.ok === true, JSON.stringify(r2.json?.erros).slice(0, 200));
  }

  sec("Simulação: pontos fictícios");
  {
    const r = await SIM({ [F_FORCA]: 3 }, { pontosFicticios: 100 });
    t("pontosFicticios=100 -> disponível 100", poolPrincipal(r.json)?.disponiveis === 100, `disp=${poolPrincipal(r.json)?.disponiveis}`);
    t("saldo 94 após Força 3", poolPrincipal(r.json)?.saldo === 94, `saldo=${poolPrincipal(r.json)?.saldo}`);
    const r2 = await SIM({ [F_FORCA]: 5 }, { pontosFicticios: 10 });
    t("orçamento 10 estoura com Força 5", poolPrincipal(r2.json)?.saldo === -5 && temErro(r2.json, "pontos insuficientes"), `saldo=${poolPrincipal(r2.json)?.saldo}`);
  }

  sec("Simulação: poderes × defeitos e dependências");
  {
    const r1 = await SIM({ [F_POD]: ["fogo"], [F_DEF]: [] });
    t("poder sem defeito -> erro", r1.json?.ok === false && temErro(r1.json, "defeito"), JSON.stringify(r1.json?.erros).slice(0, 200));

    const r2 = await SIM({ [F_POD]: ["fogo"], [F_DEF]: [{ key: "covardia", nivel: 1 }] });
    // poder 3 - defeito 1 = saldo 10 - 3 + 1 = 8
    t("poder+defeito ok -> saldo 8", r2.json?.ok === true && poolPrincipal(r2.json)?.saldo === 8, `saldo=${poolPrincipal(r2.json)?.saldo} erros=${JSON.stringify(r2.json?.erros).slice(0, 200)}`);

    const r3 = await SIM({ [F_DEF]: [{ key: "manco", nivel: 1 }] });
    t("manco sem covardia -> dependência", r3.json?.ok === false && temErro(r3.json, "Covardia"), JSON.stringify(r3.json?.erros).slice(0, 200));

    const r4 = await SIM({ [F_DEF]: [{ key: "manco", nivel: 1 }, { key: "covardia", nivel: 1 }] });
    // manco -1 + covardia nv1 -1 = +2 -> saldo 12
    t("manco+covardia -> saldo 12", r4.json?.ok === true && poolPrincipal(r4.json)?.saldo === 12, `saldo=${poolPrincipal(r4.json)?.saldo} erros=${JSON.stringify(r4.json?.erros).slice(0, 200)}`);
  }

  sec("Simulação: HP e Vitalidade");
  {
    const r0 = await SIM({});
    t("vida.hp presente", r0.json?.vida?.hp?.maximo === 100 && r0.json?.vida?.hp?.atual === 100, JSON.stringify(r0.json?.vida?.hp).slice(0, 150));
    t("vida.vitalidade nível 0", r0.json?.vida?.vitalidade?.nome === "São" && r0.json?.vida?.vitalidade?.niveis?.length === 3);

    const r1 = await SIM({ [F_FORCA]: 3 });
    t("Força 3 -> HP máximo 160", r1.json?.vida?.hp?.maximo === 160 && r1.json?.vida?.hp?.atual === 160, `hp=${r1.json?.vida?.hp?.maximo}`);

    // chaves reservadas não são campos — simulação não aceita __hp/__vitalidade
    const r2 = await SIM({ [F_FORCA]: 0, __hp: { atual: 1, historico: [] }, __vitalidade: { nivel: 2 } });
    t("__hp/__vitalidade ignorados (HP cheio, vitalidade 0)", r2.json?.vida?.hp?.atual === 100 && r2.json?.vida?.vitalidade?.nivel === 0, `hp=${r2.json?.vida?.hp?.atual} vit=${r2.json?.vida?.vitalidade?.nivel}`);
  }

  sec("Simulação: rejeições e permissões");
  {
    const semAuth = await req(BASE, "POST", `/campaigns/${cid}/regras/simulacao`, { body: { estrutura: ESTRUTURA, dados: {} } });
    t("sem sessão -> 401", semAuth.status === 401, `status=${semAuth.status}`);
    const invalido = await req(BASE, "POST", `/campaigns/${cid}/regras/simulacao`, { cookie: M, body: { dados: {} } });
    t("sem estrutura -> 400", invalido.status === 400, `status=${invalido.status}`);
    const estruturaRuim = await SIM({});
    void estruturaRuim;
    const neg = await req(BASE, "POST", `/campaigns/${cid}/regras/simulacao`, {
      cookie: M,
      body: { estrutura: { ...ESTRUTURA, pontos: { ...ESTRUTURA.pontos, pontosIniciais: -5 } }, dados: {}, pontosFicticios: -1 },
    });
    t("pontosFicticios negativo -> 400", neg.status === 400, `status=${neg.status}`);
  }

  sec("Isolamento: nada gravado");
  {
    const depois = contagens();
    t("personagens inalterados", depois.characters === antesSim.characters);
    t("regras inalteradas", depois.rule_definitions === antesSim.rule_definitions);
    t("fichas inalteradas", depois.sheet_versions === antesSim.sheet_versions && depois.sheet_templates === antesSim.sheet_templates);
    const sess = new Database(BANCO, { readonly: true });
    const dadosPersonagem = sess.prepare("select count(*) c from characters").get().c;
    sess.close();
    t("0 personagens criados pela simulação", dadosPersonagem === 0);
  }
} finally {
  proc.kill();
}

console.log(`\n==== RESULTADO: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
