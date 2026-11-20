#!/usr/bin/env node
// Testes — estado externo durável por instalação (Issue #155, contrato).
// Cobre: identidade SHA-256, dir canônico, escrita atômica, leitura
// fail-closed, quarentena, protocolo incompatível, identidade divergente,
// override MESTRE_STATE_DIR (único override de estado), consentimento separado de journal,
// e avaliação de boot (ambiguidade fail-closed).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  caminhoCanonico, instalacaoId, dirEstado, diretorioBaseEstado, gravarJsonAtomico, lerEstado,
  gravarEstado, lerJournal, lerConsentimento, gravarConsentimento,
  gravarReciboInstalacao, lerReciboInstalacao, avaliarBoot, PROTOCOLO_VERSAO,
  diagnosticarBootstrap, consumirAutorizacaoBootstrap, estadoInstalacaoConhecido,
} = await import("./scripts/estado-externo.mjs");
const bootLock = await import("./scripts/boot-lock.mjs");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("ok", n); }
  else { fail++; console.log("FALHOU", n, extra); }
};

const TMP = mkdtempSync(join(tmpdir(), "estado-externo-"));
const repo = join(TMP, "repo com espaco");
mkdirSync(join(repo, "banco"), { recursive: true });
mkdirSync(join(repo, "configuracao"), { recursive: true });
mkdirSync(join(repo, "scripts"), { recursive: true });
const STATE = join(TMP, "state-override");
const env = { MESTRE_STATE_DIR: STATE };

// ---------- identidade ----------
t("instalacaoId é sha256 hex de 64 chars", /^[0-9a-f]{64}$/.test(instalacaoId(repo)));
t("instalacaoId estável para mesmo caminho", instalacaoId(repo) === instalacaoId(repo));
t("instalacaoId diverge para caminho diferente", instalacaoId(repo) !== instalacaoId(join(TMP, "outro")));
t("dirEstado honra MESTRE_STATE_DIR/<id>", dirEstado(repo, env).startsWith(STATE));
t("dirEstado isola por instalação", dirEstado(repo, env) !== dirEstado(join(TMP, "outro"), env));
t("dirEstado NÃO cria o diretório (verificação sem efeito colateral)",
  !existsSync(dirEstado(repo, env)));
t("diretorioBaseEstado == boot-lock (mesma convenção)",
  diretorioBaseEstado(process.env) === bootLock.diretorioBaseEstado());
t("instalacaoId == boot-lock.instalacaoId", instalacaoId(repo) === bootLock.instalacaoId(repo));
t("caminhoCanonico == boot-lock.caminhoCanonicoRepo", caminhoCanonico(repo) === bootLock.caminhoCanonicoRepo(repo));
t("dirEstado == boot-lock.diretorioEstado (paridade final)",
  dirEstado(repo, process.env) === bootLock.diretorioEstado(repo));
t("MESTRE_HOME NÃO desvia o state dir (paridade boot-lock)",
  dirEstado(repo, { MESTRE_HOME: join(TMP, "mh") }) === dirEstado(repo, {}));

// ---------- escrita atômica + leitura ----------
const arq = join(dirEstado(repo, env), "journal.json");
gravarJsonAtomico(arq, { protocoloVersao: PROTOCOLO_VERSAO, a: 1 });
t("leitura ok após escrita", lerEstado(arq).status === "ok" && lerEstado(arq).dados.a === 1);
t("sem tmp órfão após rename", !existsSync(arq + ".tmp"));

// corrompido → quarentena + status corrompido
writeFileSync(arq, "{ nao-json !!!");
const rCorrompido = lerEstado(arq);
t("json corrompido → status corrompido", rCorrompido.status === "corrompido");
t("corrompido vai para quarentena", !!rCorrompido.quarentena && existsSync(rCorrompido.quarentena));
t("corrompido NÃO é ausência", rCorrompido.status !== "ausente");

// protocolo incompatível
gravarJsonAtomico(arq, { protocoloVersao: 999, instalacaoId: instalacaoId(repo) });
t("protocolo incompatível → incompativel", lerEstado(arq).status === "incompativel");

// identidade divergente
gravarJsonAtomico(arq, { protocoloVersao: PROTOCOLO_VERSAO, instalacaoId: "deadbeef" });
t("instalacaoId divergente → identidade-divergente",
  lerEstado(arq, { instalacaoId: instalacaoId(repo) }).status === "identidade-divergente");
