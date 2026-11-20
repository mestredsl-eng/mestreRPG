// Estado externo durável por instalação — Issue #155 (contrato de recuperação).
//
// Localização canônica (nunca dentro do worktree — sobrevive a
// `git reset --hard`, restauração de banco/arquivos/config e rotação de logs).
// Convenção IDÊNTICA ao Boot Lock (#189) — os dois lados devem produzir o
// mesmo diretório para a mesma instalação:
//   MESTRE_STATE_DIR definido  → <MESTRE_STATE_DIR>/<instalacaoId>/
//   MESTRE_HOME definido       → <MESTRE_HOME>/state/<instalacaoId>/  (sandbox/testes)
//   Windows                    → %LOCALAPPDATA%\MestreRPG\state\<instalacaoId>\
//   Linux c/ XDG               → $XDG_STATE_HOME/mestre-rpg/state/<instalacaoId>/
//   Linux s/ XDG               → ~/.local/state/mestre-rpg/state/<instalacaoId>/
//
// instalacaoId = SHA-256 do caminho canônico real (realpath) do repositório,
// normalizado (caixa baixa no Windows) — delega a scripts/boot-lock.mjs
// para garantir resultado idêntico (caminhoCanonicoRepo/instalacaoId).
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
//   - ausência só é legítima com recibo durável de instalação
//     (instalacao-recibo.json) — sem recibo verificável, o caso é ambíguo
//     e o fluxo mutável deve bloquear.
//
// Recibo de instalação: gravado UMA vez por um caminho de bootstrap
// confiável (updater/.bat/instalador — integração pendente, Etapa 5).
// Vinculado a instalacaoId+repoCanon+protocoloVersao; sua ausência NÃO
// pode ser contornada por manifesto versionado, arquivo tracked, código N,
// ausência de banco ou ausência do próprio state dir.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { caminhoCanonicoRepo, instalacaoId as instalacaoIdBoot } from "./boot-lock.mjs";

export const PROTOCOLO_VERSAO = 1;
export const ARQUIVO_CONSENTIMENTO = "auto-update.json";
export const ARQUIVO_MANIFESTO_PROTOCOLO = "protocolo-auto-update.json";
export const ARQUIVO_RECIBO_INSTALACAO = "instalacao-recibo.json";
export const JOURNAL_UPDATE = "atualizacao-ultima.json";
export const JOURNAL_RESTAURACAO = "restauracao-externa.json";

/** Caminho canônico do repositório — delega ao boot-lock (mesma regra:
 *  realpath nativo, caixa baixa no Windows, fallback para resolve). */
export function caminhoCanonico(dir) {
  return caminhoCanonicoRepo(dir);
}

/** Identidade da instalação: SHA-256 do caminho canônico normalizado.
 *  Idêntica à do Boot Lock por construção (mesma função). */
export function instalacaoId(repoDir) {
  return instalacaoIdBoot(repoDir);
}

/** Base do estado por usuário — espelha boot-lock.diretorioBaseEstado()
 *  com `env` injetável para testes. Manter sincronizado com o boot-lock;
 *  teste-estado-externo.mjs compara os dois resultados. */
export function diretorioBaseEstado(env = process.env) {
  const override = (env.MESTRE_STATE_DIR ?? "").trim();
  if (override) return override;
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(local, "MestreRPG", "state");
  }
  const xdg = (env.XDG_STATE_HOME ?? "").trim();
  const base = xdg || join(homedir(), ".local", "state");
  return join(base, "mestre-rpg", "state");
}

/** Diretório de estado da instalação — RESOLUÇÃO PURA, sem efeito
 *  colateral: NÃO cria o diretório. Escritas passam por
 *  gravarJsonAtomico (que cria o pai na hora de gravar); leituras e
 *  verificações nunca produzem efeitos. */
