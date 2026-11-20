#!/usr/bin/env node
// Testes — estado externo durável por instalação (Issue #155, contrato).
// Cobre: identidade SHA-256, dir canônico, escrita atômica, leitura
// fail-closed, quarentena, protocolo incompatível, identidade divergente,
// override MESTRE_STATE_DIR/MESTRE_HOME, consentimento separado de journal,
// e avaliação de boot (ambiguidade fail-closed).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  caminhoCanonico, instalacaoId, dirEstado, gravarJsonAtomico, lerEstado,
  gravarEstado, lerJournal, lerConsentimento, gravarConsentimento,
  provarInstalacaoNova, avaliarBoot, PROTOCOLO_VERSAO,
} = await import("./scripts/estado-externo.mjs");

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

// ---------- instalação nova vs ambíguo ----------
const repoNovo = join(TMP, "repo-novo");
mkdirSync(join(repoNovo, "scripts"), { recursive: true });
// sem banco, sem state dir → prova de nova (state dir pode ter sido criado por dirEstado — a prova olha marcador+banco)
const provaNova = provarInstalacaoNova(repoNovo);
t("repo sem banco e sem marcador → instalação nova provável", provaNova.nova === true, JSON.stringify(provaNova));

// com banco → não é nova
mkdirSync(join(repoNovo, "banco"), { recursive: true });
writeFileSync(join(repoNovo, "banco", "mestre-rpg.db"), "x");
t("repo com banco → não é instalação nova", provarInstalacaoNova(repoNovo).nova === false);

// ---------- avaliarBoot ----------
// repo limpo sem manifesto → seguro
const repoBoot = join(TMP, "repo-boot");
mkdirSync(join(repoBoot, "scripts"), { recursive: true });
const envBoot = { MESTRE_STATE_DIR: join(TMP, "state-boot") };
t("boot sem manifesto → seguro", avaliarBoot(repoBoot, envBoot).seguroIniciar === true);

// com manifesto e sem prova de nova → ambíguo → bloqueia
writeFileSync(join(repoBoot, "scripts", "protocolo-auto-update.json"), "{}");
mkdirSync(join(repoBoot, "banco"), { recursive: true });
writeFileSync(join(repoBoot, "banco", "mestre-rpg.db"), "x");
const amb = avaliarBoot(repoBoot, envBoot);
t("manifesto + banco sem state → estado-ambiguo bloqueia", amb.seguroIniciar === false && amb.motivo === "estado-ambiguo", amb.motivo);

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

console.log(`\n${pass} ok, ${fail} falhas`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