rmSync(arq, { force: true });

// gravarEstado injeta identidade
gravarEstado(repo, "atualizacao-ultima.json", { fase: "pull-planejado", shaAnterior: "x" }, env);
const j = lerJournal(repo, "atualizacao-ultima.json", env);
t("journal gravado com identidade", j.status === "ok" && j.dados.instalacaoId === instalacaoId(repo));
t("journal carrega fase", j.dados.fase === "pull-planejado");

// ---------- consentimento (separado de journal) ----------
t("consentimento ausente → ausente", lerConsentimento(repo).status === "ausente");
gravarConsentimento(repo, "aceito");
t("consentimento aceito", lerConsentimento(repo).status === "aceito");
gravarConsentimento(repo, "recusado");
t("consentimento recusado", lerConsentimento(repo).status === "recusado");
writeFileSync(join(repo, "configuracao", "auto-update.json"), "lixo{");
t("consentimento inválido → invalido", lerConsentimento(repo).status === "invalido");
// divergente: consentimento de OUTRA instalação
gravarConsentimento(repo, "aceito", { instalacaoId: "outra-inst" });
t("consentimento divergente → divergente", lerConsentimento(repo).status === "divergente");
rmSync(join(repo, "configuracao", "auto-update.json"), { force: true });

// ---------- recibo permanente × autorização de bootstrap ----------
// Recibo permanente prova "instalação CONCLUÍDA" — NUNCA autoriza
// banco ausente/vazio como primeira instalação. Autorização de primeiro
// bootstrap é de uso único e seu produtor confiável ainda não existe:
// nenhum teste fabrica autorização válida (proibido simular produtor).
const repoNovo = join(TMP, "repo-novo");
mkdirSync(join(repoNovo, "scripts"), { recursive: true });
const envNovo = { MESTRE_STATE_DIR: join(TMP, "state-novo") };
const dirNovo = () => dirEstado(repoNovo, envNovo);
// sem nada → diagnóstico "desconhecido"; consumo negado
const cons0 = consumirAutorizacaoBootstrap(repoNovo, envNovo);
t("sem estado → diagnóstico desconhecido", diagnosticarBootstrap(repoNovo, envNovo) === "desconhecido");
t("sem autorização → não autorizado", cons0.autorizado === false);
t("motivo = diagnóstico", cons0.motivo === "desconhecido", cons0.motivo);
// recibo corrompido → diagnóstico reflete; consumo negado
gravarJsonAtomico(join(dirNovo(), "instalacao-recibo.json"), { lixo: true });
writeFileSync(join(dirNovo(), "instalacao-recibo.json"), "{ quebrado");
t("recibo corrompido → diagnóstico reflete", /recibo-corrompido/.test(diagnosticarBootstrap(repoNovo, envNovo)));
t("recibo corrompido → não autoriza", consumirAutorizacaoBootstrap(repoNovo, envNovo).autorizado === false);
rmSync(join(dirNovo(), "instalacao-recibo.json"), { force: true });
// recibo de OUTRA instalação → divergente, não autoriza
gravarJsonAtomico(join(dirNovo(), "instalacao-recibo.json"), {
  protocoloVersao: PROTOCOLO_VERSAO, instalacaoId: "deadbeef", repoCanon: "x", tipo: "instalacao-concluida",
});
t("recibo divergente → diagnóstico reflete", /recibo-divergente/.test(diagnosticarBootstrap(repoNovo, envNovo)));
rmSync(join(dirNovo(), "instalacao-recibo.json"), { force: true });
// recibo VÁLIDO (instalação concluída) → conhecido p/ boot, mas
// NUNCA autoriza primeiro bootstrap (banco ausente = banco perdido)
gravarReciboInstalacao(repoNovo, envNovo);
t("recibo válido → instalação concluída", diagnosticarBootstrap(repoNovo, envNovo) === "instalacao-concluida");
t("recibo válido → estado conhecido p/ boot", estadoInstalacaoConhecido(repoNovo, envNovo).conhecido === true);
t("lerReciboInstalacao ok", lerReciboInstalacao(repoNovo, envNovo).status === "ok");
const consRecibo = consumirAutorizacaoBootstrap(repoNovo, envNovo);
t("recibo permanente NÃO autoriza bootstrap", consRecibo.autorizado === false && consRecibo.motivo === "instalacao-concluida", JSON.stringify(consRecibo));
// protocolo incompatível no recibo → não é instalação concluída
gravarJsonAtomico(join(dirNovo(), "instalacao-recibo.json"), {
  protocoloVersao: 999, instalacaoId: instalacaoId(repoNovo), repoCanon: caminhoCanonico(repoNovo), tipo: "instalacao-concluida",
});
t("recibo protocolo incompatível → diagnóstico reflete", /recibo-incompativel/.test(diagnosticarBootstrap(repoNovo, envNovo)));
rmSync(join(dirNovo(), "instalacao-recibo.json"), { force: true });
// autorização CORROMPIDA: consumo durável acontece (rename) mas não
// autoriza; o arquivo some do nome original → segunda tentativa cai em
// "bootstrap-interrompido" (evidência de consumo preservada)
const arqAuth = join(dirNovo(), "bootstrap-autorizacao.json");
gravarJsonAtomico(arqAuth, { lixo: true }); // inválido de propósito
const consLixo = consumirAutorizacaoBootstrap(repoNovo, envNovo);
t("autorização inválida → não autoriza", consLixo.autorizado === false && consLixo.motivo === "autorizacao-invalida", consLixo.motivo);
t("autorização inválida foi consumida (rename)", !existsSync(arqAuth) && !!consLixo.consumido && existsSync(consLixo.consumido));
t("após consumo inválido → diagnóstico bootstrap-interrompido",
  diagnosticarBootstrap(repoNovo, envNovo) === "bootstrap-interrompido");
