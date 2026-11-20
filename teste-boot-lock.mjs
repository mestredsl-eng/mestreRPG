// Testes — Lock de boot por instalação (Issue #155).
// Cobre: aquisição atômica, corrida de recuperação de lock obsoleto
// SERIALIZADA por mutex .recover, liberação só pelo proprietário
// (pid+host+repo), fail-closed para metadados inválidos/host divergente,
// concorrência REAL entre processos Node separados e a fiação do .bat.
import { spawn, spawnSync } from "node:child_process";
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

// Worker multiprocesso: node --input-type=module -e "<codigo>" <cwd>
// Imprime "CODIGO=<n>". timeout de espera curto via env para não travar.
const WORKER = `
const m = await import(${JSON.stringify("file:///" + SCRIPT.replace(/\\/g, "/"))});
const cwd = process.argv[1];
const r = await m.adquirirLock({ cwd, timeoutEsperaMs: 500, intervaloEsperaMs: 25 });
console.log("CODIGO=" + r.codigo + " MOTIVO=" + r.motivo);
process.exit(0);
`;
function spawnWorkers(cwd, n) {
  return Promise.all(Array.from({ length: n }, () => new Promise((res) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", WORKER, cwd], {
      env: { ...process.env, MESTRE_BOOT_LOCK_TIMEOUT_MS: "500" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => res({ code, out, err }));
  })));
}
const codigos = (rs) => rs.map((r) => (r.out.match(/CODIGO=(\d+)/) ?? [])[1]).filter(Boolean).map(Number);

