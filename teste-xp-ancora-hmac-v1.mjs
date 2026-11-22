// Issue #185 / F26 — compatibilidade do pacote legado HMAC v1 com
// `__xp.ancora = 0`. A I27 simulou v2×âncora, mas faltava o assert
// dedicado: uma assinatura v1 VÁLIDA precisa preservar o marcador
// explícito zero, e adulterar a âncora depois de assinar precisa
// falhar fechada sem persistir XP parcial.
//
// Escopo: SOMENTE testes. Usa exportação/importação/assinatura reais
// do servidor e banco descartável — nenhum mock do verificador HMAC.
import { randomUUID } from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb, req, criarCenario, abrirDb,
} from "./teste-base.mjs";

let ok = 0, falhas = 0;
const check = (cond, msg) => { if (cond) { ok++; } else { falhas++; console.error("FALHA:", msg); } };

const AGORA = "2025-06-01T12:00:00.000Z";
const evXp = (qtd, saldo) => ({
  em: AGORA, tipo: "concessao", quantidade: qtd, motivo: "teste",
  autorId: null, autorNome: null, saldoResultante: saldo,
});
// Cadeia coerente nascendo da âncora: primeiro evento tem
// saldoResultante - quantidade = 0 → ancora declarada 0 é demonstrável.
const ledgerCadeia = () => ({
  saldo: 15,
  historico: [evXp(5, 5), evXp(5, 10), evXp(5, 15)],
});

const dir = dirTeste("xp-ancora-hmac-v1");
const banco = `${dir}/teste.db`;
let proc = null, base = null;