const cons2 = consumirAutorizacaoBootstrap(repoNovo, envNovo);
t("segunda tentativa → não autoriza (uso único)", cons2.autorizado === false && cons2.motivo === "bootstrap-interrompido", cons2.motivo);

// ---------- avaliarBoot ----------
// repo limpo sem manifesto → seguro
const repoBoot = join(TMP, "repo-boot");
mkdirSync(join(repoBoot, "scripts"), { recursive: true });
const envBoot = { MESTRE_STATE_DIR: join(TMP, "state-boot") };
t("boot sem manifesto → seguro", avaliarBoot(repoBoot, envBoot).seguroIniciar === true);

// com manifesto e sem recibo → ambíguo → bloqueia (mesmo com banco)
writeFileSync(join(repoBoot, "scripts", "protocolo-auto-update.json"), "{}");
mkdirSync(join(repoBoot, "banco"), { recursive: true });
writeFileSync(join(repoBoot, "banco", "mestre-rpg.db"), "x");
const amb = avaliarBoot(repoBoot, envBoot);
t("manifesto + banco sem state → estado-ambiguo bloqueia", amb.seguroIniciar === false && amb.motivo === "estado-ambiguo", amb.motivo);

// com recibo válido → não é ambíguo
gravarReciboInstalacao(repoBoot, envBoot);
const comRecibo = avaliarBoot(repoBoot, envBoot);
t("manifesto + recibo → não bloqueia por ambiguidade", comRecibo.motivo !== "estado-ambiguo", comRecibo.motivo);
rmSync(join(dirEstado(repoBoot, envBoot), "instalacao-recibo.json"), { force: true });

// journal corrompido → bloqueia
gravarEstado(repoBoot, "atualizacao-ultima.json", { fase: "pull-planejado" }, envBoot);
writeFileSync(join(dirEstado(repoBoot, envBoot), "atualizacao-ultima.json"), "corrompido{");
const jb = avaliarBoot(repoBoot, envBoot);
t("journal corrompido → bloqueia", jb.seguroIniciar === false && jb.motivo === "journal-corrompido", jb.motivo);
rmSync(join(dirEstado(repoBoot, envBoot), "atualizacao-ultima.json"), { force: true });

// journal com recuperação pendente → bloqueia
gravarEstado(repoBoot, "atualizacao-ultima.json", { fase: "migracao-concluida" }, envBoot);
const rp = avaliarBoot(repoBoot, envBoot);
t("recuperação pendente → bloqueia", rp.seguroIniciar === false && rp.motivo === "recuperacao-pendente", rp.motivo);

// journal concluído → não bloqueia por journal (mas ambiguidade pode bloquear)
gravarEstado(repoBoot, "atualizacao-ultima.json", { fase: "concluido", concluidoEm: new Date().toISOString() }, envBoot);
const cj = avaliarBoot(repoBoot, envBoot);
t("journal concluído não bloqueia por journal", cj.motivo !== "recuperacao-pendente" && cj.motivo !== "journal-corrompido", cj.motivo);

