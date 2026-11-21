// Issue #186 R6.3 — runtime Socket.IO das ações de Sangue.
// Cobre: ativação narrativa (custo positivo/zero/ausente, idempotência,
// concorrência), recuperação contextual (Humano/Vampiro/desconhecida,
// ações desabilitadas, teto de capacidade), ajuste manual do mestre,
// reconciliação de capacidade, autorização (dono/não-dono/espectador/
// mestre-no-lugar-do-jogador/inativo/arquivado), ledger malformado,
// rollback SQLite sem evento, e regressão de emissões pós-commit.
// Banco 100% descartável.
import crypto from "node:crypto";
import { existsSync, rmSync } from "node:fs";
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

const DIR = dirTeste("sangue-runtime");
const BANCO = join(DIR, "banco.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

const emitir = (sock, ev, payload) => Promise.race([
  new Promise((res) => sock.emit(ev, payload, res)),
  sono(15000).then(() => ({ ok: false, codigo: "timeout_teste" })),
]);
const dadosChar = (id) => JSON.parse(abrirDb(BANCO).prepare("select data from characters where id=?").get(id).data);
const saldoSangue = (id) => dadosChar(id).__sangue?.saldo ?? null;
const usosSangue = (id) => Object.keys(dadosChar(id).__sangue?.usos ?? {});
const histSangue = (id) => dadosChar(id).__sangue?.historico ?? [];

function conectar(cookie) {
  const s = ioClient(BASE, { extraHeaders: { cookie }, transports: ["websocket"] });
  return new Promise((res) => s.on("connect", () => res(s)));
}
async function entrarCampanha(sock, campId) {
  await new Promise((res) => sock.emit("entrar-campanha", campId, res));
}

// Estrutura dedicada de Sangue: capacidade inteira, natureza seleção,
// poderes seleção_nivel vinculada à biblioteca kind="poder".
const ESTRUTURA_SANGUE = {
  versao: 1,
  secoes: [{
    id: "s1", titulo: "Sangue", ordem: 0,
    campos: [
      { id: "cap", label: "Pontos de Sangue", tipo: "inteiro", semantico: "atributo", minimo: 1, maximo: 30 },
      { id: "nat", label: "Natureza", tipo: "selecao_unica", semantico: "livre", opcoes: ["Humano", "Meta humano", "Vampiro", "Lobisomem", "Animal"] },
      { id: "poderes", label: "Poderes", tipo: "selecao_nivel", semantico: "poder", regraKind: "poder" },
    ],
  }],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};

const CONFIG_SANGUE = {
  habilitado: true,
  campoCapacidadeId: "cap",
  campoNaturezaId: "nat",
  capacidade: { modo: "valor" },
  naturezas: {
    Humano: { recuperacao: "descansar" },
    Vampiro: { recuperacao: "alimentar" },
  },
  recuperacaoSangue: {
    habilitado: true,
    acoes: {
      descansar: { habilitada: true, quantidade: 2 },
      alimentar: { habilitada: true, quantidade: 3 },
    },
  },
  poderes: { poder_fogo: { custo: 2 } },
};

function definirConfigSangue(campId, patch) {
  const db = abrirDb(BANCO);
  try {
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
    const cfg = JSON.parse(rs.config);
    cfg.sangue = patch === null ? undefined : { ...(cfg.sangue ?? {}), ...patch };
    if (cfg.sangue === undefined) delete cfg.sangue;
    db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { db.close(); }
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, {
    banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bkp"),
  });
  proc.stderr?.on("data", (d) => console.log("[srv-err]", String(d)));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Sangue Runtime",
    jogadores: { jogador1: "jog_sangue1", jogador2: "jog_sangue2", espectador: "jog_esp" },
    config: { sangue: CONFIG_SANGUE },
  });
  // papel do espectador
  {
    const db = abrirDb(BANCO);
    db.prepare("update memberships set role='espectador' where id=?").run(c.jogadores.espectador.membershipId);
    db.close();
  }
  // elemento kind="poder" no ruleset ativo
  {
    const db = abrirDb(BANCO);
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(c.campId);
    const agora = Date.now();
    db.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), rs.id, "poder", "poder_fogo", "Poder de Fogo", null, null, "{}", agora, agora);
    db.close();
  }
  // templateVersion dedicado
  let tplSangueId;
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
    db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,0,0,?,?)")
      .run(tplId, c.campId, "Ficha Sangue", null, c.adminId, agora, agora);
    db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
      .run(verId, tplId, JSON.stringify(ESTRUTURA_SANGUE), agora, agora);
    tplSangueId = verId;
    db.close();
  }
  const novoChar = (membershipId, nome, dados) => {
    const db = abrirDb(BANCO);
    try {
      const id = crypto.randomUUID(), agora = Date.now();
      db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, c.campId, membershipId, tplSangueId, nome, JSON.stringify(dados), "{}", "aprovada", 0, agora, agora);
      return id;
    } finally { db.close(); }
  };
  const sangue = (saldo, extra = {}) => ({ saldo, capacidade: 10, usos: {}, historico: [], ...extra });
  const charVampiro = novoChar(c.jogadores.jogador1.membershipId, "Vampiro J1", {
    cap: 10, nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 2 }],
    __sangue: sangue(5),
  });
  const charHumano = novoChar(c.jogadores.jogador1.membershipId, "Humano J1", {
    cap: 10, nat: "Humano", poderes: [{ key: "poder_fogo", nivel: 1 }],
    __sangue: sangue(8),
  });
  const charJ2 = novoChar(c.jogadores.jogador2.membershipId, "Vampiro J2", {
    cap: 10, nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 1 }],
    __sangue: sangue(5),
  });
  const charEsp = novoChar(c.jogadores.espectador.membershipId, "Vampiro Esp", {
    cap: 10, nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 1 }],
    __sangue: sangue(5),
  });
  const charSemPoder = novoChar(c.jogadores.jogador1.membershipId, "Sem Poder", {
    cap: 10, nat: "Vampiro", poderes: [], __sangue: sangue(5),
  });
  const charAnimal = novoChar(c.jogadores.jogador1.membershipId, "Animal J1", {
    cap: 10, nat: "Animal", poderes: [{ key: "poder_fogo", nivel: 1 }], __sangue: sangue(5),
  });
  const charCheio = novoChar(c.jogadores.jogador1.membershipId, "Cheio J1", {
    cap: 10, nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 1 }], __sangue: sangue(10),
  });
  const charPobre = novoChar(c.jogadores.jogador1.membershipId, "Pobre J1", {
    cap: 10, nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 1 }], __sangue: sangue(1),
  });
  const charRuim = novoChar(c.jogadores.jogador1.membershipId, "Ledger Ruim", {
    cap: 10, nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 1 }],
    __sangue: { saldo: "abc", usos: {}, historico: [] },
  });
  const charQuaseCheio = novoChar(c.jogadores.jogador1.membershipId, "Quase Cheio", {
    cap: 10, nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 1 }], __sangue: sangue(9),
  });
  const charSemCap = novoChar(c.jogadores.jogador1.membershipId, "Sem Cap", {
    cap: "abc", nat: "Vampiro", poderes: [{ key: "poder_fogo", nivel: 1 }], __sangue: sangue(3),
  });

  const sockJ1 = await conectar(c.jogadores.jogador1.cookie);
  const sockJ2 = await conectar(c.jogadores.jogador2.cookie);
  const sockM = await conectar(c.cookieMestre);
  await entrarCampanha(sockJ1, c.campId);
  await entrarCampanha(sockJ2, c.campId);
  await entrarCampanha(sockM, c.campId);
  // watcher de eventos da campanha (no socket do mestre)
  const eventosAtualizados = [];
  sockM.on("personagens:atualizados", (p) => eventosAtualizados.push(p));

  sec("1. Ativação narrativa — custo positivo, débito e idempotência");
  {
    const reqId = crypto.randomUUID();
    const r = await emitir(sockJ1, "sangue:ativar", { characterId: charVampiro, poderKey: "poder_fogo", requestId: reqId, motivo: "canalizar" });
    t("ACK ok", r?.ok === true && r?.replay === false, JSON.stringify(r).slice(0, 200));
    t("saldo 5→3", saldoSangue(charVampiro) === 3, `saldo=${saldoSangue(charVampiro)}`);
    t("usoId ativar:<uuid>", usosSangue(charVampiro).includes(`ativar:${reqId}`), JSON.stringify(usosSangue(charVampiro)));
    t("estado no ACK", r?.estado?.saldo === 3);
    const r2 = await emitir(sockJ1, "sangue:ativar", { characterId: charVampiro, poderKey: "poder_fogo", requestId: reqId });
    t("retry → replay ok", r2?.ok === true && r2?.replay === true, JSON.stringify(r2).slice(0, 150));
    t("saldo não debitou de novo", saldoSangue(charVampiro) === 3, `saldo=${saldoSangue(charVampiro)}`);
    // concorrência com o MESMO requestId → no máximo um débito
    const reqConc = crypto.randomUUID();
    const [k1, k2] = await Promise.all([
      emitir(sockJ1, "sangue:ativar", { characterId: charVampiro, poderKey: "poder_fogo", requestId: reqConc }),
      emitir(sockJ1, "sangue:ativar", { characterId: charVampiro, poderKey: "poder_fogo", requestId: reqConc }),
    ]);
    t("corrida mesmo requestId: ambos respondem ok", k1?.ok === true && k2?.ok === true, JSON.stringify([k1, k2]).slice(0, 200));
    t("saldo debitou uma única vez (3→1)", saldoSangue(charVampiro) === 1, `saldo=${saldoSangue(charVampiro)}`);
    t("um único usoId para o requestId concorrente", usosSangue(charVampiro).filter((u) => u === `ativar:${reqConc}`).length === 1);
    t("dois usoIds ativar no total", usosSangue(charVampiro).filter((u) => u.startsWith("ativar:")).length === 2);
    t("evento personagens:atualizados emitido", eventosAtualizados.some((e) => e?.characterId === charVampiro));
  }

  sec("2. Ativação — custo zero / ausente / inválido / não-adquirido");
  {
    definirConfigSangue(c.campId, { poderes: { poder_fogo: { custo: 0 } } });
    const r0 = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("custo zero → ok", r0?.ok === true, JSON.stringify(r0).slice(0, 150));
    t("saldo inalterado (8)", saldoSangue(charHumano) === 8, `saldo=${saldoSangue(charHumano)}`);
    definirConfigSangue(c.campId, { poderes: {} });
    const rN = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("sem custo → ok gratuito", rN?.ok === true && saldoSangue(charHumano) === 8);
    definirConfigSangue(c.campId, { poderes: { poder_fogo: { custo: -1 } } });
    const rInv = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    // custo -1 viola o schema de config → fail-closed na carga das regras
    t("custo negativo → rejeitado fail-closed", rInv?.ok === false && ["custo_invalido", "config_invalida"].includes(rInv?.codigo), JSON.stringify(rInv).slice(0, 150));
    t("saldo intacto após custo inválido", saldoSangue(charHumano) === 8);
    definirConfigSangue(c.campId, { poderes: { poder_fogo: { custo: 2 } } });
    const rDesc = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_inexistente", requestId: crypto.randomUUID() });
    t("poder fora do ruleset → poder_desconhecido", rDesc?.ok === false && rDesc?.codigo === "poder_desconhecido", JSON.stringify(rDesc).slice(0, 150));
    const rNao = await emitir(sockJ1, "sangue:ativar", { characterId: charSemPoder, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("poder não na ficha → poder_nao_adquirido", rNao?.ok === false && rNao?.codigo === "poder_nao_adquirido", JSON.stringify(rNao).slice(0, 150));
    const rUuid = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_fogo", requestId: "nao-uuid" });
    t("requestId não-UUID → uso_invalido", rUuid?.ok === false && rUuid?.codigo === "uso_invalido");
    const rPobre = await emitir(sockJ1, "sangue:ativar", { characterId: charPobre, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("saldo insuficiente → saldo_insuficiente", rPobre?.ok === false && rPobre?.codigo === "saldo_insuficiente", JSON.stringify(rPobre).slice(0, 150));
    t("saldo do pobre intacto", saldoSangue(charPobre) === 1);
  }

  sec("3. Recuperação contextual — natureza → ação → quantidade");
  {
    const reqV = crypto.randomUUID();
    const rV = await emitir(sockJ1, "sangue:recuperar", { characterId: charHumano, requestId: reqV });
    // Humano → descansar +2 (saldo 8→10)
    t("Humano recupera +2", rV?.ok === true && saldoSangue(charHumano) === 10, JSON.stringify(rV).slice(0, 200));
    t("usoId recuperar:<uuid>", usosSangue(charHumano).includes(`recuperar:${reqV}`));
    const rV2 = await emitir(sockJ1, "sangue:recuperar", { characterId: charHumano, requestId: reqV });
    t("replay recuperação", rV2?.ok === true && rV2?.replay === true && saldoSangue(charHumano) === 10);

    const reqA = crypto.randomUUID();
    const rA = await emitir(sockJ1, "sangue:recuperar", { characterId: charVampiro, requestId: reqA });
    // Vampiro → alimentar +3, mas saldo 1 + 3 = 4 (cap 10)
    t("Vampiro alimenta +3", rA?.ok === true && saldoSangue(charVampiro) === 4, JSON.stringify(rA).slice(0, 200));
    t("usoId recuperar vampiro", usosSangue(charVampiro).includes(`recuperar:${reqA}`));

    const rAnimal = await emitir(sockJ1, "sangue:recuperar", { characterId: charAnimal, requestId: crypto.randomUUID() });
    t("natureza sem ação → natureza_sem_acao", rAnimal?.ok === false && rAnimal?.codigo === "natureza_sem_acao", JSON.stringify(rAnimal).slice(0, 150));

    // já no teto: registrar usoId mesmo sem ganho
    const reqCheio = crypto.randomUUID();
    const rCheio = await emitir(sockJ1, "sangue:recuperar", { characterId: charCheio, requestId: reqCheio });
    t("no teto → ok sem ganho", rCheio?.ok === true && saldoSangue(charCheio) === 10, JSON.stringify(rCheio).slice(0, 200));
    t("usoId registrado mesmo no teto", usosSangue(charCheio).includes(`recuperar:${reqCheio}`));
  }

  sec("4. Recuperação — configuração desabilitada/inválida");
  {
    definirConfigSangue(c.campId, { recuperacaoSangue: { habilitado: false } });
    const rOff = await emitir(sockJ1, "sangue:recuperar", { characterId: charHumano, requestId: crypto.randomUUID() });
    t("global off → acao_desabilitada", rOff?.ok === false && rOff?.codigo === "acao_desabilitada", JSON.stringify(rOff).slice(0, 150));
    definirConfigSangue(c.campId, { recuperacaoSangue: { habilitado: true, acoes: { descansar: { habilitada: false }, alimentar: { habilitada: true, quantidade: 3 } } } });
    const rAcao = await emitir(sockJ1, "sangue:recuperar", { characterId: charHumano, requestId: crypto.randomUUID() });
    t("ação off → acao_desabilitada", rAcao?.ok === false && rAcao?.codigo === "acao_desabilitada", JSON.stringify(rAcao).slice(0, 150));
    definirConfigSangue(c.campId, { recuperacaoSangue: { habilitado: true, acoes: { descansar: { habilitada: true, quantidade: 0 }, alimentar: { habilitada: true, quantidade: 3 } } } });
    const rQtd = await emitir(sockJ1, "sangue:recuperar", { characterId: charHumano, requestId: crypto.randomUUID() });
    // quantidade 0 viola o schema de config → fail-closed na carga das regras
    t("quantidade 0 → rejeitada fail-closed", rQtd?.ok === false && ["quantidade_invalida", "config_invalida"].includes(rQtd?.codigo), JSON.stringify(rQtd).slice(0, 150));
    t("saldo intacto após quantidade inválida", saldoSangue(charHumano) === 10);
    definirConfigSangue(c.campId, CONFIG_SANGUE.recuperacaoSangue ? { recuperacaoSangue: CONFIG_SANGUE.recuperacaoSangue } : {});
  }

  sec("5. Ajuste manual — somente mestre, motivo e teto");
  {
    const rJ = await emitir(sockJ1, "sangue:ajustar", { characterId: charVampiro, delta: 1, motivo: "teste" });
    t("jogador → sem_permissao", rJ?.ok === false && rJ?.codigo === "sem_permissao", JSON.stringify(rJ).slice(0, 150));
    const rM = await emitir(sockJ2, "sangue:ajustar", { characterId: charVampiro, delta: 1, motivo: "teste" });
    t("outro jogador → sem_permissao", rM?.ok === false);
    const rSemMotivo = await emitir(sockM, "sangue:ajustar", { characterId: charVampiro, delta: 1, motivo: "  " });
    t("motivo vazio → quantidade_invalida", rSemMotivo?.ok === false && rSemMotivo?.codigo === "quantidade_invalida");
    const rDelta0 = await emitir(sockM, "sangue:ajustar", { characterId: charVampiro, delta: 0, motivo: "x" });
    t("delta 0 → quantidade_invalida", rDelta0?.ok === false);
    const rDeltaNaN = await emitir(sockM, "sangue:ajustar", { characterId: charVampiro, delta: "abc", motivo: "x" });
    t("delta não-numérico → quantidade_invalida", rDeltaNaN?.ok === false);
    const rPos = await emitir(sockM, "sangue:ajustar", { characterId: charVampiro, delta: 2, motivo: "recompensa" });
    t("mestre +2 ok", rPos?.ok === true && saldoSangue(charVampiro) === 6, JSON.stringify(rPos).slice(0, 200));
    t("histórico registra ajuste do mestre", histSangue(charVampiro).at(-1)?.tipo === "ajuste" || histSangue(charVampiro).at(-1)?.tipo === "ajuste_manual");
    const rTeto = await emitir(sockM, "sangue:ajustar", { characterId: charQuaseCheio, delta: 5, motivo: "excede" });
    t("positivo acima do teto → capacidade_excedida", rTeto?.ok === false && rTeto?.codigo === "capacidade_excedida", JSON.stringify(rTeto).slice(0, 150));
    const rNeg = await emitir(sockM, "sangue:ajustar", { characterId: charQuaseCheio, delta: -20, motivo: "penalidade" });
    t("negativo além do saldo → saldo_insuficiente", rNeg?.ok === false && rNeg?.codigo === "saldo_insuficiente", JSON.stringify(rNeg).slice(0, 150));
    const rSemCap = await emitir(sockM, "sangue:ajustar", { characterId: charSemCap, delta: 1, motivo: "sem capacidade válida" });
    t("capacidade não resolvida → capacidade_excedida", rSemCap?.ok === false && rSemCap?.codigo === "capacidade_excedida", JSON.stringify(rSemCap).slice(0, 150));
    t("saldo do sem-cap intacto", saldoSangue(charSemCap) === 3);
  }

  sec("6. Reconciliação de capacidade — mestre, auditável");
  {
    // reduz capacidade do charVampiro: saldo 6, cap 10 → cap 4
    {
      const db = abrirDb(BANCO);
      const row = db.prepare("select data from characters where id=?").get(charVampiro);
      const d = JSON.parse(row.data); d.cap = 4;
      db.prepare("update characters set data=? where id=?").run(JSON.stringify(d), charVampiro);
      db.close();
    }
    const usosAntes = usosSangue(charVampiro).length;
    const rJ = await emitir(sockJ1, "sangue:reconciliar-capacidade", { characterId: charVampiro, motivo: "redução" });
    t("jogador → sem_permissao", rJ?.ok === false && rJ?.codigo === "sem_permissao");
    const rSem = await emitir(sockM, "sangue:reconciliar-capacidade", { characterId: charVampiro, motivo: "" });
    t("sem motivo → quantidade_invalida", rSem?.ok === false);
    const rM = await emitir(sockM, "sangue:reconciliar-capacidade", { characterId: charVampiro, motivo: "capacidade reduzida para 4" });
    t("mestre reconcilia → ok", rM?.ok === true && rM?.ajustado === true, JSON.stringify(rM).slice(0, 200));
    t("saldo grampeado em 4", saldoSangue(charVampiro) === 4, `saldo=${saldoSangue(charVampiro)}`);
    t("histórico preservado + ajuste", histSangue(charVampiro).length >= 4);
    t("usos preservados (idempotência intacta)", usosSangue(charVampiro).length === usosAntes, `${usosSangue(charVampiro).length} vs ${usosAntes}`);
    const r2 = await emitir(sockM, "sangue:reconciliar-capacidade", { characterId: charVampiro, motivo: "segunda vez" });
    t("repetição → ajustado=false", r2?.ok === true && r2?.ajustado === false, JSON.stringify(r2).slice(0, 150));
    // restaura cap para testes seguintes
    {
      const db = abrirDb(BANCO);
      const row = db.prepare("select data from characters where id=?").get(charVampiro);
      const d = JSON.parse(row.data); d.cap = 10;
      db.prepare("update characters set data=? where id=?").run(JSON.stringify(d), charVampiro);
      db.close();
    }
  }

  sec("7. Autorização — não-dono, espectador, mestre-no-lugar, inativo, arquivado");
  {
    const saldoAntes = saldoSangue(charVampiro);
    const rOutro = await emitir(sockJ2, "sangue:ativar", { characterId: charVampiro, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("jogador2 no char do j1 → sem_permissao", rOutro?.ok === false && rOutro?.codigo === "sem_permissao", JSON.stringify(rOutro).slice(0, 150));
    const rMestre = await emitir(sockM, "sangue:ativar", { characterId: charVampiro, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("mestre não ativa pelo jogador → sem_permissao", rMestre?.ok === false && rMestre?.codigo === "sem_permissao", JSON.stringify(rMestre).slice(0, 150));
    const sockEsp = await conectar(c.jogadores.espectador.cookie);
    await entrarCampanha(sockEsp, c.campId);
    const rEsp = await emitir(sockEsp, "sangue:ativar", { characterId: charEsp, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("espectador dono → sem_permissao", rEsp?.ok === false && rEsp?.codigo === "sem_permissao", JSON.stringify(rEsp).slice(0, 150));
    const rEspRec = await emitir(sockEsp, "sangue:recuperar", { characterId: charEsp, requestId: crypto.randomUUID() });
    t("espectador recuperar → sem_permissao", rEspRec?.ok === false);
    // membership inativa
    {
      const db = abrirDb(BANCO);
      db.prepare("update memberships set status='inativo' where id=?").run(c.jogadores.jogador1.membershipId);
      db.close();
    }
    const rInat = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("membership inativa → sem_permissao", rInat?.ok === false && rInat?.codigo === "sem_permissao", JSON.stringify(rInat).slice(0, 150));
    {
      const db = abrirDb(BANCO);
      db.prepare("update memberships set status='ativo' where id=?").run(c.jogadores.jogador1.membershipId);
      db.close();
    }
    // personagem arquivado
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set status='arquivado' where id=?").run(charAnimal);
      db.close();
    }
    const rArq = await emitir(sockJ1, "sangue:ativar", { characterId: charAnimal, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("personagem arquivado → arquivado", rArq?.ok === false && rArq?.codigo === "arquivado", JSON.stringify(rArq).slice(0, 150));
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set status='aprovada' where id=?").run(charAnimal);
      db.close();
    }
    // ledger malformado — fail-closed sem mutação
    const rRuim = await emitir(sockJ1, "sangue:ativar", { characterId: charRuim, poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("ledger malformado → erro fail-closed", rRuim?.ok === false, JSON.stringify(rRuim).slice(0, 150));
    t("saldo do charVampiro intacto", saldoSangue(charVampiro) === saldoAntes, `saldo=${saldoSangue(charVampiro)}`);
    sockEsp.close();
  }

  sec("8. Rollback SQLite — nenhuma mutação nem evento parcial");
  {
    const reqId = crypto.randomUUID();
    const saldoAntes = saldoSangue(charHumano);
    const usosAntes = usosSangue(charHumano).length;
    const eventosAntes = eventosAtualizados.length;
    const db = abrirDb(BANCO);
    db.exec(`CREATE TRIGGER trg_fail_sangue_rt BEFORE UPDATE ON characters
      WHEN OLD.id='${charHumano}' BEGIN SELECT RAISE(ABORT,'falha simulada tx'); END`);
    db.close();
    const r = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_fogo", requestId: reqId });
    const dbq = abrirDb(BANCO);
    dbq.exec("DROP TRIGGER IF EXISTS trg_fail_sangue_rt");
    dbq.close();
    t("ACK erro na falha de tx", r?.ok === false, JSON.stringify(r).slice(0, 150));
    t("saldo NÃO alterado (rollback)", saldoSangue(charHumano) === saldoAntes, `saldo=${saldoSangue(charHumano)}`);
    t("sem usoId parcial", !usosSangue(charHumano).includes(`ativar:${reqId}`) && usosSangue(charHumano).length === usosAntes);
    await sono(300);
    t("nenhum personagens:atualizados na falha", eventosAtualizados.length === eventosAntes, `${eventosAtualizados.length} vs ${eventosAntes}`);
    // retry após rollback → sucesso limpo
    const rOk = await emitir(sockJ1, "sangue:ativar", { characterId: charHumano, poderKey: "poder_fogo", requestId: reqId });
    t("retry pós-rollback → ok", rOk?.ok === true, JSON.stringify(rOk).slice(0, 150));
  }

  sec("9. Payload inválido e personagem inexistente");
  {
    const rVazio = await emitir(sockJ1, "sangue:ativar", {});
    t("sem characterId → uso_invalido", rVazio?.ok === false);
    const rInex = await emitir(sockJ1, "sangue:ativar", { characterId: crypto.randomUUID(), poderKey: "poder_fogo", requestId: crypto.randomUUID() });
    t("personagem inexistente → nao_encontrado", rInex?.ok === false && rInex?.codigo === "nao_encontrado", JSON.stringify(rInex).slice(0, 150));
    // recuperação não depende de possuir Poder — charSemPoder recupera normal
    const saldoSP = saldoSangue(charSemPoder);
    const rSemPoder2 = await emitir(sockJ1, "sangue:recuperar", { characterId: charSemPoder, requestId: crypto.randomUUID() });
    t("recuperar independe de Poder → ok +3", rSemPoder2?.ok === true && saldoSangue(charSemPoder) === saldoSP + 3, JSON.stringify(rSemPoder2).slice(0, 150));
  }
} finally {
  try { sockJ1?.close(); sockJ2?.close(); sockM?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  limparDir(DIR);
}
console.log(`\n===== ${pass} passaram / ${fail} falharam =====`);
process.exit(fail ? 1 : 0);
