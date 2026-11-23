// Testes — backup pré-migration e proteção contra retenção (Issue #155, W16).
// Cobre: manifesto v2 completo (hash+tamanho do banco e da config),
// validação integral obrigatória, rejeição de manifesto ausente/
// incompleto/divergente, e imunidade à retenção de backups protegidos.
// Executar: npm run test:backup-contrato -w servidor
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { gerarManifestoBackup, sha256Arquivo } from "../../teste-fixture-backup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = resolve(__dirname, "..", "..");

const TMP = mkdtempSync(join(tmpdir(), "backup-contrato-"));
const BANCO = join(TMP, "banco", "mestre-rpg.db");
const ARQUIVOS = join(TMP, "arquivos", "campanhas");
const BACKUPS = join(TMP, "backups");
const STATE = join(TMP, "state");

process.env.MESTRE_BANCO = BANCO;
process.env.MESTRE_ARQUIVOS = ARQUIVOS;
process.env.MESTRE_BACKUPS = BACKUPS;
process.env.MESTRE_STATE_DIR = STATE;

let criarBackup: typeof import("../src/lib/backup.js").criarBackup;
let validarManifestoBackup: typeof import("../src/lib/backup.js").validarManifestoBackup;
let setConfigBackup: typeof import("../src/lib/backup.js").setConfigBackup;
let verificarBackup: typeof import("../src/lib/backup.js").verificarBackup;
let listarBackups: typeof import("../src/lib/backup.js").listarBackups;
let validarBackup: typeof import("../src/lib/validar-backup.js").validarBackup;
let dirsProtegidosBackup: typeof import("../src/lib/protecao-backup.js").dirsProtegidosBackup;
let protegerBackupContraRetencao: typeof import("../src/lib/protecao-backup.js").protegerBackupContraRetencao;
let desprotegerBackupContraRetencao: typeof import("../src/lib/protecao-backup.js").desprotegerBackupContraRetencao;
let referenciadoPorJournal: typeof import("../src/lib/protecao-backup.js").referenciadoPorJournal;
let ee: {
  dirEstado(repoDir: string, env?: NodeJS.ProcessEnv): string;
  instalacaoId(repoDir: string): string;
  caminhoCanonico(repoDir: string): string;
};

/** State dir efetivo desta instalação de teste (MESTRE_STATE_DIR=STATE). */
function stateDirTeste(): string {
  return ee.dirEstado(RAIZ_REPO, process.env);
}
/** Grava um JSON no state dir da instalação de teste. */
function gravarNoState(nome: string, dados: unknown, sub = ""): void {
  const dir = sub ? join(stateDirTeste(), sub) : stateDirTeste();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, nome), JSON.stringify(dados));
}
/** Journal/marker no formato do protocolo (identidade correta). */
function registroValido(dados: Record<string, unknown>): Record<string, unknown> {
  return {
    protocoloVersao: 1,
    instalacaoId: ee.instalacaoId(RAIZ_REPO),
    repoCanon: ee.caminhoCanonico(RAIZ_REPO),
    atualizadoEm: new Date().toISOString(),
    ...dados,
  };
}
/** Remove todos os .json do state dir e de protecao/ (isolamento entre testes). */
function limparStateTeste(): void {
  const dir = stateDirTeste();
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json") || f.includes(".quarentena-")) rmSync(join(dir, f), { force: true });
  }
  const prot = join(dir, "protecao");
  if (existsSync(prot)) {
    for (const f of readdirSync(prot)) {
      if (f.endsWith(".json") || f.includes(".quarentena-")) rmSync(join(prot, f), { force: true });
    }
  }
}

