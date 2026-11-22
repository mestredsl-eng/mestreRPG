#!/usr/bin/env node
// F25A — reprodução isolada do caso Não-Poder (Issue #186).
// Processo/SQLite/socket/bucket novos. Não executa nenhuma das outras
// seções do teste-d10-sangue-cobranca.mjs: o primeiro mesa:teste:rolar
// desta instalação precisa receber ACK ok:true sem depender de pacing.
import crypto from "node:crypto";
import { join } from "node:path";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, abrirDb, req, criarCenario,
} from "./teste-base.mjs";

const DIR = dirTeste("d10-sangue-nao-poder-isolado");
const BANCO = join(DIR, "banco.db");
let proc = null;
let sock = null;
let ok = 0;
let falhas = 0;

function check(nome, condicao, detalhe = "") {
  if (condicao) {
    ok++;
    console.log("ok " + nome + (detalhe ? " — " + detalhe : ""));
  } else {
    falhas++;
    console.error("FALHOU " + nome + (detalhe ? " — " + detalhe : ""));
  }
}

function comBanco(fn) {
  const db = abrirDb(BANCO);
  try { return fn(db); } finally { db.close(); }
}

function dadosRaw(characterId) {
  return comBanco((db) => db.prepare("SELECT data FROM characters WHERE id=?").get(characterId)?.data ?? null);
}

function contarRolls(campaignId) {
  return comBanco((db) => db.prepare("SELECT count(*) n FROM rolls WHERE campaign_id=?").get(campaignId).n);
}

function obterTeste(testId) {
  return comBanco((db) => db.prepare("SELECT * FROM tests WHERE id=?").get(testId) ?? null);
}

function conectar(cookie) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { extraHeaders: { cookie }, transports: ["websocket"] });
    const timer = setTimeout(() => {
      s.close();
      reject(new Error("timeout ao conectar socket"));
    }, 15000);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("connect_error", (erro) => {
      clearTimeout(timer);
      s.close();
      reject(erro);
    });
  });
}

function emitir(evento, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout ACK " + evento)), 15000);
    try {
      sock.emit(evento, payload, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
    } catch (erro) {
      clearTimeout(timer);
      reject(erro);
    }
  });
}

function inserirTeste(c, sessionId, characterId, skillRef) {
  const id = crypto.randomUUID();
  const agora = Date.now();
  comBanco((db) => db.prepare(
    "INSERT INTO tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,visibility,request_id,created_at,updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    id, c.campId, sessionId, characterId, c.jogadores.jogador1.id,
    JSON.stringify(skillRef), "{}", 4, 10, null, "pendente", "publica", null, agora, agora,
  ));
  return id;
}

const BASE_PORT = await portaLivre();
const BASE = "http://localhost:" + BASE_PORT;

