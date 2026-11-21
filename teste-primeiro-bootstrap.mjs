// Testes do produtor de primeiro bootstrap (P10-A / Issue #155).
// Tudo isolado em %TEMP%: repoDir falso + MESTRE_STATE_DIR/MESTRE_BANCO
// injetados via parâmetro env — nada toca o estado real do usuário.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autorizarPrimeiroBootstrap, concluirBootstrapAposHealth,
  consumirAutorizacaoBootstrap, diagnosticarBootstrap, dirEstado,
  gravarJsonAtomico, gravarEstado, gravarProvisionamento, lerProvisionamento,
  JOURNAL_UPDATE, JOURNAL_RESTAURACAO,
  ARQUIVO_AUTORIZACAO_BOOTSTRAP, ARQUIVO_RECIBO_INSTALACAO,
  ARQUIVO_PROVISIONAMENTO,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const BASE = mkdtempSync(join(tmpdir(), "mestre-bootstrap-"));
const repo = () => {
  const dir = join(BASE, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const envDe = (r) => ({
  MESTRE_STATE_DIR: join(BASE, "state"),
  MESTRE_BANCO: join(r, "banco", "mestre-rpg.db"),
});
const authsEm = (r, env) => {
  const dir = dirEstado(r, env);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("bootstrap-autorizacao")) : [];
};
// Ação explícita de provisionamento — pré-condição do produtor.
const provisionar = (r, env) => gravarProvisionamento(r, env);

sec("1. Instalação realmente limpa autoriza uma vez");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  const a = autorizarPrimeiroBootstrap(r, env);
  t("emitida", a.autorizado === true && a.motivo === "emitida", JSON.stringify(a));
  t("arquivo de autorização existe", authsEm(r, env).includes(ARQUIVO_AUTORIZACAO_BOOTSTRAP));
  t("diagnóstico = primeiro-bootstrap", diagnosticarBootstrap(r, env) === "primeiro-bootstrap");
  const b = autorizarPrimeiroBootstrap(r, env);
  t("segunda chamada idempotente (ja-autorizado)", b.autorizado === true && b.motivo === "ja-autorizado");
  t("sem segunda autorização gravada", authsEm(r, env).length === 1, authsEm(r, env).join(","));
}

sec("2. Consumo único + interrupção antes do recibo bloqueia reemissão");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  autorizarPrimeiroBootstrap(r, env);
  const c = consumirAutorizacaoBootstrap(r, env);
  t("autorização consumida", c.autorizado === true);
  t("consumo é único", consumirAutorizacaoBootstrap(r, env).autorizado === false);
  const a = autorizarPrimeiroBootstrap(r, env);
  t("reemitir após consumo sem recibo → bootstrap-interrompido", a.autorizado === false && a.motivo === "bootstrap-interrompido", a.motivo);
  t("nenhuma autorização nova gravada", authsEm(r, env).every((n) => n.startsWith("bootstrap-autorizacao.consumida-")));
}

sec("3. Recibo só após health-ready com banco comprovado");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  autorizarPrimeiroBootstrap(r, env);
  consumirAutorizacaoBootstrap(r, env);
  const semProva = concluirBootstrapAposHealth(r, env, false);
  t("sem prova de banco → não grava recibo", semProva.concluido === false && semProva.motivo === "banco-nao-comprovado", semProva.motivo);
  t("segue bootstrap-interrompido", diagnosticarBootstrap(r, env) === "bootstrap-interrompido");
  const comProva = concluirBootstrapAposHealth(r, env, true);
  t("com prova → recibo gravado", comProva.concluido === true, JSON.stringify(comProva));
  t("diagnóstico = instalacao-concluida", diagnosticarBootstrap(r, env) === "instalacao-concluida");
  const deNovo = concluirBootstrapAposHealth(r, env, true);
  t("idempotente — não regrava", deNovo.concluido === false && deNovo.motivo === "instalacao-concluida", deNovo.motivo);
  const a = autorizarPrimeiroBootstrap(r, env);
  t("após recibo, produtor bloqueia", a.autorizado === false && a.motivo === "instalacao-ja-concluida", a.motivo);
}

sec("4. Banco configurado existente bloqueia");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  mkdirSync(join(r, "banco"), { recursive: true });
  writeFileSync(env.MESTRE_BANCO, "sqlite-format-3-lixo");
  const a = autorizarPrimeiroBootstrap(r, env);
  t("banco com conteúdo → banco-existente", a.autorizado === false && a.motivo === "banco-existente", a.motivo);
  t("nada emitido", authsEm(r, env).length === 0);
}

