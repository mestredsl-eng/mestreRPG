// Issue #186 R6.2 — cobrança de Sangue no roll D10 que usa Poder.
// Cobre: sem custo, custo zero, custo positivo, saldo insuficiente,
// concorrência, retry idempotente, teste cancelado, autorização
// revogada, Poder não adquirido, config alterada na janela e rollback.
// Banco 100% descartável.
import crypto from "node:crypto";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const sono = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("d10-sangue");
const BANCO = join(DIR, "banco.db");
const FLAG = join(DIR, "pausa.flag");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let sockJ;

const emitir = (sock, ev, payload) => Promise.race([
  new Promise((res) => sock.emit(ev, payload, res)),
  sono(15000).then(() => ({ ok: false, codigo: "timeout_teste" })),
]);
const contarRolls = (campId) =>
  abrirDb(BANCO).prepare("select count(*) n from rolls where campaign_id=?").get(campId).n;
const testeRow = (id) => abrirDb(BANCO).prepare("select * from tests where id=?").get(id);
const dadosChar = (id) => JSON.parse(abrirDb(BANCO).prepare("select data from characters where id=?").get(id).data);
const saldoSangue = (id) => dadosChar(id).__sangue?.saldo ?? null;
const usosSangue = (id) => Object.keys(dadosChar(id).__sangue?.usos ?? {});