try {
  await prepararBanco(BANCO);
  proc = subirServidor(BASE_PORT, {
    banco: BANCO,
    arquivos: join(DIR, "arq"),
    backups: join(DIR, "bkp"),
  });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "F25A Não-Poder Isolado",
    config: {
      dados: { d10SucessoMinimo: 6 },
      sangue: { habilitado: true, poderes: { poder_fogo: { custo: 2 } } },
    },
    jogadores: { jogador1: "jogador_nao_poder_isolado" },
  });

  // Dois elementos homônimos no ruleset: elementoKey = poder_fogo existe
  // como Poder, mas a skillRef aponta para o campo FOR (atributo), não Poder.
  comBanco((db) => {
    const rs = db.prepare("SELECT id FROM rule_sets WHERE campaign_id=? AND is_active=1").get(c.campId);
    const agora = Date.now();
    db.prepare("INSERT INTO rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), rs.id, "poder", "poder_fogo", "Poder de Fogo", null, null, "{}", agora, agora);
    db.prepare("INSERT INTO rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), rs.id, "habilidade", "poder_fogo", "Habilidade Fogo", null, null, "{}", agora, agora);
  });

  const personagemId = c.novoPersonagem(
    c.jogadores.jogador1.membershipId,
    "Herói Não-Poder Isolado",
    { __sangue: { saldo: 10, capacidade: 15, historico: [], usos: {} } },
  );
  const sessao = await req(BASE, "POST", "/campaigns/" + c.campId + "/sessoes", {
    cookie: c.cookieMestre,
    body: { name: "F25A — sessão isolada" },
  });
  const sessionId = sessao.json?.sessao?.id;
  check("sessão criada", !!sessionId, "status=" + sessao.status);
  if (!sessionId) throw new Error("não foi possível criar a sessão");

  // Novo processo + um socket novo + bucket novo. Não há rolagem anterior
  // deste usuário neste processo; o ACK abaixo é a primeira rolagem D10.
  sock = await conectar(c.jogadores.jogador1.cookie);
  const entrou = await emitir("mesa:entrar", { sessionId });
  check("socket entrou na sessão", entrou?.ok === true, JSON.stringify(entrou).slice(0, 160));

  const testeId = inserirTeste(c, sessionId, personagemId, {
    campoId: "for",
    rotulo: "FOR",
    tipo: "inteiro",
    semantico: "atributo",
    elementoKey: "poder_fogo",
  });
  const antesRaw = dadosRaw(personagemId);
  const antesData = JSON.parse(antesRaw);
  const saldoAntes = antesData.__sangue?.saldo;
  const usosAntes = Object.keys(antesData.__sangue?.usos ?? {});
  const rollsAntes = contarRolls(c.campId);

  // Sem sono/retry: o bucket testeRolar começa com burst cheio neste servidor.
  const ack = await emitir("mesa:teste:rolar", {
    testId: testeId,
    requestId: crypto.randomUUID(),
  });
  const depoisRaw = dadosRaw(personagemId);
  const depoisData = JSON.parse(depoisRaw);
  const teste = obterTeste(testeId);
  const rollsDepois = contarRolls(c.campId);
  const roll = teste?.roll_id
    ? comBanco((db) => db.prepare("SELECT id FROM rolls WHERE id=?").get(teste.roll_id) ?? null)
    : null;

  check("ACK inicial sem burst prévio: ok:true", ack?.ok === true, JSON.stringify(ack).slice(0, 180));
  check("teste persistido como rolado", teste?.status === "rolado" && !!teste?.roll_id,
    "status=" + teste?.status + " roll_id=" + (teste?.roll_id ?? "ausente"));
  check("exatamente uma rolagem nova persistida", rollsDepois === rollsAntes + 1,
    "rolls " + rollsAntes + "→" + rollsDepois);
  check("roll_id do teste referencia a rolagem persistida", !!roll && roll.id === teste?.roll_id);
  check("saldo de Sangue permanece inalterado", depoisData.__sangue?.saldo === saldoAntes && saldoAntes === 10,
    "saldo " + saldoAntes + "→" + depoisData.__sangue?.saldo);
  check("usoId d10:<testId> ausente", !Object.keys(depoisData.__sangue?.usos ?? {}).includes("d10:" + testeId),
    JSON.stringify(Object.keys(depoisData.__sangue?.usos ?? {})));
  check("characters.data byte-a-byte idêntico", depoisRaw === antesRaw);
  check("ledger __sangue inteiro idêntico",
    JSON.stringify(depoisData.__sangue) === JSON.stringify(antesData.__sangue));
  check("nenhuma mutação parcial no personagem", JSON.stringify(depoisData) === JSON.stringify(antesData));
} catch (erro) {
  falhas++;
  console.error("ERRO FATAL:", erro);
} finally {
  try { sock?.disconnect(); } catch {}
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log("\nF25A isolada: " + ok + "/" + (ok + falhas) + " verificações OK, " + falhas + " falhas");
if (falhas) process.exit(1);
