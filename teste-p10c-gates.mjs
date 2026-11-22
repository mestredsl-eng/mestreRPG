// Contrato executável P10-C (Issue #155) — cenários AUTOMATIZÁVEIS.
// Cobre o que já existe em produção: detecção de banco via
// caminhoBancoConfigurado(), entrypoint autorizar-bootstrap.mjs e o
// gate fail-closed do migrate.ts. O fluxo .bat (set /p, node -e,
// ordenação) ainda NÃO existe — os cenários BAT/manuais constam na
// matriz I26 publicada na #189 e serão implementados na base pós-.8.
// Regra: NENHUM comportamento de produção é alterado aqui — só testes.
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  caminhoBancoConfigurado, lerProvisionamento, lerAutorizacaoBootstrap,
  gravarReciboInstalacao, dirEstado, instalacaoId, gravarEstado,
  avaliarBoot, JOURNAL_UPDATE, JOURNAL_RESTAURACAO,
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
// Diretório de estado REAL da instalação (MESTRE_STATE_DIR/<instalacaoId>)
// — arquivosState anterior lia <dir>/state, que só contém o subdir de id;
// a prova física precisa olhar dentro dele.
const stateDirReal = (env) => dirEstado(ROOT, env);
const arquivosState = (env) => {
  const d = stateDirReal(env);
  return existsSync(d) ? readdirSync(d) : [];
};
// Prova física fail-closed: zero resíduo de provisionamento/autorização.
const zeroResiduosBootstrap = (env) => {
  const nomes = arquivosState(env);
  return !nomes.some((n) => n.startsWith("provisionamento"))
    && !nomes.some((n) => n.startsWith("bootstrap-autorizacao"));
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
    !arquivosState(c.env).some((n) => n.startsWith("bootstrap-")));
  t("prova física: zero provisionamento*/bootstrap-autorizacao*",
    zeroResiduosBootstrap(c.env));
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

sec("7. Vetores de bloqueio — prova física zero provisionamento*/bootstrap-*");
{
  // Cada vetor roda o entrypoint real e confere: exit 1, motivo esperado
  // no stdout e NENHUM arquivo provisionamento*/bootstrap-autorizacao*
  // no state dir real (<MESTRE_STATE_DIR>/<instalacaoId>).
  const vetores = [];

  // 7a. Restos de instalação: backups com conteúdo (além de .gitkeep).
  {
    const c = cenario();
    mkdirSync(c.env.MESTRE_BACKUPS, { recursive: true });
    writeFileSync(join(c.env.MESTRE_BACKUPS, "pre_update_velho.zip"), "x");
    vetores.push(["restos-backups", c, /restos-backups/]);
  }
  // 7b. Restos: sidecar do banco (-wal) sem o banco principal.
  {
    const c = cenario();
    const dirBanco = dirname(c.env.MESTRE_BANCO);
    mkdirSync(dirBanco, { recursive: true });
    writeFileSync(join(dirBanco, "mestre-rpg.db-wal"), "x");
    vetores.push(["restos-banco-sidecars", c, /restos-banco-sidecars/]);
  }
  // 7c. Journal de update pendente (válido, fase em-andamento).
  {
    const c = cenario();
    gravarEstado(ROOT, JOURNAL_UPDATE, { fase: "em-andamento", detalhe: "teste-i28a" }, c.env);
    vetores.push(["journal-update-pendente", c, /journal-atualizacao-ultima\.json-ok/]);
  }
  // 7d. State divergente: recibo com instalacaoId de outra instalação.
  {
    const c = cenario();
    const dir = stateDirReal(c.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "instalacao-recibo.json"), JSON.stringify({
      protocoloVersao: 1, instalacaoId: "outra-instalacao", repoCanon: "x",
      tipo: "instalacao-concluida",
    }));
    vetores.push(["state-divergente-recibo", c, /recibo-divergente/]);
  }
  // 7e. Banco 0 bytes — presente mas vazio é ambíguo (fail-closed).
  {
    const c = cenario();
    mkdirSync(dirname(c.env.MESTRE_BANCO), { recursive: true });
    writeFileSync(c.env.MESTRE_BANCO, "");
    vetores.push(["banco-0-bytes", c, /banco-existente/]);
  }
  // 7f. Banco parcial: bytes arbitrários não-SQLite no caminho.
  {
    const c = cenario();
    mkdirSync(dirname(c.env.MESTRE_BANCO), { recursive: true });
    writeFileSync(c.env.MESTRE_BANCO, Buffer.alloc(512, 0xAB));
    vetores.push(["banco-parcial-lixo", c, /banco-existente/]);
  }

  for (const [nome, c, motivoRe] of vetores) {
    const r = entrypoint(c.env);
    t(`${nome}: exit 1`, r.status === 1, `status=${r.status}`);
    t(`${nome}: motivo esperado`, motivoRe.test(String(r.stdout)), String(r.stdout).slice(0, 140));
    t(`${nome}: prova física zero provisionamento*/bootstrap-*`, zeroResiduosBootstrap(c.env),
      arquivosState(c.env).join(","));
    t(`${nome}: nenhuma autorização emitida`,
      lerAutorizacaoBootstrap(ROOT, c.env).status !== "ok");
  }
}

