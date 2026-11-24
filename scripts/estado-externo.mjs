// Estado externo durável por instalação — Issue #155 (contrato de recuperação).
//
// Localização canônica (nunca dentro do worktree — sobrevive a
// `git reset --hard`, restauração de banco/arquivos/config e rotação de logs).
// Convenção IDÊNTICA ao Boot Lock (#189) — os dois lados devem produzir o
// mesmo diretório para a mesma instalação:
//   MESTRE_STATE_DIR definido  → <MESTRE_STATE_DIR>/<instalacaoId>/
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
//   - ausência só é legítima para primeiro bootstrap mediante
//     autorização de uso único (bootstrap-autorizacao.json) emitida
//     por produtor confiável — sem ela, o caso é ambíguo e o fluxo
//     mutável deve bloquear. Recibo permanente de instalação concluída
//     NÃO autoriza banco ausente/vazio como primeira instalação.
//
// Recibo de instalação: gravado UMA vez por um caminho de bootstrap
// confiável (updater/.bat/instalador — integração pendente, Etapa 5).
// Vinculado a instalacaoId+repoCanon+protocoloVersao; sua ausência NÃO
// pode ser contornada por manifesto versionado, arquivo tracked, código N,
// ausência de banco ou ausência do próprio state dir.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, writeSync,
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
 *  verificações nunca produzem efeitos.
 *  Paridade EXATA com boot-lock.diretorioEstado(): mesmo base (somente
 *  MESTRE_STATE_DIR|LOCALAPPDATA|XDG — MESTRE_HOME NÃO participa, pois
 *  é raiz de DADOS, não de estado) e mesmo <instalacaoId>. Overrides de
 *  teste: APENAS MESTRE_STATE_DIR (explícito e compatível). */
