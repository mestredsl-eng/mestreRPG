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
} finally {
  try { sockJ?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  limparDir(DIR);
}
console.log(`\n===== ${pass} passaram / ${fail} falharam =====`);
process.exit(fail ? 1 : 0);
