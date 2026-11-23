#!/usr/bin/env node
// Issue #185 / I27 — integração isolada da âncora XP, janela de 500 eventos
// e proveniência HMAC v1. Este arquivo não altera runtime nem os scripts
// reservados à PR empilhada #258.
import { randomUUID } from "node:crypto";
import { aplicarXp, lerXp } from "./servidor/dist/lib/progressao.js";
import { assinarLedgerXp, verificarLedgerXp } from "./servidor/dist/lib/assinatura-xp.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb, req, criarCenario, abrirDb,
} from "./teste-base.mjs";

let ok = 0;
let falhas = 0;
const check = (cond, msg) => {
  if (cond) {
    ok++;
    console.log("  ok", msg);
  } else {
    falhas++;
    console.error("  FALHOU:", msg);
  }
};

const AGORA = "2026-11-22T12:00:00.000Z";
const evXp = (quantidade, saldoResultante) => ({
  em: AGORA,
  tipo: "concessao",
  quantidade,
  motivo: "teste de âncora",
  autorId: null,
  autorNome: null,
  saldoResultante,
});

// Zero explícito faz parte do payload assinado. Nesta PR pai testamos a
// leitura e a semântica criptográfica do marcador; a geração/importação
// integral do caso zero fica coberta pela suíte empilhada da #258.
const ledgerZero = {
  saldo: 15,
  historico: [evXp(5, 5), evXp(5, 10), evXp(5, 15)],
  ancora: 0,
};
const personagemZeroId = randomUUID();
const contextoTeste = {
  chave: Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex"),
  regrasFp: "a".repeat(64),
};
const assinaturaZero = assinarLedgerXp(contextoTeste, personagemZeroId, ledgerZero);
const zeroAssinado = { ...ledgerZero, sig: assinaturaZero };
check(lerXp({ __xp: ledgerZero }).ancora === 0,
  "lerXp preserva ancora=0 explicitamente");
check(assinaturaZero.startsWith("v1.") &&
  verificarLedgerXp(contextoTeste, personagemZeroId, zeroAssinado),
  "HMAC v1 autentica o marcador ancora=0");
check(!verificarLedgerXp(contextoTeste, personagemZeroId, { ...zeroAssinado, ancora: 1 }),
  "HMAC v1 rejeita adulteração de ancora após assinar");

function gerarTruncamentos() {
  let dados = {};
  let primeiroCorte = null;
  for (let i = 0; i < 1001; i++) {
    const delta = i === 0 ? 100 : 1;
    dados = aplicarXp(dados, delta, {
      tipo: "concessao",
      motivo: "homologação janela 500",
      autorId: null,
      autorNome: null,
    }).dados;
    if (i === 500) primeiroCorte = JSON.parse(JSON.stringify(dados.__xp));
  }
  return { primeiroCorte, final: JSON.parse(JSON.stringify(dados.__xp)) };
}

const { primeiroCorte, final: ledgerTruncado } = gerarTruncamentos();
check(primeiroCorte?.historico?.length === 500 && primeiroCorte?.saldo === 600 &&
  primeiroCorte?.ancora === 100,
  "501 eventos: retém 500 e grava âncora 100 no primeiro corte");
const somaRetida = (ledgerTruncado?.historico ?? []).reduce((s, e) => s + e.quantidade, 0);
check(ledgerTruncado?.historico?.length === 500 &&
  ledgerTruncado?.saldo === 1100 && ledgerTruncado?.ancora === 600,
  "1001 eventos: mantém janela 500 e avança âncora para 600");
check(somaRetida === 500 && ledgerTruncado?.historico?.[0]?.saldoResultante === 601 &&
  ledgerTruncado?.ancora + somaRetida === ledgerTruncado?.saldo,
  "invariante saldo = âncora + soma dos 500 deltas retidos");

const dir = dirTeste("xp-ancora-integridade-pilha");
const banco = dir + "/teste.db";
let proc = null;
let base = null;

