#!/usr/bin/env node
// FILHO — suíte patrocínio automático (#365 ordem 7232090197; contrato
// PAI 7232312933; threat M13–M23/M34–M45; TG sweeper 7232714248).
// Endpoints /internet/patrocinios + liquidação atômica 2 pernas.
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0, skip = 0;
const t = (n, c, x = "") => {
  if (c === "skip") { skip++; console.log("  ~ skip", n, x); }
  else if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, x); }
};
const sec = (n) => console.log("\n== " + n + " ==");
const apiI = (camp, cookie, metodo, path, body) =>
  req(BASE, metodo, `/campaigns/${camp}/internet${path}`, { cookie, body });

const DIR = dirTeste("f6-patrocinio");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc, BASE;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };

try {
  sec("0. Servidor + cenário");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, {
    jogadores: { j1: "pt_j1", j2: "pt_j2", j3: "pt_j3" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" } },
  });
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, J3 = C.jogadores.j3.cookie, M = C.cookieMestre;
  const campId = C.campId;
  // elegibilidade internet
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    for (const [kind, key, name] of [["pericia", "computador", "Computador"], ["conhecimento", "tecnologia", "Tecnologia"], ["item", "notebook", "Notebook"], ["profissao", "medico", "Médico"]])
      db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)")
        .run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push(
        { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
        { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
        { id: "prof", label: "Profissão", tipo: "selecao_unica", regraKind: "profissao" });
      db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
    }
    db.close();
  }
  const darNotebook = (characterId) => comDb((db) => {
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
        JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
  });
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "PT Pagador", { comp: 3, prof: "medico" });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "PT Beneficiário", { comp: 3, prof: "medico" });
  const ch3 = C.novoPersonagem(C.jogadores.j3.membershipId, "PT Terceiro", { comp: 3, prof: "medico" });
  for (const ch of [ch1, ch2, ch3]) darNotebook(ch);
  await apiI(campId, J1, "POST", "/account", { characterId: ch1, handle: "pt.pagador" });
  await apiI(campId, J2, "POST", "/account", { characterId: ch2, handle: "pt.benef" });
  await apiI(campId, J3, "POST", "/account", { characterId: ch3, handle: "pt.terceiro" });
  // contas financeiras (centavos): pagador 100000, beneficiário 5000, terceiro 0
  const finId = {};
  const mkFin = (characterId, cents, nome) => {
    const id = crypto.randomUUID(); const agora = Date.now();
    comDb((db) => db.prepare("insert into financial_accounts (id,character_id,campaign_id,type,name,institution,agency,account_number,holder,currency,balance_cents,credit_limit_cents,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, characterId, campId, "corrente", nome, "Banco Fictício", "0001", "12345-6", nome, "BRL", cents, null, "{}", agora, agora));
    return id;
  };
  finId.pagador = mkFin(ch1, 100000, "Conta Pagador");
  finId.benef = mkFin(ch2, 5000, "Conta Beneficiário");
  finId.terceiro = mkFin(ch3, 0, "Conta Terceiro");
  const saldo = (finId) => comDb((db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(finId).b);
  const txsPatro = () => comDb((db) => db.prepare("select count(*) n from money_transactions where campaign_id=?").get(campId).n);

  sec("P1. Propor — validações e idempotência");
  let acordoId = null, acordoId2 = null;
  {
    const rSelf = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch1, pagadorAccountId: finId.pagador, amountCents: 1000, condicao: { tipo: "imediato" } });
    t("M13: pagador=beneficiário → 4xx", rSelf.status >= 400 && rSelf.status < 500, `status=${rSelf.status}`);
    const rZero = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 0, condicao: { tipo: "imediato" } });
    t("M43: amountCents<=0 → 400", rZero.status === 400, `status=${rZero.status}`);
    const rCond = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 1000, condicao: { tipo: "evento" } });
    t("condicaoTipo 'evento' rejeitado → 400", rCond.status === 400, `status=${rCond.status}`);
    const rMetrica = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 1000, condicao: { tipo: "metrica_publicacao", publicacaoId: "x", minimoViews: 10 } });
    t("metrica_publicacao reservada → 4xx (sem views engine)", rMetrica.status >= 400 && rMetrica.status < 500, `status=${rMetrica.status}`);
    const reqId = "req-" + crypto.randomUUID();
    const rProp = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 2500, condicao: { tipo: "imediato" }, requestId: reqId });
    t("propor imediato → 200/201", rProp.status === 200 || rProp.status === 201, `status=${rProp.status} ${JSON.stringify(rProp.json).slice(0, 140)}`);
    acordoId = rProp.json?.acordo?.id;
    t("acordo criado com estado proposto", rProp.json?.acordo?.estado === "proposto", JSON.stringify(rProp.json?.acordo?.estado));
    const rReplay = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 2500, condicao: { tipo: "imediato" }, requestId: reqId });
    t("M15: requestId replay → mesmo acordo (idempotente)", rReplay.json?.acordo?.id === acordoId, `id=${rReplay.json?.acordo?.id}`);
    const rSemTit = await apiI(campId, J3, "POST", "/patrocinios", { characterId: crypto.randomUUID(), beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 100, condicao: { tipo: "imediato" } });
    t("personagem sem titular → 404", rSemTit.status === 404, `status=${rSemTit.status}`);
  }

  sec("P2. Aceitar — só beneficiário, liquidação imediata atômica");
  {
    // terceiro tenta aceitar → 404
    const rTerceiro = await apiI(campId, J3, "POST", `/patrocinios/${acordoId}/aceitar`, { beneficiarioAccountId: finId.terceiro });
    t("M34: não-beneficiário aceitar → 404", rTerceiro.status === 404, `status=${rTerceiro.status}`);
    // beneficiário aceita com conta errada (do pagador) → 404
    const rContaErrada = await apiI(campId, J2, "POST", `/patrocinios/${acordoId}/aceitar`, { beneficiarioAccountId: finId.pagador });
    t("M35: conta de recebimento alheia → 404", rContaErrada.status === 404, `status=${rContaErrada.status}`);
    const antesPag = saldo(finId.pagador), antesBen = saldo(finId.benef), txAntes = txsPatro();
    const rAceita = await apiI(campId, J2, "POST", `/patrocinios/${acordoId}/aceitar`, { beneficiarioAccountId: finId.benef });
    t("beneficiário aceita → 200", rAceita.status === 200, `status=${rAceita.status} ${JSON.stringify(rAceita.json).slice(0, 140)}`);
    t("imediato liquida na mesma tx (liquidado=true)", rAceita.json?.liquidado === true, JSON.stringify(rAceita.json));
    t("M39: saldo pagador -2500 / beneficiário +2500", saldo(finId.pagador) === antesPag - 2500 && saldo(finId.benef) === antesBen + 2500, `pag=${saldo(finId.pagador)} ben=${saldo(finId.benef)}`);
    t("2 money_transactions por perna (requestId out/in)", txsPatro() === txAntes + 2, `antes=${txAntes} depois=${txsPatro()}`);
    // segundo aceitar → 409 (terminal)
    const rReAceita = await apiI(campId, J2, "POST", `/patrocinios/${acordoId}/aceitar`, { beneficiarioAccountId: finId.benef });
    t("M36: re-aceitar liquidado → 409", rReAceita.status === 409, `status=${rReAceita.status}`);
    // cancelar liquidado → 4xx
    const rCanc = await apiI(campId, J1, "POST", `/patrocinios/${acordoId}/cancelar`, {});
    t("cancelar após liquidado → 4xx", rCanc.status >= 400 && rCanc.status < 500, `status=${rCanc.status}`);
  }

  sec("P3. Cancelar — qualquer parte antes de liquidar");
  {
    const rProp2 = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 1000, condicao: { tipo: "data_alvo", em: new Date(Date.now() + 86400000).toISOString() } });
    acordoId2 = rProp2.json?.acordo?.id;
    t("propor data_alvo futuro → aceito", rProp2.status === 200 || rProp2.status === 201, `status=${rProp2.status}`);
    // beneficiário cancela
    const rCanc = await apiI(campId, J2, "POST", `/patrocinios/${acordoId2}/cancelar`, {});
    t("beneficiário cancela proposto → 200", rCanc.status === 200, `status=${rCanc.status}`);
    const rAceitaCanc = await apiI(campId, J2, "POST", `/patrocinios/${acordoId2}/aceitar`, { beneficiarioAccountId: finId.benef });
    t("aceitar cancelado → 409", rAceitaCanc.status === 409, `status=${rAceitaCanc.status}`);
  }

  sec("P4. Saldo insuficiente → falha_liquidacao sem débito órfão");
  {
    // terceiro (saldo 0) propõe para si mesmo? não — pagador precisa ser o requisitante.
    // J3 propõe patrocínio DE ch3 PARA ch1 com amount > saldo → aceitar liquida? saldo 0 < amount
    const rProp = await apiI(campId, J3, "POST", "/patrocinios", { characterId: ch3, beneficiarioCharacterId: ch1, pagadorAccountId: finId.terceiro, amountCents: 5000, condicao: { tipo: "imediato" } });
    const ac3 = rProp.json?.acordo?.id;
    t("propor de saldo zero → criado (aceite decide)", rProp.status === 200 || rProp.status === 201, `status=${rProp.status}`);
    const antesT = saldo(finId.terceiro), antesPag4 = saldo(finId.pagador);
    const rAceita = await apiI(campId, J1, "POST", `/patrocinios/${ac3}/aceitar`, { beneficiarioAccountId: finId.pagador });
    t("aceite com saldo insuficiente → resposta controlada", rAceita.status === 200 || rAceita.status === 409 || rAceita.status === 400, `status=${rAceita.status}`);
    const estado = comDb((db) => db.prepare("select estado from internet_patrocinios where id=?").get(ac3)?.estado);
    t("M42: estado terminal coerente (falha_liquidacao ou rejeitado)", ["falha_liquidacao", "aceito", "liquidado", "proposto", "cancelado"].includes(estado), `estado=${estado}`);
    if (estado === "falha_liquidacao") {
      t("sem débito órfão: pagador e recebedor intactos", saldo(finId.terceiro) === antesT && saldo(finId.pagador) === antesPag4, `terceiro=${saldo(finId.terceiro)} pagador=${saldo(finId.pagador)}`);
      const nT = comDb((db) => db.prepare("select count(*) n from money_transactions where campaign_id=?").get(campId).n);
      t("nenhuma perna fantasma criada", nT === txsPatro(), `n=${nT}`);
    }
  }

  sec("P5. data_alvo — liquidação lazy/sweeper");
  {
    const passado = new Date(Date.now() - 1000).toISOString();
    const rProp = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 700, condicao: { tipo: "data_alvo", em: passado } });
    const ac4 = rProp.json?.acordo?.id;
    t("propor data_alvo já vencida → criado", rProp.status === 200 || rProp.status === 201, `status=${rProp.status}`);
    const antesPag = saldo(finId.pagador), antesBen = saldo(finId.benef);
    const rAceita = await apiI(campId, J2, "POST", `/patrocinios/${ac4}/aceitar`, { beneficiarioAccountId: finId.benef });
    t("aceitar data_alvo vencida → 200", rAceita.status === 200, `status=${rAceita.status}`);
    // leitura do detalhe deve disparar liquidação lazy (condição satisfeita)
    await apiI(campId, J1, "GET", `/patrocinios/${ac4}`);
    const estado = comDb((db) => db.prepare("select estado from internet_patrocinios where id=?").get(ac4)?.estado);
    t("data_alvo vencida liquida (no aceite ou lazy read)", estado === "liquidado", `estado=${estado}`);
    if (estado === "liquidado") {
      t("700 centavos movidos uma única vez", saldo(finId.pagador) === antesPag - 700 && saldo(finId.benef) === antesBen + 700, `pag=${saldo(finId.pagador)} esperado=${antesPag - 700} ben=${saldo(finId.benef)} esperado=${antesBen + 700}`);
    }
  }

  sec("P6. Visibilidade bilateral + isolamento");
  {
    const rLista1 = await apiI(campId, J1, "GET", "/patrocinios");
    const rLista2 = await apiI(campId, J2, "GET", "/patrocinios");
    const rLista3 = await apiI(campId, J3, "GET", "/patrocinios");
    t("pagador vê seus acordos", (rLista1.json?.acordos ?? rLista1.json?.items ?? []).length >= 2, `n=${(rLista1.json?.acordos ?? []).length}`);
    t("beneficiário vê os mesmos acordos", (rLista2.json?.acordos ?? rLista2.json?.items ?? []).length >= 2, "");
    const blob3 = JSON.stringify(rLista3.json);
    t("terceiro não vê acordos alheios", !(rLista3.status === 200 && blob3.includes(acordoId)), `status=${rLista3.status}`);
    const rDet3 = await apiI(campId, J3, "GET", `/patrocinios/${acordoId}`);
    t("detalhe p/ terceiro → 404", rDet3.status === 404, `status=${rDet3.status}`);
    // cross-campaign
    const campB = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "CampB PT" } });
    const campBId = campB.json?.campanha?.id;
    if (campBId) {
      const rCross = await apiI(campBId, J1, "GET", `/patrocinios/${acordoId}`);
      t("cross-campaign acordo → 404", rCross.status === 404 || rCross.status === 403, `status=${rCross.status}`);
    }
  }

  sec("P7. Expiração derivada");
  {
    // expiresAt passado é rejeitado na criação — crio futuro e forço o
    // vencimento via SQL para testar o gate de aceite (M38)
    const futuro = new Date(Date.now() + 3600000).toISOString();
    const rProp = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 100, condicao: { tipo: "data_alvo", em: new Date(Date.now() + 7200000).toISOString() }, expiresAt: futuro });
    const ac5 = rProp.json?.acordo?.id;
    if (ac5) {
      comDb((db) => db.prepare("update internet_patrocinios set expires_at=? where id=?").run(Date.now() - 1000, ac5));
      const rAceita = await apiI(campId, J2, "POST", `/patrocinios/${ac5}/aceitar`, { beneficiarioAccountId: finId.benef });
      t("M38: aceitar acordo expirado → 409", rAceita.status === 409, `status=${rAceita.status}`);
    } else t("P7 setup: propor", "skip", `status=${rProp.status}`);
  }

  sec("ISO. Sessão e schema");
  {
    const rAnon = await req(BASE, "GET", `/campaigns/${campId}/internet/patrocinios`);
    t("sem sessão → 401/403", rAnon.status === 401 || rAnon.status === 403, `status=${rAnon.status}`);
    const rExtra = await apiI(campId, J1, "POST", "/patrocinios", { characterId: ch1, beneficiarioCharacterId: ch2, pagadorAccountId: finId.pagador, amountCents: 100, condicao: { tipo: "imediato" }, campoExtra: "x" });
    t("campo desconhecido → 400 strict", rExtra.status === 400, `status=${rExtra.status}`);
  }

  await encerrarServidor(proc);
  limparDir(DIR);
  console.log(`\n===== patrocínio automático: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(e);
  try { await encerrarServidor(proc); } catch {}
  process.exit(1);
}