export function dirEstado(repoDir, env = process.env) {
  const id = instalacaoId(repoDir);
  // MESTRE_HOME é override de sandbox/testes (o servidor de dados vive
  // fora do worktree real); MESTRE_STATE_DIR tem precedência.
  if ((env.MESTRE_HOME ?? "").trim() && !(env.MESTRE_STATE_DIR ?? "").trim()) {
    return join(resolve(env.MESTRE_HOME), "state", id);
  }
  return join(resolve(diretorioBaseEstado(env)), id);
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

/** Leitura NÃO destrutiva de JSON (sem quarentena) — para verificações
 *  que não podem produzir efeitos colaterais. */
function lerJsonCru(caminho) {
  try { return JSON.parse(readFileSync(caminho, "utf8")); }
  catch { return undefined; }
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

// ---------- recibo durável de instalação (Correção 1) ----------
// ÚNICA prova aceita de "instalação já inicializada": um recibo gravado
// por um caminho de bootstrap confiável, vinculado à identidade desta
// instalação. NÃO são recibo: manifesto versionado, arquivo tracked,
// código N, ausência de banco, ausência do state dir ou do protocolo.
// A escrita é responsabilidade do integrador (updater/.bat/instalador —
// Etapa 5, PENDENTE); até lá nenhuma instalação nova é comprovada e o
// caso ambíguo permanece bloqueado (fail-closed).

/** Grava o recibo de instalação inicializada. Chamar UMA vez, somente
 *  após a instalação ser comprovadamente concluída e validada. */
export function gravarReciboInstalacao(repoDir, env = process.env, dadosExtra = {}) {
  return gravarEstado(repoDir, ARQUIVO_RECIBO_INSTALACAO, {
    tipo: "instalacao-inicial",
    criadoEm: new Date().toISOString(),
    ...dadosExtra,
  }, env);
}

/** Lê o recibo sem efeitos colaterais. Retorno:
 *  { status: "ok", dados } | { status: "ausente" } |
 *  { status: "corrompido"|"invalido"|"divergente" } (motivo, sem quarentena). */
export function lerReciboInstalacao(repoDir, env = process.env) {
  const caminho = join(dirEstado(repoDir, env), ARQUIVO_RECIBO_INSTALACAO);
  if (!existsSync(caminho)) return { status: "ausente" };
  const dados = lerJsonCru(caminho);
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return { status: "corrompido" };
  if (dados.protocoloVersao !== PROTOCOLO_VERSAO) return { status: "incompativel" };
  if (dados.instalacaoId !== instalacaoId(repoDir)) return { status: "divergente" };
  if (dados.repoCanon !== caminhoCanonico(repoDir)) return { status: "divergente" };
  if (dados.tipo !== "instalacao-inicial") return { status: "invalido" };
  return { status: "ok", dados };
}

/**
 * Prova de instalação já inicializada — SOMENTE por recibo durável
 * independente e verificável. Sem recibo válido, nada mais prova:
 * ausência de banco, ausência de state dir, manifesto versionado,
 * arquivo tracked ou código N são explicitamente NÃO-recibos.
 * A verificação é livre de efeitos colaterais (não cria diretórios,
 * não move arquivos para quarentena).
 */
export function provarInstalacaoNova(repoDir, env = process.env) {
  const r = lerReciboInstalacao(repoDir, env);
  if (r.status === "ok") return { nova: true, recibo: r.dados };
  return { nova: false, motivo: `sem-recibo-valido (${r.status})` };
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
  const journal = lerJournal(repoDir, JOURNAL_UPDATE, env);
  if (journal.status !== "ausente" && journal.status !== "ok") {
    return { seguroIniciar: false, motivo: `journal-${journal.status}`, detalhes: journal };
  }
  if (journal.status === "ok" && journal.dados?.fase && journal.dados.fase !== "concluido") {
    return { seguroIniciar: false, motivo: "recuperacao-pendente", detalhes: journal.dados };
  }
  const restauracao = lerJournal(repoDir, JOURNAL_RESTAURACAO, env);
  if (restauracao.status !== "ausente" && restauracao.status !== "ok") {
    return { seguroIniciar: false, motivo: `restauracao-${restauracao.status}`, detalhes: restauracao };
  }
  if (restauracao.status === "ok" && restauracao.dados?.fase && !["concluido", "concluido-com-flag"].includes(restauracao.dados.fase)) {
    return { seguroIniciar: false, motivo: "restauracao-em-andamento", detalhes: restauracao.dados };
  }
  // Ambiguidade de estado: o repo carrega o manifesto do protocolo N,
  // mas não há recibo durável de instalação — não é comprovadamente
  // instalação nova NEM comprovadamente estado perdido: bloqueia.
  const manifesto = caminhoManifestoProtocolo(repoDir);
  if (existsSync(manifesto)) {
    const prova = provarInstalacaoNova(repoDir, env);
    if (!prova.nova) {
      return { seguroIniciar: false, motivo: "estado-ambiguo", detalhes: prova };
    }
  }
  return { seguroIniciar: true, motivo: "ok" };
}
