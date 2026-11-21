#!/usr/bin/env node
// Concessão de XP em lote (Issue #185 item 3) — suíte HTTP com banco
// temporário. Cobre: lote válido multi-personagem, tudo-ou-nada
// (cross-campaign, arquivado, ficha não selada, item duplicado),
// idempotência por requestId (retry idêntico devolve resultado gravado;
// payload divergente → 409), rollback total, permissão mestre-only e
// readbacks de saldo/__xp.historico/auditoria/xp_lotes.
import { req, dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel, encerrarServidor, limparDir, criarCenario, abrirDb, comDb } from "./teste-base.mjs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const DIR = dirTeste("xp-lote");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;

function t(desc, ok, details = "") {
  if (ok) { console.log(`  ok ${desc}`); pass++; }
  else { console.log(`  FALHOU ${desc} ${details}`); fail++; }
}
const sec = (n) => console.log("\n== " + n + " ==");

const xpDe = (charId) => comDb(BANCO, (db) => {
  const row = db.prepare("select data from characters where id = ?").get(charId);
  const xp = JSON.parse(row.data || "{}").__xp;
  return xp ? { saldo: xp.saldo, historico: xp.historico ?? [] } : { saldo: 0, historico: [] };
});
const loteRow = (campId, requestId) => comDb(BANCO, (db) =>
  db.prepare("select * from xp_lotes where campaign_id = ? and request_id = ?").get(campId, requestId) ?? null);
const auditorias = (action) => comDb(BANCO, (db) =>
  db.prepare("select * from audit_logs where action = ? order by created_at").all(action));