before(async () => {
  mkdirSync(dirname(BANCO), { recursive: true });
  mkdirSync(ARQUIVOS, { recursive: true });
  mkdirSync(BACKUPS, { recursive: true });
  // provisionamento explícito de primeiro bootstrap — mesmo contrato
  // do instalador real: sem a autorização, migrate falha fechado.
  const auth = spawnSync("node", [join(RAIZ_REPO, "scripts", "autorizar-bootstrap.mjs"), "--confirmar-provisionamento"], {
    env: { ...process.env }, encoding: "utf8",
  });
  assert.equal(auth.status, 0, `autorizar-bootstrap falhou: ${auth.stdout}${auth.stderr}`);
  // migrations reais no banco descartável
  const mig = spawnSync("node", [join(RAIZ_REPO, "servidor", "dist", "db", "migrate.js")], {
    env: { ...process.env }, encoding: "utf8",
  });
  assert.equal(mig.status, 0, `migrate falhou: ${mig.stderr}`);
  const mod = await import("../src/lib/backup.js");
  criarBackup = mod.criarBackup;
  validarManifestoBackup = mod.validarManifestoBackup;
  setConfigBackup = mod.setConfigBackup;
  verificarBackup = mod.verificarBackup;
  listarBackups = mod.listarBackups;
  const vb = await import("../src/lib/validar-backup.js");
  validarBackup = vb.validarBackup;
  const pb = await import("../src/lib/protecao-backup.js");
  dirsProtegidosBackup = pb.dirsProtegidosBackup;
  protegerBackupContraRetencao = pb.protegerBackupContraRetencao;
  desprotegerBackupContraRetencao = pb.desprotegerBackupContraRetencao;
  referenciadoPorJournal = pb.referenciadoPorJournal;
  ee = await import("../../scripts/estado-externo.mjs") as typeof ee;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("backup pré-migration — manifesto v2 e proteção (W16)", () => {
  it("criarBackup gera manifesto v2 com hash+tamanho de banco e config", async () => {
    writeFileSync(join(ARQUIVOS, "doc.txt"), "conteudo-teste");
    const r = await criarBackup("manual", "teste w16");
    assert.equal(r.sucesso, true, `erros: ${r.erros}`);
    const man = JSON.parse(readFileSync(join(r.dir, "manifesto.json"), "utf8"));
    assert.equal(man.manifestoVersao, 2);
    assert.equal(typeof man.banco?.size, "number");
    assert.equal(typeof man.banco?.sha256, "string");
    assert.equal(man.banco.sha256.length, 64);
    assert.ok(man.configuracao === undefined || (typeof man.configuracao?.sha256 === "string"));
    assert.deepEqual(validarManifestoBackup(r.dir), []);
  });

  it("manifesto divergente é detectado (arquivo alterado)", async () => {
    const r = await criarBackup("manual", "teste divergente");
    assert.equal(r.sucesso, true);
    const alvo = join(r.dir, "arquivos", "doc.txt");
    if (existsSync(alvo)) writeFileSync(alvo, "adulterado");
    const problemas = validarManifestoBackup(r.dir);
    assert.ok(problemas.length > 0, "divergência não detectada");
  });

  it("manifesto ausente é rejeitado", async () => {
    const r = await criarBackup("manual", "teste sem manifesto");
    assert.equal(r.sucesso, true);
    rmSync(join(r.dir, "manifesto.json"));
    const problemas = validarManifestoBackup(r.dir);
    assert.ok(problemas.some((p) => p.includes("ausente")));
    const v = await verificarBackup(r.id);
    assert.equal(v.ok, false);
  });

  it("backup protegido sobrevive à retenção; desprotegido é rotacionado", async () => {
    // retenção mínima: mantém só o mais recente de cada classe
    await setConfigBackup({ agenda: "manual", retencaoDiarios: 1, retencaoSemanais: 1 });
    await sleep(20);
    const antigo = await criarBackup("manual", "antigo-desprotegido");
    assert.equal(antigo.sucesso, true);
    await sleep(20);
    const protegido = await criarBackup("pre_update", "protegido", { proteger: true, meta: { shaAnterior: "a", shaNovo: "b" } });
    assert.equal(protegido.sucesso, true, `protegido falhou: ${protegido.erros}`);
    assert.ok(existsSync(protegido.dir));
    await sleep(20);
    const novo = await criarBackup("manual", "mais-recente");
    assert.equal(novo.sucesso, true);
    // após a criação de `novo`, a retenção rodou: `antigo` deve ter saído,
    // `protegido` deve permanecer (marker ativo), `novo` permanece (mais recente)
    assert.ok(!existsSync(antigo.dir), "backup antigo desprotegido não foi rotacionado");
    assert.ok(existsSync(protegido.dir), "backup protegido foi removido pela retenção");
    const lista = await listarBackups();
    assert.ok(lista.some((b) => b.filePath === protegido.dir), "backup protegido sumiu do registro");
  });

  it("desproteção aborta diante de evidência inconclusiva em protecao/", async () => {
    const prot = await import("../src/lib/protecao-backup.js");
    const ee = await import("../../scripts/estado-externo.mjs");
    const { createHash } = await import("node:crypto");
    const dirEstado = ee.dirEstado(RAIZ_REPO, process.env);
    const protDir = join(dirEstado, "protecao");
    mkdirSync(protDir, { recursive: true });
    const alvo = join(TMP, "backups", "alvo-desprotecao");
    const idAlvo = createHash("sha256").update(prot.normDir(alvo)).digest("hex").slice(0, 16);
    const markerAlvo = join(protDir, `${idAlvo}.json`);
    try {
      assert.equal(await prot.protegerBackupContraRetencao(alvo, "teste-desprotecao"), true);
      assert.ok(existsSync(markerAlvo));

      // 1) marker CORROMPIDO em protecao/ → referência inconclusiva
      const corrupto = join(protDir, "corrompido.json");
      writeFileSync(corrupto, "{ nao-json");
      assert.equal(await prot.referenciadoPorJournal(alvo), null, "marker corrompido deveria ser inconclusivo");
      assert.equal(await prot.desprotegerBackupContraRetencao(alvo), false, "desproteção deveria abortar");
      assert.ok(existsSync(markerAlvo), "marker do alvo não pode ser removido com evidência inconclusiva");
      rmSync(corrupto, { force: true });

      // 2) marker em QUARENTENA em protecao/ → inconclusivo
      const quarentena = join(protDir, "x.json.quarentena-teste-1");
      writeFileSync(quarentena, "{}");
      assert.equal(await prot.referenciadoPorJournal(alvo), null, "marker em quarentena deveria ser inconclusivo");
      assert.equal(await prot.desprotegerBackupContraRetencao(alvo), false);
      assert.ok(existsSync(markerAlvo));
      rmSync(quarentena, { force: true });

      // 3) marker sem identidade → inconclusivo
      const semId = join(protDir, "sem-identidade.json");
      writeFileSync(semId, JSON.stringify({ backupDir: alvo, motivo: "x" }));
      assert.equal(await prot.referenciadoPorJournal(alvo), null, "marker sem identidade deveria ser inconclusivo");
      assert.equal(await prot.desprotegerBackupContraRetencao(alvo), false);
      assert.ok(existsSync(markerAlvo));
      rmSync(semId, { force: true });

      // 4) marker de terceiro VÁLIDO não bloqueia; sem journal → desprotege
      const outro = join(protDir, "outro-valido.json");
      writeFileSync(outro, JSON.stringify({
        protocoloVersao: 1,
        instalacaoId: ee.instalacaoId(RAIZ_REPO),
        repoCanon: ee.caminhoCanonico(RAIZ_REPO),
        backupDir: join(TMP, "backups", "outro"), motivo: "m", criadoEm: new Date().toISOString(),
      }));
      assert.equal(await prot.referenciadoPorJournal(alvo), false);
      assert.equal(await prot.desprotegerBackupContraRetencao(alvo), true);
      assert.ok(!existsSync(markerAlvo), "marker deveria ter sido removido com prova de não-referência");
      rmSync(outro, { force: true });
    } finally {
      rmSync(markerAlvo, { force: true });
    }
  });

  it("backup pre_update sem proteção possível falha (fail-closed)", async () => {
    // estado externo indisponível: MESTRE_STATE_DIR apontando para caminho inválido
    const envOriginal = process.env.MESTRE_STATE_DIR;
    const bloqueio = join(TMP, "state", "arquivo-bloqueante");
    process.env.MESTRE_STATE_DIR = bloqueio;
    mkdirSync(dirname(bloqueio), { recursive: true });
    writeFileSync(bloqueio, "não é diretório");
    try {
      const r = await criarBackup("pre_update", "sem protecao", { proteger: true });
      assert.equal(r.sucesso, false, "backup protegido deveria falhar sem state dir");
    } finally {
      process.env.MESTRE_STATE_DIR = envOriginal;
      rmSync(bloqueio, { force: true });
    }
  });
});

// =====================================================================
// T2 — varredura de proteção fail-closed (dirsProtegidosBackup)
// Retorno null = varredura inconclusiva → consumidor DEVE abortar a
// retenção. Conjunto vazio só é válido quando a varredura completou.
// =====================================================================
describe("T2 — proteção de backups: varredura fail-closed", () => {
  it("state dir inexistente → null (inconclusivo, NUNCA prova de não-proteção)", async () => {
    limparStateTeste();
    rmSync(stateDirTeste(), { recursive: true, force: true });
    const v = await dirsProtegidosBackup();
    // d822f0e: ausência do state dir é inconclusiva — pode ter sido
    // perdido/movido; retornar Set vazio seria fail-open.
    assert.equal(v, null, "state dir ausente deveria retornar null");
  });

  it("state dir existe mas é ILEGÍVEL (arquivo, não diretório) → null", async () => {
    limparStateTeste();
    // <base>/<id> como ARQUIVO: existsSync(dir)=true, readdirSync falha
    const dir = stateDirTeste();
    mkdirSync(dirname(dir), { recursive: true });
    writeFileSync(dir, "não é diretório");
    const v = await dirsProtegidosBackup();
    assert.equal(v, null, "state dir ilegível deveria retornar null (fail-closed)");
    rmSync(dir, { force: true });
  });

  it("journal corrompido no state dir → null (varredura inconclusiva)", async () => {
    limparStateTeste();
    gravarNoState("atualizacao-ultima.json", registroValido({ fase: "pull" }));
    writeFileSync(join(stateDirTeste(), "journal-corrompido.json"), "{ não-json !!!");
    // journal corrompido com nome de protocolo: qualquer *.json ilegível bloqueia
    const v = await dirsProtegidosBackup();
    assert.equal(v, null);
    limparStateTeste();
  });

  it("journal do protocolo corrompido → null", async () => {
    limparStateTeste();
    writeFileSync(join(stateDirTeste(), "atualizacao-ultima.json"), "lixo{");
    const v = await dirsProtegidosBackup();
    assert.equal(v, null);
    limparStateTeste();
  });

  it("marker corrompido em protecao/ → null", async () => {
    limparStateTeste();
    gravarNoState("x.json", registroValido({}), "protecao");
    writeFileSync(join(stateDirTeste(), "protecao", "quebrado.json"), "{{{");
    const v = await dirsProtegidosBackup();
    assert.equal(v, null);
    limparStateTeste();
  });

  it("registro do protocolo em QUARENTENA (*.quarentena-*) → null (bloqueia)", async () => {
    limparStateTeste();
    // d822f0e: quarentena é fail-closed — um journal/marker quarentenado
    // pode referenciar backup que a retenção não pode tocar. O arquivo
    // nem precisa terminar em .json: o NOME já bloqueia a varredura.
    gravarNoState("atualizacao-ultima.json.quarentena-json-2025", "lixo não-json");
    const v = await dirsProtegidosBackup();
    assert.equal(v, null, "quarentena no state dir deveria bloquear");
    limparStateTeste();
    // idem dentro de protecao/
    gravarNoState("protecao/x.json.quarentena-protocolo-2025", "lixo");
    const v2 = await dirsProtegidosBackup();
    assert.equal(v2, null, "quarentena em protecao/ deveria bloquear");
    limparStateTeste();
  });

  it("journal com identidade divergente → null", async () => {
    limparStateTeste();
    gravarNoState("atualizacao-ultima.json", registroValido({ fase: "pull", instalacaoId: "outra" }));
    const v = await dirsProtegidosBackup();
    assert.equal(v, null);
    limparStateTeste();
  });

  it("journal com protocoloVersao incompatível → null", async () => {
    limparStateTeste();
    gravarNoState("atualizacao-ultima.json", registroValido({ fase: "pull", protocoloVersao: 99 }));
    const v = await dirsProtegidosBackup();
    assert.equal(v, null);
    limparStateTeste();
  });

  it("journal SEM instalacaoId/repoCanon → null (identidade ausente bloqueia)", async () => {
    limparStateTeste();
    // d822f0e: TODO registro do protocolo exige protocoloVersao +
    // instalacaoId + repoCanon presentes e correspondentes — campo
    // ausente é fail-closed (antes era aceito: gap F-identidade).
    gravarNoState("atualizacao-ultima.json", { fase: "pull", backupDir: "C:\fake\bk", protocoloVersao: 1 });
    const v = await dirsProtegidosBackup();
    assert.equal(v, null, "identidade ausente deveria bloquear a varredura");
    limparStateTeste();
    // sem NENHUM campo de identidade → também bloqueia
    gravarNoState("atualizacao-ultima.json", { fase: "pull", backupDir: "C:\fake\bk" });
    const v2 = await dirsProtegidosBackup();
    assert.equal(v2, null, "registro sem identidade nenhuma deveria bloquear");
    limparStateTeste();
  });

  it("journal ativo protege backupDir; journal concluído não protege", async () => {
    limparStateTeste();
    const alvo = join(TMP, "bk-protegido");
    gravarNoState("atualizacao-ultima.json", registroValido({ fase: "pull", backupDir: alvo }));
    let v = await dirsProtegidosBackup();
    assert.ok(v !== null && v.has((await import("../src/lib/protecao-backup.js")).normDir(alvo)), "journal ativo deveria proteger");
    // journal concluído → deixa de proteger
    gravarNoState("atualizacao-ultima.json", registroValido({ fase: "concluido", backupDir: alvo }));
    v = await dirsProtegidosBackup();
    assert.ok(v !== null && !v.has((await import("../src/lib/protecao-backup.js")).normDir(alvo)), "journal concluído não deveria proteger");
    limparStateTeste();
  });
});

// =====================================================================
// T3 — ciclo de vida dos markers de proteção
// =====================================================================
describe("T3 — ciclo de vida dos markers", () => {
  it("marker ativo protege; referenciadoPorJournal distingue journal de marker", async () => {
    limparStateTeste();
    const alvo = join(TMP, "bk-marker");
    const ok = await protegerBackupContraRetencao(alvo, "teste-marker");
    assert.equal(ok, true, "proteção deveria ser gravada");
    const v = await dirsProtegidosBackup();
    const { normDir } = await import("../src/lib/protecao-backup.js");
    assert.ok(v !== null && v.has(normDir(alvo)), "marker ativo deveria proteger");
    // marker sozinho (sem journal) → referenciadoPorJournal = false
    assert.equal(await referenciadoPorJournal(alvo), false);
    const okDes = await desprotegerBackupContraRetencao(alvo);
    assert.equal(okDes, true, "desproteção com não-referência provada deveria remover");
    const v2 = await dirsProtegidosBackup();
    assert.ok(v2 !== null && !v2.has(normDir(alvo)), "marker removido não deveria proteger");
    limparStateTeste();
  });

  it("marker NÃO expira por idade — proteção só termina por conclusão comprovada", async () => {
    limparStateTeste();
    const alvo = join(TMP, "bk-velho");
    // d822f0e removeu a expiração: marker antigo (ate no passado,
    // criadoEm de meses atrás) continua protegendo e NÃO é apagado
    // pela varredura — a janela marker→restaurador pode ser longa.
    // grava via API real e depois REESCREVE com timestamps antigos
    const ok = await protegerBackupContraRetencao(alvo, "teste-velho");
    assert.equal(ok, true);
    const protDir = join(stateDirTeste(), "protecao");
    const arqMarker = readdirSync(protDir).find((f) => f.endsWith(".json"));
    assert.ok(arqMarker, "marker deveria existir");
    const man = JSON.parse(readFileSync(join(protDir, arqMarker), "utf8"));
    man.criadoEm = "2020-01-01T00:00:00.000Z";
    man.ate = "2020-02-01T00:00:00.000Z"; // expirado de propósito
    writeFileSync(join(protDir, arqMarker), JSON.stringify(man));
    const { normDir } = await import("../src/lib/protecao-backup.js");
    const v = await dirsProtegidosBackup();
    assert.ok(v !== null && v.has(normDir(alvo)), "marker antigo NÃO deveria perder proteção por idade");
    // a varredura não removeu o arquivo
    assert.ok(existsSync(join(protDir, arqMarker)), "marker expirado não deveria ser removido pela varredura");
    limparStateTeste();
  });

  it("desproteção INCONCLUSIVA não remove marker", async () => {
    limparStateTeste();
    const alvo = join(TMP, "bk-inconclusivo");
    assert.equal(await protegerBackupContraRetencao(alvo, "teste"), true);
    // torna a referência inconclusiva: journal corrompido no state dir
    writeFileSync(join(stateDirTeste(), "atualizacao-ultima.json"), "{lixo");
    const okDes = await desprotegerBackupContraRetencao(alvo);
    assert.equal(okDes, false, "desproteção inconclusiva deveria retornar false");
    // varredura também inconclusiva → null; mas o marker AINDA existe
    const protDir = join(stateDirTeste(), "protecao");
    assert.ok(readdirSync(protDir).some((f) => f.endsWith(".json")), "marker deveria permanecer após desproteção abortada");
    limparStateTeste();
  });

  it("referenciadoPorJournal com state dir ausente → null (inconclusivo)", async () => {
    limparStateTeste();
    rmSync(stateDirTeste(), { recursive: true, force: true });
    const r = await referenciadoPorJournal(join(TMP, "bk-qq"));
    assert.equal(r, null, "state dir ausente deveria ser inconclusivo, não 'não referenciado'");
  });

  it("journal rollback-concluido MANTÉM proteção (flag ainda pendente)", async () => {
    limparStateTeste();
    const alvo = join(TMP, "bk-rollback");
    gravarNoState("restauracao-externa.json", registroValido({ fase: "rollback-concluido", preRestoreDir: alvo }));
    const v = await dirsProtegidosBackup();
    const { normDir } = await import("../src/lib/protecao-backup.js");
    assert.ok(v !== null && v.has(normDir(alvo)), "rollback-concluido deveria manter proteção");
    limparStateTeste();
  });

  it("journal corrompido → referenciadoPorJournal null (nunca 'concluído')", async () => {
    limparStateTeste();
    const alvo = join(TMP, "bk-ref");
    writeFileSync(join(stateDirTeste(), "atualizacao-ultima.json"), "lixo{");
    // referenciadoPorJournal lê JSONs do state dir — corrompido → null
    const r = await referenciadoPorJournal(alvo);
    assert.equal(r, null, "leitura inconclusiva deveria retornar null");
    limparStateTeste();
  });

  it("falha ao registrar proteção retorna false", async () => {
    limparStateTeste();
    // state dir como ARQUIVO → gravarJsonAtomico falha → false
    const dir = stateDirTeste();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    writeFileSync(dir, "não é diretório");
    const ok = await protegerBackupContraRetencao(join(TMP, "bk-x"), "teste");
    assert.equal(ok, false, "proteção impossível deveria retornar false");
    rmSync(dir, { force: true });
  });
});

// =====================================================================
// T4 — integridade integral de backups (validarBackup — módulo neutro,
// o MESMO usado pelo restaurador offline e por verificarBackup)
// =====================================================================
describe("T4 — integridade do backup: manifesto × inventário real", () => {
  /** Monta um backup mínimo válido: db sqlite real + manifesto v2. */
  function fixtureBackup(sufixo: string, { comCfg = true, comArq = true } = {}) {
    const dir = join(TMP, `bkval_${sufixo}`);
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "mestre-rpg.db"));
    db.exec("create table t (id integer)");
    db.close();
    if (comCfg) {
      mkdirSync(join(dir, "configuracao"), { recursive: true });
      writeFileSync(join(dir, "configuracao", "servidor.json"), JSON.stringify({ porta: 3001 }));
    }
    if (comArq) {
      mkdirSync(join(dir, "arquivos"), { recursive: true });
      writeFileSync(join(dir, "arquivos", "doc.txt"), "conteudo");
    }
    gerarManifestoBackup(dir);
    return dir;
  }
  const manPath = (dir: string) => join(dir, "manifesto.json");
  const lerMan = (dir: string) => JSON.parse(readFileSync(manPath(dir), "utf8"));
  const gravarMan = (dir: string, man: unknown) => writeFileSync(manPath(dir), JSON.stringify(man, null, 2));

  it("backup válido → ok", () => {
    const dir = fixtureBackup("ok");
    const v = validarBackup(dir);
    assert.equal(v.ok, true, `problemas: ${v.problemas.join("; ")}`);
  });

  it("banco alterado após manifesto → sha256 diverge", () => {
    const dir = fixtureBackup("dbalt");
    const db = new Database(join(dir, "mestre-rpg.db"));
    db.exec("insert into t values (1)");
    db.close();
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("sha256") || p.includes("tamanho")), v.problemas.join("; "));
  });

  it("configuração alterada → diverge", () => {
    const dir = fixtureBackup("cfgalt");
    writeFileSync(join(dir, "configuracao", "servidor.json"), JSON.stringify({ porta: 9999 }));
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("configuracao")), v.problemas.join("; "));
  });

  it("arquivo de campanha alterado → diverge", () => {
    const dir = fixtureBackup("arqalt");
    writeFileSync(join(dir, "arquivos", "doc.txt"), "adulterado");
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("doc.txt")), v.problemas.join("; "));
  });

  it("entrada removida do manifesto → arquivo real sem declaração", () => {
    const dir = fixtureBackup("semdecl");
    const man = lerMan(dir);
    delete man.arquivos["arquivos/doc.txt"];
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("sem entrada no manifesto")), v.problemas.join("; "));
  });

  it("entrada extra no manifesto → declaração sem arquivo", () => {
    const dir = fixtureBackup("extra");
    const man = lerMan(dir);
    man.arquivos["arquivos/fantasma.txt"] = { size: 1, sha256: "0".repeat(64) };
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("sem arquivo")), v.problemas.join("; "));
  });

  it("manifesto ausente → rejeita", () => {
    const dir = fixtureBackup("semman");
    rmSync(manPath(dir));
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("ausente")));
  });

  it("manifesto corrompido → rejeita", () => {
    const dir = fixtureBackup("manruim");
    writeFileSync(manPath(dir), "{lixo");
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
  });

  it("versão incompatível → rejeita", () => {
    const dir = fixtureBackup("ver");
    const man = lerMan(dir);
    man.manifestoVersao = 1;
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("manifestoVersao")));
  });

  it("manifesto incompleto (sem banco/configuracao/arquivos) → rejeita", () => {
    const dir = fixtureBackup("incompleto");
    gravarMan(dir, { manifestoVersao: 2 });
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.length >= 3, v.problemas.join("; "));
  });

  it("caminho traversal em arquivos → rejeita", () => {
    const dir = fixtureBackup("trav");
    const man = lerMan(dir);
    man.arquivos["../escape.txt"] = { size: 1, sha256: "0".repeat(64) };
    man.arquivos["arquivos/../../etc/passwd"] = { size: 1, sha256: "0".repeat(64) };
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("caminho inválido")), v.problemas.join("; "));
  });

  it("caminho absoluto / unidade Windows → rejeita", () => {
    const dir = fixtureBackup("abs");
    const man = lerMan(dir);
    man.arquivos["/etc/passwd"] = { size: 1, sha256: "0".repeat(64) };
    man.arquivos["C:/Windows/x"] = { size: 1, sha256: "0".repeat(64) };
    man.arquivos["arquivos/C:/x"] = { size: 1, sha256: "0".repeat(64) };
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("caminho inválido") || p.includes("fora de")), v.problemas.join("; "));
  });

  it("symlink interno no backup → rejeita", () => {
    const dir = fixtureBackup("sym");
    const alvo = join(TMP, "alvo-sym.txt");
    writeFileSync(alvo, "fora");
    let okLink = true;
    try { symlinkSync(alvo, join(dir, "arquivos", "link.txt")); }
    catch { okLink = false; }
    if (!okLink) { console.log("  (skip: sem privilégio de symlink)"); return; }
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("symlink")), v.problemas.join("; "));
  });

  it("arquivo declarado inexistente → rejeita", () => {
    const dir = fixtureBackup("fantasma");
    const man = lerMan(dir);
    man.banco = { size: 999999, sha256: "f".repeat(64) };
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
  });

  it("configuração real sem entrada no manifesto → rejeita (inventário nos dois sentidos)", () => {
    const dir = fixtureBackup("cfgsolta");
    // config existe mas manifesto declara configuracao:null
    const man = lerMan(dir);
    man.configuracao = null;
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("sem entrada no manifesto")), v.problemas.join("; "));
  });

  it("configuração ausente com declaracao null explícita → válido", () => {
    const dir = fixtureBackup("cfgnull", { comCfg: false });
    const man = lerMan(dir);
    assert.equal(man.configuracao, null);
    const v = validarBackup(dir);
    assert.equal(v.ok, true, v.problemas.join("; "));
  });

  it("configuração ausente do manifesto (chave faltando) → rejeita", () => {
    const dir = fixtureBackup("cfgkey", { comCfg: false });
    const man = lerMan(dir);
    delete man.configuracao;
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("configuracao")), v.problemas.join("; "));
  });

  it("banco com integrity_check inválido → rejeita", () => {
    const dir = fixtureBackup("dbruim");
    // corrompe o db DEPOIS do manifesto → integrity_check falha
    // (e o sha também diverge — ambos são problemas legítimos)
    const p = join(dir, "mestre-rpg.db");
    const fd = readFileSync(p);
    const buf = Buffer.from(fd);
    for (let i = 100; i < Math.min(500, buf.length); i++) buf[i] = 0xab;
    writeFileSync(p, buf);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p2) => p2.includes("integrity") || p2.includes("sha256") || p2.includes("não foi possível")), v.problemas.join("; "));
  });

  it("arquivo > 2 GiB: hash SEMPRE verificado em streaming — sha256 divergente rejeita", () => {
    const dir = fixtureBackup("big");
    const grande = join(dir, "arquivos", "grande.bin");
    writeFileSync(grande, "x");
    const TAM = 2 * 1024 * 1024 * 1024 + 1; // > 2 GiB
    truncateSync(grande, TAM); // sparse: leitura rápida de zeros
    const man = lerMan(dir);
    // tamanho CORRETO + sha256 propositalmente errado: se o validador
    // pulasse o hash (comportamento antigo), passaria — a rejeição
    // prova que o hash é calculado em streaming sem limite de tamanho.
    man.arquivos["arquivos/grande.bin"] = { size: TAM, sha256: "0".repeat(64) };
    gravarMan(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false, ">2GiB com hash divergente deveria rejeitar");
    assert.ok(
      v.problemas.some((p) => p.includes("grande.bin") && p.includes("sha256")),
      `problema de hash ausente: ${v.problemas.join("; ")}`,
    );
    rmSync(grande, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("raiz do backup como symlink/junction → REJEITA", () => {
    const real = fixtureBackup("raizreal");
    const link = join(TMP, "bklink");
    let okLink = true;
    try { symlinkSync(real, link, "junction"); }
    catch { okLink = false; }
    if (!okLink) { console.log("  (skip: sem privilégio de symlink)"); return; }
    // d822f0e: lstat na raiz — symlink é proibido antes de qualquer leitura
    const v = validarBackup(link);
    assert.equal(v.ok, false, "raiz symlink deveria ser rejeitada");
    assert.ok(v.problemas.some((p) => p.includes("symlink") || p.includes("raiz")), v.problemas.join("; "));
    rmSync(link, { force: true });
  });
});

// =====================================================================
// T5 — formato LEGADO v1 (backups da v1.0.8 e anteriores, Issue #266/W16)
// manifesto.json sem 'manifestoVersao': { arquivos: {"arquivos/<rel>":
// {size,sha256}}, criadoEm, versao }. Contrato = verificador v1.0.8:
// integridade SQLite + size/sha256 declarados + inventário restrito.
// =====================================================================
describe("T5 — backup legado v1 (formato v1.0.8)", () => {
  /** Monta um backup no formato legado v1. */
  function fixtureLegado(sufixo: string) {
    const dir = join(TMP, `bkleg_${sufixo}`);
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "mestre-rpg.db"));
    db.exec("create table t (id integer)");
    db.close();
    mkdirSync(join(dir, "arquivos", "campanha"), { recursive: true });
    writeFileSync(join(dir, "arquivos", "campanha", "doc.txt"), "conteudo legado");
    mkdirSync(join(dir, "configuracao"), { recursive: true });
    writeFileSync(join(dir, "configuracao", "servidor.json"), JSON.stringify({ porta: 3001 }));
    const arq: Record<string, { size: number; sha256: string }> = {};
    for (const rel of ["arquivos/campanha/doc.txt"]) {
      const p = join(dir, ...rel.split("/"));
      arq[rel] = { size: statSync(p).size, sha256: sha256Arquivo(p) };
    }
    writeFileSync(join(dir, "manifesto.json"), JSON.stringify({
      arquivos: arq, criadoEm: new Date().toISOString(), versao: "1.0.8",
    }, null, 2));
    return dir;
  }
  const manLeg = (dir: string) => JSON.parse(readFileSync(join(dir, "manifesto.json"), "utf8"));
  const gravarLeg = (dir: string, man: unknown) => writeFileSync(join(dir, "manifesto.json"), JSON.stringify(man, null, 2));

  it("backup legado válido → ok", () => {
    const dir = fixtureLegado("ok");
    const v = validarBackup(dir);
    assert.equal(v.ok, true, `problemas: ${v.problemas.join("; ")}`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("legado sem configuração → ok (config não existia como obrigatório no v1)", () => {
    const dir = fixtureLegado("semcfg");
    rmSync(join(dir, "configuracao"), { recursive: true, force: true });
    const v = validarBackup(dir);
    assert.equal(v.ok, true, `problemas: ${v.problemas.join("; ")}`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("legado com arquivo adulterado → sha256 diverge → rejeita", () => {
    const dir = fixtureLegado("adulterado");
    writeFileSync(join(dir, "arquivos", "campanha", "doc.txt"), "conteudo adulterado!");
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("sha256") || p.includes("tamanho")), v.problemas.join("; "));
    rmSync(dir, { recursive: true, force: true });
  });

  it("legado com arquivo extra não declarado → rejeita", () => {
    const dir = fixtureLegado("extra");
    writeFileSync(join(dir, "arquivos", "campanha", "extra.txt"), "intruso");
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("sem entrada no manifesto")), v.problemas.join("; "));
    rmSync(dir, { recursive: true, force: true });
  });

  it("legado com traversal no caminho declarado → rejeita", () => {
    const dir = fixtureLegado("traversal");
    const man = manLeg(dir);
    man.arquivos["arquivos/../escape.txt"] = { size: 1, sha256: "0".repeat(64) };
    gravarLeg(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("caminho inválido")), v.problemas.join("; "));
    rmSync(dir, { recursive: true, force: true });
  });

  it("manifesto sem 'manifestoVersao' e sem 'arquivos' → formato desconhecido → rejeita", () => {
    const dir = fixtureLegado("desconhecido");
    gravarLeg(dir, { criadoEm: new Date().toISOString(), versao: "1.0.8" });
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("não reconhecido")), v.problemas.join("; "));
    rmSync(dir, { recursive: true, force: true });
  });

  it("manifestoVersao:1 explícito → NÃO é legado → rejeita por versão", () => {
    const dir = fixtureLegado("v1explicito");
    const man = { ...manLeg(dir), manifestoVersao: 1 };
    gravarLeg(dir, man);
    const v = validarBackup(dir);
    assert.equal(v.ok, false);
    assert.ok(v.problemas.some((p) => p.includes("manifestoVersao")), v.problemas.join("; "));
    rmSync(dir, { recursive: true, force: true });
  });
});
