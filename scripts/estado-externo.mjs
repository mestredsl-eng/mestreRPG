// Estado externo durável por instalação — Issue #155 (contrato de recuperação).
//
// Localização canônica (nunca dentro do worktree — sobrevive a
// `git reset --hard`, restauração de banco/arquivos/config e rotação de logs):
//   MESTRE_STATE_DIR definido  → <MESTRE_STATE_DIR>/<instalacaoId>/
//   MESTRE_HOME definido       → <MESTRE_HOME>/state/<instalacaoId>/  (sandbox/testes)
//   Windows                    → %LOCALAPPDATA%\MestreRPG\state\<instalacaoId>\
//   demais                    → $XDG_STATE_HOME/mestre-rpg/<instalacaoId>/
//                               ou ~/.mestre-rpg/<instalacaoId>/
//
// instalacaoId = SHA-256 do caminho canônico real (realpath) do repositório,
// normalizado (caixa baixa no Windows). Mesma convenção do Boot Lock (#189).
//
// Três conceitos separados por desenho:
//   - consentimento  → configuracao/auto-update.json (preferência local,
//                      gitignored, vinculada a instalacaoId);
//   - journal        → <stateDir>/<nome>.json (update/restauração em curso);
//   - identidade     → protocoloVersao + instalacaoId + repoCanon gravados
//                      em cada registro.
//
// Regras fail-closed:
//   - JSON corrompido/inválido → quarentena + status "corrompido" (nunca
//     interpretado como ausência);
//   - protocoloVersao desconhecida → "incompativel";
//   - instalacaoId/repoCanon divergentes → "identidade-divergente";
//   - ausência só é legítima quando comprovadamente instalação nova —
//     caso ambíguo deve bloquear o fluxo mutável (ver avaliarBoot).
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PROTOCOLO_VERSAO = 1;
export const ARQUIVO_CONSENTIMENTO = "auto-update.json";
export const ARQUIVO_MANIFESTO_PROTOCOLO = "protocolo-auto-update.json";

/** Caminho canônico do repositório: realpath resolve junctions, 8.3 e
 *  diferenças de caixa; fallback para resolve(). Idêntico ao boot-lock. */
export function caminhoCanonico(dir) {
  const abs = resolve(dir);
  try {
    const real = realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  }
}

/** Identidade da instalação: SHA-256 do caminho canônico normalizado. */
export function instalacaoId(repoDir) {
  return createHash("sha256").update(caminhoCanonico(repoDir)).digest("hex");
}

/** Diretório de estado da instalação (cria se necessário). */
export function dirEstado(repoDir, env = process.env) {
  const id = instalacaoId(repoDir);
  let base;
  if (env.MESTRE_STATE_DIR) base = join(resolve(env.MESTRE_STATE_DIR), id);
  else if (env.MESTRE_HOME) base = join(resolve(env.MESTRE_HOME), "state", id);
  else if (process.platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    base = join(local, "MestreRPG", "state", id);
  } else {
    base = join(env.XDG_STATE_HOME ?? join(homedir(), ".mestre-rpg"), "mestre-rpg", id);
  }
  mkdirSync(base, { recursive: true });
  return base;
}

/** Caminho do arquivo de consentimento (dentro do repo, gitignored). */
export function caminhoConsentimento(repoDir) {
  return join(repoDir, "configuracao", ARQUIVO_CONSENTIMENTO);
}

/** Manifesto versionado do protocolo (tracked — marcador de versão, NÃO
 *  prova de instalação nova). */
export function caminhoManifestoProtocolo(repoDir) {
  return join(repoDir, "scripts", ARQUIVO_MANIFESTO_PROTOCOLO);
}