try {
  await prepararBanco(banco);
  const porta = await portaLivre();
  base = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco, arquivos: `${dir}/arq`, backups: `${dir}/bks` });
  await esperarSaudavel(base, proc);

  const c = await criarCenario(base, banco, { campanha: "Âncora HMAC v1" });
  const { campId, cookieMestre } = c;

  const tpl = comDb(banco, (db) =>
    db.prepare("select id from sheet_versions where template_id in (select id from sheet_templates where campaign_id=?)").get(campId).id);
  const membershipId = c.jogadores.jogador1.membershipId;
  const inserir = (nome, xp) => {
    const id = randomUUID();
    const db = abrirDb(banco);
    db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, campId, membershipId, tpl, nome, JSON.stringify({ for: 5, __xp: xp }), "{}", "aprovada", 0, Date.now(), Date.now());
    db.close();
    return id;
  };

  // Char A: pacote legado com âncora zero explícita; Char B: ledger
  // completo SEM âncora (semântica antiga — não pode fabricar marcador).
  const idAncora = inserir("Legado Âncora Zero", { ...ledgerCadeia(), ancora: 0 });
  inserir("Legado Sem Âncora", ledgerCadeia());

  const personagem = (nome) => comDb(banco, (db) => {
    const r = db.prepare("select data from characters where campaign_id=? and name=?").get(campId, nome);
    return r ? JSON.parse(r.data) : null;
  });
  const linhaPacote = (pacote, nome) =>
    (pacote.estado.characters ?? []).find((r) => r.name === nome);

  // ---------- exportação: servidor assina os dois ledgers (v1) ----------
  const exp = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
  check(exp.status === 200, `exportar status ${exp.status}`);
  const pacote = exp.json;
  const xpA = linhaPacote(pacote, "Legado Âncora Zero")?.data?.__xp;
  const xpB = linhaPacote(pacote, "Legado Sem Âncora")?.data?.__xp;
  check(xpA?.ancora === 0 && typeof xpA?.sig === "string" && xpA.sig.startsWith("v1."),
    `pacote: âncora 0 exportada com sig v1 (ancora=${xpA?.ancora}, sig=${String(xpA?.sig).slice(0, 10)}…)`);
  check(xpB && xpB.ancora === undefined && typeof xpB?.sig === "string" && xpB.sig.startsWith("v1."),
    "pacote: ledger sem âncora exportado com sig v1 e sem marcador");

  // ---------- CASO 1: importar idêntico (substituir, ids intactos) ----------
  const imp1 = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  check(imp1.status === 200, `importar idêntico status ${imp1.status}: ${JSON.stringify(imp1.json)?.slice(0, 200)}`);
  let d = personagem("Legado Âncora Zero");
  check(d?.__xp?.ancora === 0 && d.__xp.saldo === 15 && d.__xp.historico.length === 3,
    `v1 válida: âncora 0 preservada explicitamente (ancora=${d?.__xp?.ancora}, saldo=${d?.__xp?.saldo}, hist=${d?.__xp?.historico?.length})`);
  d = personagem("Legado Sem Âncora");
  check(d?.__xp?.ancora === undefined && d.__xp.saldo === 15 && d.__xp.historico.length === 3,
    `v1 válida sem âncora: semântica antiga mantida, nenhum ancora:0 fabricado (ancora=${d?.__xp?.ancora})`);

  // re-exportar: o marcador zero continua explícito e reassinado
  const exp2 = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
  const xpA2 = linhaPacote(exp2.json, "Legado Âncora Zero")?.data?.__xp;
  check(xpA2?.ancora === 0 && typeof xpA2?.sig === "string" && xpA2.sig.startsWith("v1."),
    "re-export: âncora 0 segue explícita sob nova assinatura v1");

  // ---------- CASO 2: tampering — altera ancora:0 DEPOIS de assinar ----------
  const adulterado = JSON.parse(JSON.stringify(pacote));
  linhaPacote(adulterado, "Legado Âncora Zero").data.__xp.ancora = 1; // sig intacta → diverge
  const imp2 = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: adulterado, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  check(imp2.status === 200, `importar adulterado status ${imp2.status}`);
  check((imp2.json?.saneamento?.totais?.ledgersXpInvalidos ?? 0) >= 1,
    `tampering: ledger invalidado contabilizado (${imp2.json?.saneamento?.totais?.ledgersXpInvalidos})`);
  d = personagem("Legado Âncora Zero");
  check(d?.__xp?.saldo === 0 && d.__xp.historico.length === 0 && d.__xp.ancora === undefined,
    `tampering: fail-closed — zero XP parcial, sem âncora forjada (saldo=${d?.__xp?.saldo}, hist=${d?.__xp?.historico?.length}, ancora=${d?.__xp?.ancora})`);
  check(d?.for === 5, "tampering: dados normais da ficha preservados");
  d = personagem("Legado Sem Âncora");
  check(d?.__xp?.saldo === 15 && d.__xp.historico.length === 3,
    "tampering: ledger íntegro do MESMO pacote não é afetado (fail-closed por ledger)");

  // controle extra: remover `sig` também reprova (assinatura ausente ≠ válida)
  const semSig = JSON.parse(JSON.stringify(pacote));
  delete linhaPacote(semSig, "Legado Âncora Zero").data.__xp.sig;
  await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: semSig, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  d = personagem("Legado Âncora Zero");
  check(d?.__xp?.saldo === 0 && d.__xp.historico.length === 0,
    "sig ausente: fail-closed igualmente (sem prova de procedência)");

  // ---------- CASO 4: credenciais/assinaturas NÃO persistem no banco ----------
  const chaveRow = comDb(banco, (db) =>
    db.prepare("select value from server_settings where key='exportacao.chave.xp'").get());
  // value é text modo json — drizzle grava a string COM aspas
  let chaveHex = null;
  try { chaveHex = JSON.parse(chaveRow?.value); } catch { chaveHex = chaveRow?.value; }
  check(typeof chaveHex === "string" && /^[0-9a-f]{64}$/.test(chaveHex),
    "chave HMAC existe em server_settings (instalação)");
  check(chaveHex && !JSON.stringify(pacote).includes(chaveHex),
    "pacote exportado NÃO contém a chave de assinatura");
  check(!JSON.stringify(pacote.estado).includes("server_settings") && !JSON.stringify(pacote.estado).includes("serverSettings"),
    "pacote não exporta a tabela de credenciais");
  const comSigNoBanco = comDb(banco, (db) =>
    db.prepare("select count(*) n from characters where campaign_id=? and data like '%\"sig\"%'").get(campId).n);
  check(comSigNoBanco === 0, `assinaturas sig não persistem em characters.data (${comSigNoBanco} linhas)`);

  // sanity do id criado (evita falso positivo por personagem errado)
  check(!!idAncora, "personagem âncora-zero inserido no cenário");
} finally {
  if (proc) encerrarServidor(proc);
  limparDir(dir);
}

const passaram = ok;
console.log(`\n${passaram}/${passaram + falhas} verificações OK`);
if (falhas) process.exit(1);
