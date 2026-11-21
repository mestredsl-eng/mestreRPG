#!/usr/bin/env node
// Issue #186 R7.1 — GET /api/characters/:id/sangue (somente leitura).
// Banco 100% descartável. Cobre: dono/mestre, não-dono/espectador,
// arquivado, config desabilitada/inválida, natureza/ação, modos de
// capacidade (valor/somaNiveis/mapa), ledger ausente/válido/corrompido,
// cache adulterado ignorado, GET sem escrita, sem vazamento de usos.
import crypto from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  req, dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir, sessao,
} from "./teste-base.mjs";

const DIR = dirTeste("sangue-read-api");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");

const getSangue = (id, cookie) => req(BASE, "GET", `/characters/${id}/sangue`, { cookie });

function db() { return abrirDb(BANCO); }
function dadosRow(charId) {
  const w = db();
  try { return w.prepare("select data, updated_at from characters where id=?").get(charId); }
  finally { w.close(); }
}
function setSangue(charId, sangue) {
  const w = db();
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    const data = JSON.parse(row.data || "{}");
    if (sangue === undefined) delete data.__sangue; else data.__sangue = sangue;
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(data), charId);
  } finally { w.close(); }
}
function setCampo(charId, campoId, valor) {
  const w = db();
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    const data = JSON.parse(row.data || "{}");
    data[campoId] = valor;
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(data), charId);
  } finally { w.close(); }
}
function setStatus(charId, status) {
  const w = db();
  try { w.prepare("update characters set status=? where id=?").run(status, charId); }
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

const CFG_BASE = {
  habilitado: true,
  campoCapacidadeId: "f-cap",
  campoNaturezaId: "f-nat",
  naturezas: {
    humano: { recuperacao: "descansar" },
    vampiro: { recuperacao: "alimentar", metaHumanoComPoder: true },
  },
  recuperacaoSangue: {
    habilitado: true,
    acoes: {
      descansar: { habilitada: true, quantidade: 2 },
      alimentar: { habilitada: true, quantidade: 3 },
    },
  },
};

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Sangue Read",
    jogadores: { jogador1: "jog_rd", jogador2: "jog_outro" },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie;
  const J2 = c.jogadores.jogador2.cookie;

  // Espectador: membership role=espectador + sessão própria
  const wEsp = db();
  let ESP;
  try {
    const uid = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const agora = Date.now();
    wEsp.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, "esp_read", "Espectador", "$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfakeha", agora, agora);
    wEsp.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(mid, CID, uid, agora, agora, agora);
    ESP = sessao(BANCO, uid);
  } finally { wEsp.close(); }

  sec("Template com campos de capacidade/natureza");
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Sangue" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Sangue", ordem: 0, campos: [
        { id: "f-cap", label: "Capacidade", tipo: "inteiro" },
        { id: "f-cap-soma", label: "Cap Soma", tipo: "selecao_nivel" },
        { id: "f-cap-mapa", label: "Cap Mapa", tipo: "selecao_unica" },
        { id: "f-nat", label: "Natureza", tipo: "selecao_unica" },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
  setSangueConfig(CID, CFG_BASE);

  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1,
    body: { name: "Lobisomem", templateVersionId: vid, data: { "f-cap": 8, "f-nat": "humano", "f-cap-soma": [{ key: "a", nivel: 2 }, { key: "b", nivel: 3 }], "f-cap-mapa": "Medio" } },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  t("personagem criado", !!CHAR, JSON.stringify(pj.json).slice(0, 160));
  const testId = crypto.randomUUID();
  setSangue(CHAR, {
    saldo: 5,
    usos: { [`d10:${testId}`]: { tipo: "uso", em: "2026-01-01T00:00:00.000Z", personagemId: CHAR, testId } },
    historico: [{ tipo: "ajuste", em: "2026-01-01T00:00:00.000Z", quantidade: 5, saldoResultante: 5, motivo: "seed" }],
    capacidade: 999,
    ancora: 0,
  });

  sec("Leitura autorizada — dono e mestre");
  {
    const r = await getSangue(CHAR, J1);
    t("dono → 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    const j = r.json ?? {};
    t("estado ok", j.estado === "ok", JSON.stringify(j));
    t("saldo derivado do ledger (5)", j.saldo === 5, `saldo=${j.saldo}`);
    t("capacidadeMax derivada do campo (8), ignora cache 999", j.capacidadeMax === 8, `cap=${j.capacidadeMax}`);
    t("utilizavel true", j.utilizavel === true);
    t("natureza rotulada conhecida", j.natureza?.rotulo === "humano" && j.natureza?.conhecida === true && j.natureza?.metaHumanoComPoder === false, JSON.stringify(j.natureza));
    t("acaoRecuperacao descansar/2", j.acaoRecuperacao?.acao === "descansar" && j.acaoRecuperacao?.quantidade === 2, JSON.stringify(j.acaoRecuperacao));
    t("sem usos/historico no payload", !("usos" in j) && !("historico" in j) && !JSON.stringify(j).includes(testId), JSON.stringify(j).slice(0, 300));

    const rm = await getSangue(CHAR, M);
    t("mestre → 200 mesmo conteúdo", rm.status === 200 && rm.json?.saldo === 5 && rm.json?.capacidadeMax === 8);
  }

  sec("Autorização — não-dono e espectador");
  {
    const r2 = await getSangue(CHAR, J2);
    t("não-dono → 403/404", r2.status === 403 || r2.status === 404, `status=${r2.status}`);
    t("sem dados do ledger", !JSON.stringify(r2.json ?? {}).includes('"saldo"'));
    const re = await getSangue(CHAR, ESP);
    t("espectador → 403/404", re.status === 403 || re.status === 404, `status=${re.status}`);
    const rn = await getSangue(crypto.randomUUID(), J1);
    t("personagem inexistente → 404", rn.status === 404, `status=${rn.status}`);
  }

  sec("Personagem arquivado — legível, sem mutação");
  {
    const antes = dadosRow(CHAR);
    setStatus(CHAR, "arquivado");
    const r = await getSangue(CHAR, J1);
    t("arquivado → 200", r.status === 200, `status=${r.status}`);
    t("saldo/capacidade seguem", r.json?.saldo === 5 && r.json?.capacidadeMax === 8);
    const depois = dadosRow(CHAR);
    t("data inalterada", depois.data === antes.data && depois.updated_at === antes.updated_at, `upd ${antes.updated_at}→${depois.updated_at}`);
    setStatus(CHAR, "aprovada");
  }

  sec("GET repetido — zero escrita (data byte-a-byte)");
  {
    const antes = dadosRow(CHAR);
    await getSangue(CHAR, J1);
    await getSangue(CHAR, M);
    await getSangue(CHAR, J1);
    const depois = dadosRow(CHAR);
    t("data idêntica", depois.data === antes.data);
    t("updated_at idêntico", depois.updated_at === antes.updated_at);
  }

  sec("Config desabilitada / ausente / campo inválido → fail-closed");
  {
    setSangueConfig(CID, { ...CFG_BASE, habilitado: false });
    let r = await getSangue(CHAR, J1);
    t("habilitado:false → estado desabilitado", r.json?.estado === "desabilitado" && r.json?.saldo === null && r.json?.capacidadeMax === null, JSON.stringify(r.json));

    setSangueConfig(CID, { ...CFG_BASE, campoCapacidadeId: "fantasma" });
    r = await getSangue(CHAR, J1);
    t("campo inexistente → capacidade_indisponivel", r.json?.estado === "capacidade_indisponivel" && r.json?.motivo === "campo_inexistente" && r.json?.capacidadeMax === null, JSON.stringify(r.json));
    t("capacidade_indisponivel: nenhum resumo anunciado", r.json?.saldo === null && r.json?.natureza === null && r.json?.acaoRecuperacao === null && r.json?.utilizavel === false, JSON.stringify(r.json));

    setSangueConfig(CID, null);
    r = await getSangue(CHAR, J1);
    t("sem config.sangue → desabilitado", r.json?.estado === "desabilitado", JSON.stringify(r.json));
    setSangueConfig(CID, CFG_BASE);
  }

  sec("Ledger ausente / corrompido / cache adulterado");
  {
    setSangue(CHAR, undefined);
    let r = await getSangue(CHAR, J1);
    t("sem __sangue → saldo 0 válido", r.json?.estado === "ok" && r.json?.saldo === 0 && r.json?.capacidadeMax === 8, JSON.stringify(r.json));

    setSangue(CHAR, "lixo-invalido");
    r = await getSangue(CHAR, J1);
    t("ledger corrompido → ledger_invalido, saldo null", r.json?.estado === "ledger_invalido" && r.json?.saldo === null, JSON.stringify(r.json));
    // Contrato #227 (correção #7056578372): estado != ok → TODOS os
    // resumos null — nenhum painel pode anunciar ação a partir de
    // estado parcial.
    t("ledger_invalido: capacidadeMax/natureza/acaoRecuperacao null", r.json?.capacidadeMax === null && r.json?.natureza === null && r.json?.acaoRecuperacao === null && r.json?.utilizavel === false, JSON.stringify(r.json));

    setSangue(CHAR, { saldo: 5, usos: {}, historico: [], capacidade: 999 });
    r = await getSangue(CHAR, J1);
    t("cache 999 ignorado → capacidadeMax 8", r.json?.capacidadeMax === 8 && r.json?.saldo === 5, JSON.stringify(r.json));
  }

  sec("Natureza ausente/desconhecida e ação desabilitada");
  {
    setCampo(CHAR, "f-nat", "alien");
    let r = await getSangue(CHAR, J1);
    t("natureza desconhecida → conhecida:false, sem ação", r.json?.natureza?.conhecida === false && r.json?.acaoRecuperacao === null, JSON.stringify(r.json?.natureza));

    setCampo(CHAR, "f-nat", "vampiro");
    setSangueConfig(CID, { ...CFG_BASE, recuperacaoSangue: { habilitado: true, acoes: { descansar: { habilitada: true, quantidade: 2 }, alimentar: { habilitada: false } } } });
    r = await getSangue(CHAR, J1);
    t("alimentar desabilitada → acaoRecuperacao null", r.json?.acaoRecuperacao === null, JSON.stringify(r.json?.acaoRecuperacao));
    t("natureza vampiro metaHumano true", r.json?.natureza?.metaHumanoComPoder === true);

    setSangueConfig(CID, { ...CFG_BASE, recuperacaoSangue: { habilitado: false, acoes: { descansar: { habilitada: true, quantidade: 2 } } } });
    setCampo(CHAR, "f-nat", "humano");
    r = await getSangue(CHAR, J1);
    t("global desligada → acaoRecuperacao null", r.json?.acaoRecuperacao === null);

    setSangueConfig(CID, CFG_BASE);
    setCampo(CHAR, "f-nat", "humano");
  }

  sec("Modos de capacidade — somaNiveis e mapa");
  {
    setSangueConfig(CID, { ...CFG_BASE, campoCapacidadeId: "f-cap-soma", capacidade: { modo: "somaNiveis" } });
    let r = await getSangue(CHAR, J1);
    t("somaNiveis 2+3 → capacidadeMax 5", r.json?.capacidadeMax === 5, `cap=${r.json?.capacidadeMax}`);

    setSangueConfig(CID, { ...CFG_BASE, campoCapacidadeId: "f-cap-mapa", capacidade: { modo: "mapa", mapa: { Medio: 5, Forte: 10 } } });
    r = await getSangue(CHAR, J1);
    t("mapa Medio→5", r.json?.capacidadeMax === 5, `cap=${r.json?.capacidadeMax}`);

    setCampo(CHAR, "f-cap-mapa", "Desconhecido");
    r = await getSangue(CHAR, J1);
    t("rótulo fora do mapa → indisponível", r.json?.estado === "capacidade_indisponivel" && r.json?.capacidadeMax === null, JSON.stringify(r.json));

    setCampo(CHAR, "f-cap-mapa", "Medio");
    setSangueConfig(CID, CFG_BASE);
  }

  sec("Personagem sem template_version → indisponível explícito");
  {
    const w = db();
    let CHAR2;
    try {
      const pj2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
        cookie: J1, body: { name: "SemVersao", templateVersionId: vid, data: {} },
      });
      CHAR2 = pj2.json?.personagem?.id ?? pj2.json?.id;
    } finally { w.close(); }
    const w2 = db();
    try { w2.prepare("update characters set template_version_id=null where id=?").run(CHAR2); } finally { w2.close(); }
    const r = await getSangue(CHAR2, J1);
    t("sem versão → indisponivel/sem_versao_ficha", r.json?.estado === "indisponivel" && r.json?.motivo === "sem_versao_ficha", JSON.stringify(r.json));
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