const novoPersonagemSelado = async (c, membershipId, nome, { arquivado = false } = {}) => {
  const p = c.novoPersonagem(membershipId, nome);
  const w = abrirDb(BANCO);
  try {
    const row = w.prepare("select data from characters where id = ?").get(p);
    const data = JSON.parse(row.data || "{}");
    data.__pontos = { bonus: 0, historico: [], selo: { em: new Date().toISOString(), autorId: "t", autorNome: "T" } };
    const status = arquivado ? "arquivado" : "aprovada";
    w.prepare("update characters set data = ?, status = ? where id = ?").run(JSON.stringify(data), status, p);
  } finally { w.close(); }
  return p;
};
const postLote = (campId, cookie, body) =>
  req(BASE, "POST", `/campaigns/${campId}/xp-lote`, { cookie, body });

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Lote XP",
    jogadores: { jogador1: "jog_l1", jogador2: "jog_l2" },
    ficha: false,
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie;

  // Segunda campanha no MESMO banco/cenário (criarCenario só roda uma
  // vez — setup admin é único). Personagem dela prova o isolamento
  // cross-campaign do lote.
  const camp2 = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "Campanha Lote XP 2" } });
  const CID2 = camp2.json?.campanha?.id;
  const uid2 = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    const agora = Date.now();
    const { hashSenha } = await import("./servidor/dist/lib/password.js");
    w.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid2, "jog_l3", "Jogador L3", await hashSenha("senha-jogador-123"), agora, agora);
    w.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(crypto.randomUUID(), CID2, uid2, agora, agora, agora);
    w.close();
  }
  const { sessao } = await import("./teste-base.mjs");
  const M2 = sessao(BANCO, c.adminId); // mesmo mestre é mestre das duas campanhas
  const memb2 = comDb(BANCO, (db) => db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID2, c.adminId).id);

  const P1 = await novoPersonagemSelado(c, c.jogadores.jogador1.membershipId, "Lote Um");
  const P2 = await novoPersonagemSelado(c, c.jogadores.jogador2.membershipId, "Lote Dois");
  const P3 = await novoPersonagemSelado(c, c.membMestre, "Lote Três");
  const P_ARQ = await novoPersonagemSelado(c, c.membMestre, "Lote Arq", { arquivado: true });
  const P_OUTRA = await novoPersonagemSelado({ novoPersonagem: (mid, nome) => {
    const w = abrirDb(BANCO);
    try {
      const id = crypto.randomUUID();
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, CID2, mid, null, nome, "{}", "{}", "aprovada", 0, Date.now(), Date.now());
      return id;
    } finally { w.close(); }
  } }, memb2, "Lote Outra Campanha");
  const P_NSEL = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Sem Selo"); // sem __pontos.selo

  sec("Validação de entrada e permissão");
  {
    const semAuth = await req(BASE, "POST", `/campaigns/${CID}/xp-lote`, { body: { requestId: "r1", motivo: "x", itens: [{ characterId: P1, quantidade: 5 }] } });
    t("sem cookie → 401", semAuth.status === 401, `status=${semAuth.status}`);
    const jogador = await postLote(CID, J1, { requestId: "r-jog", motivo: "tentativa", itens: [{ characterId: P1, quantidade: 5 }] });
    t("jogador → 403", jogador.status === 403, `status=${jogador.status}`);
    const vazio = await postLote(CID, M, { requestId: "r-vazio", motivo: "x", itens: [] });
    t("itens vazio → 400", vazio.status === 400, `status=${vazio.status}`);
    const qtdZero = await postLote(CID, M, { requestId: "r-q0", motivo: "x", itens: [{ characterId: P1, quantidade: 0 }] });
    t("quantidade 0 → 400", qtdZero.status === 400, `status=${qtdZero.status}`);
    const semMotivo = await postLote(CID, M, { requestId: "r-sm", itens: [{ characterId: P1, quantidade: 5 }] });
    t("motivo ausente → 400", semMotivo.status === 400, `status=${semMotivo.status}`);
    const dup = await postLote(CID, M, { requestId: "r-dup", motivo: "x", itens: [{ characterId: P1, quantidade: 5 }, { characterId: P1, quantidade: 7 }] });
    t("characterId duplicado → 400", dup.status === 400 && dup.json?.codigo === "item_duplicado", `status=${dup.status}`);
  }

  sec("Lote válido multi-personagem");
  {
    const antes1 = xpDe(P1).saldo, antes2 = xpDe(P2).saldo;
    const r = await postLote(CID, M, {
      requestId: "lote-sessao-01",
      motivo: "XP da sessão 3 — todos participaram",
      itens: [{ characterId: P1, quantidade: 40 }, { characterId: P2, quantidade: 25 }, { characterId: P3, quantidade: 10 }],
    });
    t("lote → 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 250)}`);
    t("repetido=false", r.json?.repetido === false);
    t("totalPersonagens=3", r.json?.lote?.totalPersonagens === 3);
    t("totalXp=75", r.json?.lote?.totalXp === 75);
    t("saldos resultantes por item", r.json?.itens?.length === 3 && r.json.itens.every((i) => typeof i.saldoResultante === "number"));
    t("P1 saldo 40", xpDe(P1).saldo === antes1 + 40, `saldo=${xpDe(P1).saldo}`);
    t("P2 saldo 25", xpDe(P2).saldo === antes2 + 25, `saldo=${xpDe(P2).saldo}`);
    t("P3 saldo 10", xpDe(P3).saldo === 10, `saldo=${xpDe(P3).saldo}`);
    const ev1 = xpDe(P1).historico.at(-1);
    t("evento __xp tipo concessao + loteRequestId", ev1?.tipo === "concessao" && ev1?.loteRequestId === "lote-sessao-01", JSON.stringify(ev1));
    const row = loteRow(CID, "lote-sessao-01");
    t("xp_lotes gravado", !!row && row.total_personagens === 3 && row.total_xp === 75, JSON.stringify(row).slice(0, 200));
    const aud = auditorias("campanha.xp_lote").filter((a) => a.campaign_id === CID);
    t("auditoria agregada única", aud.length === 1, `n=${aud.length}`);
    const det = JSON.parse(aud[0]?.detail ?? "{}");
    t("auditoria com itens e totais", det.totalXp === 75 && Array.isArray(det.itens) && det.itens.length === 3, JSON.stringify(det).slice(0, 200));
  }

  sec("Idempotência por requestId");
  {
    const antes = xpDe(P1).saldo;
    const retry = await postLote(CID, M, {
      requestId: "lote-sessao-01",
      motivo: "XP da sessão 3 — todos participaram",
      itens: [{ characterId: P1, quantidade: 40 }, { characterId: P2, quantidade: 25 }, { characterId: P3, quantidade: 10 }],
    });
    t("retry mesmo payload → 200 repetido=true", retry.status === 200 && retry.json?.repetido === true, `status=${retry.status} ${JSON.stringify(retry.json).slice(0, 150)}`);
    t("saldo NÃO duplicado", xpDe(P1).saldo === antes, `saldo=${xpDe(P1).saldo}`);
    t("histórico não duplicado", xpDe(P1).historico.length === 1, `n=${xpDe(P1).historico.length}`);
    const divergente = await postLote(CID, M, {
      requestId: "lote-sessao-01",
      motivo: "payload diferente",
      itens: [{ characterId: P1, quantidade: 40 }, { characterId: P2, quantidade: 25 }, { characterId: P3, quantidade: 11 }],
    });
    t("requestId divergente → 409", divergente.status === 409 && divergente.json?.codigo === "requestId_divergente", `status=${divergente.status}`);
    const ordemInvertida = await postLote(CID, M, {
      requestId: "lote-sessao-01",
      motivo: "XP da sessão 3 — todos participaram",
      itens: [{ characterId: P3, quantidade: 10 }, { characterId: P2, quantidade: 25 }, { characterId: P1, quantidade: 40 }],
    });
    t("mesmo payload em outra ordem → repetido (hash canônico)", ordemInvertida.status === 200 && ordemInvertida.json?.repetido === true, `status=${ordemInvertida.status}`);
    const aud = auditorias("campanha.xp_lote").filter((a) => a.campaign_id === CID);
    t("auditoria continua única após retries", aud.length === 1, `n=${aud.length}`);
  }

  sec("Tudo-ou-nada — falhas intermediárias cancelam o lote inteiro");
  {
    const sP1 = xpDe(P1).saldo, sP2 = xpDe(P2).saldo, sP3 = xpDe(P3).saldo;
    const hP1 = xpDe(P1).historico.length;

    const cross = await postLote(CID, M, {
      requestId: "lote-cross-01", motivo: "tentativa cross",
      itens: [{ characterId: P1, quantidade: 15 }, { characterId: P_OUTRA, quantidade: 15 }],
    });
    t("personagem de outra campanha → 404", cross.status === 404 && cross.json?.codigo === "personagem_nao_encontrado", `status=${cross.status} ${JSON.stringify(cross.json).slice(0, 150)}`);
    t("P1 saldo inalterado após cross", xpDe(P1).saldo === sP1);
    t("nenhum xp_lotes gravado p/ cross", loteRow(CID, "lote-cross-01") === null);

    const arq = await postLote(CID, M, {
      requestId: "lote-arq-01", motivo: "tentativa arquivado",
      itens: [{ characterId: P2, quantidade: 15 }, { characterId: P_ARQ, quantidade: 15 }],
    });
    t("personagem arquivado → 403", arq.status === 403 && arq.json?.codigo === "personagem_arquivado", `status=${arq.status} ${JSON.stringify(arq.json).slice(0, 150)}`);
    t("P2 saldo inalterado após arquivado", xpDe(P2).saldo === sP2);
    t("P_ARQ saldo segue 0", xpDe(P_ARQ).saldo === 0, `saldo=${xpDe(P_ARQ).saldo}`);

    const nsel = await postLote(CID, M, {
      requestId: "lote-nsel-01", motivo: "tentativa sem selo",
      itens: [{ characterId: P3, quantidade: 15 }, { characterId: P_NSEL, quantidade: 15 }],
    });
    t("ficha sem selo → 403", nsel.status === 403 && nsel.json?.codigo === "ficha_nao_selada", `status=${nsel.status}`);
    t("P3 saldo inalterado após sem selo", xpDe(P3).saldo === sP3);

    const inexistente = await postLote(CID, M, {
      requestId: "lote-inex-01", motivo: "tentativa inexistente",
      itens: [{ characterId: P1, quantidade: 15 }, { characterId: "char-inexistente", quantidade: 15 }],
    });
    t("personagem inexistente → 404", inexistente.status === 404, `status=${inexistente.status}`);
    t("P1 histórico inalterado após falhas", xpDe(P1).historico.length === hP1, `n=${xpDe(P1).historico.length}`);
    t("zero linhas xp_lotes das tentativas", ["lote-cross-01", "lote-arq-01", "lote-nsel-01", "lote-inex-01"].every((r) => loteRow(CID, r) === null));
  }

  sec("requestId com escopo por campanha");
  {
    const r2 = await postLote(CID2, M2, {
      requestId: "lote-sessao-01", motivo: "mesmo requestId noutra campanha",
      itens: [{ characterId: P_OUTRA, quantidade: 7 }],
    });
    t("mesmo requestId em OUTRA campanha → executa (escopo campanha+requestId)", r2.status === 200 && r2.json?.repetido === false, `status=${r2.status}`);
    t("P_OUTRA recebeu 7 XP", xpDe(P_OUTRA).saldo === 7, `saldo=${xpDe(P_OUTRA).saldo}`);
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n===== ${pass} passaram / ${fail} falharam =====`);
process.exit(fail ? 1 : 0);
