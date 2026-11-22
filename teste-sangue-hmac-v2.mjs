// Issue #186/C3 — roundtrip REAL do HMAC v2: exportarPacote →
// POST /campaigns/importar (modo substituir) → estado persistido.
// Banco descartável; nenhum dado de produção é tocado.
import { randomUUID } from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb, req, criarCenario, abrirDb,
} from "./teste-base.mjs";

let ok = 0, falhas = 0;
const check = (cond, msg) => { if (cond) { ok++; } else { falhas++; console.error("FALHA:", msg); } };

const dir = dirTeste("sangue-v2");
const banco = `${dir}/teste.db`;
const arquivos = `${dir}/arquivos`;
const backups = `${dir}/backups`;
let proc = null, base = null;

const AGORA = "2025-06-01T12:00:00.000Z";
const XP_50 = {
  saldo: 50,
  historico: [{
    em: AGORA, tipo: "concessao", quantidade: 50, motivo: "seed",
    autorId: null, autorNome: null, saldoResultante: 50,
  }],
};
const SANGUE_3 = { saldo: 3, historico: [{ em: AGORA, tipo: "ganho", quantidade: 3 }] };

const dadosPersonagem = (pid) =>
  comDb(banco, (db) => JSON.parse(db.prepare("select data from characters where id=?").get(pid)?.data ?? "{}"));
const pacoteClone = (p) => JSON.parse(JSON.stringify(p));
const personagemDoPacote = (pacote, pid) =>
  pacote.estado.characters.find((r) => r.id === pid);

