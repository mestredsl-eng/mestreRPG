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
let sockM;

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
    // P1 refresh — elemento HOMÔNIMO de outro kind no mesmo ruleset
    db.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), rs.id, "habilidade", "poder_fogo", "Habilidade Fogo", null, null, "{}", agora, agora);
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
  sockM = await conectar(c.cookieMestre);
  await emitir(sockJ, "mesa:entrar", { sessionId: SID });
  await emitir(sockM, "mesa:entrar", { sessionId: SID });

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

  sec("3. Poder sem custo / custo zero — gratuito com ledger durável");
  definirCusto(c, 0);
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charZero, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("custo zero → roll ok", r?.ok === true, JSON.stringify(r).slice(0, 150));
    t("saldo inalterado (4)", saldoSangue(charZero) === 4, `saldo=${saldoSangue(charZero)}`);
    // Contrato #219: gratuito ≠ invisível — usoId durável + evento
    // quantidade 0 tornam o retry idempotente.
    t("usoId d10:<testId> registrado (gratuito)", usosSangue(charZero).includes(`d10:${tid}`), JSON.stringify(usosSangue(charZero)));
    t("evento histórico quantidade 0", dadosChar(charZero).__sangue.historico.at(-1)?.quantidade === 0, JSON.stringify(dadosChar(charZero).__sangue.historico.at(-1)));
    const rReplay = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("retry mesmo testId → jaRolado", rReplay?.ok === true && rReplay?.jaRolado === true, JSON.stringify(rReplay).slice(0, 150));
    t("ledger não duplica após retry", usosSangue(charZero).filter((u) => u === `d10:${tid}`).length === 1
      && dadosChar(charZero).__sangue.historico.filter((e) => e.quantidade === 0).length === 1);
    definirCusto(c, null); // remove a entrada → custo ausente = zero
    const tid2 = novoTeste(c, { sessionId: SID, characterId: charSemCusto, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const r2 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid2, requestId: crypto.randomUUID() });
    t("sem custo → roll ok", r2?.ok === true, JSON.stringify(r2).slice(0, 150));
    t("saldo inalterado (7)", saldoSangue(charSemCusto) === 7, `saldo=${saldoSangue(charSemCusto)}`);
    t("custo ausente também registra usoId", usosSangue(charSemCusto).includes(`d10:${tid2}`), JSON.stringify(usosSangue(charSemCusto)));
    t("evento quantidade 0 (ausente)", dadosChar(charSemCusto).__sangue.historico.at(-1)?.quantidade === 0);
    definirCusto(c, 2); // restaura
  }

  sec("4. Saldo insuficiente — recusa sem efeito parcial");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charPobre, userId: c.jogadores.jogador1.id, skillRef: SKILL_PODER });
    const antes = contarRolls(c.campId);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("ACK erro sangue_insuficiente", r?.ok === false && r?.codigo === "sangue_insuficiente", JSON.stringify(r).slice(0, 200));
    t(
      "ACK de D10 não revela o saldo privado",
      !("saldo" in (r ?? {})) && !/saldo\\s*[:=]?\\s*\\d/i.test(r?.erro ?? ""),
      JSON.stringify(r).slice(0, 200),
    );
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
    await sono(700); // rate limit do socket — rajada das seções anteriores
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
    await sono(700); // rate limit do socket — rajada das seções anteriores
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

  sec("10. Não-Poder com elementoKey — gratuito (campoSel autoritativo)");
  {
    const charNormal = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Herói Normal", { for: 5 });
    const tid = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id,
      skillRef: { campoId: "for", rotulo: "FOR", tipo: "inteiro", semantico: "atributo", elementoKey: "poder_fogo" } });
    const dadosAntes = JSON.stringify(dadosChar(charNormal));
    await sono(700); // rate limit do socket — seção 9 acabou de rolar
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    // Campo conhecido NÃO-Poder é autoritativo: elementoKey homônimo a
    // um Poder do ruleset NÃO promove o teste a cobrança de Sangue —
    // o roll segue como D10 legado, sem débito, sem usoId e sem
    // escrita no ledger (refresh P1, seções 17/18 cobrem os demais).
    t("campo não-Poder rola como D10 legado", r?.ok === true, JSON.stringify(r).slice(0, 150));
    t("characters.data byte-a-byte intacto", JSON.stringify(dadosChar(charNormal)) === dadosAntes);
    t("sem usoId d10:<testId> no ledger", !usosSangue(charNormal).includes(`d10:${tid}`));
    t("teste rolado normalmente", testeRow(tid)?.status === "rolado");
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
        { id: "poder_sel", label: "Poder (seleção)", tipo: "selecao_nivel", semantico: "poder", usadoEmTestes: true, regraKind: "poder" },
        { id: "habilidades", label: "Habilidades", tipo: "selecao_nivel", semantico: "habilidade", usadoEmTestes: true, regraKind: "habilidade" },
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
  // R6.2 P2 — personagens para os testes de mesa:teste:pedir
  const charSelOk = novoCharPoder("Poder seleção ok", {
    poder_sel: [{ key: "poder_fogo", nivel: 2 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charSelFrac = novoCharPoder("Poder seleção fração", {
    poder_sel: [{ key: "poder_fogo", nivel: 0.5 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charSelZero = novoCharPoder("Poder seleção zero", {
    poder_sel: [{ key: "poder_fogo", nivel: 0 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charSelCinco = novoCharPoder("Poder seleção nível 5", {
    poder_sel: [{ key: "poder_fogo", nivel: 5 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charSelSeis = novoCharPoder("Poder seleção nível 6", {
    poder_sel: [{ key: "poder_fogo", nivel: 6 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charSelFora = novoCharPoder("Poder fora do ruleset", {
    poder_sel: [{ key: "poder_fora", nivel: 2 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charSelAusente = novoCharPoder("Poder seleção ausente", {
    poder_sel: [{ key: "outro", nivel: 2 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charHab = novoCharPoder("Habilidades (não-Poder)", {
    habilidades: [{ key: "correr", nivel: 1 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  // P1 refresh — key HOMÔNIMA: "poder_fogo" existe como habilidade
  // no ruleset E como poder; o campo é de habilidade → nunca debita.
  const charHabColisao = novoCharPoder("Habilidade homônima", {
    habilidades: [{ key: "poder_fogo", nivel: 2 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charSelControle = novoCharPoder("Poder seleção controle", {
    poder_sel: [{ key: "poder_fogo", nivel: 2 }],
    __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} },
  });
  const charVincFrac = novoCharPoder("Vínculo fracionário", {
    poder_vinculado: 0.5,
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
    t("sem usoId novo neste roll", !usosSangue(charSemCusto).includes(`d10:${tid}`));
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

  // ---------- R6.2 P2: mesa:teste:pedir valida Poder ANTES do INSERT ----------
  const contarTestes = () => abrirDb(BANCO).prepare("select count(*) n from tests where session_id=?").get(SID).n;
  const pedir = (payload) => emitir(sockM, "mesa:teste:pedir", {
    sessionId: SID, dadosLados: 10, requestId: crypto.randomUUID(), ...payload,
  });
  const removerPoderRuleset = () => {
    const db = abrirDb(BANCO);
    try {
      const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(c.campId);
      db.prepare("delete from rule_definitions where rule_set_id=? and kind=? and key=?").run(rs.id, "poder", "poder_fogo");
    } finally { db.close(); }
  };
  const restaurarPoderRuleset = () => {
    const db = abrirDb(BANCO);
    try {
      const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(c.campId);
      const agora = Date.now();
      db.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), rs.id, "poder", "poder_fogo", "Poder de Fogo", null, null, "{}", agora, agora);
    } finally { db.close(); }
  };
  const recusaPedir = async (rotulo, payload, antes) => {
    const r = await pedir(payload);
    t(`${rotulo} → ACK recusado`, r?.ok === false, JSON.stringify(r).slice(0, 160));
    t(`${rotulo} → zero linha nova em tests`, contarTestes() === antes, `antes=${antes} depois=${contarTestes()}`);
  };

  sec("14. P2 — pedir: selecao_nivel de Poder exige nível inteiro 1..5 + key no ruleset");
  {
    await sono(3100); // janela do limitador mesa:teste:pedir (15/3s)
    // positivo: nível 2 válido → desafio persistido
    {
      const antes = contarTestes();
      const r = await pedir({ characterId: charSelOk, campoId: "poder_sel", elementoKey: "poder_fogo" });
      t("nível 2 + key válida → desafio criado", r?.ok === true && !!r?.id, JSON.stringify(r).slice(0, 160));
      t("linha pendente persistida", contarTestes() === antes + 1);
      const row = testeRow(r?.id);
      t("status pendente", row?.status === "pendente");
      const ref = JSON.parse(row?.skill_ref ?? "null");
      t("skillRef carrega elementoKey", ref?.elementoKey === "poder_fogo" && ref?.campoId === "poder_sel", JSON.stringify(ref).slice(0, 160));
    }
    // nível 5 (teto) também válido
    {
      const r = await pedir({ characterId: charSelCinco, campoId: "poder_sel", elementoKey: "poder_fogo" });
      t("nível 5 → desafio criado", r?.ok === true && !!r?.id, JSON.stringify(r).slice(0, 160));
    }
    // negativos: fração, zero, >5, key fora do ruleset, key ausente da ficha
    for (const [rotulo, charId, key] of [
      ["fração 0.5", charSelFrac, "poder_fogo"],
      ["nível 0", charSelZero, "poder_fogo"],
      ["nível 6 (>5)", charSelSeis, "poder_fogo"],
      ["key fora do ruleset", charSelFora, "poder_fora"],
      ["key ausente da ficha", charSelAusente, "poder_fogo"],
    ]) {
      const antes = contarTestes();
      await recusaPedir(`sel ${rotulo}`, { characterId: charId, campoId: "poder_sel", elementoKey: key }, antes);
      await sono(250); // amortecer o limitador
    }
    // não-Poder (selecao_nivel comum) → comportamento legado preservado
    {
      const antes = contarTestes();
      const r = await pedir({ characterId: charHab, campoId: "habilidades", elementoKey: "correr" });
      t("não-Poder seleção → desafio criado (legado)", r?.ok === true && !!r?.id, JSON.stringify(r).slice(0, 160));
      t("linha persistida", contarTestes() === antes + 1);
    }
  }

  sec("15. P2 — pedir: campo escalar vinculado a Poder exige key no ruleset + valor > 0");
  {
    await sono(3100); // janela do limitador mesa:teste:pedir
    // 0.5 decimal é nível válido (convenção nivelNoVinculo)
    {
      const antes = contarTestes();
      const r = await pedir({ characterId: charVincFrac, campoId: "poder_vinculado" });
      t("escalar vínculo 0.5 → desafio criado", r?.ok === true && !!r?.id, JSON.stringify(r).slice(0, 160));
      t("linha persistida", contarTestes() === antes + 1);
    }
    // negativos: zero, regraKind sem regra.key, key removida do ruleset
    for (const [rotulo, charId, campoId] of [
      ["escalar vínculo 0", charVinculadoZero, "poder_vinculado"],
      ["escalar vínculo ausente", novoCharPoder("Vínculo ausente", { __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} } }), "poder_vinculado"],
      ["regraKind sem regra.key", charEscalar, "poder_geral"],
    ]) {
      const antes = contarTestes();
      await recusaPedir(rotulo, { characterId: charId, campoId }, antes);
      await sono(250);
    }
    // key existe na ficha/regra mas foi removida do ruleset ativo
    {
      removerPoderRuleset();
      const antes = contarTestes();
      await recusaPedir("key fora do ruleset (escalar)", { characterId: charVinculado, campoId: "poder_vinculado" }, antes);
      restaurarPoderRuleset();
      // e o caminho selecao_nivel também recusa com a key fora do ruleset
      const antes2 = contarTestes();
      removerPoderRuleset();
      await recusaPedir("key fora do ruleset (seleção)", { characterId: charSelOk, campoId: "poder_sel", elementoKey: "poder_fogo" }, antes2);
      restaurarPoderRuleset();
    }
  }

  sec("16. P2 — roll fail-closed: key removida do ruleset entre pedido e rolagem");
  {
    // pedido válido enquanto a key existe
    const antesT = contarTestes();
    const rPed = await pedir({ characterId: charSelOk, campoId: "poder_sel", elementoKey: "poder_fogo" });
    t("pedido pré-remoção aceito", rPed?.ok === true && !!rPed?.id, JSON.stringify(rPed).slice(0, 160));
    const tid = rPed?.id;
    const saldoAntes = saldoSangue(charSelOk);
    // a key some do ruleset DEPOIS do pedido
    removerPoderRuleset();
    const antes = contarRolls(c.campId);
    await sono(700);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("roll recusado fail-closed (não vira livre)", r?.ok === false && /poder_nao_identificado|erro/i.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200));
    t("zero roll novo", contarRolls(c.campId) === antes);
    t("saldo inalterado", saldoSangue(charSelOk) === saldoAntes, `saldo=${saldoSangue(charSelOk)}`);
    t("teste segue pendente", testeRow(tid)?.status === "pendente");
    t("sem usoId novo", !usosSangue(charSelOk).some((u) => u === `d10:${tid}`));
    restaurarPoderRuleset();
    // com a key restaurada, o MESMO teste pendente rola e debita — prova
    // de que a recusa anterior foi a ausência da key, não estado corrompido
    await sono(700);
    const r2 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("após restaurar key → roll ok e debita", r2?.ok === true && saldoSangue(charSelOk) === saldoAntes - 2, JSON.stringify(r2).slice(0, 160));
  }

  sec("17. P1 refresh — key homônima em campo NÃO-Poder nunca debita");
  {
    // ruleset tem poder:poder_fogo E habilidade:poder_fogo; a ficha
    // do charHabColisao tem a key homônima no campo de HABILIDADE.
    // pedir cria o desafio (campo não-Power → validação de Poder não se aplica)
    const antesT = contarTestes();
    const rPed = await pedir({ characterId: charHabColisao, campoId: "habilidades", elementoKey: "poder_fogo" });
    t("pedido em campo habilidade aceito (legado)", rPed?.ok === true && !!rPed?.id, JSON.stringify(rPed).slice(0, 160));
    const tid = rPed?.id;
    t("linha pendente persistida", contarTestes() === antesT + 1);
    const dadosAntes = JSON.stringify(dadosChar(charHabColisao));
    const saldoAntes = saldoSangue(charHabColisao);
    await sono(700);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: crypto.randomUUID() });
    t("roll ok (D10 legado)", r?.ok === true, JSON.stringify(r).slice(0, 160));
    t("saldo INALTERADO (10) — não debitou como Poder", saldoSangue(charHabColisao) === saldoAntes, `saldo=${saldoSangue(charHabColisao)}`);
    t("sem usoId d10:<testId>", !usosSangue(charHabColisao).includes(`d10:${tid}`), JSON.stringify(usosSangue(charHabColisao)));
    t("characters.data byte-a-byte intacto", JSON.stringify(dadosChar(charHabColisao)) === dadosAntes);
    t("teste rolado normalmente", testeRow(tid)?.status === "rolado");
    // CONTROLE: campo Poder com a MESMA key homônima → debita custo
    const rPed2 = await pedir({ characterId: charSelControle, campoId: "poder_sel", elementoKey: "poder_fogo" });
    t("controle: pedido em campo Poder aceito", rPed2?.ok === true && !!rPed2?.id, JSON.stringify(rPed2).slice(0, 160));
    const tid2 = rPed2?.id;
    await sono(700);
    const r2 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid2, requestId: crypto.randomUUID() });
    t("controle: roll de Poder ok", r2?.ok === true, JSON.stringify(r2).slice(0, 160));
    t("controle: saldo 10→8 (custo 2)", saldoSangue(charSelControle) === 8, `saldo=${saldoSangue(charSelControle)}`);
    t("controle: usoId d10:<testId> registrado", usosSangue(charSelControle).includes(`d10:${tid2}`));
  }

  sec("18. P2 refresh — falha ao carregar ruleset rejeita pedido de Poder antes do INSERT");
  {
    // injeta falha determinística: config JSON inválido → carregarRegras lança
    const db = abrirDb(BANCO);
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(c.campId);
    const configOriginal = rs.config;
    db.prepare("update rule_sets set config=? where id=?").run("{", rs.id);
    db.close();
    try {
      const antes = contarTestes();
      const r = await pedir({ characterId: charSelOk, campoId: "poder_sel", elementoKey: "poder_fogo" });
      t("ruleset corrompido → ACK recusado", r?.ok === false, JSON.stringify(r).slice(0, 160));
      t("zero linha nova em tests", contarTestes() === antes, `antes=${antes} depois=${contarTestes()}`);
      // caminho escalar também fail-closed
      const antes2 = contarTestes();
      const r2 = await pedir({ characterId: charVinculado, campoId: "poder_vinculado" });
      t("escalar: ruleset corrompido → ACK recusado", r2?.ok === false, JSON.stringify(r2).slice(0, 160));
      t("escalar: zero linha nova", contarTestes() === antes2);
      // campo NÃO-Poder não é afetado (não carrega ruleset para validar)
      const antes3 = contarTestes();
      const r3 = await pedir({ characterId: charHab, campoId: "habilidades", elementoKey: "correr" });
      t("não-Poder segue legado mesmo com ruleset quebrado", r3?.ok === true && !!r3?.id, JSON.stringify(r3).slice(0, 160));
      t("não-Poder: linha persistida", contarTestes() === antes3 + 1);
    } finally {
      const dbR = abrirDb(BANCO);
      dbR.prepare("update rule_sets set config=? where id=?").run(configOriginal, rs.id);
      dbR.close();
    }
    // ruleset restaurado → campo Poder volta a funcionar
    const antes4 = contarTestes();
    const rOk = await pedir({ characterId: charSelOk, campoId: "poder_sel", elementoKey: "poder_fogo" });
    t("ruleset restaurado → pedido Poder aceito", rOk?.ok === true && !!rOk?.id, JSON.stringify(rOk).slice(0, 160));
    t("linha persistida pós-restore", contarTestes() === antes4 + 1);
  }
} finally {
  try { sockJ?.close(); } catch {}
  try { sockM?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  limparDir(DIR);
}
console.log(`\n===== ${pass} passaram / ${fail} falharam =====`);
process.exit(fail ? 1 : 0);
