// Testes — configuração de HP/Vitalidade/Poderes×Defeitos e integração na ficha.
// Cobre: PUT /regras/config (payload completo estilo-UI + rejeições com
// detalhes), modelo de ficha com campos de biblioteca, publicação,
// criação de personagem, seleção de defeitos por nível, HP e vitalidade,
// e persistência após restart. Roda em CÓPIA isolada — nunca no banco real.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-vida-config";
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

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc = subir(porta);
await esperarSaudavel(BASE, proc);
const cookie = () => sessaoDb();
const M = cookie();
const camp = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "Teste Vida Config" } });
const cid = camp.json.campanha.id;
console.log(`servidor teste em ${BASE} — campanha ${cid}`);

let charId, VIGOR = "", DEFEITOS = "", PODERES = "";
try {
  sec("Config: payload completo estilo-UI");
  {
    // payload idêntico ao que PainelPontuacao envia (config inteira + custos)
    const cfg = await req(BASE, "GET", `/campaigns/${cid}/regras`, { cookie: M });
    const base = cfg.json.config;
    const r = await req(BASE, "PUT", `/campaigns/${cid}/regras/config`, {
      cookie: M,
      body: {
        ...base,
        pontos: { ...base.pontos, custos: { atributo: [1, 2, 3, 4, 5] } },
        hp: { habilitado: true, base: 100, porNivel: 20, edicaoPor: "ambos" },
        vitalidade: {
          edicaoPor: "ambos",
          niveis: [
            { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
            { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
            { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
          ],
        },
        poderes: { limitePoderes: 1, exigirDefeito: true },
        dados: { d10SucessoMinimo: 6 },
      },
    });
    t("PUT config completa -> 200", r.status === 200, JSON.stringify(r.json).slice(0, 300));
    const cfg2 = await req(BASE, "GET", `/campaigns/${cid}/regras`, { cookie: M });
    t("hp persistido", cfg2.json.config.hp?.habilitado === true && cfg2.json.config.hp?.base === 100);
    t("vitalidade custom persistida (3 níveis)", cfg2.json.config.vitalidade?.niveis?.length === 3);
    t("poderes.exigirDefeito persistido", cfg2.json.config.poderes?.exigirDefeito === true);
  }

  sec("Config: rejeições com detalhes de campo");
  {
    const casos = [
      ["nível sem nome", { vitalidade: { niveis: [{ nome: "", penalidadeDados: 0, bloqueiaAcoes: false }] } }],
      ["penalidade 31", { vitalidade: { niveis: [{ nome: "X", penalidadeDados: 31, bloqueiaAcoes: false }] } }],
      ["penalidade decimal", { vitalidade: { niveis: [{ nome: "X", penalidadeDados: 1.5, bloqueiaAcoes: false }] } }],
      ["hp base negativa", { hp: { base: -5 } }],
      ["d10 = 11", { dados: { d10SucessoMinimo: 11 } }],
    ];
    for (const [nome, patch] of casos) {
      const r = await req(BASE, "PUT", `/campaigns/${cid}/regras/config`, { cookie: M, body: patch });
      t(`rejeita ${nome}`, r.status === 400 && Array.isArray(r.json?.detalhes), `status=${r.status} ${JSON.stringify(r.json?.detalhes?.[0]?.path ?? "")}`);
    }
    // restaura config válida
    await req(BASE, "PUT", `/campaigns/${cid}/regras/config`, {
      cookie: M,
      body: { vitalidade: { niveis: [{ nome: "São", penalidadeDados: 0, bloqueiaAcoes: false }, { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false }, { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true }] } },
    });
  }

  sec("Biblioteca: defeitos e poderes com níveis");
  {
    const ep = `/campaigns/${cid}/regras/elementos`;
    const d = await req(BASE, "POST", ep, {
      cookie: M,
      body: { kind: "defeito", key: "covardia", name: "Covardia", definition: { niveis: [{ descricao: "Medo leve", custo: -1 }, { descricao: "Pavor", custo: -2 }], reservaPontos: "vantagens" } },
    });
    t("criar defeito graduado", d.status === 201, JSON.stringify(d.json).slice(0, 200));
    const p = await req(BASE, "POST", ep, { cookie: M, body: { kind: "poder", key: "fogo", name: "Manipular Fogo", definition: { custoPontos: 3 } } });
    t("criar poder", p.status === 201);
    const vin = await req(BASE, "GET", `/campaigns/${cid}/regras/vinculaveis`, { cookie: M });
    const cov = vin.json?.elementos?.defeito?.find((e) => e.key === "covardia");
    t("vinculaveis expõe defeito c/ níveis", cov?.niveis?.length === 2);
  }

  sec("Ficha: modelo com Vigor + campos de biblioteca, publicar");
  {
    const mod = await req(BASE, "POST", `/campaigns/${cid}/sheet-templates`, { cookie: M, body: { name: "Ficha Vida" } });
    t("criar modelo", mod.status === 201, JSON.stringify(mod.json).slice(0, 200));
    const tid = mod.json.modelo.id;
    const vid = mod.json.modelo.versionId;
    const def = await req(BASE, "PATCH", `/campaigns/${cid}/sheet-templates/${tid}`, { cookie: M, body: { isDefault: true } });
    t("marcar modelo como padrão", def.status === 200, JSON.stringify(def.json).slice(0, 200));
    const estrutura = {
      versao: 1,
      secoes: [{
        id: "s1", titulo: "Atributos", ordem: 0, campos: [
          { id: "f-vigor", label: "Vigor", tipo: "inteiro", semantico: "atributo", minimo: 0, maximo: 10 },
        ],
      }, {
        id: "s2", titulo: "Poderes e Defeitos", ordem: 1, campos: [
          { id: "f-defeitos", label: "Defeitos", tipo: "selecao_nivel", regraKind: "defeito" },
          { id: "f-poderes", label: "Poderes", tipo: "selecao_multipla", regraKind: "poder" },
        ],
      }],
      pontos: { habilitado: true, pontosIniciais: 30, pools: [{ id: "principal", nome: "Principal", pontos: 30 }, { id: "vantagens", nome: "Vantagens", pontos: 5 }], custos: { atributo: [1, 2, 3, 4, 5] } },
    };
    const put = await req(BASE, "PUT", `/campaigns/${cid}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
    t("salvar estrutura rascunho", put.status === 200, JSON.stringify(put.json).slice(0, 300));
    const pub = await req(BASE, "POST", `/campaigns/${cid}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
    t("publicar versão", pub.status === 200, JSON.stringify(pub.json).slice(0, 200));
    VIGOR = "f-vigor"; DEFEITOS = "f-defeitos"; PODERES = "f-poderes";
    // HP passa a apontar explicitamente para o campo Vigor da ficha publicada
    const cfgHp = await req(BASE, "PUT", `/campaigns/${cid}/regras/config`, {
      cookie: M,
      body: { hp: { habilitado: true, base: 100, porNivel: 20, campoId: VIGOR, edicaoPor: "ambos" } },
    });
    t("config hp.campoId = Vigor", cfgHp.status === 200, JSON.stringify(cfgHp.json?.detalhes ?? "").slice(0, 200));
  }

  sec("Personagem: HP por Vigor, defeitos por nível, vitalidade");
  {
    const novo = await req(BASE, "POST", `/campaigns/${cid}/characters`, { cookie: M, body: { name: "PJ Vida Config" } });
    t("criar personagem", novo.status === 201 || novo.status === 200, JSON.stringify(novo.json).slice(0, 200));
    charId = novo.json?.id ?? novo.json?.personagem?.id;
    if (!charId) throw new Error("personagem criado sem id: " + JSON.stringify(novo.json).slice(0, 300));
    let ficha = (await req(BASE, "GET", `/characters/${charId}`, { cookie: M })).json?.ficha;
    t("vida exposta", !!ficha?.vida, JSON.stringify(Object.keys(ficha ?? {})));
    t("HP inicial = base 100 (Vigor 0)", ficha?.vida?.hp?.maximo === 100 && ficha?.vida?.hp?.atual === 100, `hp=${ficha?.vida?.hp?.maximo}`);
    t("vitalidade nível 0 custom", ficha?.vida?.vitalidade?.nome === "São" && ficha?.vida?.vitalidade?.niveis?.length === 3);

    // sobe Vigor -> HP recalcula; defeito nv2 + sem poder (exigirDefeito só p/ poder)
    const patch = await req(BASE, "PATCH", `/characters/${charId}`, {
      cookie: M,
      body: { data: { [VIGOR]: 3, [DEFEITOS]: [{ key: "covardia", nivel: 2 }] } },
    });
    t("salvar ficha c/ vigor+defeito", patch.status === 200, JSON.stringify(patch.json?.detalhes ?? patch.json).slice(0, 300));
    ficha = (await req(BASE, "GET", `/characters/${charId}`, { cookie: M })).json?.ficha;
    t("Vigor 3 -> HP máximo 160", ficha?.vida?.hp?.maximo === 160, `max=${ficha?.vida?.hp?.maximo}`);
    t("HP atual preservado", ficha?.vida?.hp?.atual === 100, `atual=${ficha?.vida?.hp?.atual}`);
    const defeitos = ficha?.campos?.[DEFEITOS];
    t("defeito persistido nv2", Array.isArray(defeitos) && defeitos[0]?.key === "covardia" && defeitos[0]?.nivel === 2, JSON.stringify(defeitos));

    // poder sem defeito já tem defeito -> ok; agora testa exigirDefeito removendo defeito
    const patch2 = await req(BASE, "PATCH", `/characters/${charId}`, { cookie: M, body: { data: { [PODERES]: ["fogo"], [DEFEITOS]: [] } } });
    t("poder sem defeito rejeitado", patch2.status === 400, `status=${patch2.status}`);
    const patch3 = await req(BASE, "PATCH", `/characters/${charId}`, { cookie: M, body: { data: { [PODERES]: ["fogo"], [DEFEITOS]: [{ key: "covardia", nivel: 1 }] } } });
    t("poder + defeito aceito", patch3.status === 200, `status=${patch3.status} ${JSON.stringify(patch3.json?.detalhes ?? "")}`);

    // HP dano/recuperar
    const dano = await req(BASE, "POST", `/characters/${charId}/hp`, { cookie: M, body: { acao: "dano", quantidade: 40, motivo: "Combate" } });
    t("dano 40 -> HP 60", dano.json?.hp?.atual === 60, `atual=${dano.json?.hp?.atual}`);
    const rec = await req(BASE, "POST", `/characters/${charId}/hp`, { cookie: M, body: { acao: "recuperar", quantidade: 200 } });
    t("recuperar limitado ao máximo 160", rec.json?.hp?.atual === 160, `atual=${rec.json?.hp?.atual}`);

    // vitalidade custom: nível 2 = Incapacitado
    const vit = await req(BASE, "POST", `/characters/${charId}/vitalidade`, { cookie: M, body: { nivel: 2 } });
    t("vitalidade -> Incapacitado", vit.json?.vitalidade?.nome === "Incapacitado" && vit.json?.vitalidade?.bloqueiaAcoes === true, JSON.stringify(vit.json?.vitalidade?.nome));
    const vitBad = await req(BASE, "POST", `/characters/${charId}/vitalidade`, { cookie: M, body: { nivel: 9 } });
    t("nível vitalidade inválido -> 400", vitBad.status === 400);
    await req(BASE, "POST", `/characters/${charId}/vitalidade`, { cookie: M, body: { nivel: 0 } });
  }
} finally {
  proc.kill();
}

sec("Persistência após restart");
{
  proc = subir(porta);
  await esperarSaudavel(BASE, proc);
  const cfg = await req(BASE, "GET", `/campaigns/${cid}/regras`, { cookie: sessaoDb() });
  t("config hp/vitalidade/poderes persistem", cfg.json?.config?.hp?.habilitado === true && cfg.json?.config?.vitalidade?.niveis?.length === 3 && cfg.json?.config?.poderes?.exigirDefeito === true);
  const ficha = (await req(BASE, "GET", `/characters/${charId}`, { cookie: sessaoDb() })).json?.ficha;
  t("HP 160/160 e vitalidade 0 persistem", ficha?.vida?.hp?.maximo === 160 && ficha?.vida?.hp?.atual === 160 && ficha?.vida?.vitalidade?.nivel === 0, `hp=${ficha?.vida?.hp?.atual}/${ficha?.vida?.hp?.maximo} vit=${ficha?.vida?.vitalidade?.nivel}`);
  const defeitos = ficha?.campos?.[DEFEITOS];
  t("defeito nv1 persiste", Array.isArray(defeitos) && defeitos[0]?.key === "covardia" && defeitos[0]?.nivel === 1);
  proc.kill();
}

console.log(`\n==== RESULTADO: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