try {
  // ---------- aquisição básica ----------
  const lock1 = caminhoLock(repoComEspaco, TMP);
  const r1 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: () => true, fetchHealth: fetchNunca,
    timeoutEsperaMs: 50, intervaloEsperaMs: 5, log: () => {},
  });
  t("primeira aquisição obtém lock (codigo 0)", r1.codigo === 0, String(r1.codigo));
  t("arquivo de lock existe", existsSync(lock1));
  t("caminho do lock é por repo canônico", caminhoLock(repoComEspaco, TMP) === lock1);

  // lock ocupado por pid vivo → aguarda health → timeout → aborta
  const t0 = Date.now();
  const r2 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid + 1, pidVivo: () => true, fetchHealth: fetchNunca,
    timeoutEsperaMs: 120, intervaloEsperaMs: 10, log: () => {},
  });
  t("lock ocupado sem health aborta após timeout", r2.codigo === 1 && /timeout/.test(r2.motivo), `${r2.codigo} ${r2.motivo}`);
  t("espera respeitou a janela (~120ms)", Date.now() - t0 >= 100, String(Date.now() - t0));

  const r3 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid + 1, pidVivo: () => true, fetchHealth: fetchSempre,
    timeoutEsperaMs: 500, intervaloEsperaMs: 5, log: () => {},
  });
  t("lock ocupado + servidor no ar → codigo 20", r3.codigo === 20, String(r3.codigo));

  // ---------- liberação somente pelo proprietário (pid+host+repo) ----------
  const relErrado = liberarLock({ cwd: repoComEspaco, lockPath: lock1, tmp: TMP, pid: 999999 });
  t("liberação por pid estranho é recusada", relErrado.ok === false, relErrado.motivo);
  t("lock continua existindo após recusa", existsSync(lock1));
  const relHostErrado = liberarLock({ cwd: repoComEspaco, lockPath: lock1, tmp: TMP, pid: process.pid, host: "HOST-FALSO" });
  t("liberação por host divergente (pid coincidente) é recusada", relHostErrado.ok === false, relHostErrado.motivo);
  t("lock continua existindo após recusa de host", existsSync(lock1));
  const relCerto = liberarLock({ cwd: repoComEspaco, lockPath: lock1, tmp: TMP, pid: process.pid, host: hostname() });
  t("proprietário (pid+host+repo) libera o lock", relCerto.ok === true, relCerto.motivo);
  t("arquivo removido após liberação", !existsSync(lock1));

  // liberação com repo divergente: lock gravado para repoA, liberar com cwd repoB
  writeFileSync(lock1, JSON.stringify(META(process.pid, hostname(), caminhoCanonicoRepo(repoComEspaco))));
  const repoB = join(TMP, "outra instalacao");
  mkdirSync(repoB, { recursive: true });
  const relRepoB = liberarLock({ cwd: repoB, lockPath: lock1, tmp: TMP, pid: process.pid, host: hostname() });
  t("liberação com repo divergente é recusada", relRepoB.ok === false && existsSync(lock1), relRepoB.motivo);
  rmSync(lock1, { force: true });

  // ---------- metadados inválidos → fail-closed ----------
  writeFileSync(lock1, "{json corrompido");
  const r5 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: () => true, fetchHealth: fetchNunca,
    timeoutEsperaMs: 60, intervaloEsperaMs: 5, log: () => {},
  });
  t("metadados inválidos bloqueiam (aguarda e aborta)", r5.codigo === 1 && /lock-invalido/.test(r5.motivo), `${r5.codigo} ${r5.motivo}`);

  // ---------- host divergente → nunca remove ----------
  const morto = pidMorto();
  writeFileSync(lock1, JSON.stringify(META(morto, "OUTRA-MAQUINA-XYZ", caminhoCanonicoRepo(repoComEspaco))));
  const antes = readFileSync(lock1, "utf8");
  const r6 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, host: hostname(), pidVivo: () => false,
    fetchHealth: fetchNunca, timeoutEsperaMs: 60, intervaloEsperaMs: 5, log: () => {},
  });
  t("host divergente não é removido nem assumido", r6.codigo === 1 && readFileSync(lock1, "utf8") === antes, `${r6.codigo}`);

  // ---------- recuperação de lock obsoleto (sequencial) ----------
  writeFileSync(lock1, JSON.stringify(META(morto, hostname(), caminhoCanonicoRepo(repoComEspaco))));
  const r7 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: (p) => p !== morto, fetchHealth: fetchNunca,
    timeoutEsperaMs: 50, intervaloEsperaMs: 5, log: () => {},
  });
  t("lock de pid morto é recuperado via seção crítica", r7.codigo === 0, `${r7.codigo} ${r7.motivo}`);
  const metaNovo = JSON.parse(readFileSync(lock1, "utf8"));
  t("novo lock tem pid do novo proprietário", metaNovo.pid === process.pid);
  // mutex liberado após a seção
  t("mutex .recover liberado após recuperação", !existsSync(lock1 + ".recover"));
  liberarLock({ cwd: repoComEspaco, lockPath: lock1, tmp: TMP, pid: process.pid, host: hostname() });

  // ---------- mutex .recover ocupado por pid vivo → fail-closed ----------
  writeFileSync(lock1, JSON.stringify(META(morto, hostname(), caminhoCanonicoRepo(repoComEspaco))));
  writeFileSync(lock1 + ".recover", JSON.stringify({ ...META(process.pid, hostname(), caminhoCanonicoRepo(repoComEspaco)), nonce: "n-vivo" }));
  const r8 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: (p) => p === process.pid, // só o pid do mutex "vive"
    fetchHealth: fetchNunca, timeoutEsperaMs: 60, intervaloEsperaMs: 5, log: () => {},
  });
  t("mutex ocupado → trata como ocupado e aborta", r8.codigo === 1 && /lock-sendo-recuperado/.test(r8.motivo), `${r8.codigo} ${r8.motivo}`);

  // ---------- mutex .recover OBSOLETO → NUNCA reivindicado ----------
  // Interleaving P1/P2/P3 da auditoria: antes, um recuperante podia
  // renomear o mutex NOVO de outro. Agora não existe caminho de código
  // que reivindique .recover — o resultado é sempre fail-closed com
  // intervenção manual, e ambos os arquivos ficam preservados intactos.
  const recPath1 = lock1 + ".recover";
  const recObsoleto = JSON.stringify({ ...META(pidMorto(), hostname(), caminhoCanonicoRepo(repoComEspaco)), nonce: "n-velho" });
  writeFileSync(recPath1, recObsoleto);
  const lockAntes = readFileSync(lock1, "utf8");
  const r9 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: () => false, // nada vivo: lock E mutex obsoletos
    fetchHealth: fetchNunca, timeoutEsperaMs: 60, intervaloEsperaMs: 5,
    log: (m) => { if (/Remova manualmente/.test(m)) globalThis.__instrucaoVista = true; },
  });
  t("mutex obsoleto → aborta fail-closed (codigo 1)", r9.codigo === 1 && r9.motivo === "mutex-obsoleto", `${r9.codigo} ${r9.motivo}`);
  t("instrução de remoção manual emitida", globalThis.__instrucaoVista === true);
  t("mutex obsoleto preservado byte-a-byte", readFileSync(recPath1, "utf8") === recObsoleto);
  t("lock principal preservado durante aborto", readFileSync(lock1, "utf8") === lockAntes);

  // mutex corrompido → fail-closed, preservado
  writeFileSync(recPath1, "{lixo");
  const r10 = await adquirirLock({
    cwd: repoComEspaco, lockPath: lock1, tmp: TMP,
    pid: process.pid, pidVivo: () => false,
    fetchHealth: fetchNunca, timeoutEsperaMs: 60, intervaloEsperaMs: 5, log: () => {},
  });
  t("mutex corrompido → fail-closed", r10.codigo === 1 && /mutex/.test(r10.motivo), `${r10.codigo} ${r10.motivo}`);
  t("mutex corrompido preservado", readFileSync(recPath1, "utf8") === "{lixo");
  rmSync(recPath1, { force: true });
  rmSync(lock1, { force: true });

  // ---------- CONCORRÊNCIA REAL: processos Node separados ----------
  // Repo dedicado para não colidir com locks de função acima.
  const repoConc = join(TMP, "repo concorrencia");
  mkdirSync(repoConc, { recursive: true });
  const lockConc = caminhoLock(repoConc); // tmpdir real — mesmo que o CLI usa
  rmSync(lockConc, { force: true });
  rmSync(lockConc + ".recover", { force: true });

  // 4 workers simultâneos, repo vazio → exatamente UM deve adquirir
  let rs = await spawnWorkers(repoConc, 4);
  let cs = codigos(rs);
  t("4 processos simultâneos: exatamente um proprietário", cs.filter((c) => c === 0).length === 1, JSON.stringify(cs));
  t("lock existe após corrida", existsSync(lockConc));
  const metaConc = JSON.parse(readFileSync(lockConc, "utf8"));
  t("metadados do vencedor são válidos", metaConc.v === 1 && Number.isInteger(metaConc.pid) && metaConc.host === hostname());

  // segundo processo NÃO remove o lock ativo do vencedor
  const antesLock = readFileSync(lockConc, "utf8");
  rs = await spawnWorkers(repoConc, 2);
  cs = codigos(rs);
  t("processos subsequentes não assumem lock vivo", cs.every((c) => c !== 0), JSON.stringify(cs));
  t("lock do vencedor permanece intacto", readFileSync(lockConc, "utf8") === antesLock);

  // corrida de recuperação obsoleta: lock com pid morto + 4 workers
  for (let rodada = 0; rodada < 3; rodada++) {
    rmSync(lockConc, { force: true });
    rmSync(lockConc + ".recover", { force: true });
    writeFileSync(lockConc, JSON.stringify(META(pidMorto(), hostname(), caminhoCanonicoRepo(repoConc))));
    rs = await spawnWorkers(repoConc, 4);
    cs = codigos(rs);
    t(`rodada ${rodada + 1}: exatamente um recupera o lock obsoleto`, cs.filter((c) => c === 0).length === 1, JSON.stringify(cs));
    t(`rodada ${rodada + 1}: nenhum mutex residual`, !existsSync(lockConc + ".recover"), "");
    const metaR = existsSync(lockConc) ? JSON.parse(readFileSync(lockConc, "utf8")) : null;
    t(`rodada ${rodada + 1}: lock final é de pid vivo válido`, metaR && Number.isInteger(metaR.pid) && metaR.pid > 0);
  }
  liberarLock({ cwd: repoConc, lockPath: lockConc, pid: process.pid, host: hostname() });

  // ---------- INTERLEAVING P1/P2/P3 — mutex obsoleto jamais reivindicado ----------
  // Reproduz o cenário da auditoria: lock principal obsoleto + mutex
  // .recover obsoleto presentes, 4 processos concorrentes. Com a correção
  // não existe código que reivindique .recover — todo processo deve
  // abortar fail-closed e AMBOS os arquivos devem permanecer intactos.
  // Sem barreira de código necessária: a janela perigosa foi eliminada
  // estruturalmente; o teste prova preservação sob concorrência real.
  rmSync(lockConc, { force: true });
  rmSync(lockConc + ".recover", { force: true });
  const lockStaleConc = JSON.stringify(META(pidMorto(), hostname(), caminhoCanonicoRepo(repoConc)));
  const recStaleConc = JSON.stringify({ ...META(pidMorto(), hostname(), caminhoCanonicoRepo(repoConc)), nonce: "n-velho" });
  writeFileSync(lockConc, lockStaleConc);
  writeFileSync(lockConc + ".recover", recStaleConc);
  rs = await spawnWorkers(repoConc, 4);
  cs = codigos(rs);
  t("mutex obsoleto + 4 processos: nenhum adquire", cs.every((c) => c !== 0), JSON.stringify(cs));
  t("todos abortam por mutex obsoleto/inválido", rs.every((r) => /mutex/.test(r.out)), rs.map((r) => r.out.trim()).join(" | "));
  t("lock principal preservado após corrida", readFileSync(lockConc, "utf8") === lockStaleConc);
  t("mutex .recover preservado após corrida", readFileSync(lockConc + ".recover", "utf8") === recStaleConc);
  rmSync(lockConc + ".recover", { force: true });
  rmSync(lockConc, { force: true });

  // ---------- CLI real: adquirir/liberar ----------
  rmSync(lockConc, { force: true });
  const cliA = spawnSync(process.execPath, [SCRIPT, "adquirir"], {
    cwd: repoConc, encoding: "utf8", timeout: 15000,
    env: { ...process.env, MESTRE_BOOT_LOCK_TIMEOUT_MS: "300" },
  });
  t("CLI adquirir → exit 0", cliA.status === 0, `${cliA.status} ${cliA.stderr} ${cliA.stdout}`);
  const cliMeta = JSON.parse(readFileSync(lockConc, "utf8"));
  t("CLI grava pid do processo pai (dono)", Number.isInteger(cliMeta.pid) && cliMeta.pid > 0, JSON.stringify(cliMeta));
  const cliLib = spawnSync(process.execPath, [SCRIPT, "liberar"], { cwd: repoConc, encoding: "utf8", timeout: 15000 });
  t("CLI liberar → exit 0 (mesmo ppid+host+repo)", cliLib.status === 0, `${cliLib.status} ${cliLib.stderr}`);
  t("lock real removido", !existsSync(lockConc));

  // ---------- .bat: sem bypass, cobertura de liberação ----------
  const bat = readFileSync(BAT, "utf8");
  const iPorta = bat.indexOf("Invoke-WebRequest");
  const iAdq = bat.indexOf("boot-lock.mjs adquirir");
  const iUpd = bat.indexOf("auto-update.mjs");
  const iStart = bat.indexOf("npm run start");
  t(".bat adquire lock após check de porta e antes do updater",
    iPorta > -1 && iAdq > iPorta && iUpd > iAdq, `porta=${iPorta} adq=${iAdq} upd=${iUpd}`);
  t(".bat NÃO tem bypass sem-lock (goto :sem_boot_lock removido)",
    !/goto\s+:sem_boot_lock/.test(bat));
  t(".bat aborta se boot-lock.mjs ausente", /boot-lock\.mjs ausente/.test(bat));
  const liberarCount = (bat.match(/boot-lock\.mjs liberar/g) ?? []).length;
  t(".bat libera o lock em todos os caminhos de falha + fim",
    liberarCount >= 8, String(liberarCount));
  t(".bat sai sem erro quando outra instância assume (codigo 20)",
    /errorlevel%==20 exit \/b 0/.test(bat));

  // lock não fica dentro do worktree (não pode sujar git status)
  t("lock fica fora do repositório (tmpdir)", !caminhoLock(repoComEspaco).startsWith(resolve(repoComEspaco)));
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ok */ }
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exitCode = fail ? 1 : 0;
