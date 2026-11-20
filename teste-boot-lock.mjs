// Testes — Lock de boot por instalação (Issue #155).
// Cobre: aquisição atômica concorrente, espera por health, abort por
// timeout, liberação só pelo proprietário, recuperação de lock obsoleto
// com prova de pid morto, fail-closed para metadados inválidos/host
// divergente, caminhos com espaços e a fiação do .bat.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(RAIZ, "scripts", "boot-lock.mjs");
const BAT = join(RAIZ, "iniciar-mestre-rpg.bat");

const { adquirirLock, liberarLock, caminhoLock, caminhoCanonicoRepo } =
  await import("./scripts/boot-lock.mjs");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("ok " + n); }
  else { fail++; console.log("FALHOU " + n + " " + extra); }
};

const TMP = join(tmpdir(), `boot-lock-teste-${Date.now().toString(36)}`);
mkdirSync(TMP, { recursive: true });
const repoComEspaco = join(TMP, "instalacao com espacos");
mkdirSync(repoComEspaco, { recursive: true });

// pid garantidamente morto: varre faixa alta até achar um ESRCH real
function pidMorto() {
  for (let cand = 4000000; cand < 4194303; cand++) {
    try { process.kill(cand, 0); } catch (e) { if (e.code === "ESRCH") return cand; }
  }
  return 4194303;
}
const fetchNunca = async () => false;
const fetchSempre = async () => ({ ok: true });
const META = (pid, host, repo) => ({ v: 1, pid, host, repo, ts: Date.now() });

