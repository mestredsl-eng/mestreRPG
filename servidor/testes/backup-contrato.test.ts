// Testes — backup pré-migration e proteção contra retenção (Issue #155, W16).
// Cobre: manifesto v2 completo (hash+tamanho do banco e da config),
// validação integral obrigatória, rejeição de manifesto ausente/
// incompleto/divergente, e imunidade à retenção de backups protegidos.
// Executar: npm run test:backup-contrato -w servidor
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

before(async () => {
  mkdirSync(dirname(BANCO), { recursive: true });
  mkdirSync(ARQUIVOS, { recursive: true });
  mkdirSync(BACKUPS, { recursive: true });
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