sec("5. Banco vazio (0 bytes) BLOQUEIA — arquivo presente é ambíguo");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  mkdirSync(join(r, "banco"), { recursive: true });
  writeFileSync(env.MESTRE_BANCO, "");
  const a = autorizarPrimeiroBootstrap(r, env);
  t("0 bytes → banco-existente", a.autorizado === false && a.motivo === "banco-existente", a.motivo);
  t("nada emitido", authsEm(r, env).length === 0);
}

sec("6. Journal de update presente bloqueia");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  gravarEstado(r, JOURNAL_UPDATE, { fase: "concluido" }, env);
  const a = autorizarPrimeiroBootstrap(r, env);
  t("journal ok → bloqueado", a.autorizado === false && String(a.motivo).includes("journal"), a.motivo);
}

sec("7. Journal corrompido bloqueia (nunca tratado como ausência)");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  const dir = dirEstado(r, env);
  mkdirSync(dir, { recursive: true });
  gravarJsonAtomico(join(dir, JOURNAL_RESTAURACAO), "isto-nao-e-json{");
  // grava JSON inválido por cima — gravarJsonAtomico sempre serializa;
  // escrever cru para simular corrupção real:
  writeFileSync(join(dir, JOURNAL_RESTAURACAO), "{quebrado");
  const a = autorizarPrimeiroBootstrap(r, env);
  t("journal corrompido → bloqueado", a.autorizado === false && String(a.motivo).includes("corrompido"), a.motivo);
}

sec("8. Autorização adulterada/divergente bloqueia");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  autorizarPrimeiroBootstrap(r, env);
  const dir = dirEstado(r, env);
  const arq = join(dir, ARQUIVO_AUTORIZACAO_BOOTSTRAP);
  const dados = JSON.parse(readFileSync(arq, "utf8"));
  dados.instalacaoId = "0".repeat(64);
  writeFileSync(arq, JSON.stringify(dados));
  const a = autorizarPrimeiroBootstrap(r, env);
  t("identidade divergente → bloqueado", a.autorizado === false && String(a.motivo).includes("divergente"), a.motivo);
}

sec("9. State dir ilegível bloqueia");
{
  const r = repo(); const env = envDe(r);
  const dir = dirEstado(r, env);
  mkdirSync(env.MESTRE_STATE_DIR, { recursive: true });
  writeFileSync(dir, "sou-um-arquivo, nao-diretorio");
  const a = autorizarPrimeiroBootstrap(r, env);
  t("state-ilegivel → bloqueado", a.autorizado === false && a.motivo === "state-ilegivel", a.motivo);
}

sec("10. Recibo corrompido bloqueia");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  const dir = dirEstado(r, env);
  writeFileSync(join(dir, ARQUIVO_RECIBO_INSTALACAO), "{lixo");
  const a = autorizarPrimeiroBootstrap(r, env);
  t("recibo corrompido → bloqueado", a.autorizado === false && String(a.motivo).includes("recibo"), a.motivo);
}

sec("11. State dir AUSENTE bloqueia — não é lista vazia");
{
  const r = repo(); const env = envDe(r);
  // nada provisionado: nem state dir, nem marcador — DB ausente +
  // state ausente é ambíguo (perda conjunta) e NÃO autoriza.
  const a = autorizarPrimeiroBootstrap(r, env);
  t("state-ausente → bloqueado", a.autorizado === false && a.motivo === "state-ausente", a.motivo);
  t("nada emitido", authsEm(r, env).length === 0);
}

sec("12. Sem marcador de provisionamento bloqueia");
{
  const r = repo(); const env = envDe(r);
  mkdirSync(dirEstado(r, env), { recursive: true }); // dir existe, marcador não
  const a = autorizarPrimeiroBootstrap(r, env);
  t("provisionamento-ausente → bloqueado", a.autorizado === false && a.motivo === "provisionamento-ausente", a.motivo);
  t("nada emitido", authsEm(r, env).length === 0);
}

sec("13. Marcador de provisionamento inválido/divergente bloqueia");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  const dir = dirEstado(r, env);
  const arq = join(dir, ARQUIVO_PROVISIONAMENTO);
  const dados = JSON.parse(readFileSync(arq, "utf8"));
  dados.instalacaoId = "f".repeat(64);
  writeFileSync(arq, JSON.stringify(dados));
  const a = autorizarPrimeiroBootstrap(r, env);
  t("marcador divergente → bloqueado", a.autorizado === false && a.motivo === "provisionamento-divergente", a.motivo);
  t("nada emitido", authsEm(r, env).length === 0);
}