// ---------- T5 — paridade de caminhos com o Boot Lock ----------
// Compara os RESOLVEDORES REAIS dos dois módulos (nenhuma lógica
// reimplementada). boot-lock lê process.env diretamente; estado-externo
// aceita env injetável — mutamos process.env por caso e comparamos.
console.log("\n== T5 paridade estado-externo × boot-lock ==");
{
  const CHAVES = ["MESTRE_STATE_DIR", "MESTRE_HOME", "LOCALAPPDATA", "XDG_STATE_HOME"];
  const salvo = {};
  for (const k of CHAVES) { salvo[k] = process.env[k]; delete process.env[k]; }
  const par = (nome, mutar, esperadoDivergente = false) => {
    for (const k of CHAVES) { if (salvo[k] !== undefined) process.env[k] = salvo[k]; else delete process.env[k]; }
    mutar();
    const eeDir = dirEstado(repo, process.env);
    const blDir = bootLock.diretorioEstado(repo); // usa process.env internamente
    const igual = eeDir === blDir;
    t(`paridade ${nome}: ${igual ? "iguais" : `DIVERGEM ee=${eeDir} bl=${blDir}`}`,
      esperadoDivergente ? !igual : igual);
  };
  par("MESTRE_STATE_DIR definido", () => { process.env.MESTRE_STATE_DIR = join(TMP, "par-state"); });
  par("MESTRE_STATE_DIR vazio", () => { process.env.MESTRE_STATE_DIR = ""; });
  par("MESTRE_STATE_DIR só espaços", () => { process.env.MESTRE_STATE_DIR = "   "; });
  par("MESTRE_STATE_DIR com espaços nas pontas", () => { process.env.MESTRE_STATE_DIR = `  ${join(TMP, "par-sp")}  `; });
  par("LOCALAPPDATA custom (win32)", () => { process.env.LOCALAPPDATA = join(TMP, "local-app"); });
  par("LOCALAPPDATA vazio", () => { process.env.LOCALAPPDATA = ""; });
  par("XDG_STATE_HOME definido em win32 (ignorado pelos dois)", () => { process.env.XDG_STATE_HOME = join(TMP, "xdg"); });
  // MESTRE_HOME é raiz de DADOS, NÃO de estado: desde d822f0e o
  // dirEstado() tem paridade EXATA com boot-lock — MESTRE_HOME não
  // pode desviar o state dir em nenhum ambiente.
  par("MESTRE_HOME definido (não desvia state dir)",
    () => { process.env.MESTRE_HOME = join(TMP, "mhome"); });
  // ramos Linux (XDG_STATE_HOME / ~/.local/state) não são exercitáveis em
  // win32 — process.platform é fixo. Registrado como NOT EXECUTED local;
  // a convenção foi alinhada por inspeção do código (diretorioBaseEstado
  // espelha boot-lock.diretorioBaseEstado).
  t("ramos Linux XDG/fallback — NOT EXECUTED em win32 (verificar em CI Linux)", true);
  for (const k of CHAVES) { if (salvo[k] !== undefined) process.env[k] = salvo[k]; else delete process.env[k]; }
}

// ---------- T1 — ciclo de vida do recibo: falha de bootstrap ----------
{
  // gravarReciboInstalacao com destino impossível → lança, sem efeito
  // parcial: nenhum arquivo de recibo é criado e a prova continua
  // negativa (falha de bootstrap não produz falso sucesso).
  const repoB = join(TMP, "repo-bootstrap");
  mkdirSync(join(repoB, "scripts"), { recursive: true });
  const envB = { MESTRE_STATE_DIR: join(TMP, "state-bloqueado") };
  writeFileSync(envB.MESTRE_STATE_DIR, "não é diretório");
  let lancou = false;
  try { gravarReciboInstalacao(repoB, envB); } catch { lancou = true; }
  t("gravarReciboInstalacao em destino impossível → lança", lancou);
  t("sem recibo parcial após falha", lerReciboInstalacao(repoB, envB).status === "ausente");
  t("estado continua desconhecido após falha", estadoInstalacaoConhecido(repoB, envB).conhecido === false);
  rmSync(envB.MESTRE_STATE_DIR, { force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