export function dirEstado(repoDir, env = process.env) {
  return join(diretorioBaseEstado(env), instalacaoId(repoDir));
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

/** Flush do diretório pai após rename/unlink.
 * POSIX permite fsync do diretório para persistir a entrada de diretório.
 * No Windows o Node não expõe um handle de diretório com as flags
 * necessárias; o arquivo ainda recebe fsync antes do rename atômico. */
function fsyncDiretorio(dir) {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** Escrita atômica: tmp exclusivo no mesmo diretório → flush/fsync → rename
 * + fsync do diretório pai, persistindo também a troca de nome no POSIX. */
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
  fsyncDiretorio(dir);
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

/** Remove um journal concluído e persiste a remoção da entrada no POSIX.
 * Não chamar para journals pendentes ou corrompidos. */
export function removerEstado(repoDir, nome, env = process.env) {
  const dir = dirEstado(repoDir, env);
  rmSync(join(dir, nome), { force: true });
  if (existsSync(dir)) fsyncDiretorio(dir);
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

// ---------- ciclo de vida do recibo/autorização de instalação ----------
// Três estados distintos, nunca confundidos:
//   1) PRIMEIRO BOOTSTRAP — autorizado por `bootstrap-autorizacao.json`,
//      arquivo de USO ÚNICO gravado por um caminho de bootstrap
//      confiável (produtor REAL pendente — Etapa 5). Consumido de forma
//      durável (rename atômico) no ato da autorização: um crash não
//      permite replay. Enquanto não existir produtor confiável, nenhum
//      arquivo válido é escrito e DB ausente/vazio permanece bloqueado.
//   2) INSTALAÇÃO CONCLUÍDA — `instalacao-recibo.json` permanente,
//      gravado UMA vez após instalação comprovadamente concluída e
//      validada. Prova que a instalação EXISTIU — NÃO autoriza banco
//      ausente/vazio como "primeira instalação" (isso é "instalação
//      existente cujo banco foi perdido" → bloqueio).
//   3) BOOTSTRAP INTERROMPIDO — autorização consumida sem recibo
//      permanente: estado ambíguo, exige intervenção.
// NÃO são prova de nada: manifesto versionado, arquivo tracked, código
// N, ausência de banco, ausência do state dir ou do protocolo.

export const ARQUIVO_AUTORIZACAO_BOOTSTRAP = "bootstrap-autorizacao.json";
export const ARQUIVO_PROVISIONAMENTO = "provisionamento.json";
const PREFIXO_AUTORIZACAO_CONSUMIDA = "bootstrap-autorizacao.consumida-";
const TIPO_RECIBO_CONCLUIDA = "instalacao-concluida";
const TIPO_AUTORIZACAO = "primeiro-bootstrap";
const TIPO_PROVISIONAMENTO = "provisionamento";

/** Grava o recibo de instalação CONCLUÍDA. Chamar UMA vez, somente
 *  após a instalação ser comprovadamente concluída e validada. */
export function gravarReciboInstalacao(repoDir, env = process.env, dadosExtra = {}) {
  return gravarEstado(repoDir, ARQUIVO_RECIBO_INSTALACAO, {
    tipo: TIPO_RECIBO_CONCLUIDA,
    criadoEm: new Date().toISOString(),
    ...dadosExtra,
  }, env);
}

/** Lê o recibo sem efeitos colaterais. Retorno:
 *  { status: "ok", dados } | { status: "ausente" } |
 *  { status: "corrompido"|"incompativel"|"divergente"|"invalido" }. */
export function lerReciboInstalacao(repoDir, env = process.env) {
  const caminho = join(dirEstado(repoDir, env), ARQUIVO_RECIBO_INSTALACAO);
  if (!existsSync(caminho)) return { status: "ausente" };
  const dados = lerJsonCru(caminho);
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return { status: "corrompido" };
  if (dados.protocoloVersao !== PROTOCOLO_VERSAO) return { status: "incompativel" };
  if (dados.instalacaoId !== instalacaoId(repoDir)) return { status: "divergente" };
  if (dados.repoCanon !== caminhoCanonico(repoDir)) return { status: "divergente" };
  if (dados.tipo !== TIPO_RECIBO_CONCLUIDA) return { status: "invalido" };
  return { status: "ok", dados };
}

/** Grava a autorização de primeiro bootstrap — SOMENTE o produtor
 *  confiável futuro (instalador/.bat/updater, integração pendente).
 *  Nenhum código de produção chama esta função hoje; ela existe para
 *  definir o formato que o produtor deverá escrever. */
export function gravarAutorizacaoBootstrap(repoDir, env = process.env, dadosExtra = {}) {
  return gravarEstado(repoDir, ARQUIVO_AUTORIZACAO_BOOTSTRAP, {
    tipo: TIPO_AUTORIZACAO,
    emitidaEm: new Date().toISOString(),
    ...dadosExtra,
  }, env);
}

/** Lê a autorização SEM consumi-la (verificação não destrutiva). */
export function lerAutorizacaoBootstrap(repoDir, env = process.env) {
  const caminho = join(dirEstado(repoDir, env), ARQUIVO_AUTORIZACAO_BOOTSTRAP);
  if (!existsSync(caminho)) return { status: "ausente" };
  const dados = lerJsonCru(caminho);
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return { status: "corrompido" };
  if (dados.protocoloVersao !== PROTOCOLO_VERSAO) return { status: "incompativel" };
  if (dados.instalacaoId !== instalacaoId(repoDir)) return { status: "divergente" };
  if (dados.repoCanon !== caminhoCanonico(repoDir)) return { status: "divergente" };
  if (dados.tipo !== TIPO_AUTORIZACAO) return { status: "invalido" };
  return { status: "ok", dados };
}

/** Grava o marcador de PROVISIONAMENTO — prova positiva e independente
 *  de que uma ação explícita de provisionamento ocorreu neste state
 *  dir (criada pelo entrypoint scripts/autorizar-bootstrap.mjs com
 *  --confirmar-provisionamento, ou pelo instalador/.bat na P10-C).
 *  Não autoriza nada por si só: é pré-condição do produtor de
 *  primeiro bootstrap. Idempotente por natureza — regravar só atualiza
 *  o timestamp; chamadores NUNCA devem regravar sobre marcador
 *  inválido/divergente (o produtor bloqueia e nada é sobrescrito). */
export function gravarProvisionamento(repoDir, env = process.env, dadosExtra = {}) {
  return gravarEstado(repoDir, ARQUIVO_PROVISIONAMENTO, {
    tipo: TIPO_PROVISIONAMENTO,
    provisionadoEm: new Date().toISOString(),
    ...dadosExtra,
  }, env);
}

/** Lê o marcador de provisionamento sem efeitos colaterais. Mesmo
 *  contrato de validação dos demais artefatos: ok | ausente |
 *  corrompido | incompativel | divergente | invalido. */
export function lerProvisionamento(repoDir, env = process.env) {
  const caminho = join(dirEstado(repoDir, env), ARQUIVO_PROVISIONAMENTO);
  if (!existsSync(caminho)) return { status: "ausente" };
  const dados = lerJsonCru(caminho);
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return { status: "corrompido" };
  if (dados.protocoloVersao !== PROTOCOLO_VERSAO) return { status: "incompativel" };
  if (dados.instalacaoId !== instalacaoId(repoDir)) return { status: "divergente" };
  if (dados.repoCanon !== caminhoCanonico(repoDir)) return { status: "divergente" };
  if (dados.tipo !== TIPO_PROVISIONAMENTO) return { status: "invalido" };
  return { status: "ok", dados };
}

/** Remove SOMENTE o marcador de provisionamento — uso exclusivo do
 *  rollback atômico do entrypoint: quando o marcador foi criado
 *  NESTA execução e o bootstrap foi bloqueado, ele não pode persistir
 *  como prova de um provisionamento que não se concretizou (senão uma
 *  perda posterior do banco o transformaria em "prova antiga").
 *  NUNCA chamar sobre marcador preexistente — chamadores garantem
 *  que só removem o que acabaram de gravar. */
export function removerProvisionamento(repoDir, env = process.env) {
  rmSync(join(dirEstado(repoDir, env), ARQUIVO_PROVISIONAMENTO), { force: true });
}

/** Diagnóstico NÃO destrutivo do estado de instalação — usado para
 *  mensagens fail-closed e pela avaliação de boot. Retorno:
 *  "primeiro-bootstrap"      → autorização válida ainda não consumida;
 *  "instalacao-concluida"     → recibo permanente válido (banco ausente
 *                               aqui significa BANCO PERDIDO, bloqueio);
 *  "bootstrap-interrompido"   → autorização consumida sem recibo;
 *  "desconhecido"             → nada que prove estado legítimo. */
export function diagnosticarBootstrap(repoDir, env = process.env) {
  const dir = dirEstado(repoDir, env);
  const auth = lerAutorizacaoBootstrap(repoDir, env);
  if (auth.status === "ok") return "primeiro-bootstrap";
  const recibo = lerReciboInstalacao(repoDir, env);
  if (recibo.status === "ok") return "instalacao-concluida";
  let nomes = [];
  try { nomes = existsSync(dir) ? readdirSync(dir) : []; }
  catch { return "state-ilegivel"; }
  if (nomes.some((n) => n.startsWith(PREFIXO_AUTORIZACAO_CONSUMIDA))) return "bootstrap-interrompido";
  if (recibo.status !== "ausente") return `recibo-${recibo.status}`;
  if (auth.status !== "ausente") return `autorizacao-${auth.status}`;
  return "desconhecido";
}

/**
 * Consome a autorização de primeiro bootstrap — USO ÚNICO e durável.
 * O rename atômico acontece ANTES da validação do conteúdo: quem perde
 * a corrida recebe ENOENT e ninguém reutiliza a autorização. O arquivo
 * consumido é preservado como evidência (sem sufixo .json — não entra
 * em varreduras de protocolo). Recibo permanente válido ⇒ instalação
 * já concluída ⇒ autorização NÃO se aplica (replay impossível).
 * Retorno: { autorizado:true, dados, consumido } |
 *          { autorizado:false, motivo, consumido? }.
 */
export function consumirAutorizacaoBootstrap(repoDir, env = process.env) {
  const dir = dirEstado(repoDir, env);
  const caminho = join(dir, ARQUIVO_AUTORIZACAO_BOOTSTRAP);
  if (!existsSync(caminho)) {
    return { autorizado: false, motivo: diagnosticarBootstrap(repoDir, env) };
  }
  // Recibo permanente válido ⇒ instalação concluída: autorização de
  // primeiro bootstrap é irrelevante e NÃO é consumida (evidência fica).
  if (lerReciboInstalacao(repoDir, env).status === "ok") {
    return { autorizado: false, motivo: "instalacao-concluida" };
  }
  const consumido = join(
    dir,
    `${PREFIXO_AUTORIZACAO_CONSUMIDA}${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`,
  );
  try {
    renameSync(caminho, consumido);
  } catch {
    return { autorizado: false, motivo: diagnosticarBootstrap(repoDir, env) };
  }
  const dados = lerJsonCru(consumido);
  const valido = dados && typeof dados === "object" && !Array.isArray(dados)
    && dados.protocoloVersao === PROTOCOLO_VERSAO
    && dados.instalacaoId === instalacaoId(repoDir)
    && dados.repoCanon === caminhoCanonico(repoDir)
    && dados.tipo === TIPO_AUTORIZACAO;
  if (!valido) return { autorizado: false, motivo: "autorizacao-invalida", consumido };
  return { autorizado: true, dados, consumido };
}

/** Estado de instalação conhecido para avaliação de boot: instalação
 *  concluída (recibo) OU primeiro bootstrap autorizado e ainda não
 *  consumido. Qualquer outro caso é ambíguo → fail-closed. */
export function estadoInstalacaoConhecido(repoDir, env = process.env) {
  const diag = diagnosticarBootstrap(repoDir, env);
  return { conhecido: diag === "instalacao-concluida" || diag === "primeiro-bootstrap", motivo: diag };
}

/**
 * Avaliação de boot para a versão N+: decide se o fluxo mutável pode
 * prosseguir. Retorno: { seguroIniciar: bool, motivo, detalhes? }.
 * - journal corrompido/incompatível/identidade divergente → bloqueia;
 * - ausência ambígua de estado (protocolo deveria existir) → bloqueia;
 * - recuperação pendente NUNCA é bloqueada por consentimento.
 */
export function avaliarBoot(repoDir, env = process.env) {
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
  // mas não há estado conhecido (recibo concluído ou autorização de
  // bootstrap válida) — bloqueia.
  const manifesto = caminhoManifestoProtocolo(repoDir);
  if (existsSync(manifesto)) {
    const prova = estadoInstalacaoConhecido(repoDir, env);
    if (!prova.conhecido) {
      return { seguroIniciar: false, motivo: "estado-ambiguo", detalhes: prova };
    }
  }
  return { seguroIniciar: true, motivo: "ok" };
}

// ---------- produtor confiável de primeiro bootstrap (P10-A) ----------
// Emite `bootstrap-autorizacao.json` (uso único) SOMENTE quando a prova
// combinada de instalação limpa passa por inteiro — incluindo o marcador
// de provisionamento (provisionamento.json), prova positiva de ação
// explícita. State dir ausente NÃO é lista vazia: é ambíguo e bloqueia.
// Nunca autoriza apenas porque o banco não existe: qualquer estado
// corrompido, incompatível, divergente, desconhecido ou interrompido
// bloqueia.
// O consumidor (aplicar-restauracao) já existe; o produtor é este
// módulo + scripts/autorizar-bootstrap.mjs (entrypoint do .bat na
// integração P10-C). Recibo permanente só é gravado por
// concluirBootstrapAposHealth, chamado pelo servidor após listen
// confirmado (health-ready real) com o banco comprovadamente populado.

/** Caminho do banco configurado — espelha CAMINHOS.banco de
 *  servidor/src/db/index.ts: MESTRE_BANCO ou <repo>/banco/mestre-rpg.db. */
export function caminhoBancoConfigurado(repoDir, env = process.env) {
  const override = (env.MESTRE_BANCO ?? "").trim();
  if (override) return resolve(override);
  return join(repoDir, "banco", "mestre-rpg.db");
}

/** Restos de instalação anterior dentro do repo — só existem depois
 *  que o servidor rodou de verdade: backups criados (backups/ tem
 *  conteúdo além do .gitkeep versionado) e sidecars do banco
 *  (mestre-rpg.db-wal/-shm/-journal no diretório configurado).
 *  Sobrevivem à perda conjunta DB+state e provam que a instalação
 *  existiu — sem eles, um wipe total é indistinguível de clone novo
 *  (aceito: não há mais evidência a proteger). Varredura env-aware
 *  (MESTRE_BACKUPS/MESTRE_BANCO) para testes isolados. */
function restosDeInstalacao(repoDir, env) {
  const restos = [];
  const backups = (env.MESTRE_BACKUPS ?? "").trim() || join(repoDir, "backups");
  try {
    if (existsSync(backups) && readdirSync(backups).some((n) => n !== ".gitkeep")) {
      restos.push("backups");
    }
  } catch { restos.push("backups-ilegivel"); }
  const banco = caminhoBancoConfigurado(repoDir, env);
  const base = banco.split(/[\\/]/).pop();
  try {
    const dirBanco = dirname(banco);
    if (existsSync(dirBanco)
        && readdirSync(dirBanco).some((n) => n.startsWith(base) && n !== base)) {
      restos.push("banco-sidecars");
    }
  } catch { restos.push("banco-ilegivel"); }
  return restos;
}

/**
 * Produtor de autorização de primeiro bootstrap — fail-closed.
 * Retorno: { autorizado:true, motivo:"emitida"|"ja-autorizado", dados } |
 *          { autorizado:false, motivo }.
 * Provas exigidas (todas):
 *   0. state dir EXISTENTE e legível — ausência não é "lista vazia"
 *      (perda conjunta DB+state é ambígua e bloqueia);
 *   0b. marcador de provisionamento VÁLIDO (provisionamento.json) —
 *      prova positiva de ação explícita de provisionamento; sem ela
 *      a ausência de evidências não basta;
 *   1. journals de update e restauração AUSENTES (qualquer status
 *      diferente de "ausente" — inclusive ok/corrompido/divergente —
 *      bloqueia);
 *   2. recibo de instalação ausente (recibo válido ⇒ já concluída);
 *   3. autorização existente: válida ⇒ idempotente ("ja-autorizado",
 *      sem regravar); inválida/divergente/corrompida ⇒ bloqueia;
 *   4. nenhuma autorização consumida sem recibo (bootstrap-interrompido
 *      NUNCA é reemitido);
 *   5. banco configurado AUSENTE — qualquer arquivo presente, mesmo
 *      vazio (0 bytes), é estado ambíguo e bloqueia ("banco-existente");
 *   6. nenhum resto de instalação anterior (backups com conteúdo,
 *      sidecars do banco) — sobrevivem ao wipe DB+state e provam que
 *      a instalação existiu; reemitir sobre eles seria reset
 *      destrutivo implícito.
 */
/** Núcleo de pré-condições do primeiro bootstrap — TODAS as provas
 *  exceto o marcador de provisionamento e a emissão da autorização.
 *  Retorno: { status:"limpo" } | { status:"ja-autorizado", dados } |
 *  { status:"bloqueado", motivo }. Não escreve nada. */
function checarNucleoBootstrap(repoDir, env) {
  const dir = dirEstado(repoDir, env);
  // Dir ausente = todos os artefatos de estado ausentes (journals,
  // recibo, autorização, consumidas vivem DENTRO do dir) — o
  // entrypoint cria o dir ao gravar o marcador. O produtor completo
  // continua exigindo dir existente (state-ausente bloqueia chamadas
  // diretas sem provisionamento). Banco e restos são checados sempre.
  let nomes = [];
  if (existsSync(dir)) {
    try { nomes = readdirSync(dir); }
    catch { return { status: "bloqueado", motivo: "state-ilegivel" }; }
  }
  for (const j of [JOURNAL_UPDATE, JOURNAL_RESTAURACAO]) {
    const r = lerJournal(repoDir, j, env);
    if (r.status !== "ausente") return { status: "bloqueado", motivo: `journal-${j}-${r.status}` };
  }
  const recibo = lerReciboInstalacao(repoDir, env);
  if (recibo.status === "ok") return { status: "bloqueado", motivo: "instalacao-ja-concluida" };
  if (recibo.status !== "ausente") return { status: "bloqueado", motivo: `recibo-${recibo.status}` };
  const auth = lerAutorizacaoBootstrap(repoDir, env);
  if (auth.status === "ok") return { status: "ja-autorizado", dados: auth.dados };
  if (auth.status !== "ausente") return { status: "bloqueado", motivo: `autorizacao-${auth.status}` };
  if (nomes.some((n) => n.startsWith(PREFIXO_AUTORIZACAO_CONSUMIDA))) {
    return { status: "bloqueado", motivo: "bootstrap-interrompido" };
  }
  const banco = caminhoBancoConfigurado(repoDir, env);
  if (existsSync(banco)) {
    // Qualquer arquivo presente — mesmo 0 bytes — é ambíguo: pode ser
    // resto de crash, dump parcial ou adulteração. Fail-closed.
    return { status: "bloqueado", motivo: "banco-existente" };
  }
  const restos = restosDeInstalacao(repoDir, env);
  if (restos.length) return { status: "bloqueado", motivo: `restos-${restos.join("+")}` };
  return { status: "limpo" };
}

/** Pré-validação do primeiro bootstrap SEM exigir o marcador de
 *  provisionamento e SEM escrever nada — usada pelo entrypoint para
 *  crash-safety: o marcador só vira visível depois que TODAS as
 *  demais precondições já foram confirmadas, então um kill/crash
 *  antes da escrita não deixa prova residual alguma. Retorno:
 *  { pronto:true, motivo:"limpo"|"ja-autorizado" } |
 *  { pronto:false, motivo }. */
export function validarPrecondicoesBootstrap(repoDir, env = process.env) {
  const c = checarNucleoBootstrap(repoDir, env);
  if (c.status === "bloqueado") return { pronto: false, motivo: c.motivo };
  return { pronto: true, motivo: c.status === "ja-autorizado" ? "ja-autorizado" : "limpo" };
}

/**
 * Identifica somente um CANDIDATO a instalação legada para adoção assistida.
 * Este preflight NÃO valida SQLite nem autoriza migração: ele apenas permite
 * que o operador confirme a intenção. O script de adoção, executado depois
 * de npm ci/build, valida o schema 1.0.8 exato, integridade e backup completo
 * antes de gravar o recibo permanente.
 *
 * Retorno false para banco ausente, symlink, estado de protocolo pré-existente,
 * corrompido, quarentenado ou arquivos inesperados no state dir.
 */
export function avaliarCandidatoAdocaoLegada(repoDir, env = process.env) {
  const banco = caminhoBancoConfigurado(repoDir, env);
  try {
    const st = lstatSync(banco);
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0) {
      return { adotavel: false, motivo: "banco-legado-nao-regular" };
    }
  } catch (e) {
    return { adotavel: false, motivo: e?.code === "ENOENT" ? "banco-legado-ausente" : "banco-legado-ilegivel" };
  }

  const estados = [
    ["recibo", lerReciboInstalacao(repoDir, env)],
    ["autorizacao", lerAutorizacaoBootstrap(repoDir, env)],
    ["provisionamento", lerProvisionamento(repoDir, env)],
    ["journal-update", lerJournal(repoDir, JOURNAL_UPDATE, env)],
    ["journal-restauracao", lerJournal(repoDir, JOURNAL_RESTAURACAO, env)],
  ];
  for (const [nome, estado] of estados) {
    if (estado.status !== "ausente") return { adotavel: false, motivo: `${nome}-${estado.status}` };
  }

  const dir = dirEstado(repoDir, env);
  let nomes = [];
  try {
    if (existsSync(dir)) nomes = readdirSync(dir);
  } catch {
    return { adotavel: false, motivo: "state-ilegivel" };
  }
  if (nomes.some((n) => n.includes(".quarentena-")
    || n.startsWith("bootstrap-autorizacao.consumida-"))) {
    return { adotavel: false, motivo: "state-quarentenado-ou-interrompido" };
  }

  // O único JSON alheio ao protocolo permitido é o lock pertencente ao
  // processo atual. Marcadores de backup são aceitos somente com identidade
  // completa e caminho de backup; qualquer outro estado exige investigação.
  for (const nome of nomes) {
    if (nome === "mestre-boot-lock.json") continue;
    if (nome === "protecao") {
      const protDir = join(dir, nome);
      let markers;
      try { markers = readdirSync(protDir); }
      catch { return { adotavel: false, motivo: "protecao-ilegivel" }; }
      for (const marker of markers) {
        if (!marker.endsWith(".json") || marker.includes(".quarentena-")) {
          return { adotavel: false, motivo: "protecao-estado-desconhecido" };
        }
        let dados;
        try { dados = JSON.parse(readFileSync(join(protDir, marker), "utf8")); }
        catch { return { adotavel: false, motivo: "protecao-corrompida" }; }
        if (!dados || dados.protocoloVersao !== PROTOCOLO_VERSAO
          || dados.instalacaoId !== instalacaoId(repoDir)
          || dados.repoCanon !== caminhoCanonico(repoDir)
          || typeof dados.backupDir !== "string" || !dados.backupDir) {
          return { adotavel: false, motivo: "protecao-divergente" };
        }
      }
      continue;
    }
    return { adotavel: false, motivo: "state-arquivo-desconhecido" };
  }

  return { adotavel: true, motivo: "banco-legado-candidato" };
}

export function autorizarPrimeiroBootstrap(repoDir, env = process.env) {
  const dir = dirEstado(repoDir, env);
  if (!existsSync(dir)) return { autorizado: false, motivo: "state-ausente" };
  try { readdirSync(dir); }
  catch { return { autorizado: false, motivo: "state-ilegivel" }; }
  const prov = lerProvisionamento(repoDir, env);
  if (prov.status !== "ok") return { autorizado: false, motivo: `provisionamento-${prov.status}` };
  const c = checarNucleoBootstrap(repoDir, env);
  if (c.status === "bloqueado") return { autorizado: false, motivo: c.motivo };
  if (c.status === "ja-autorizado") return { autorizado: true, motivo: "ja-autorizado", dados: c.dados };
  const dados = gravarAutorizacaoBootstrap(repoDir, env);
  return { autorizado: true, motivo: "emitida", dados };
}

/**
 * Conclusão do bootstrap — grava o recibo permanente SOMENTE quando a
 * instalação está comprovadamente concluída: estado
 * "bootstrap-interrompido" (autorização consumida, sem recibo) E o
 * chamador atesta `bancoComDados` (health-ready real + DB populado).
 * `npm run start` bloqueia o .bat, por isso quem prova a escuta é o
 * próprio servidor (listen confirmado em index.ts). Idempotente:
 * recibo já existente ⇒ diagnosticarBootstrap retorna
 * "instalacao-concluida" ⇒ não regrava. Retorno:
 * { concluido:true, motivo:"recibo-gravado", recibo } |
 * { concluido:false, motivo }.
 */
export function concluirBootstrapAposHealth(repoDir, env = process.env, bancoComDados = false) {
  const diag = diagnosticarBootstrap(repoDir, env);
  if (diag !== "bootstrap-interrompido") return { concluido: false, motivo: diag };
  if (bancoComDados !== true) return { concluido: false, motivo: "banco-nao-comprovado" };
  const recibo = gravarReciboInstalacao(repoDir, env);
  return { concluido: true, motivo: "recibo-gravado", recibo };
}
