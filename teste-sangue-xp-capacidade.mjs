#!/usr/bin/env node
// Issue #186 adendo — compra de nível por XP da Característica de
// capacidade de Sangue (exceção estreita, SEM liberar `caracteristica`
// globalmente). Banco 100% descartável.
// Cobre: 0→1 no campo configurado, custo incremental, XP debitado uma
// vez, __sangue.saldo intacto, inelegíveis (outra característica,
// sangue off, campo errado, custo ausente), permissões, campo oculto,
// concorrência/retry, regressão de kinds proibidos.
import crypto from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  req, dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("sangue-xp-cap");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");

const progressaoDe = (id, cookie) => req(BASE, "GET", `/characters/${id}/progressao`, { cookie });
const comprar = (id, cookie, body) => req(BASE, "POST", `/characters/${id}/comprar-ponto`, { cookie, body });
const darXp = (id, cookie, body) => req(BASE, "POST", `/characters/${id}/xp`, { cookie, body });

function db() { return abrirDb(BANCO); }
function selarFicha(charId, dados = {}) {
  const w = db();
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    const data = JSON.parse(row.data || "{}");
    Object.assign(data, dados);
    const atual = data.__pontos && typeof data.__pontos === "object" ? data.__pontos : {};
    data.__pontos = { ...atual, selo: { em: new Date().toISOString(), autorId: "t", autorNome: "T" } };
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(data), charId);
  } finally { w.close(); }
}
function dadosChar(charId) {
  const w = db();
  try { return JSON.parse(w.prepare("select data from characters where id=?").get(charId).data); }
  finally { w.close(); }
}
function setSangueConfig(campId, sangue) {
  const w = db();
  try {
    const rs = w.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
    const cfg = JSON.parse(rs.config || "{}");
    if (sangue === null) delete cfg.sangue; else cfg.sangue = sangue;
    w.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { w.close(); }
}
function arquivar(charId) {
  const w = db();
  try { w.prepare("update characters set status='arquivado' where id=?").run(charId); }
  finally { w.close(); }
}

const SANGUE_CFG = { habilitado: true, campoCapacidadeId: "f-sangue" };

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Sangue XP",
    jogadores: { jogador1: "jog_sx", jogador2: "jog_outro" },
    config: { pontos: { habilitado: true, pontosIniciais: 5, pools: [], custos: {} } },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie;
  const J2 = c.jogadores.jogador2.cookie;

  sec("Biblioteca + ficha com campo de capacidade");
  // caracteristica de capacidade (custoPontos = preço por nível no motor)
  await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
    cookie: M, body: { kind: "caracteristica", key: "sangue_cap", name: "Capacidade de Sangue", definition: { custoPontos: 3, disponivel: true } },
  });
  // outra caracteristica NÃO configurada como capacidade
  await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
    cookie: M, body: { kind: "caracteristica", key: "carisma", name: "Carisma", definition: { custoPontos: 3, disponivel: true } },
  });
  // vantagem para regressão de kind proibido
  await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
    cookie: M, body: { kind: "vantagem", key: "sorte", name: "Sorte", definition: { custoPontos: 1, disponivel: true } },
  });

  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Sangue" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Personagem", ordem: 0, campos: [
        { id: "f-sangue", label: "Capacidade de Sangue", tipo: "inteiro", semantico: "atributo", regra: { kind: "caracteristica", key: "sangue_cap" }, custoPontos: 3 },
        { id: "f-car", label: "Carisma", tipo: "inteiro", regra: { kind: "caracteristica", key: "carisma" }, custoPontos: 3 },
        { id: "f-vant", label: "Sorte", tipo: "inteiro", regra: { kind: "vantagem", key: "sorte" }, custoPontos: 1 },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
  setSangueConfig(CID, SANGUE_CFG);

  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1, body: { name: "Sangue XP", templateVersionId: vid, data: {} },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  t("personagem criado", !!CHAR, JSON.stringify(pj.json).slice(0, 160));
  selarFicha(CHAR, { __sangue: { saldo: 7, usos: {}, historico: [] } });
  const pj2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J2, body: { name: "Outro", templateVersionId: vid, data: {} },
  });
  const CHAR2 = pj2.json?.personagem?.id ?? pj2.json?.id;
  selarFicha(CHAR2);
  await darXp(CHAR, M, { acao: "conceder", quantidade: 20, motivo: "seed xp" });

  sec("GET progressao — capacidade visível como comprável");
  {
    const g = await progressaoDe(CHAR, J1);
    const el = (g.json?.disponiveis ?? []).find((d) => d.kind === "caracteristica" && d.key === "sangue_cap");
    t("caracteristica capacidade listada", !!el, JSON.stringify(g.json?.disponiveis).slice(0, 200));
    t("compravel com preco 3 (0→1)", el?.compravel === true && el?.precoProximo === 3, JSON.stringify(el));
    t("marcador positivo capacidadeSangue:true", el?.capacidadeSangue === true, JSON.stringify(el));
    const car = (g.json?.disponiveis ?? []).find((d) => d.kind === "caracteristica" && d.key === "carisma");
    t("outra caracteristica NÃO compravel", car && car.compravel === false, JSON.stringify(car));
    t("outra caracteristica SEM marcador", car?.capacidadeSangue !== true, JSON.stringify(car));
    const vant = (g.json?.disponiveis ?? []).find((d) => d.kind === "vantagem");
    t("vantagem SEM marcador", vant?.capacidadeSangue !== true, JSON.stringify(vant));
  }

  sec("POST 0→1 — débito único, __sangue intacto");
  {
    const r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 1 });
    t("compra 0→1 aceita", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    const d = dadosChar(CHAR);
    t("campo f-sangue = 1", d["f-sangue"] === 1, `valor=${d["f-sangue"]}`);
    t("XP debitado (20→17)", r.json?.xp?.saldo === 17, JSON.stringify(r.json?.xp));
    t("__sangue.saldo intacto (7)", d.__sangue?.saldo === 7, JSON.stringify(d.__sangue));
    t("sem evento __sangue novo", (d.__sangue?.historico ?? []).length === 0);
    const hist = d.__xp?.historico ?? [];
    const ev = hist.at(-1);
    t("evento compra com kind/key", ev?.compra?.kind === "caracteristica" && ev?.compra?.key === "sangue_cap" && ev?.compra?.campoId === "f-sangue", JSON.stringify(ev?.compra));
  }

  sec("Incremento 1→2 — custo correto, XP debitado de novo");
  {
    const r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 2 });
    t("compra 1→2 aceita", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    const d = dadosChar(CHAR);
    t("campo = 2", d["f-sangue"] === 2);
    t("XP 17→14", r.json?.xp?.saldo === 14, JSON.stringify(r.json?.xp));
    t("__sangue.saldo ainda 7", d.__sangue?.saldo === 7);
    t("financiado registra campo", Array.isArray(d.__xp?.financiado?.["f-sangue"]) && d.__xp.financiado["f-sangue"].length === 2, JSON.stringify(d.__xp?.financiado));
  }

  sec("Inelegíveis — recusados sem efeito");
  {
    const casos = [
      ["outra caracteristica", { kind: "caracteristica", key: "carisma", nivelAlvo: 1 }],
      ["vantagem (kind proibido)", { kind: "vantagem", key: "sorte", nivelAlvo: 1 }],
      ["salto de nível", { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 5 }],
      ["nivelAlvo 0", { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 0 }],
      ["key inexistente", { kind: "caracteristica", key: "fantasma", nivelAlvo: 1 }],
    ];
    for (const [nome, body] of casos) {
      const r = await comprar(CHAR, J1, body);
      t(`400: ${nome}`, r.status === 400, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    }
    const d = dadosChar(CHAR);
    t("campo intacto (=2)", d["f-sangue"] === 2);
    t("XP intacto (14)", d.__xp?.saldo === 14, `saldo=${d.__xp?.saldo}`);
  }

  sec("Sangue desabilitado / config ausente → fail-closed");
  {
    setSangueConfig(CID, { habilitado: false, campoCapacidadeId: "f-sangue" });
    let r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 3 });
    t("habilitado:false → 400", r.status === 400, `status=${r.status}`);
    {
      const g = await progressaoDe(CHAR, J1);
      const el = (g.json?.disponiveis ?? []).find((d) => d.key === "sangue_cap");
      t("sangue off → SEM marcador capacidadeSangue", el?.capacidadeSangue !== true, JSON.stringify(el));
    }
    setSangueConfig(CID, { habilitado: true }); // sem campoCapacidadeId
    r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 3 });
    t("sem campoCapacidadeId → 400", r.status === 400, `status=${r.status}`);
    setSangueConfig(CID, { habilitado: true, campoCapacidadeId: "f-car" }); // aponta p/ OUTRO campo
    r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 3 });
    t("campo divergente → 400", r.status === 400, `status=${r.status}`);
    setSangueConfig(CID, null); // sem bloco sangue
    r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 3 });
    t("sem config.sangue → 400", r.status === 400, `status=${r.status}`);
    setSangueConfig(CID, SANGUE_CFG); // restaura
    const d = dadosChar(CHAR);
    t("nada alterado (campo=2, xp=14)", d["f-sangue"] === 2 && d.__xp?.saldo === 14);
  }

  sec("Permissões — arquivado, não-dono, campo oculto");
  {
    // jogador2 tenta comprar no personagem do jogador1
    let r = await comprar(CHAR, J2, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 3 });
    t("não-dono → 403/404", r.status === 403 || r.status === 404, `status=${r.status}`);
    // arquivado
    arquivar(CHAR2);
    r = await comprar(CHAR2, J2, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 1 });
    t("arquivado → 403", r.status === 403, `status=${r.status}`);
    // campo oculto para o jogador: override visibilidade mestre
    const w = db();
    try {
      w.prepare("update characters set overrides=? where id=?").run(JSON.stringify({ "f-sangue": { visibilidade: "mestre" } }), CHAR);
    } finally { w.close(); }
    r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 3 });
    t("campo oculto p/ jogador → 400/403", r.status === 400 || r.status === 403, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    const g = await progressaoDe(CHAR, J1);
    const el = (g.json?.disponiveis ?? []).find((d) => d.key === "sangue_cap");
    t("GET omite capacidade oculta do jogador", !el || el.compravel === false, JSON.stringify(el));
    // mestre continua podendo (campo visível p/ mestre)
    r = await comprar(CHAR, M, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 3 });
    t("mestre compra campo oculto → 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    // limpa override para os próximos testes
    const w2 = db();
    try { w2.prepare("update characters set overrides='{}' where id=?").run(CHAR); } finally { w2.close(); }
    const d = dadosChar(CHAR);
    t("campo agora 3", d["f-sangue"] === 3, `valor=${d["f-sangue"]}`);
    t("__sangue.saldo ainda 7", d.__sangue?.saldo === 7);
  }

  sec("XP insuficiente / concorrência / retry");
  {
    // zera XP
    const w = db();
    try {
      const row = w.prepare("select data from characters where id=?").get(CHAR);
      const data = JSON.parse(row.data);
      data.__xp = { saldo: 2, historico: [], financiado: data.__xp?.financiado };
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(data), CHAR);
    } finally { w.close(); }
    let r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 4 });
    t("XP insuficiente → 400 xp_insuficiente", r.status === 400 && r.json?.codigo === "xp_insuficiente", `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    {
      const g = await progressaoDe(CHAR, J1);
      const el = (g.json?.disponiveis ?? []).find((d) => d.key === "sangue_cap");
      t("XP insuficiente → marcador persiste, compravel false", el?.capacidadeSangue === true && el?.compravel === false, JSON.stringify(el));
    }
    // repõe XP e corre duas compras simultâneas do mesmo nível
    const w2 = db();
    try {
      const row = w2.prepare("select data from characters where id=?").get(CHAR);
      const data = JSON.parse(row.data);
      data.__xp = { saldo: 20, historico: [], financiado: data.__xp?.financiado };
      w2.prepare("update characters set data=? where id=?").run(JSON.stringify(data), CHAR);
    } finally { w2.close(); }
    const [r1, r2] = await Promise.all([
      comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 4 }),
      comprar(CHAR, M, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 4 }),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 200).length;
    t("corrida: exatamente 1 compra efetivada", oks === 1, `statuses=${r1.status}|${r2.status}`);
    const d = dadosChar(CHAR);
    t("campo = 4 (uma única transição)", d["f-sangue"] === 4, `valor=${d["f-sangue"]}`);
    t("XP debitado uma vez (20→17)", d.__xp?.saldo === 17, `saldo=${d.__xp?.saldo}`);
    t("__sangue.saldo ainda 7", d.__sangue?.saldo === 7);
  }

  sec("Regressão — kinds proibidos seguem bloqueados");
  {
    const r = await comprar(CHAR, J1, { kind: "caracteristica", key: "carisma", nivelAlvo: 1 });
    t("carisma (caracteristica não-configurada) → 400", r.status === 400, `status=${r.status}`);
    const g = await progressaoDe(CHAR, J1);
    const car = (g.json?.disponiveis ?? []).find((d) => d.key === "carisma");
    t("GET: carisma não compravel", car?.compravel === false);
  }
} catch (e) {
  fail++;
  console.log("FALHOU exceção:", e?.stack ?? e);
} finally {
  try { if (proc) await encerrarServidor(proc); } catch {}
  try { limparDir(DIR); } catch {}
}
console.log(`\n===== ${pass} passaram / ${fail} falharam =====`);
process.exit(fail ? 1 : 0);