try {
  // ---------- aquisição básica e concorrência ----------
  const lock1 = caminhoLock(repoComEspaco, TMP);
  const r1 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: () => true, fetchHealth: fetchNunca,
    timeoutEsperaMs: 50, intervaloEsperaMs: 5, log: () => {},
  });
  t("primeira aquisição obtém lock (codigo 0)", r1.codigo === 0, String(r1.codigo));
  t("arquivo de lock existe", existsSync(lock1));

  // lockPath custom deve coincidir com o canônico por repo
  t("caminho do lock é por repo canônico", caminhoLock(repoComEspaco, TMP) === lock1);

  // segunda aquisição com pid "vivo" → aguarda health → timeout → aborta
  const t0 = Date.now();
  const r2 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid + 1, pidVivo: () => true, fetchHealth: fetchNunca,
    timeoutEsperaMs: 120, intervaloEsperaMs: 10, log: () => {},
  });
  t("segunda aquisição concorrente aborta após timeout", r2.codigo === 1 && /timeout/.test(r2.motivo), `${r2.codigo} ${r2.motivo}`);
  t("espera respeitou a janela (~120ms)", Date.now() - t0 >= 100, String(Date.now() - t0));

  // com health respondendo → código 20 (servidor de outra instância no ar)
  const r3 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid + 1, pidVivo: () => true, fetchHealth: fetchSempre,
    timeoutEsperaMs: 500, intervaloEsperaMs: 5, log: () => {},
  });
  t("lock ocupado + servidor no ar → codigo 20", r3.codigo === 20, String(r3.codigo));

  // ---------- liberação somente pelo proprietário ----------
  const relErrado = liberarLock({ cwd: repoComEspaco, lockPath: lock1, tmp: TMP, pid: 999999 });
  t("liberação por pid estranho é recusada", relErrado.ok === false, relErrado.motivo);
  t("lock continua existindo após recusa", existsSync(lock1));
  const relCerto = liberarLock({ cwd: repoComEspaco, lockPath: lock1, tmp: TMP, pid: process.pid });
  t("proprietário libera o lock", relCerto.ok === true, relCerto.motivo);
  t("arquivo removido após liberação", !existsSync(lock1));

  // ---------- recuperação de lock obsoleto ----------
  const morto = pidMorto();
  writeFileSync(lock1, JSON.stringify(META(morto, hostname(), caminhoCanonicoRepo(repoComEspaco))));
  const r4 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: (p) => p !== morto, fetchHealth: fetchNunca,
    timeoutEsperaMs: 50, intervaloEsperaMs: 5, log: () => {},
  });
  t("lock de pid morto é recuperado", r4.codigo === 0, `${r4.codigo} ${r4.motivo}`);
  const metaNovo = JSON.parse(readFileSync(lock1, "utf8"));
  t("novo lock tem pid do novo proprietário", metaNovo.pid === process.pid);

  // ---------- metadados inválidos → fail-closed ----------
  liberarLock({ cwd: repoComEspaco, lockPath: lock1, tmp: TMP, pid: process.pid });
  writeFileSync(lock1, "{json corrompido");
  const r5 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: () => true, fetchHealth: fetchNunca,
    timeoutEsperaMs: 60, intervaloEsperaMs: 5, log: () => {},
  });
  t("metadados inválidos bloqueiam (aguarda e aborta)", r5.codigo === 1 && /lock-invalido/.test(r5.motivo), `${r5.codigo} ${r5.motivo}`);

  // ---------- host divergente → nunca remove ----------
  writeFileSync(lock1, JSON.stringify(META(morto, "OUTRA-MAQUINA-XYZ", caminhoCanonicoRepo(repoComEspaco))));
  const antes = readFileSync(lock1, "utf8");
  const r6 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, host: hostname(), pidVivo: () => false,
    fetchHealth: fetchNunca, timeoutEsperaMs: 60, intervaloEsperaMs: 5, log: () => {},
  });
  t("host divergente não é removido nem assumido", r6.codigo === 1 && readFileSync(lock1, "utf8") === antes, `${r6.codigo}`);

  // ---------- repo divergente no mesmo lockPath → não assume ----------
  const repoB = join(TMP, "outra instalacao");
  mkdirSync(repoB, { recursive: true });
  writeFileSync(lock1, JSON.stringify(META(process.pid, hostname(), caminhoCanonicoRepo(repoB))));
  const r7 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: () => false, fetchHealth: fetchNunca,
    timeoutEsperaMs: 60, intervaloEsperaMs: 5, log: () => {},
  });
  t("lock de outro repo no mesmo path é tratado como ocupado", r7.codigo === 1, String(r7.codigo));

  // ---------- CLI real: adquirir/liberar via processo ----------
  // Nota: o pid gravado pelo CLI é o ppid do node auxiliar — no .bat é o
  // cmd.exe; num spawnSync de teste é ESTE processo (vivo durante todo o
  // teste), então não dá para simular "dono morto" pelo CLI sem enfraquecer
  // o mecanismo. Cobertura de stale/ocupado fica nos testes de função acima.
  const lockReal = caminhoLock(repoComEspaco);
  rmSync(lockReal, { force: true });
  const cliA = spawnSync(process.execPath, [SCRIPT, "adquirir"], { cwd: repoComEspaco, encoding: "utf8", timeout: 15000 });
  t("CLI adquirir → exit 0", cliA.status === 0, `${cliA.status} ${cliA.stderr}`);
  const cliMeta = JSON.parse(readFileSync(lockReal, "utf8"));
  t("CLI grava pid do processo pai (dono)", Number.isInteger(cliMeta.pid) && cliMeta.pid > 0, JSON.stringify(cliMeta));
  const cliLib = spawnSync(process.execPath, [SCRIPT, "liberar"], { cwd: repoComEspaco, encoding: "utf8", timeout: 15000 });
  t("CLI liberar → exit 0 (mesmo ppid = proprietário)", cliLib.status === 0, `${cliLib.status} ${cliLib.stderr}`);
  t("lock real removido", !existsSync(lockReal));

  // ---------- .bat: ordenação e cobertura de liberação ----------
  const bat = readFileSync(BAT, "utf8");
  const iPorta = bat.indexOf("Invoke-WebRequest");
  const iAdq = bat.indexOf("boot-lock.mjs adquirir");
  const iUpd = bat.indexOf("auto-update.mjs");
  const iStart = bat.indexOf("npm run start");
  const iFim = bat.indexOf("boot-lock.mjs liberar", iStart);
  t(".bat adquire lock após check de porta e antes do updater",
    iPorta > -1 && iAdq > iPorta && iUpd > iAdq, `porta=${iPorta} adq=${iAdq} upd=${iUpd}`);
  const liberarCount = (bat.match(/boot-lock\.mjs liberar/g) ?? []).length;
  t(".bat libera o lock em todos os caminhos de falha + fim",
    liberarCount >= 8, String(liberarCount)); // 7 falhas + 1 fim
  t(".bat sai sem erro quando outra instância assume (codigo 20)",
    /errorlevel%==20 exit \/b 0/.test(bat));

  // lock não fica dentro do worktree (não pode sujar git status)
  t("lock fica fora do repositório (tmpdir)", !caminhoLock(repoComEspaco).startsWith(resolve(repoComEspaco)));
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ok */ }
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exitCode = fail ? 1 : 0;