sec("8. Restauração pendente — precedência sobre bootstrap e migrate");
{
  const c = cenario();
  gravarEstado(ROOT, JOURNAL_RESTAURACAO,
    { fase: "em-andamento", detalhe: "restauracao-i28a" }, c.env);

  const boot = avaliarBoot(ROOT, c.env);
  t("avaliarBoot bloqueia: restauracao-em-andamento",
    boot.seguroIniciar === false && boot.motivo === "restauracao-em-andamento",
    JSON.stringify(boot).slice(0, 140));

  const ep = entrypoint(c.env);
  t("entrypoint bloqueia com journal de restauração", ep.status === 1, `status=${ep.status}`);
  t("motivo journal-restauracao no stdout", /journal-restauracao-externa\.json-ok/.test(String(ep.stdout)),
    String(ep.stdout).slice(0, 140));

  // O migrate NÃO consulta journals — quem aplica a precedência é o
  // orquestrador (.bat, P10-C). Aqui provamos que, mesmo forçado, o
  // migrate bloqueia por conta própria (banco vazio sem estado
  // reconhecido) e que NADA de bootstrap/autorização foi gravado.
  const mig = migrar(c.env);
  t("migrate forçado bloqueia (exit≠0)", mig.status !== 0, `status=${mig.status}`);
  t("zero provisionamento*/bootstrap-* após a sequência",
    zeroResiduosBootstrap(c.env), arquivosState(c.env).join(","));
  t("nenhuma autorização de bootstrap residual",
    lerAutorizacaoBootstrap(ROOT, c.env).status !== "ok");
}

sec("9. Integridade do corte — byte-compare migrations/journal/snapshots vs HEAD");
{
  // Todo artefato tracked sob servidor/migrations/ (SQL, meta/_journal.json
  // e meta/*_snapshot.json) deve ser byte-idêntico ao HEAD — a suíte não
  // pode mutar o corte de migrations. Hoje a base vai até 0030; quando a
  // .8 trouxer 0031/0032 o mesmo laço as cobre automaticamente.
  const lista = execSync("git ls-files servidor/migrations", { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  t("artefatos de migration enumerados (>0)", lista.length > 0, `n=${lista.length}`);
  // Byte-compare cru falharia no Windows (autocrlf: blob LF × disco CRLF).
  // A comparação canônica é a do próprio git: status porcelain pega
  // modificações E não-rastreados; diff --quiet confirma zero delta vs HEAD.
  const status = execSync("git status --porcelain -- servidor/migrations",
    { cwd: ROOT, encoding: "utf8" }).trim();
  const diff = spawnSync("git", ["diff", "--quiet", "HEAD", "--", "servidor/migrations"],
    { cwd: ROOT, encoding: "utf8" });
  t("git status limpo em servidor/migrations (zero modificados/não-rastreados)",
    status === "", status.slice(0, 200));
  t("git diff HEAD vazio em servidor/migrations", diff.status === 0,
    `status=${diff.status}`);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