sec("14. Marcador corrompido bloqueia (nunca tratado como ausência)");
{
  const r = repo(); const env = envDe(r);
  const dir = dirEstado(r, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ARQUIVO_PROVISIONAMENTO), "{quebrado");
  const a = autorizarPrimeiroBootstrap(r, env);
  t("marcador corrompido → bloqueado", a.autorizado === false && a.motivo === "provisionamento-corrompido", a.motivo);
}

sec("15. Entrypoint exige --confirmar-provisionamento");
{
  const script = join(process.cwd(), "scripts", "autorizar-bootstrap.mjs");
  const env = {
    ...process.env,
    MESTRE_STATE_DIR: join(BASE, "state-entry"),
    MESTRE_BANCO: join(BASE, "banco-entry", "mestre-rpg.db"),
    MESTRE_BACKUPS: join(BASE, "backups-entry"), // isola restos do repo real
  };
  const semFlag = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  t("sem flag → exit 2", semFlag.status === 2, `status=${semFlag.status}`);
  t("sem flag → nada gravado", !existsSync(join(env.MESTRE_STATE_DIR)));
  const comFlag = spawnSync(process.execPath, [script, "--confirmar-provisionamento"], { env, encoding: "utf8" });
  t("com flag → exit 0", comFlag.status === 0, `status=${comFlag.status} ${comFlag.stderr}`);
  const temAuth = existsSync(env.MESTRE_STATE_DIR)
    && readdirSync(env.MESTRE_STATE_DIR).some((id) =>
      existsSync(join(env.MESTRE_STATE_DIR, id, ARQUIVO_AUTORIZACAO_BOOTSTRAP)));
  t("autorização emitida pelo entrypoint", temAuth);
  const replay = spawnSync(process.execPath, [script, "--confirmar-provisionamento"], { env, encoding: "utf8" });
  t("replay idempotente → exit 0", replay.status === 0, `status=${replay.status}`);
}

sec("16. Instalação concluída + wipe DB+state + restos → NUNCA re-emite");
{
  const r = repo(); const env = envDe(r);
  provisionar(r, env);
  autorizarPrimeiroBootstrap(r, env);
  consumirAutorizacaoBootstrap(r, env);
  concluirBootstrapAposHealth(r, env, true); // recibo permanente
  // Perda conjunta: apaga DB (já ausente) e o state dir INTEIRO —
  // recibo, autorização e marcador desaparecem juntos.
  rmSync(dirEstado(r, env), { recursive: true, force: true });
  // Restos de instalação anterior sobrevivem: backups com conteúdo.
  mkdirSync(join(r, "backups", "2020-01-01T00-00-00-000Z_manual"), { recursive: true });
  writeFileSync(join(r, "backups", "2020-01-01T00-00-00-000Z_manual", "manifesto.json"), "{}");
  const script = join(process.cwd(), "scripts", "autorizar-bootstrap.mjs");
  const envFilho = { ...process.env, ...env, MESTRE_BACKUPS: join(r, "backups") };
  const semFlag = spawnSync(process.execPath, [script], { env: envFilho, encoding: "utf8" });
  t("sem flag → exit 2", semFlag.status === 2, `status=${semFlag.status}`);
  const comFlag = spawnSync(process.execPath, [script, "--confirmar-provisionamento"], { env: envFilho, encoding: "utf8" });
  t("com flag → BLOQUEADO (restos)", comFlag.status === 1, `status=${comFlag.status} ${comFlag.stdout}`);
  provisionar(r, env); // entrypoint grava o marcador antes de autorizar
  const a = autorizarPrimeiroBootstrap(r, env);
  t("produtor → restos-*", a.autorizado === false && String(a.motivo).startsWith("restos-"), a.motivo);
  t("nada emitido", authsEm(r, env).length === 0);
  // Sidecars do banco também são resto, mesmo sem backups/.
  rmSync(join(r, "backups"), { recursive: true, force: true });
  mkdirSync(join(r, "banco"), { recursive: true });
  writeFileSync(join(r, "banco", "mestre-rpg.db-wal"), "wal");
  const b = autorizarPrimeiroBootstrap(r, env);
  t("sidecar -wal → bloqueado", b.autorizado === false && String(b.motivo).includes("banco-sidecars"), b.motivo);
  // Wipe TOTAL (sem nenhum resto) é indistinguível de clone novo —
  // documentado: não há evidência restante a proteger.
  rmSync(join(r, "banco"), { recursive: true, force: true });
  const c = autorizarPrimeiroBootstrap(r, env);
  t("wipe total → emitida (indistinguível de fresh)", c.autorizado === true, c.motivo);
}

console.log(`\n${pass} ok / ${fail} falhas`);
rmSync(BASE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