function conectar(cookie) {
  const s = ioClient(BASE, { extraHeaders: { cookie }, transports: ["websocket"] });
  return new Promise((res) => s.on("connect", () => res(s)));
}
const SKILL_PODER = { campoId: "poderes_ficha", rotulo: "Poder de Fogo", tipo: "selecao_nivel", semantico: "poder", elementoKey: "poder_fogo" };
function novoTeste(c, { sessionId, characterId, userId, skillRef = null, dados = 4, lados = 10 }) {
  const db = abrirDb(BANCO);
  try {
    const id = crypto.randomUUID(), agora = Date.now();
    db.prepare(`insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,visibility,request_id,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, c.campId, sessionId, characterId, userId, skillRef ? JSON.stringify(skillRef) : null, "{}", dados, lados, null, "pendente", "publica", null, agora, agora);
    return id;
  } finally { db.close(); }
}
function definirCusto(c, custo) {
  const db = abrirDb(BANCO);
  try {
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(c.campId);
    const cfg = JSON.parse(rs.config);
    if (custo === null) {
      if (cfg.sangue?.poderes) delete cfg.sangue.poderes.poder_fogo;
      if (cfg.sangue && Object.keys(cfg.sangue.poderes ?? {}).length === 0) delete cfg.sangue.poderes;
    } else {
      cfg.sangue = { ...(cfg.sangue ?? {}), poderes: { poder_fogo: { custo } } };
    }
    db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { db.close(); }
}
function definirSangue(c, modo) {
  // modo: "off" → habilitado:false (poderes preservados); "ausente" → bloco removido
  const db = abrirDb(BANCO);
  try {
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(c.campId);
    const cfg = JSON.parse(rs.config);
    if (modo === "ausente") delete cfg.sangue;
    else cfg.sangue = { ...(cfg.sangue ?? {}), habilitado: false };
    db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { db.close(); }
}
function reabilitarSangue(c) {
  const db = abrirDb(BANCO);
  try {
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(c.campId);
    const cfg = JSON.parse(rs.config);
    cfg.sangue = { ...(cfg.sangue ?? {}), habilitado: true, poderes: { poder_fogo: { custo: 2 } } };
    db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { db.close(); }
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, {
    banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bkp"),
    env: { MESTRE_PAUSA_FLAG: FLAG },
  });
  proc.stderr?.on("data", (d) => console.log("[srv-err]", String(d)));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha D10 Sangue",
    config: {
      dados: { d10SucessoMinimo: 6 },
      sangue: { habilitado: true, poderes: { poder_fogo: { custo: 2 } } },
    },
  });
  // elemento kind="poder" no ruleset ativo
  {
    const db = abrirDb(BANCO);
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(c.campId);
    const agora = Date.now();
    db.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), rs.id, "poder", "poder_fogo", "Poder de Fogo", null, null, "{}", agora, agora);
    db.close();
  }
  const fichaBase = {
    poderes_ficha: [{ key: "poder_fogo", nivel: 2 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  };
  const charCusto = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Vampiro Custo", fichaBase);
  const charSemCusto = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Vampiro Sem Custo", {
    poderes_ficha: [{ key: "poder_fogo", nivel: 1 }],
    __sangue: { saldo: 7, capacidade: 15, historico: [], usos: {} },
  });
  const charZero = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Vampiro Zero", {
    poderes_ficha: [{ key: "poder_fogo", nivel: 1 }],
    __sangue: { saldo: 4, capacidade: 15, historico: [], usos: {} },
  });
  const charPobre = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Vampiro Pobre", {
    poderes_ficha: [{ key: "poder_fogo", nivel: 1 }],
    __sangue: { saldo: 1, capacidade: 15, historico: [], usos: {} },
  });
  const charSemPoder = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Sem o Poder", {
    poderes_ficha: [{ key: "outro", nivel: 1 }],
    __sangue: { saldo: 9, capacidade: 15, historico: [], usos: {} },
  });

  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Sangue" } });
  const SID = sess.json?.sessao?.id;
  t("sessão criada", !!SID, JSON.stringify(sess.json).slice(0, 120));
  sockJ = await conectar(c.jogadores.jogador1.cookie);
  await emitir(sockJ, "mesa:entrar", { sessionId: SID });

  sec("1. Custo positivo — débito único na mesma tx");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const antes = contarRolls(c.campId);
    await sono(700);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("roll ok", r?.ok === true, JSON.stringify(r).slice(0, 200));
    t("saldo 10→8", saldoSangue(charCusto) === 8, `saldo=${saldoSangue(charCusto)}`);
    t("usoId d10:<testId> registrado", usosSangue(charCusto).includes(`d10:${tid}`), JSON.stringify(usosSangue(charCusto)));
    t("evento __sangue tipo uso", dadosChar(charCusto).__sangue.historico.at(-1)?.tipo === "uso");
    t("roll persistido", contarRolls(c.campId) === antes + 1);
    const row = testeRow(tid);
    t("teste rolado", row?.status === "rolado" && !!row?.roll_id);
  }

  sec("2. Retry e concorrência — nunca debita duas vezes");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const [r1, r2] = await Promise.all([
      emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() }),
      emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() }),
    ]);
    t("um ok + um jaRolado/ok", (r1?.ok === true && r2?.ok === true), JSON.stringify([r1, r2]).slice(0, 200));
    const saldoApos = saldoSangue(charCusto);
    t("saldo debitado exatamente uma vez (8→6)", saldoApos === 6, `saldo=${saldoApos}`);
    t("um único usoId d10 no ledger", usosSangue(charCusto).filter((u) => u === `d10:${tid}`).length === 1);
  }

  sec("3. Poder sem custo / custo zero — gratuito");
  definirCusto(c, 0);
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charZero, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("custo zero → roll ok", r?.ok === true, JSON.stringify(r).slice(0, 150));
    t("saldo inalterado (4)", saldoSangue(charZero) === 4, `saldo=${saldoSangue(charZero)}`);
    t("sem usoId no ledger", usosSangue(charZero).length === 0);
    definirCusto(c, null); // remove a entrada → sem custo configurado
    const tid2 = novoTeste(c, { sessionId: SID, characterId: charSemCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const r2 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid2, requestId: crypto.randomUUID() });
    t("sem custo → roll ok", r2?.ok === true, JSON.stringify(r2).slice(0, 150));
    t("saldo inalterado (7)", saldoSangue(charSemCusto) === 7, `saldo=${saldoSangue(charSemCusto)}`);
    definirCusto(c, 2); // restaura
  }

  sec("4. Saldo insuficiente — recusa sem efeito parcial");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charPobre, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const antes = contarRolls(c.campId);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("ACK erro sangue_insuficiente", r?.ok === false && r?.codigo === "sangue_insuficiente", JSON.stringify(r).slice(0, 200));
    t("zero roll novo", contarRolls(c.campId) === antes);
    t("teste continua pendente", testeRow(tid)?.status === "pendente");
    t("saldo inalterado (1)", saldoSangue(charPobre) === 1, `saldo=${saldoSangue(charPobre)}`);
    t("sem usoId", usosSangue(charPobre).length === 0);
  }

  sec("5. Poder não adquirido — fail-closed");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charSemPoder, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const antes = contarRolls(c.campId);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("ACK erro", r?.ok === false, JSON.stringify(r).slice(0, 200));
    t("zero roll novo", contarRolls(c.campId) === antes);
    t("saldo inalterado (9)", saldoSangue(charSemPoder) === 9, `saldo=${saldoSangue(charSemPoder)}`);
  }

  sec("6. Teste cancelado — não cobra");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const db = abrirDb(BANCO);
    db.prepare("update tests set status='cancelado' where id=?").run(tid);
    db.close();
    const saldoAntes = saldoSangue(charCusto);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("cancelado não rola nem cobra", r?.ok === true && r?.jaRolado === true, JSON.stringify(r).slice(0, 150));
    t("saldo inalterado", saldoSangue(charCusto) === saldoAntes, `saldo=${saldoSangue(charCusto)}`);
    t("sem usoId novo", !usosSangue(charCusto).includes(`d10:${tid}`));
  }

  sec("7. Autorização revogada — sem débito");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const db = abrirDb(BANCO);
    db.prepare("update memberships set status='inativo' where id=?").run(c.jogadores.jogador1.membershipId);
    db.close();
    const saldoAntes = saldoSangue(charCusto);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("ACK erro", r?.ok === false, JSON.stringify(r).slice(0, 150));
    t("saldo inalterado", saldoSangue(charCusto) === saldoAntes, `saldo=${saldoSangue(charCusto)}`);
    const db2 = abrirDb(BANCO);
    db2.prepare("update memberships set status='ativo' where id=?").run(c.jogadores.jogador1.membershipId);
    db2.close();
  }

  sec("8. Config alterada na janela pré-commit → aborta sem débito");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const saldoAntes = saldoSangue(charCusto);
    writeFileSync(FLAG, tid);
    const pendente = emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    for (let i = 0; i < 100 && !existsSync(FLAG + ".pausado"); i++) await sono(50);
    t("handler pausado", existsSync(FLAG + ".pausado"));
    definirCusto(c, 5); // muda config.sangue → fingerprint diverge
    rmSync(FLAG);
    const r = await pendente;
    t("ACK regras alteradas", r?.ok === false, JSON.stringify(r).slice(0, 150));
    t("saldo inalterado", saldoSangue(charCusto) === saldoAntes, `saldo=${saldoSangue(charCusto)}`);
    definirCusto(c, 2); // restaura
  }

  sec("9. Rollback — falha na tx desfaz roll E débito");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const antes = contarRolls(c.campId);
    const saldoAntes = saldoSangue(charCusto);
    const db = abrirDb(BANCO);
    db.exec(`CREATE TRIGGER trg_fail_sangue_test BEFORE UPDATE ON tests
      WHEN NEW.status='rolado' BEGIN SELECT RAISE(ABORT,'falha simulada tx'); END`);
    db.close();
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    const dbq = abrirDb(BANCO);
    dbq.exec("DROP TRIGGER IF EXISTS trg_fail_sangue_test");
    dbq.close();
    t("ACK erro", r?.ok === false, JSON.stringify(r).slice(0, 150));
    t("zero roll novo", contarRolls(c.campId) === antes);
    t("teste pendente", testeRow(tid)?.status === "pendente");
    t("saldo NÃO debitado (rollback total)", saldoSangue(charCusto) === saldoAntes, `saldo=${saldoSangue(charCusto)}`);
    t("sem usoId", !usosSangue(charCusto).includes(`d10:${tid}`));
  }

  sec("10. Não-Poder com elementoKey — gratuito");
  {
    const charNormal = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Herói Normal", { for: 5 });
    const tid = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id,
      skillRef: { campoId: "for", rotulo: "FOR", tipo: "inteiro", semantico: "atributo", elementoKey: "poder_fogo" } });
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    // elementoKey aponta para poder do ruleset MAS a ficha não tem o
    // elemento na lista do campo → poder_nao_adquirido (fail-closed)
    t("elemento ausente da ficha → recusado", r?.ok === false, JSON.stringify(r).slice(0, 150));
  }

  // ---------- P2-2: campo ligado a Poder sem elementoKey ----------
  // Template dedicado com campos escalares ligados a Poder:
  //  - poder_geral: regraKind="poder" sem vínculo → NÃO identifica
  //    qual Poder → fail-closed, nunca gratuito silencioso;
  //  - poder_vinculado: regra={kind:"poder",key:"poder_fogo"} →
  //    identidade autoritativa do campo → debita o custo configurado.
  let verPoderId = null;
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    const tplId = crypto.randomUUID(); verPoderId = crypto.randomUUID();
    const estrutura = {
      versao: 1,
      secoes: [{ id: "s1", titulo: "Poderes", ordem: 0, campos: [
        { id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" },
        { id: "poder_geral", label: "Poder Geral", tipo: "inteiro", semantico: "atributo", usadoEmTestes: true, regraKind: "poder" },
        { id: "poder_vinculado", label: "Poder Vinculado", tipo: "inteiro", semantico: "atributo", usadoEmTestes: true, regra: { kind: "poder", key: "poder_fogo" } },
      ] }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
      .run(tplId, c.campId, "Ficha Poder Escalar", null, c.adminId, agora, agora);
    db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
      .run(verPoderId, tplId, JSON.stringify(estrutura), agora, agora);
    db.prepare("update sheet_templates set current_version_id=? where id=?").run(verPoderId, tplId);
    db.close();
  }
  const novoCharPoder = (nome, dataExtra) => {
    const db = abrirDb(BANCO);
    try {
      const id = crypto.randomUUID(), agora = Date.now();
      db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, c.campId, c.jogadores.jogador1.membershipId, verPoderId, nome,
          JSON.stringify({ for: 5, ...dataExtra }), "{}", "aprovada", 0, agora, agora);
      return id;
    } finally { db.close(); }
  };
  const charEscalar = novoCharPoder("Poder sem identidade", {
    poder_geral: 3,
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charVinculado = novoCharPoder("Poder vinculado", {
    poder_vinculado: 4,
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charVinculadoZero = novoCharPoder("Vínculo zerado", {
    poder_vinculado: 0,
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charVinculadoNeg = novoCharPoder("Vínculo negativo", {
    poder_vinculado: -3,
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });

  sec("11. P2-2 — Poder escalar sem identidade → fail-closed");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charEscalar, userId: c.jogadores.jogador1.id,
      skillRef: { campoId: "poder_geral", rotulo: "Poder Geral", tipo: "inteiro", semantico: "atributo" } });
    const antes = contarRolls(c.campId);
    const dadosAntes = JSON.stringify(dadosChar(charEscalar));
    await sono(700);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("ACK erro poder_nao_identificado", r?.ok === false && /poder_nao_identificado/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200));
    t("zero roll novo", contarRolls(c.campId) === antes);
    t("teste continua pendente", testeRow(tid)?.status === "pendente");
    t("characters.data byte-a-byte intacto", JSON.stringify(dadosChar(charEscalar)) === dadosAntes);
    t("sem usoId", usosSangue(charEscalar).length === 0);
  }

  sec("12. P2-2 — Poder escalar COM vínculo regra.key → debita custo");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charVinculado, userId: c.jogadores.jogador1.id,
      skillRef: { campoId: "poder_vinculado", rotulo: "Poder Vinculado", tipo: "inteiro", semantico: "atributo" } });
    await sono(700);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("roll ok", r?.ok === true, JSON.stringify(r).slice(0, 200));
    t("saldo 10→8 (custo do poder vinculado)", saldoSangue(charVinculado) === 8, `saldo=${saldoSangue(charVinculado)}`);
    t("usoId d10:<testId> registrado", usosSangue(charVinculado).includes(`d10:${tid}`), JSON.stringify(usosSangue(charVinculado)));
  }

  sec("12b. P3 #237 — vínculo regra.key com valor 0/negativo → não adquirido");
  for (const [rotulo, charId, valor] of [["zero", charVinculadoZero, 0], ["negativo", charVinculadoNeg, -3]]) {
    const tid = novoTeste(c, { sessionId: SID, characterId: charId, userId: c.jogadores.jogador1.id,
      skillRef: { campoId: "poder_vinculado", rotulo: "Poder Vinculado", tipo: "inteiro", semantico: "atributo" } });
    const antes = contarRolls(c.campId);
    await sono(700); // rate limit do socket
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t(`vínculo ${rotulo} (${valor}) → recusado poder_nao_adquirido`, r?.ok === false && /não consta|poder_nao_adquirido/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 160));
    t(`vínculo ${rotulo} → zero roll novo`, contarRolls(c.campId) === antes);
    t(`vínculo ${rotulo} → saldo intacto (10)`, saldoSangue(charId) === 10, `saldo=${saldoSangue(charId)}`);
    t(`vínculo ${rotulo} → teste segue pendente`, testeRow(tid)?.status === "pendente");
    t(`vínculo ${rotulo} → sem usoId`, usosSangue(charId).length === 0);
  }

  sec("13. P2-1 — Sangue desabilitado → D10 legado sem débito");
  {
    definirSangue(c, "off"); // habilitado:false, poderes/custos preservados
    const tid = novoTeste(c, { sessionId: SID, characterId: charSemCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const dadosAntes = JSON.stringify(dadosChar(charSemCusto));
    await sono(700);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("roll ok (legado)", r?.ok === true, JSON.stringify(r).slice(0, 200));
    t("saldo inalterado (7)", saldoSangue(charSemCusto) === 7, `saldo=${saldoSangue(charSemCusto)}`);
    t("characters.data byte-a-byte intacto (sem escrita no ledger)", JSON.stringify(dadosChar(charSemCusto)) === dadosAntes);
    t("sem usoId", usosSangue(charSemCusto).length === 0);
    // config.sangue ausente por completo → mesmo comportamento
    definirSangue(c, "ausente");
    const tid2 = novoTeste(c, { sessionId: SID, characterId: charZero, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const dadosAntes2 = JSON.stringify(dadosChar(charZero));
    await sono(700);
    const r2 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid2, requestId: crypto.randomUUID() });
    t("config ausente → roll ok (legado)", r2?.ok === true, JSON.stringify(r2).slice(0, 150));
    t("saldo inalterado (4)", saldoSangue(charZero) === 4, `saldo=${saldoSangue(charZero)}`);
    t("characters.data intacto", JSON.stringify(dadosChar(charZero)) === dadosAntes2);
    reabilitarSangue(c); // restaura habilitado+custo para seções futuras
  }
} finally {
  try { sockJ?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  limparDir(DIR);
}
console.log(`\n===== ${pass} passaram / ${fail} falharam =====`);
process.exit(fail ? 1 : 0);
