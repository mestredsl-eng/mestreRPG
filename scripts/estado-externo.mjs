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
// Recibo de instalação: gravado por caminhos confiáveis — o Gate 0
// (scripts/bootstrap-install.mjs via iniciar-mestre-rpg.bat) na adoção,
// ou o migrador após conclusão (origem "migrate-concluido").
// Vinculado a instalacaoId+repoCanon+protocoloVersao; sua ausência NÃO
// pode ser contornada por manifesto versionado, arquivo tracked, código N,
// ausência de banco ou ausência do próprio state dir.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Classificação de existência por lstat — distingue ausência provada
 *  (ENOENT) de falha de leitura/permissão. existsSync() devolve false
 *  tanto para ausente quanto para EACCES/EPERM, o que transformaria
 *  "não consegui verificar" em "não existe" — inaceitável em avaliação
 *  fail-closed. Retorno: "existe" | "ausente" | "inconclusivo". */
export function estadoCaminho(caminho) {
  try {
    lstatSync(caminho);
    return "existe";
  } catch (e) {
    if (e && e.code === "ENOENT") return "ausente";
    return "inconclusivo";
  }
}

function tmpUnico(dir, nome) {
  return join(dir, `.${nome}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
}

const ERROS_RETRY_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_TENTATIVAS_RENAME = 6;

/** Bloqueio curto da thread principal sem processo extra. */
function dormirSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* ambientes sem SharedArrayBuffer: segue sem espera */ }
}

/** Rename com retry limitado SOMENTE para erros transitórios do
 *  Windows (EPERM/EBUSY/EACCES — antivírus/indexador segurando o
 *  arquivo). Tentativas limitadas, backoff progressivo curto, erro
 *  original propagado ao esgotar; nunca retorna sucesso sem rename. */
export function renomearComRetry(origem, destino, opcoes = {}) {
  const renomear = opcoes.renomear ?? renameSync;
  const dormir = opcoes.dormir ?? dormirSync;
  const max = opcoes.maxTentativas ?? MAX_TENTATIVAS_RENAME;
  for (let i = 0; i < max; i++) {
    try {
      renomear(origem, destino);
      return;
    } catch (e) {
      if (!ERROS_RETRY_RENAME.has(e?.code) || i === max - 1) throw e;
      dormir(50 * 2 ** i); // 50, 100, 200, 400, 800 ms
    }
  }
}

/** Escrita atômica: tmp exclusivo no mesmo diretório → flush/fsync →
 *  rename (com retry transitório). Falha final remove o tmp quando
 *  seguro e propaga o erro original. */
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
  try {
    renomearComRetry(tmp, caminho);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* melhor esforço */ }
    throw e;
  }
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

/** Leitura classificada SEM efeitos colaterais (nunca quarentena):
 *  distingue ausência provada (ENOENT), conteúdo corrompido e falha de
 *  leitura/permissão (inconclusivo). Usada pelos leitores de marcador,
 *  recibo e autorização — avaliações somente-leitura. */
function lerJsonEstado(caminho) {
  const est = estadoCaminho(caminho);
  if (est === "ausente") return { status: "ausente" };
  if (est === "inconclusivo") return { status: "inconclusivo" };
  let bruto;
  try {
    bruto = readFileSync(caminho, "utf8");
  } catch {
    return { status: "inconclusivo" };
  }
  try {
    return { status: "ok", dados: JSON.parse(bruto) };
  } catch {
    return { status: "corrompido" };
  }
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
  const est = estadoCaminho(caminho);
  if (est === "ausente") return { status: "ausente" };
  if (est === "inconclusivo") return { status: "inconclusivo" };
  let bruto;
  try {
    bruto = readFileSync(caminho, "utf8");
  } catch {
    // EACCES/EPERM/EISDIR etc. — NÃO é JSON corrompido: inconclusivo.
    return { status: "inconclusivo" };
  }
  let dados;
  try {
    dados = JSON.parse(bruto);
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
const PREFIXO_AUTORIZACAO_CONSUMIDA = "bootstrap-autorizacao.consumida-";
const TIPO_RECIBO_CONCLUIDA = "instalacao-concluida";
const TIPO_AUTORIZACAO = "primeiro-bootstrap";

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
  const lido = lerJsonEstado(join(dirEstado(repoDir, env), ARQUIVO_RECIBO_INSTALACAO));
  if (lido.status !== "ok") return { status: lido.status };
  const dados = lido.dados;
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return { status: "corrompido" };
  if (dados.protocoloVersao !== PROTOCOLO_VERSAO) return { status: "incompativel" };
  if (dados.instalacaoId !== instalacaoId(repoDir)) return { status: "divergente" };
  if (dados.repoCanon !== caminhoCanonico(repoDir)) return { status: "divergente" };
  if (dados.tipo !== TIPO_RECIBO_CONCLUIDA) return { status: "invalido" };
  return { status: "ok", dados };
}

/** Grava a autorização de primeiro bootstrap — produtor confiável:
 *  scripts/bootstrap-install.mjs (Gate 0 do .bat) e o fluxo
 *  `assumir-reinstalacao` explícito do operador. */
export function gravarAutorizacaoBootstrap(repoDir, env = process.env, dadosExtra = {}) {
  return gravarEstado(repoDir, ARQUIVO_AUTORIZACAO_BOOTSTRAP, {
    tipo: TIPO_AUTORIZACAO,
    emitidaEm: new Date().toISOString(),
    ...dadosExtra,
  }, env);
}

/** Lê a autorização SEM consumi-la (verificação não destrutiva). */
export function lerAutorizacaoBootstrap(repoDir, env = process.env) {
  const lido = lerJsonEstado(join(dirEstado(repoDir, env), ARQUIVO_AUTORIZACAO_BOOTSTRAP));
  if (lido.status !== "ok") return { status: lido.status };
  const dados = lido.dados;
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return { status: "corrompido" };
  if (dados.protocoloVersao !== PROTOCOLO_VERSAO) return { status: "incompativel" };
  if (dados.instalacaoId !== instalacaoId(repoDir)) return { status: "divergente" };
  if (dados.repoCanon !== caminhoCanonico(repoDir)) return { status: "divergente" };
  if (dados.tipo !== TIPO_AUTORIZACAO) return { status: "invalido" };
  return { status: "ok", dados };
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
  const estDir = estadoCaminho(dir);
  if (estDir === "inconclusivo") return "state-ilegivel";
  try { nomes = estDir === "existe" ? readdirSync(dir) : []; }
  catch { return "state-ilegivel"; }
  // bootstrap em andamento (autorização já consumida, instalação a meio
  // caminho) — estado conhecido: o ciclo de primeiro boot está válido.
  if (nomes.includes(ARQUIVO_BOOTSTRAP_ANDAMENTO)) {
    const andamento = lerJournal(repoDir, ARQUIVO_BOOTSTRAP_ANDAMENTO, env);
    if (andamento.status === "ok") return "bootstrap-em-andamento";
    if (andamento.status !== "ausente") return `bootstrap-andamento-${andamento.status}`;
  }
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
  const estAuth = estadoCaminho(caminho);
  if (estAuth === "inconclusivo") {
    return { autorizado: false, motivo: "autorizacao-inconclusiva" };
  }
  if (estAuth === "ausente") {
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

// ---------- marcador de proveniência (W13) ----------
// O recibo/autorização vivem DENTRO do state dir — se o diretório for
// perdido, eles somem junto e "instalação que perdeu o estado" fica
// indistinguível de "clone novo". O marcador de proveniência fica FORA
// do state dir (diretório próprio por plataforma), para que a prova de
// "esta instalação já foi inicializada" sobreviva à perda do estado:
//   MESTRE_PROVENIENCIA_DIR definido → <override>/<instalacaoId>/
//   Windows                     → %LOCALAPPDATA%\MestreRPG\install\<id>\
//   Linux c/ XDG                → $XDG_STATE_HOME/mestre-rpg/install/<id>/
//   Linux s/ XDG                → ~/.local/state/mestre-rpg/install/<id>/
// Fora do worktree (sobrevive a git reset/clone no mesmo path? não —
// clone novo no MESMO path compartilha instalacaoId: o marcador é
// evidência de proveniência por caminho, e divergências de conteúdo
// são detectadas por repoCanon/identidade). Não fica no banco nem no
// state dir, por exigência do contrato W13.
export const ARQUIVO_MARCADOR_INSTALACAO = "instalacao-marcador.json";
const TIPO_MARCADOR = "instalacao-inicializada";

export function diretorioBaseProveniencia(env = process.env) {
  const override = (env.MESTRE_PROVENIENCIA_DIR ?? "").trim();
  if (override) return override;
  // Sem override explícito, um MESTRE_STATE_DIR customizado (testes,
  // sandboxes) também isola a proveniência — senão fixtures que só
  // isolam o state dir escreveriam o marcador real da instalação.
  const stateDir = (env.MESTRE_STATE_DIR ?? "").trim();
  if (stateDir) return join(dirname(stateDir), "install");
  // MESTRE_HOME é a raiz de dados alternativa (testes/sandbox): sem
  // ela, fixtures que só isolam MESTRE_HOME compartilhariam o marcador
  // real da instalação e contaminariam umas às outras. O marcador fica
  // dentro da raiz de dados do sandbox — continua fora do state dir e
  // do banco, e some junto numa perda total do MESTRE_HOME (cenário que
  // já exige decisão explícita do operador).
  const home = (env.MESTRE_HOME ?? "").trim();
  if (home) return join(home, ".proveniencia-install");
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(local, "MestreRPG", "install");
  }
  const xdg = (env.XDG_STATE_HOME ?? "").trim();
  const base = xdg || join(homedir(), ".local", "state");
  return join(base, "mestre-rpg", "install");
}

export function dirProveniencia(repoDir, env = process.env) {
  return join(diretorioBaseProveniencia(env), instalacaoId(repoDir));
}

export function caminhoMarcadorInstalacao(repoDir, env = process.env) {
  return join(dirProveniencia(repoDir, env), ARQUIVO_MARCADOR_INSTALACAO);
}

/** Grava o marcador de proveniência — escrita atômica durável.
 *  Chamar quando houver PROVA de instalação concluída (banco válido
 *  adotado) ou explicitamente no fluxo de bootstrap. Idempotente:
 *  regravar o mesmo registro é inócuo. */
export function gravarMarcadorInstalacao(repoDir, env = process.env, dadosExtra = {}) {
  const registro = {
    protocoloVersao: PROTOCOLO_VERSAO,
    instalacaoId: instalacaoId(repoDir),
    repoCanon: caminhoCanonico(repoDir),
    tipo: TIPO_MARCADOR,
    criadoEm: new Date().toISOString(),
    ...dadosExtra,
  };
  gravarJsonAtomico(caminhoMarcadorInstalacao(repoDir, env), registro);
  return registro;
}

/** Lê o marcador SEM efeitos colaterais e SEM quarentena: um marcador
 *  corrompido precisa continuar bloqueando — quarentená-lo o faria
 *  "ausente" e abriria caminho para tratar perda de estado como
 *  instalação nova. Retorno: { status: "ok", dados } | "ausente" |
 *  "corrompido" | "incompativel" | "divergente" | "invalido". */
export function lerMarcadorInstalacao(repoDir, env = process.env) {
  const lido = lerJsonEstado(caminhoMarcadorInstalacao(repoDir, env));
  if (lido.status !== "ok") return { status: lido.status };
  const dados = lido.dados;
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return { status: "corrompido" };
  if (dados.protocoloVersao !== PROTOCOLO_VERSAO) return { status: "incompativel" };
  if (dados.instalacaoId !== instalacaoId(repoDir)) return { status: "divergente" };
  if (dados.repoCanon !== caminhoCanonico(repoDir)) return { status: "divergente" };
  if (dados.tipo !== TIPO_MARCADOR) return { status: "invalido" };
  return { status: "ok", dados };
}

/** O diretório de estado contém registros do protocolo (journals,
 *  recibo, autorização/consumidas, proteção/, quarentena)? Artefatos
 *  do Boot Lock (mestre-boot-lock.json[.recover]) são recriados a cada
 *  boot e NÃO provam estado de protocolo — não contam.
 *  Retorno: true | false | null (diretório ilegível → inconclusivo). */
export function stateDirTemProtocolo(dir) {
  const est = estadoCaminho(dir);
  if (est === "inconclusivo") return null;
  let nomes;
  try { nomes = est === "existe" ? readdirSync(dir) : []; }
  catch { return null; }
  return nomes.some((n) => !n.startsWith("mestre-boot-lock.json"));
}

// ---------- bootstrap em andamento (W13) ----------
// Gravado pelo restaurador NO INSTANTE em que consome a autorização de
// uso único: prova de que o bootstrap foi autorizado e está em curso —
// distingue "primeira instalação a caminho" de "autorização consumida
// e instalação interrompida" (que bloqueia). Limpo pelo Gate 0 quando
// o banco válido é observado (adoção) ou por recuperação explícita.
export const ARQUIVO_BOOTSTRAP_ANDAMENTO = "bootstrap-em-andamento.json";
const TIPO_BOOTSTRAP_ANDAMENTO = "bootstrap-em-andamento";

export function gravarBootstrapAndamento(repoDir, env = process.env, dadosExtra = {}) {
  return gravarEstado(repoDir, ARQUIVO_BOOTSTRAP_ANDAMENTO, {
    tipo: TIPO_BOOTSTRAP_ANDAMENTO,
    em: new Date().toISOString(),
    ...dadosExtra,
  }, env);
}

/** Sandbox sem state dir isolado: MESTRE_HOME definido mas
 *  MESTRE_STATE_DIR ausente → dirEstado() cai no diretório REAL da
 *  instalação. Nesse modo, escritas de protocolo (recibo, andamento,
 *  autorização) contaminariam o estado real — os consumidores devem
 *  evitá-las. Leituras fail-closed continuam normais. */
export function estadoRealCompartilhado(env = process.env) {
  return Boolean((env.MESTRE_HOME ?? "").trim()) && !(env.MESTRE_STATE_DIR ?? "").trim();
}

/** Remove o marcador de bootstrap em andamento (pós-adoção). */
export function limparBootstrapAndamento(repoDir, env = process.env) {
  try { rmSync(join(dirEstado(repoDir, env), ARQUIVO_BOOTSTRAP_ANDAMENTO), { force: true }); }
  catch { /* melhor esforço — arquivo pode não existir */ }
}

/** Estado de instalação conhecido para avaliação de boot: instalação
 *  concluída (recibo) OU primeiro bootstrap autorizado e ainda não
 *  consumido. Qualquer outro caso é ambíguo → fail-closed. */
export function estadoInstalacaoConhecido(repoDir, env = process.env) {
  const diag = diagnosticarBootstrap(repoDir, env);
  return {
    conhecido: diag === "instalacao-concluida" || diag === "primeiro-bootstrap" || diag === "bootstrap-em-andamento",
    motivo: diag,
  };
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
  const estManifesto = estadoCaminho(manifesto);
  if (estManifesto === "inconclusivo") {
    return { seguroIniciar: false, motivo: "manifesto-inconclusivo" };
  }
  if (estManifesto === "existe") {
    const prova = estadoInstalacaoConhecido(repoDir, env);
    if (!prova.conhecido) {
      return { seguroIniciar: false, motivo: "estado-ambiguo", detalhes: prova };
    }
  }
  return { seguroIniciar: true, motivo: "ok" };
}
