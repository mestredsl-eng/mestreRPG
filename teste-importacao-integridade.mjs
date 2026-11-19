#!/usr/bin/env node
// Issue #162 — integridade do ledger XP e selo na importação/restauração.
//
// Separa dois níveis de confiança na entrada de estado:
//  - snapshot interno (restauração de ponto de recuperação): __xp e
//    __pontos passam intactos;
//  - pacote JSON externo (importação modo "nova" e "substituir"):
//    __xp (saldo/histórico/financiado) e __pontos (bônus/histórico/selo)
//    são descartados por inteiro e reportados ao mestre — mesmo quando o
//    pacote parece um export legítimo, pois a proveniência não é
//    verificável.
//
// As asserções leem o BANCO (characters.data persistido), não apenas a
// resposta HTTP.
import { req, dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel, encerrarServidor, limparDir, criarCenario, abrirDb, comDb } from "./teste-base.mjs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const DIR = dirTeste("import-integridade");
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

const dataDe = (charId) => {
  const row = comDb(BANCO, (db) => db.prepare("select data from characters where id=?").get(charId));
  return row ? JSON.parse(row.data) : null;
};

function semear(charId, patch, { remover = [] } = {}) {
  const w = abrirDb(BANCO);
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    const data = JSON.parse(row.data || "{}");
    Object.assign(data, patch);
    for (const k of remover) delete data[k];
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(data), charId);
  } finally { w.close(); }
}

// Coleções com campaignId (validade de coerência do pacote).
const COLECOES_CID = ["memberships", "invitations", "sheetTemplates", "characters", "ruleSets", "itemTemplates", "vehicles", "financialAccounts", "moneyTransactions", "sessions", "chatMessages", "rolls", "tests", "notes", "files", "folders"];
// FKs internas do estado exportado (campo camelCase → coleção de origem).
const FKS = {
  sheetVersions: { templateId: "sheetTemplates" },
  sheetTemplates: { currentVersionId: "sheetVersions" },
  characters: { membershipId: "memberships", templateVersionId: "sheetVersions" },
  characterFields: { characterId: "characters" },
  ruleDefinitions: { ruleSetId: "ruleSets" },
  inventoryEntries: { characterId: "characters" },
  equipmentEntries: { characterId: "characters" },
  vehicles: { characterId: "characters" },
  financialAccounts: { characterId: "characters" },
  moneyTransactions: { characterId: "characters", counterpartyCharacterId: "characters", accountId: "financialAccounts" },
  turns: { sessionId: "sessions" },
  chatMessages: { sessionId: "sessions", characterId: "characters" },
  rolls: { sessionId: "sessions", characterId: "characters" },
  tests: { sessionId: "sessions", characterId: "characters", rollId: "rolls" },
  notes: { characterId: "characters" },
  files: { folderId: "folders" },
  folders: { parentId: "folders" },
  noteAttachments: { noteId: "notes", fileId: "files" },
};
const TODAS_COLECOES = [...COLECOES_CID, "sheetVersions", "characterFields", "ruleDefinitions", "turns", "noteAttachments"];


/**
 * Converte um export da PRÓPRIA instalação em pacote "estrangeiro":
 * regenera todos os ids e remapeia as FKs internas — equivalente ao que
 * uma exportação de outra instalação já traria (ids nunca colidem).
 */
function pacoteEstrangeiro(pacote, novoCid) {
  const p = JSON.parse(JSON.stringify(pacote));
  p.campanhaId = novoCid;
  const mapas = {};
  for (const k of TODAS_COLECOES) {
    mapas[k] = new Map();
    for (const row of p.estado[k] ?? []) {
      if (typeof row.id === "string") mapas[k].set(row.id, crypto.randomUUID());
    }
  }
  for (const k of TODAS_COLECOES) {
    for (const row of p.estado[k] ?? []) {
      if (typeof row.campaignId === "string") row.campaignId = novoCid;
      if (mapas[k].has(row.id)) row.id = mapas[k].get(row.id);
      for (const [campo, origem] of Object.entries(FKS[k] ?? {})) {
        const antigo = row[campo];
        if (typeof antigo === "string" && mapas[origem]?.has(antigo)) row[campo] = mapas[origem].get(antigo);
      }
    }
  }
  return p;
}

