// Contrato executável P10-C (Issue #155) — cenários AUTOMATIZÁVEIS.
// Cobre o que já existe em produção: detecção de banco via
// caminhoBancoConfigurado(), entrypoint autorizar-bootstrap.mjs e o
// gate fail-closed do migrate.ts. O fluxo .bat (set /p, node -e,
// ordenação) ainda NÃO existe — os cenários BAT/manuais constam na
// matriz I26 publicada na #189 e serão implementados na base pós-.8.
// Regra: NENHUM comportamento de produção é alterado aqui — só testes.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caminhoBancoConfigurado, lerProvisionamento, lerAutorizacaoBootstrap,
  gravarReciboInstalacao,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(ROOT, "scripts", "autorizar-bootstrap.mjs");

const BASE = mkdtempSync(join(tmpdir(), "mestre-p10c-"));
let seq = 0;
const cenario = () => {
  const dir = join(BASE, `c${++seq}`);
  mkdirSync(dir, { recursive: true });
  const env = {
    MESTRE_BANCO: join(dir, "banco", "mestre-rpg.db"),
    MESTRE_BACKUPS: join(dir, "backups"),
    MESTRE_ARQUIVOS: join(dir, "arquivos"),
    MESTRE_STATE_DIR: join(dir, "state"),
  };
  return { dir, env };
};
const entrypoint = (env, args = ["--confirmar-provisionamento"]) =>
  spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000,
  });
const migrar = (env) =>
  spawnSync(process.execPath, [TSX, "servidor/src/db/migrate.ts"], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120000,
  });
const arquivosState = (dir) => {
  const d = join(dir, "state");
  return existsSync(d) ? readdirSync(d) : [];
};

sec("1. Detecção de banco — caminhoBancoConfigurado (fonte única)");
{
  const c = cenario();
  t("default = <repo>/banco/mestre-rpg.db",
    caminhoBancoConfigurado(ROOT, {}) === join(ROOT, "banco", "mestre-rpg.db"));
  const comEspacos = join(c.dir, "meu banco", "jogo rpg.db");
  t("MESTRE_BANCO com espaços é honrado integralmente",
    caminhoBancoConfigurado(ROOT, { MESTRE_BANCO: comEspacos }) === comEspacos);
  t("MESTRE_BANCO com espaços nas bordas é trimmed",
    caminhoBancoConfigurado(ROOT, { MESTRE_BANCO: `  ${comEspacos}  ` }) === comEspacos);
  // Prova via o MESMO módulo que o .bat usará (node -e) — sem duplicar lógica.
  const modUrl = new URL("./scripts/estado-externo.mjs", `file:///${ROOT.replace(/\\/g, "/")}/`).href;
  const det = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(modUrl)});` +
    `console.log(m.caminhoBancoConfigurado(${JSON.stringify(ROOT)}, process.env));`],
    { cwd: ROOT, env: { ...process.env, ...c.env }, encoding: "utf8" });
  t("node -e resolve o caminho configurado do cenário",
    det.stdout.trim() === c.env.MESTRE_BANCO, `${det.stdout.trim()} ${det.stderr?.slice(0, 120)}`);
}

sec("2. Entrypoint — matriz de exit codes (CLI real)");
{
  const c = cenario();
  const semFlag = entrypoint(c.env, []);
  t("sem --confirmar-provisionamento → exit 2", semFlag.status === 2, `status=${semFlag.status}`);

  const limpo = entrypoint(c.env);
  t("cenário limpo + flag → exit 0", limpo.status === 0, `status=${limpo.status} ${limpo.stderr?.slice(0,120)}`);
  t("autorização emitida após exit 0",
    lerAutorizacaoBootstrap(ROOT, c.env).status === "ok");

  // Segundo bootstrap no MESMO cenário: ja-autorizado → exit 0 idempotente.
  const idem = entrypoint(c.env);
  t("repetição idempotente → exit 0", idem.status === 0, `status=${idem.status}`);
}

sec("3. Caminho bloqueado — nada é gravado (fail-closed)");
{
  const c = cenario();
  mkdirSync(join(c.dir, "banco"), { recursive: true });
  writeFileSync(c.env.MESTRE_BANCO, "resto"); // banco existente = bloqueio
  const r = entrypoint(c.env);
  t("banco existente + flag → exit 1", r.status === 1, `status=${r.status}`);
  t("NENHUM provisionamento.json no state", lerProvisionamento(ROOT, c.env).status === "ausente");
  t("NENHUM arquivo bootstrap-* no state",
    !arquivosState(c.dir).some((n) => n.startsWith("bootstrap-")));
  t("NENHUMA autorização emitida",
    lerAutorizacaoBootstrap(ROOT, c.env).status !== "ok");
}

sec("4. Recibo + banco apagado = PERDA → entrypoint bloqueia");
{
  const c = cenario();
  gravarReciboInstalacao(ROOT, c.env);
  const r = entrypoint(c.env);
  t("recibo presente + banco ausente → exit 1", r.status === 1, `status=${r.status}`);
  t("sem provisionamento residual", lerProvisionamento(ROOT, c.env).status === "ausente");
}

sec("5. Sequência bootstrap→migrate: recusa impede migração");
{
  // Contrato que o .bat vai ligar: se o entrypoint recusa (exit≠0),
  // o migrate NÃO pode ser invocado — e mesmo invocado à força,
  // bloqueia por conta própria (vazio sem estado reconhecido).
  const c = cenario();
  mkdirSync(join(c.dir, "banco"), { recursive: true });
  writeFileSync(c.env.MESTRE_BANCO, "resto");
  const boot = entrypoint(c.env);
  t("entrypoint recusou (exit 1)", boot.status === 1);
  const mig = migrar(c.env);
  t("migrate forçado ainda bloqueia (exit≠0)", mig.status !== 0, `status=${mig.status}`);
  t("mensagem de provisionamento no stderr do migrate",
    /autorizar-bootstrap|provisionamento|diagnóstico|backup/i.test(String(mig.stderr)),
    String(mig.stderr).slice(0, 160));
  t("nenhum backup pré-update criado na recusa",
    !existsSync(join(c.dir, "backups")) ||
    readdirSync(join(c.dir, "backups")).filter((n) => n.startsWith("pre_update")).length === 0);
}

sec("6. Bootstrap autorizado → migrate prossegue (caminho feliz)");
{
  const c = cenario();
  const boot = entrypoint(c.env);
  t("entrypoint exit 0", boot.status === 0, `status=${boot.status}`);
  const mig = migrar(c.env);
  t("migrate exit 0 com bootstrap autorizado", mig.status === 0,
    `status=${mig.status} ${String(mig.stderr).slice(0, 160)}`);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