try {
  await prepararBanco(banco);
  const porta = await portaLivre();
  base = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco, arquivos, backups });
  await esperarSaudavel(base, proc);

  // cenário: ruleset ativo com config.sangue + ficha publicada na campanha
  const c = await criarCenario(base, banco, {
    config: { sangue: { habilitado: true, campoCapacidadeId: "for" } },
  });
  const { campId, cookieMestre, membMestre, jogadores, novoPersonagem } = c;

  const pAmbos = novoPersonagem(membMestre, "Ambos Ledgers", { __xp: XP_50, __sangue: SANGUE_3 });
  const pSoSangue = novoPersonagem(jogadores.jogador1.membershipId, "So Sangue", {
    __sangue: { ...SANGUE_3, saldo: 7 },
  });
  const pSoXp = novoPersonagem(membMestre, "So XP", { __xp: XP_50 });

  // ---------- exportação: emissão v2 somente com cadeia íntegra ----------
  const exp = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
  check(exp.status === 200, `exportar status ${exp.status}`);
  const pacote = exp.json;
  const dAmbos = personagemDoPacote(pacote, pAmbos)?.data ?? {};
  const dSoSangue = personagemDoPacote(pacote, pSoSangue)?.data ?? {};
  const dSoXp = personagemDoPacote(pacote, pSoXp)?.data ?? {};

  check(typeof dAmbos.__sangue_sig === "string" && dAmbos.__sangue_sig.startsWith("v2."), "p1: __sangue_sig v2 emitida");
  check(dAmbos.__xp && !("sig" in dAmbos.__xp), "p1: __xp.sig residual removido na exportação v2");
  check(typeof dSoSangue.__sangue_sig === "string" && dSoSangue.__sangue_sig.startsWith("v2."), "p2 (sem __xp): v2 emitida");
  check(typeof dSoXp.__xp?.sig === "string" && dSoXp.__xp.sig.startsWith("v1."), "p3: XP sem Sangue segue v1");
  check(!dSoXp.__sangue_sig, "p3: sem __sangue_sig");

  const importar = async (pac) => req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pac, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });

  // ---------- roundtrip legítimo ----------
  const impOk = await importar(pacote);
  check(impOk.status === 200, `importar legítimo status ${impOk.status}: ${JSON.stringify(impOk.json)?.slice(0, 300)}`);
  check(impOk.json?.saneamento?.totais?.sanguesAutenticados === 2, "relatório: 2 sangues autenticados");

  const r1 = dadosPersonagem(pAmbos);
  check(r1.__sangue?.saldo === 3, "p1: __sangue preservado");
  check(r1.__xp?.saldo === 50 && r1.__xp.historico?.length === 1, "p1: __xp preservado (saldo+histórico)");
  check(!("__sangue_sig" in r1), "p1: __sangue_sig NÃO persistida");
  check(!r1.__xp || !("sig" in r1.__xp), "p1: __xp.sig NÃO persistida");

  const r2 = dadosPersonagem(pSoSangue);
  check(r2.__sangue?.saldo === 7, "p2: __sangue sem __xp preservado");
  check(!r2.__xp, "p2: __xp permanece ausente");

  const r3 = dadosPersonagem(pSoXp);
  check(r3.__xp?.saldo === 50 && r3.__xp.historico?.length === 1, "p3: XP v1 preservado");
  check(!r3.__xp || !("sig" in r3.__xp), "p3: __xp.sig removida antes de persistir");

  // ---------- campanha de origem: vínculos cruzados ----------
  // Cada coleção precisa continuar vinculada à campanha do envelope.
  // A rota deve rejeitar antes de snapshot/restauração e preservar os dados.
  const pacRuleSetCampanha = pacoteClone(pacote);
  const ruleSetCampanha = pacRuleSetCampanha.estado.ruleSets.find((r) => r.isActive);
  check(!!ruleSetCampanha, "fixture: ruleset ativo presente para testar vínculo de campanha");
  if (ruleSetCampanha) {
    ruleSetCampanha.campaignId = randomUUID();
    const impRuleSetCampanha = await importar(pacRuleSetCampanha);
    check(impRuleSetCampanha.status === 400, `ruleset de outra campanha rejeitado: status ${impRuleSetCampanha.status}`);
    const preservado = dadosPersonagem(pAmbos);
    check(preservado.__sangue?.saldo === 3 && preservado.__xp?.saldo === 50,
      "ruleset incoerente: campanha permanece intacta");
  }

  const pacTemplateCampanha = pacoteClone(pacote);
  const templateCampanha = pacTemplateCampanha.estado.sheetTemplates.find((t) => t.id === "tpl-" + "nao-usado");
  const templateReal = pacTemplateCampanha.estado.sheetTemplates[0];
  check(!!templateReal, "fixture: template presente para testar vínculo de campanha");
  if (templateReal) {
    templateReal.campaignId = randomUUID();
    const impTemplateCampanha = await importar(pacTemplateCampanha);
    check(impTemplateCampanha.status === 400, `template de outra campanha rejeitado: status ${impTemplateCampanha.status}`);
    const preservado = dadosPersonagem(pAmbos);
    check(preservado.__sangue?.saldo === 3 && preservado.__xp?.saldo === 50,
      "template incoerente: campanha permanece intacta");
  }

  // ---------- adulteração: só Sangue ----------
  const pacSangue = pacoteClone(pacote);
  personagemDoPacote(pacSangue, pAmbos).data.__sangue.saldo = 99;
  const imp1 = await importar(pacSangue);
  check(imp1.status === 200, `importar sangue adulterado status ${imp1.status}`);
  check((imp1.json?.saneamento?.totais?.sanguesInvalidos ?? 0) >= 1, "relatório: sangue inválido contabilizado");
  const a1 = dadosPersonagem(pAmbos);
  check(!a1.__sangue, "p1 adulterada: __sangue rejeitado");
  check(a1.__xp?.saldo === 0 && a1.__xp.historico?.length === 0, "p1 adulterada: XP rejeitado conjuntamente (sem fallback v1)");
  const b1 = dadosPersonagem(pSoSangue);
  check(b1.__sangue?.saldo === 7, "p2 intacta: rejeição é por personagem");

  // ---------- adulteração: estrutura publicada ----------
  const pacEstrutura = pacoteClone(pacote);
  const verPac = pacEstrutura.estado.sheetVersions.find((v) => v.id === personagemDoPacote(pacEstrutura, pAmbos).templateVersionId);
  verPac.structure = { secoes: [] };
  const imp2 = await importar(pacEstrutura);
  check(imp2.status === 200, `importar estrutura adulterada status ${imp2.status}`);
  check(!dadosPersonagem(pAmbos).__sangue, "estrutura adulterada: __sangue rejeitado");
  check(dadosPersonagem(pAmbos).__xp?.saldo === 0, "estrutura adulterada: XP rejeitado conjuntamente");

  // ---------- adulteração: config.sangue ----------
  const pacConfig = pacoteClone(pacote);
  const rsPac = pacConfig.estado.ruleSets.find((r) => r.isActive);
  rsPac.config = { ...(rsPac.config ?? {}), sangue: { habilitado: false } };
  const imp3 = await importar(pacConfig);
  check(imp3.status === 200, `importar config.sangue adulterada status ${imp3.status}`);
  check(!dadosPersonagem(pAmbos).__sangue, "config.sangue adulterada: __sangue rejeitado");

  // ---------- adulteração: templateVersionId (versão real divergente) ----------
  // FK rejeitaria um id inexistente com 500 — o vetor real é apontar
  // para OUTRA versão publicada da campanha (estrutura diferente →
  // fichaFp divergente → rejeição conjunta pelo verificador).
  const tvOriginal = personagemDoPacote(pacote, pAmbos).templateVersionId;
  const tvNovo = randomUUID();
  const dbw = abrirDb(banco);
  try {
    const ver = dbw.prepare("select * from sheet_versions where id=?").get(tvOriginal);
    const estruturaDiv = JSON.parse(ver.structure);
    estruturaDiv.secoes[0].campos.push({ id: "hackeado", label: "X", tipo: "inteiro" });
    dbw.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,?,?,?,?)")
      .run(tvNovo, ver.template_id, 99, JSON.stringify(estruturaDiv), Date.now(), Date.now());
  } finally { dbw.close(); }
  const pacTv = pacoteClone(pacote);
  personagemDoPacote(pacTv, pAmbos).templateVersionId = tvNovo;
  // inclui a versão divergente no pacote para que a cadeia resolva —
  // a rejeição então vem do fichaFp divergente, não da ausência do elo
  const verNovo = comDb(banco, (db) => db.prepare("select * from sheet_versions where id=?").get(tvNovo));
  void verNovo;
  pacTv.estado.sheetVersions.push({
    id: tvNovo, templateId: verNovo.template_id, version: 99,
    structure: JSON.parse(verNovo.structure), publishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
  const imp4 = await importar(pacTv);
  check(imp4.status === 200, `importar templateVersionId adulterado status ${imp4.status}`);
  check(!dadosPersonagem(pAmbos).__sangue, "templateVersionId adulterado: __sangue rejeitado");
  check(dadosPersonagem(pAmbos).__xp?.saldo === 0, "templateVersionId adulterado: XP rejeitado conjuntamente");

  // ---------- v1 com Sangue: descarta Sangue, preserva XP, reporta ----------
  const pacV1 = pacoteClone(pacote);
  const dV1 = personagemDoPacote(pacV1, pSoXp).data;
  dV1.__sangue = { ...SANGUE_3, saldo: 11 }; // injeta SEM __sangue_sig — __xp.sig v1 segue válida
  const imp5 = await importar(pacV1);
  check(imp5.status === 200, `importar v1+sangue status ${imp5.status}`);
  check((imp5.json?.saneamento?.totais?.sanguesRemovidos ?? 0) >= 1, "relatório: sangue descartado contabilizado");
  const v1 = dadosPersonagem(pSoXp);
  check(v1.__xp?.saldo === 50 && v1.__xp.historico?.length === 1, "v1+sangue: XP preservado");
  check(!v1.__sangue, "v1+sangue: __sangue descartado");

  // ---------- pacote v2 malformado / chave divergente (simula origem externa) ----------
  const pacKey = pacoteClone(pacote);
  personagemDoPacote(pacKey, pAmbos).data.__sangue_sig = "v2." + "00".repeat(32);
  const imp6 = await importar(pacKey);
  check(imp6.status === 200, `importar sig forjada status ${imp6.status}`);
  check(!dadosPersonagem(pAmbos).__sangue, "sig forjada: __sangue rejeitado");
  check(dadosPersonagem(pAmbos).__xp?.saldo === 0, "sig forjada: XP rejeitado conjuntamente");
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(dir);
}

console.log(`\n${ok} ok, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