try {
  await prepararBanco(banco);
  const porta = await portaLivre();
  base = "http://127.0.0.1:" + porta;
  proc = subirServidor(porta, {
    banco,
    arquivos: dir + "/arq",
    backups: dir + "/bks",
  });
  await esperarSaudavel(base, proc);

  const c = await criarCenario(base, banco, {
    campanha: "I27 âncora e HMAC",
    jogadores: { jogador1: "i27_jogador1" },
  });
  const tpl = comDb(banco, (db) =>
    db.prepare("select id from sheet_versions where template_id in (select id from sheet_templates where campaign_id=?)")
      .get(c.campId).id);
  const membershipId = c.jogadores.jogador1.membershipId;
  const inserir = (nome, xp) => {
    const id = randomUUID();
    const agora = Date.now();
    const db = abrirDb(banco);
    try {
      db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, c.campId, membershipId, tpl, nome,
          JSON.stringify({ for: 5, __xp: xp }), "{}", "aprovada", 0, agora, agora);
    } finally {
      db.close();
    }
    return id;
  };

  const idZero = inserir("I27 âncora zero explícita", ledgerZero);
  const idTruncado = inserir("I27 histórico truncado", ledgerTruncado);
  const idSemAncora = inserir("I27 ledger completo", {
    saldo: 15,
    historico: [evXp(5, 5), evXp(5, 10), evXp(5, 15)],
  });

  const linha = (pacote, id) =>
    (pacote?.estado?.characters ?? []).find((r) => r.id === id);
  const personagem = (id) => comDb(banco, (db) => {
    const row = db.prepare("select data from characters where id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  });
  const importar = (pacote) => req(base, "POST", "/campaigns/importar", {
    cookie: c.cookieMestre,
    body: {
      pacote,
      modo: "substituir",
      campaignId: c.campId,
      confirmacao: "SUBSTITUIR",
    },
  });

  // Exportação deve assinar o ledger completo sem persistir a assinatura.
  const exportado = await req(base, "GET", "/campaigns/" + c.campId + "/exportar", {
    cookie: c.cookieMestre,
  });
  check(exportado.status === 200, "exportação da campanha disponível");
  const pacote = exportado.json;
  const xpZeroPacote = linha(pacote, idZero)?.data?.__xp;
  const xpTruncadoPacote = linha(pacote, idTruncado)?.data?.__xp;
  const xpCompletoPacote = linha(pacote, idSemAncora)?.data?.__xp;
  check(xpZeroPacote?.ancora === 0 && xpZeroPacote?.sig?.startsWith("v1."),
    "exportação assina ledger que contém ancora=0");
  check(xpTruncadoPacote?.ancora === 600 &&
    xpTruncadoPacote?.historico?.length === 500 &&
    xpTruncadoPacote?.sig?.startsWith("v1."),
    "exportação assina a âncora e a janela truncada de 500 eventos");
  check(xpCompletoPacote?.ancora === undefined && xpCompletoPacote?.sig?.startsWith("v1."),
    "histórico completo é assinado sem fabricar âncora");

  // Importação externa válida deve preservar a cadeia positiva truncada.
  const importado = await importar(pacote);
  check(importado.status === 200,
    "importação/substituição do pacote assinado aceita (status=" + importado.status + ")");
  let d = personagem(idTruncado);
  check(d?.__xp?.saldo === 1100 && d.__xp?.ancora === 600 &&
    d.__xp?.historico?.length === 500,
    "saneamento preserva saldo, âncora e 500 eventos autenticados");
  check(!Object.prototype.hasOwnProperty.call(d?.__xp ?? {}, "sig"),
    "assinatura de transporte não persiste em characters.data");
  const leitura = await req(base, "GET", "/characters/" + idTruncado + "/progressao", {
    cookie: c.cookieMestre,
  });
  check(leitura.status === 200 && leitura.json?.xp?.ancora === 600 &&
    leitura.json?.xp?.historico?.length === 500,
    "GET /progressao devolve a âncora truncada já saneada");

  // A âncora faz parte do HMAC: adulterá-la depois de exportar invalida
  // somente o ledger daquele personagem, sem apagar a ficha normal nem
  // os ledgers válidos dos demais personagens do mesmo pacote.
  const adulterado = JSON.parse(JSON.stringify(pacote));
  linha(adulterado, idTruncado).data.__xp.ancora = 601;
  const importAdulterado = await importar(adulterado);
  check(importAdulterado.status === 200,
    "pacote com ledger adulterado é importado com saneamento fail-closed");
  check((importAdulterado.json?.saneamento?.totais?.ledgersXpInvalidos ?? 0) >= 1,
    "relatório contabiliza ledger cuja âncora foi adulterada");
  d = personagem(idTruncado);
  check(d?.for === 5 && d?.__xp?.saldo === 0 &&
    d?.__xp?.historico?.length === 0 && d?.__xp?.ancora === undefined,
    "tampering zera apenas XP não demonstrável e preserva a ficha");
  const leituraFechada = await req(base, "GET", "/characters/" + idTruncado + "/progressao", {
    cookie: c.cookieMestre,
  });
  check(leituraFechada.status === 200 && leituraFechada.json?.xp?.saldo === 0 &&
    leituraFechada.json?.xp?.historico?.length === 0 &&
    !Object.prototype.hasOwnProperty.call(leituraFechada.json?.xp ?? {}, "ancora"),
    "GET confirma fail-closed sem saldo parcial nem âncora forjada");
  d = personagem(idSemAncora);
  check(d?.__xp?.saldo === 15 && d?.__xp?.historico?.length === 3,
    "ledger válido do mesmo pacote permanece íntegro");

  // Chave de instalação não pode acompanhar o pacote; assinaturas são
  // somente de transporte e não podem aparecer no banco.
  const chaveRow = comDb(banco, (db) =>
    db.prepare("select value from server_settings where key='exportacao.chave.xp'").get());
  let chaveHex = null;
  try {
    chaveHex = JSON.parse(chaveRow?.value);
  } catch {
    chaveHex = chaveRow?.value;
  }
  check(typeof chaveHex === "string" && /^[0-9a-f]{64}$/.test(chaveHex),
    "chave HMAC v1 fica em server_settings na instalação");
  check(chaveHex && !JSON.stringify(pacote).includes(chaveHex),
    "pacote exportado não contém a chave secreta HMAC");
  const sigPersistida = comDb(banco, (db) =>
    db.prepare("select count(*) n from characters where campaign_id=? and data like '%\"sig\"%'")
      .get(c.campId).n);
  check(sigPersistida === 0, "nenhuma assinatura HMAC persiste em characters.data");
} catch (erro) {
  falhas++;
  console.error("FALHOU: exceção não tratada na suíte I27:", erro?.stack ?? erro);
} finally {
  await encerrarServidor(proc);
  limparDir(dir);
}

console.log("\n" + ok + "/" + (ok + falhas) + " verificações OK");
if (falhas) process.exit(1);