function tmpUnico(dir, nome) {
  return join(dir, `.${nome}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
}

/** Escrita atômica: tmp exclusivo no mesmo diretório → flush/fsync → rename. */
export function gravarJsonAtomico(caminho, obj) {
  const dir = dirname(caminho);
  mkdirSync(dir, { recursive: true });
  const tmp = tmpUnico(dir, caminho.split(/[\\/]/).pop());
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(obj, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, caminho);
}

/** Move arquivo corrompido para quarentena datada; nunca apaga. */
export function colocarEmQuarentena(caminho, motivo = "corrompido") {
  if (!existsSync(caminho)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const destino = `${caminho}.quarentena-${motivo}-${ts}`;
  try { renameSync(caminho, destino); return destino; } catch { return null; }
}

/**
 * Lê um registro JSON do estado externo com classificação fail-closed.
 * Retorno: { status: "ausente" } |
 *          { status: "ok", dados } |
 *          { status: "corrompido", quarentena } |
 *          { status: "incompativel", quarentena } |
 *          { status: "identidade-divergente", quarentena }.
 * `esperado` = { instalacaoId?, repoCanon?, protocoloVersao? } — quando
 * informado, divergências são classificadas (nunca tratadas como ausência).
 */
export function lerEstado(caminho, esperado = {}) {
  if (!existsSync(caminho)) return { status: "ausente" };
  let dados;
  try {
    dados = JSON.parse(readFileSync(caminho, "utf8"));
  } catch {
    return { status: "corrompido", quarentena: colocarEmQuarentena(caminho, "json") };
  }
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
    return { status: "corrompido", quarentena: colocarEmQuarentena(caminho, "json") };
  }
  const pv = esperado.protocoloVersao ?? PROTOCOLO_VERSAO;
  if (dados.protocoloVersao !== pv) {
    return { status: "incompativel", quarentena: colocarEmQuarentena(caminho, "protocolo"), dados };
  }
  if (esperado.instalacaoId && dados.instalacaoId !== esperado.instalacaoId) {
    return { status: "identidade-divergente", quarentena: colocarEmQuarentena(caminho, "identidade"), dados };
  }
  if (esperado.repoCanon && dados.repoCanon !== esperado.repoCanon) {
    return { status: "identidade-divergente", quarentena: colocarEmQuarentena(caminho, "repo"), dados };
  }
  return { status: "ok", dados };
}

/** Grava registro com identidade/protocolo padrão da instalação. */
export function gravarEstado(repoDir, nome, dados, env = process.env) {
  const registro = {
    protocoloVersao: PROTOCOLO_VERSAO,
    instalacaoId: instalacaoId(repoDir),
    repoCanon: caminhoCanonico(repoDir),
    ...dados,
  };
  gravarJsonAtomico(join(dirEstado(repoDir, env), nome), registro);
  return registro;
}

export function lerJournal(repoDir, nome, env = process.env) {
  return lerEstado(join(dirEstado(repoDir, env), nome), {
    instalacaoId: instalacaoId(repoDir),
    repoCanon: caminhoCanonico(repoDir),
  });
}

/**
 * Consentimento: preferência local de atualização automática.
 * Retorno: { status: "aceito"|"recusado"|"ausente"|"invalido"|"divergente", dados? }.
 * "invalido"/"divergente" são fail-closed para o UPDATER — nunca autorizam.
 */
export function lerConsentimento(repoDir) {
  const caminho = caminhoConsentimento(repoDir);
  if (!existsSync(caminho)) return { status: "ausente" };
  let dados;
  try { dados = JSON.parse(readFileSync(caminho, "utf8")); }
  catch { return { status: "invalido" }; }
  if (!dados || typeof dados !== "object") return { status: "invalido" };
  if (dados.instalacaoId && dados.instalacaoId !== instalacaoId(repoDir)) {
    return { status: "divergente", dados };
  }
  if (dados.consentimento === "aceito" || dados.consentimento === "recusado") {
    return { status: dados.consentimento, dados };
  }
  return { status: "invalido", dados };
}

export function gravarConsentimento(repoDir, consentimento, dadosExtra = {}) {
  const registro = {
    consentimento,
    instalacaoId: instalacaoId(repoDir),
    decididoEm: new Date().toISOString(),
    ...dadosExtra,
  };
  gravarJsonAtomico(caminhoConsentimento(repoDir), registro);
  return registro;
}

/**
 * Prova de instalação nova: state dir nunca criado E nenhum sinal de uso
 * prévio da instalação (banco de dados existente). Sem essa prova, a
 * ausência de estado é AMBÍGUA → o chamador deve bloquear o fluxo mutável.
 * Limite residual documentado: instalação que rodou N mas nunca criou o
 * banco e perdeu o state dir é indistinguível de instalação nova.
 */
export function provarInstalacaoNova(repoDir) {
  const dir = dirEstado(repoDir);
  const marcador = join(dir, "protocolo-ativo.json");
  if (existsSync(marcador)) return { nova: false, motivo: "protocolo-ja-ativado" };
  const banco = join(repoDir, "banco", "mestre-rpg.db");
  if (existsSync(banco)) return { nova: false, motivo: "banco-existente" };
  return { nova: true };
}

/**
 * Avaliação de boot para a versão N+: decide se o fluxo mutável pode
 * prosseguir. Retorno: { seguroIniciar: bool, motivo, detalhes? }.
 * - journal corrompido/incompatível/identidade divergente → bloqueia;
 * - ausência ambígua de estado (protocolo deveria existir) → bloqueia;
 * - recuperação pendente NUNCA é bloqueada por consentimento.
 */
export function avaliarBoot(repoDir, env = process.env) {
  const dir = dirEstado(repoDir, env);
  const journal = lerJournal(repoDir, "atualizacao-ultima.json", env);
  if (journal.status !== "ausente" && journal.status !== "ok") {
    return { seguroIniciar: false, motivo: `journal-${journal.status}`, detalhes: journal };
  }
  if (journal.status === "ok" && journal.dados?.fase && journal.dados.fase !== "concluido") {
    return { seguroIniciar: false, motivo: "recuperacao-pendente", detalhes: journal.dados };
  }
  const restauracao = lerJournal(repoDir, "restauracao-externa.json", env);
  if (restauracao.status !== "ausente" && restauracao.status !== "ok") {
    return { seguroIniciar: false, motivo: `restauracao-${restauracao.status}`, detalhes: restauracao };
  }
  if (restauracao.status === "ok" && restauracao.dados?.fase && !["concluido", "concluido-com-flag"].includes(restauracao.dados.fase)) {
    return { seguroIniciar: false, motivo: "restauracao-em-andamento", detalhes: restauracao.dados };
  }
  // Ambiguidade de estado: marcador de protocolo no repo existe mas o
  // state dir nunca foi ativado → não é comprovadamente instalação nova.
  const manifesto = caminhoManifestoProtocolo(repoDir);
  if (existsSync(manifesto)) {
    const prova = provarInstalacaoNova(repoDir);
    if (!prova.nova) {
      return { seguroIniciar: false, motivo: "estado-ambiguo", detalhes: prova };
    }
  }
  return { seguroIniciar: true, motivo: "ok" };
}