const XP_LEGITIMO = {
  saldo: 42,
  historico: [
    { em: "2026-01-01T00:00:00.000Z", tipo: "concessao", quantidade: 50, motivo: "sessão", autorId: "m", autorNome: "Mestre", saldoResultante: 50 },
    { em: "2026-01-02T00:00:00.000Z", tipo: "compra", quantidade: -8, motivo: null, autorId: "m", autorNome: "Mestre", saldoResultante: 42, compra: { kind: "atributo", key: "for", nome: "FOR", campoId: "for", nivelAnterior: 1, nivelNovo: 2, custoXp: 8 } },
  ],
  financiado: { for: [0] },
};
const PONTOS_LEGITIMOS = {
  bonus: 3,
  historico: [{ em: "2026-01-01T00:00:00.000Z", quantidade: 3, motivo: "bônus", autorId: "m", autorNome: "Mestre" }],
  selo: { em: "2026-01-01T00:00:00.000Z", autorId: "m", autorNome: "Mestre" },
};
const XP_FORJADO = {
  saldo: 99999,
  historico: [{ em: "2030-01-01T00:00:00.000Z", tipo: "concessao", quantidade: 99999, motivo: "forjado", autorId: "atacante", autorNome: "Forjador", saldoResultante: 99999 }],
  financiado: { for: [0, 1, 2, 3, 4] },
};
const PONTOS_FORJADOS = {
  bonus: 999,
  historico: [{ em: "2030-01-01T00:00:00.000Z", quantidade: 999, motivo: "forjado", autorId: "atacante", autorNome: "Forjador" }],
  selo: { em: "2030-01-01T00:00:00.000Z", autorId: "atacante", autorNome: "Forjador" },
};

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Integridade XP",
    jogadores: { jogador1: "jog_imp" },
    config: { pontos: { habilitado: true, pontosIniciais: 5, pools: [], custos: {} } },
  });
  const CID = c.campId, M = c.cookieMestre;
  const charId = c.personagemMestre; // personagem do mestre, sem metadados ainda

  // ---------- 1) Semeia ledger legítimo ----------
  sec("Semeadura de ledger legítimo");
  semear(charId, { __xp: XP_LEGITIMO, __pontos: PONTOS_LEGITIMOS });
  t("1. ledger semeado", dataDe(charId).__xp?.saldo === 42 && dataDe(charId).__pontos?.selo != null);
  const dadosOriginais = dataDe(charId);

  // ---------- 2) Snapshot interno preserva tudo ----------
  sec("Restauração de snapshot interno (confiável)");
  const snap = await req(BASE, "POST", `/campaigns/${CID}/snapshots`, { cookie: M, body: { description: "antes da perda" } });
  t("2. snapshot manual criado", snap.status === 201 && !!snap.json?.id, JSON.stringify(snap.json));
  const snapId = snap.json?.id;

  // simula perda: remove os metadados direto no banco
  semear(charId, {}, { remover: ["__xp", "__pontos"] });
  t("3. metadados removidos antes do restore", dataDe(charId).__xp === undefined);

  const rest = await req(BASE, "POST", `/campaigns/${CID}/snapshots/${snapId}/restaurar`, { cookie: M, body: { confirmacao: "RESTAURAR" } });
  t("4. restore interno ok", rest.status === 200 && rest.json?.ok === true, JSON.stringify(rest.json).slice(0, 200));
  const descSnap = rest.json?.dadosProtegidosDescartados;
  t("5. restore interno não descarta nada", descSnap && descSnap.personagensAfetados === 0 && descSnap.xpSaldoDescartado === 0, JSON.stringify(descSnap));
  const dadosRest = dataDe(charId);
  t("6. __xp preservado exatamente", dadosRest.__xp?.saldo === 42 && dadosRest.__xp?.historico?.length === 2 && JSON.stringify(dadosRest.__xp?.financiado) === JSON.stringify({ for: [0] }), JSON.stringify(dadosRest.__xp));
  t("7. __pontos preservado exatamente", dadosRest.__pontos?.bonus === 3 && dadosRest.__pontos?.historico?.length === 1 && !!dadosRest.__pontos?.selo, JSON.stringify(dadosRest.__pontos));
  t("8. demais dados da ficha intactos", dadosRest.for === dadosOriginais.for && dadosRest.__pontos?.selo?.autorId === "m");

  // ---------- 3) Importação externa forjada (modo nova) ----------
  sec("Importação externa — pacote forjado (modo nova)");
  const exp = await req(BASE, "GET", `/campaigns/${CID}/exportar`, { cookie: M });
  t("9. exportação ok", exp.status === 200 && exp.json?.versao === 1);
  const pacote = exp.json;

  // pacote "estrangeiro": ids novos em tudo + forja nos metadados do charId
  const pacoteForjado = pacoteEstrangeiro(pacote, crypto.randomUUID());
  const NOVO1 = pacoteForjado.campanhaId;
  const charForjado = pacoteForjado.estado.characters.find((r) => r.name === "Mestre Herói");
  charForjado.data.__xp = XP_FORJADO;
  charForjado.data.__pontos = PONTOS_FORJADOS;
  const novoCharId = charForjado.id;

  const imp1 = await req(BASE, "POST", "/campaigns/importar", { cookie: M, body: { pacote: pacoteForjado, modo: "nova" } });
  t("10. import forjado modo nova → 201", imp1.status === 201, `status=${imp1.status} ${JSON.stringify(imp1.json).slice(0, 250)}`);
  const d1 = imp1.json?.dadosProtegidosDescartados;
  t("11. relatório informa descartes", d1?.personagensAfetados === 1 && d1?.xpSaldoDescartado === 99999 && d1?.xpHistoricoDescartado === 1 && d1?.xpFinanciadoDescartado === 1 && d1?.pontosBonusDescartado === 999 && d1?.pontosHistoricoDescartado === 1 && d1?.selosDescartados === 1, JSON.stringify(d1));

  const rowImp1 = comDb(BANCO, (db) => db.prepare("select campaign_id, data from characters where id=?").get(novoCharId));
  t("12. personagem importado pertence à nova campanha", rowImp1?.campaign_id === NOVO1);
  const dataImp1 = JSON.parse(rowImp1.data);
  t("13. __xp forjado NÃO persistiu", dataImp1.__xp === undefined, JSON.stringify(dataImp1.__xp));
  t("14. __pontos forjado NÃO persistiu", dataImp1.__pontos === undefined, JSON.stringify(dataImp1.__pontos));
  t("15. dados funcionais preservados", dataImp1.for === dadosOriginais.for, JSON.stringify(dataImp1).slice(0, 120));

  // consequência: ficha importada não tem selo → XP negado
  const fichaImp = await req(BASE, "GET", `/characters/${novoCharId}`, { cookie: M });
  t("16. ficha importada sem selo", fichaImp.json?.ficha?.pontosBonus?.selado === false, JSON.stringify(fichaImp.json?.ficha?.pontosBonus));
  const xpNegado = await req(BASE, "POST", `/characters/${novoCharId}/xp`, { cookie: M, body: { acao: "conceder", quantidade: 10, motivo: "tentativa" } });
  t("17. concessão de XP negada sem selo real", xpNegado.status === 403 && xpNegado.json?.codigo === "ficha_nao_selada", `status=${xpNegado.status} ${JSON.stringify(xpNegado.json).slice(0, 160)}`);

  // dados funcionais da campanha importada preservados
  const nMembros = comDb(BANCO, (db) => db.prepare("select count(*) c from memberships where campaign_id=?").get(NOVO1).c);
  const nChars = comDb(BANCO, (db) => db.prepare("select count(*) c from characters where campaign_id=?").get(NOVO1).c);
  t("18. demais entidades importadas", nMembros === pacote.estado.memberships.length && nChars === pacote.estado.characters.length, `membros=${nMembros} chars=${nChars}`);

  // ---------- 4) Export "íntegro" também é externo ----------
  sec("Importação externa — pacote íntegro (modo nova)");
  // Segunda campanha com personagem próprio (ids já únicos — criados
  // depois) e ledger legítimo: export íntegro, sem adulteração.
  const camp2 = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "Campanha Íntegra" } });
  const CID2 = camp2.json?.campanha?.id;
  t("19. segunda campanha criada", !!CID2);
  const char2 = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    const memb2 = w.prepare("select id from memberships where campaign_id=? and role='mestre'").get(CID2).id;
    w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(char2, CID2, memb2, null, "Herói Íntegro", JSON.stringify({ for: 7, __xp: XP_LEGITIMO, __pontos: PONTOS_LEGITIMOS }), "{}", "aprovada", 0, Date.now(), Date.now());
    w.close();
  }
  const exp2 = await req(BASE, "GET", `/campaigns/${CID2}/exportar`, { cookie: M });
  t("20. exportação íntegra ok", exp2.status === 200);
  const NOVO2 = crypto.randomUUID();
  // pacote "estrangeiro" (ids novos + FKs remapeadas): ids originais de
  // CID2 colidiriam em PK no modo "nova"
  const pkgIntegro = pacoteEstrangeiro(exp2.json, NOVO2);
  const charImp2 = pkgIntegro.estado.characters.find((r) => r.name === "Herói Íntegro");
  const imp2 = await req(BASE, "POST", "/campaigns/importar", { cookie: M, body: { pacote: pkgIntegro, modo: "nova" } });
  t("21. import íntegro modo nova → 201", imp2.status === 201, `status=${imp2.status} ${JSON.stringify(imp2.json).slice(0, 200)}`);
  const d2 = imp2.json?.dadosProtegidosDescartados;
  t("22. pacote íntegro TAMBÉM tem metadados descartados", d2?.personagensAfetados === 1 && d2?.xpSaldoDescartado === 42 && d2?.selosDescartados === 1, JSON.stringify(d2));
  const dataImp2 = dataDe(charImp2.id);
  t("23. __xp legítimo não persistiu na importação externa", dataImp2.__xp === undefined);
  t("24. __pontos legítimo não persistiu na importação externa", dataImp2.__pontos === undefined);
  t("25. dados funcionais do íntegro preservados", dataImp2.for === 7);

  // ---------- 5) Substituição com pacote forjado ----------
  sec("Substituição de campanha — pacote forjado");
  // pacote forjado nos ids ORIGINAIS de CID (campanhaId=CID, rows= CID)
  const pacoteSub = JSON.parse(JSON.stringify(pacote));
  const charSub = pacoteSub.estado.characters.find((r) => r.id === charId);
  charSub.data.__xp = XP_FORJADO;
  charSub.data.__pontos = PONTOS_FORJADOS;
  const snapsAntes = comDb(BANCO, (db) => db.prepare("select count(*) c from snapshots where campaign_id=? and kind='pre_restauracao'").get(CID).c);
  const impSub = await req(BASE, "POST", "/campaigns/importar", { cookie: M, body: { pacote: pacoteSub, modo: "substituir", campaignId: CID, confirmacao: "SUBSTITUIR" } });
  t("26. substituir forjado → 200", impSub.status === 200 && impSub.json?.ok === true, `status=${impSub.status} ${JSON.stringify(impSub.json).slice(0, 250)}`);
  const dSub = impSub.json?.dadosProtegidosDescartados;
  t("27. substituir reporta descartes", dSub?.personagensAfetados === 1 && dSub?.xpSaldoDescartado === 99999 && dSub?.selosDescartados === 1, JSON.stringify(dSub));
  const snapsDepois = comDb(BANCO, (db) => db.prepare("select count(*) c from snapshots where campaign_id=? and kind='pre_restauracao'").get(CID).c);
  t("28. snapshot pré-substituição preservado", snapsDepois === snapsAntes + 1, `${snapsAntes}→${snapsDepois}`);
  const dataSub = dataDe(charId);
  t("29. __xp forjado não persistiu no substituir", dataSub.__xp === undefined);
  t("30. __pontos forjado não persistiu no substituir", dataSub.__pontos === undefined);
  t("31. dados funcionais preservados no substituir", dataSub.for === dadosOriginais.for);

  // ---------- 6) Snapshot DEPOIS da substituição é interno de novo ----------
  sec("Pós-substituição: novo snapshot interno segue confiável");
  const snap2 = await req(BASE, "POST", `/campaigns/${CID}/snapshots`, { cookie: M, body: { description: "pos-substituicao" } });
  const rest2 = await req(BASE, "POST", `/campaigns/${CID}/snapshots/${snap2.json?.id}/restaurar`, { cookie: M, body: { confirmacao: "RESTAURAR" } });
  t("32. restore pós-substituição ok", rest2.status === 200, `status=${rest2.status}`);
  t("33. nada a descartar no restore interno", rest2.json?.dadosProtegidosDescartados?.personagensAfetados === 0);
} catch (e) {
  fail++; console.log("EXCEÇÃO " + (e?.stack ?? e));
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
