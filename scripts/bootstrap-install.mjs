#!/usr/bin/env node
// Gate 0 de boot — proveniência e bootstrap (Issue #155, W13/W14).
//
// Executado por iniciar-mestre-rpg.bat DEPOIS de adquirir o Boot Lock e
// ANTES do auto-update/npm/build/restaurador/migrate/start. Decide se o
// fluxo mutável pode prosseguir, distinguindo:
//
//   - PRIMEIRA INSTALAÇÃO legítima (clone novo, sem nenhuma evidência
//     de uso anterior) → emite bootstrap-autorizacao.json de uso único;
//   - INSTALAÇÃO EXISTENTE com banco válido → adoção: grava o marcador
//     de proveniência (fora do state dir) + recibo no state dir;
//   - INSTALAÇÃO REGISTRADA que perdeu o banco → bloqueia;
//   - INSTALAÇÃO REGISTRADA que perdeu o state dir → bloqueia até
//     recuperação explícita (`recuperar-estado`);
//   - estado ambíguo/corrompido/divergente → bloqueia com instruções.
//
// NUNCA transforma perda de banco/estado em instalação nova
// automaticamente. O servidor (index.ts) e o migrador (migrate.ts)
// reavaliam de forma SOMENTE-LEITURA via verificarPortao() — nenhuma
// escrita de proveniência/autorização acontece fora deste gate.
//
// Uso:
//   node scripts/bootstrap-install.mjs                  → gate do boot
//   node scripts/bootstrap-install.mjs recuperar-estado → recria o
//       state dir + recibo após perda confirmada pelo operador
//   node scripts/bootstrap-install.mjs assumir-reinstalacao --confirmar
//       → operador declara explicitamente perda total e autoriza
//         bootstrap (única saída para "tudo perdido" sem backup)
//
// Overrides de teste: MESTRE_BANCO, MESTRE_ARQUIVOS, MESTRE_BACKUPS,
// MESTRE_STATE_DIR, MESTRE_PROVENIENCIA_DIR, MESTRE_HOME.
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");

const JOURNAL_UPDATE = "atualizacao-ultima.json";
const JOURNAL_RESTAURACAO = "restauracao-externa.json";
const FASES_FINAIS_REST = new Set(["concluido", "concluido-com-flag"]);

let ee = null;
async function estadoExterno() {
  if (ee) return ee;
  ee = await import(pathToFileURL(join(REPO_ROOT, "scripts", "estado-externo.mjs")).href);
  return ee;
}

/** Mesma resolução de caminhos do servidor/restaurador: overrides
 *  MESTRE_* > raiz do repo. MESTRE_HOME é raiz de dados alternativa
 *  (testes/sandbox) — usada só quando os overrides específicos faltam,
 *  espelhando aplicar-restauracao.ts. */
function resolverCaminhos(repoDir, env) {
  const dados = env.MESTRE_HOME?.trim() ? resolve(env.MESTRE_HOME) : repoDir;
  return {
    db: env.MESTRE_BANCO?.trim() ? resolve(env.MESTRE_BANCO) : join(dados, "banco", "mestre-rpg.db"),
    arquivos: env.MESTRE_ARQUIVOS?.trim() ? resolve(env.MESTRE_ARQUIVOS) : join(dados, "arquivos", "campanhas"),
    backups: env.MESTRE_BACKUPS?.trim() ? resolve(env.MESTRE_BACKUPS) : join(dados, "backups"),
  };
}

function dirTemConteudo(dir) {
  // Distingue: ausente (false) | vazio|só-.gitkeep (false) | conteúdo
  // (true) | inacessível/tipo inválido (null → inconclusivo → bloqueia).
  return dirConteudoClassificado(dir).temConteudo;
}

function dirConteudoClassificado(dir) {
  const est = estadoCaminhoLocal(dir);
  if (est === "inconclusivo") return { temConteudo: null, estado: "inconclusivo" };
  if (est === "ausente") return { temConteudo: false, estado: "ausente" };
  let nomes;
  try { nomes = readdirSync(dir); }
  catch { return { temConteudo: null, estado: "inconclusivo" }; }
  // .gitkeep é placeholder TRACKED do repo — todo clone novo o tem e
  // ele NÃO é evidência de instalação anterior.
  return { temConteudo: nomes.some((n) => n !== ".gitkeep"), estado: "existe" };
}

/** lstat local — existeSync devolveria false em EACCES/EPERM, o que
 *  faria "não consegui verificar" parecer "não existe". */
function estadoCaminhoLocal(caminho) {
  try {
    lstatSync(caminho);
    return "existe";
  } catch (e) {
    return e && e.code === "ENOENT" ? "ausente" : "inconclusivo";
  }
}

// better-sqlite3 é carregado SOB DEMANDA: o Gate 0 roda antes do
// `npm ci` no .bat — num clone limpo sem node_modules a ausência do
// banco deve ser classificável sem a dependência. Com banco existente,
// dependência indisponível ou inspeção impossível → "inconclusivo"
// (bloqueio fail-closed — nunca "válido" por falta de módulo).
let sqliteMod = null;
async function carregarSqlite() {
  if (sqliteMod) return sqliteMod;
  const mod = await import("better-sqlite3");
  sqliteMod = mod.default ?? mod;
  return sqliteMod;
}

/** Sonda o banco SEM criá-lo e SEM efeitos colaterais no original:
 *  ausente | vazio (0 tabelas) | valido (≥1 tabela) | ilegivel |
 *  inconclusivo (dependência ausente, path inacessível ou inspeção
 *  impossível). A inspeção copia db+sidecars para um diretório
 *  temporário do SO — nem readonly nem abertura normal são usados no
 *  arquivo real (ambos criam -shm/-wal em bancos WAL). */
async function sondarBanco(caminho) {
  const est = estadoCaminhoLocal(caminho);
  if (est === "ausente") return { estado: "ausente" };
  if (est === "inconclusivo") {
    return { estado: "inconclusivo", detalhe: "caminho do banco inacessível" };
  }
  let Database;
  try {
    Database = await carregarSqlite();
  } catch (e) {
    return { estado: "inconclusivo", detalhe: `better-sqlite3 indisponível: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  const tmp = mkdtempSync(join(tmpdir(), "gate0-db-"));
  try {
    const base = caminho.split(/[\\/]/).pop();
    for (const suf of ["", "-wal", "-shm", "-journal"]) {
      const src = caminho + suf;
      const estSide = estadoCaminhoLocal(src);
      if (estSide === "inconclusivo") {
        return { estado: "inconclusivo", detalhe: `sidecar ${suf || "(principal)"} inacessível` };
      }
      if (estSide === "existe") copyFileSync(src, join(tmp, base + suf));
    }
    const db = new Database(join(tmp, base), { fileMustExist: true });
    try {
      const total = db.prepare("select count(*) as c from sqlite_master where type='table'").get().c;
      return { estado: total === 0 ? "vazio" : "valido" };
    } finally {
      try { db.close(); } catch { /* ignora */ }
    }
  } catch (e) {
    return { estado: "inconclusivo", detalhe: String(e?.message ?? e).slice(0, 160) };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* melhor esforço */ }
  }
}

/**
 * Monta a fotografia completa do estado de instalação — SOMENTE LEITURA.
 * Retorno: objeto de evidências consumido por decidirPortao().
 */
export async function sondarInstalacao(repoDir = REPO_ROOT, env = process.env) {
  const mod = await estadoExterno();
  const cam = resolverCaminhos(repoDir, env);
  const dirEst = mod.dirEstado(repoDir, env);
  // Sandbox sem state isolado (MESTRE_HOME sem MESTRE_STATE_DIR): o
  // state dir resolvido é o REAL da instalação — journals/recibos/
  // autorizações de lá não dizem nada sobre esta instalação sandbox, e
  // lê-los poderia até quarentenar arquivos reais. Sinais de state dir
  // são neutralizados; marcador (MESTRE_HOME-isolado), banco e evidência
  // legada continuam valendo. Escritas seguem bloqueadas no portão.
  const compartilhado = Boolean(mod.estadoRealCompartilhado?.(env));
  const ausente = { status: "ausente" };

  const s = {
    compartilhado,
    repoDir,
    env,
    cam,
    dirEstado: dirEst,
    banco: await sondarBanco(cam.db),
    stateProtocolo: compartilhado ? false : mod.stateDirTemProtocolo(dirEst),
    marcador: mod.lerMarcadorInstalacao(repoDir, env),
    recibo: compartilhado ? ausente : mod.lerReciboInstalacao(repoDir, env),
    auth: compartilhado ? ausente : mod.lerAutorizacaoBootstrap(repoDir, env),
    journalUpdate: compartilhado ? ausente : mod.lerJournalSemEfeitos(repoDir, JOURNAL_UPDATE, env),
    journalRest: compartilhado ? ausente : mod.lerJournalSemEfeitos(repoDir, JOURNAL_RESTAURACAO, env),
    legado: {
      backups: dirTemConteudo(cam.backups),
      arquivos: dirTemConteudo(cam.arquivos),
      // configuracao/servidor.json é ARQUIVO TRACKED do repo (template
      // default) — existe em todo clone e não prova instalação anterior.
      // Evidência de uso real = backups/ ou arquivos de campanha com
      // conteúdo de usuário.
    },
  };
  // autorização já consumida (evidência durável fora do nome .json)
  try {
    const est = estadoCaminhoLocal(dirEst);
    s.autorizacoesConsumidas = compartilhado ? 0
      : est === "existe"
        ? readdirSync(dirEst).filter((n) => n.startsWith("bootstrap-autorizacao.consumida-")).length
        : est === "ausente" ? 0 : null;
  } catch { s.autorizacoesConsumidas = null; }
  // bootstrap em andamento: autorização já consumida pelo restaurador
  // neste ciclo — prova de que o primeiro boot está a meio caminho.
  s.andamento = compartilhado ? ausente : mod.lerJournalSemEfeitos(repoDir, mod.ARQUIVO_BOOTSTRAP_ANDAMENTO ?? "bootstrap-em-andamento.json", env);
  // Validação semântica compartilhada do andamento (tipo/etapa/
  // autorizacaoId/prova vinculada/marcador ausente) — somente leitura.
  s.andamentoAval = compartilhado
    ? { status: "ausente" }
    : (mod.avaliarBootstrapAndamento?.(repoDir, env) ?? { status: s.andamento.status });
  return s;
}

const MARCADOR_RUIM = new Set(["corrompido", "incompativel", "divergente", "invalido", "inconclusivo"]);
const AUTH_RUIM = new Set(["corrompido", "incompativel", "divergente", "invalido", "inconclusivo"]);

function temEvidenciaLegado(s) {
  return s.legado.backups === true || s.legado.arquivos === true;
}

/**
 * Decide o destino do boot a partir das evidências. Retorno:
 * { seguro: bool, acao, motivo, instrucao? }
 *   acao ∈ "prosseguir" | "autorizar-bootstrap" | "adotar" |
 *          "recuperar-estado" | "assumir-reinstalacao"
 * Nenhuma escrita acontece aqui — executarPortao() aplica as ações.
 */
export function decidirPortao(s) {
  const bloquear = (motivo, instrucao) => ({ seguro: false, acao: "bloquear", motivo, instrucao });

  // 1) Journals do protocolo: corrompido/incompatível/divergente NUNCA
  //    é "ausência". Journal de atualização pendente bloqueia — não há
  //    resolvedor integrado ainda (Etapa 4). Journal de restauração
  //    pendente NÃO bloqueia: o restaurador oficial o retoma neste
  //    mesmo boot, depois dos builds.
  for (const [nome, j] of [["atualizacao", s.journalUpdate], ["restauracao", s.journalRest], ["bootstrap-andamento", s.andamento]]) {
    if (j.status !== "ausente" && j.status !== "ok") {
      return bloquear(`journal-${nome}-${j.status}`, "Estado externo corrompido ou divergente. Inspecione o diretório de estado reportado e a quarentena antes de reiniciar.");
    }
  }
  if (s.journalUpdate.status === "ok" && s.journalUpdate.dados?.fase && s.journalUpdate.dados.fase !== "concluido") {
    return bloquear("atualizacao-pendente", "Existe uma atualização interrompida registrada no estado externo. Resolva o journal antes de reiniciar (Etapa 4 do protocolo).");
  }

  // 1b) Sinais inconclusivos NUNCA viram ausência: state dir ilegível,
  //     contagem de autorizações falha ou evidência legada inacessível
  //     bloqueiam qualquer decisão — inclusive a emissão de autorização.
  if (s.stateProtocolo === null || s.autorizacoesConsumidas === null) {
    return bloquear("state-ilegivel", "O diretório de estado não pôde ser lido. Verifique permissões antes de reiniciar.");
  }
  if (s.legado.backups === null || s.legado.arquivos === null) {
    return bloquear("evidencia-legada-inconclusiva", "Não foi possível verificar backups/ ou arquivos/ de campanhas (permissão ou tipo inválido). A instalação pode ser anterior — resolva o acesso antes de reiniciar.");
  }

  // 2) Banco ilegível/inconclusivo: não dá para classificar → fail-closed.
  if (s.banco.estado === "ilegivel" || s.banco.estado === "inconclusivo") {
    return bloquear(`banco-${s.banco.estado}`, `O banco de dados não pôde ser inspecionado: ${s.banco.detalhe ?? "erro"}. Verifique o arquivo ${s.cam.db}.`);
  }

  // 3) Banco VÁLIDO — a prova mais forte de instalação existente.
  if (s.banco.estado === "valido") {
    if (MARCADOR_RUIM.has(s.marcador.status)) {
      return bloquear(`marcador-${s.marcador.status}`, "O marcador de proveniência está corrompido ou diverge desta instalação. Não o remova automaticamente — investigue antes de reiniciar.");
    }
    if (s.marcador.status === "ok") {
      if (s.stateProtocolo === null) {
        return bloquear("state-ilegivel", "O diretório de estado existe mas não pôde ser lido. Verifique permissões.");
      }
      // No sandbox compartilhado o state dir é o real e não se aplica a
      // esta instalação — marcador+banco válido já são prova suficiente.
      if (s.stateProtocolo === false && !s.compartilhado) {
        return bloquear("estado-externo-perdido",
          "Esta instalação já foi inicializada (marcador de proveniência presente), mas o diretório de estado externo sumiu — journals e proteções de backup podem ter sido perdidos. Após confirmar que não há restauração/atualização pendente, execute: node scripts\\bootstrap-install.mjs recuperar-estado");
      }
      return { seguro: true, acao: "prosseguir", motivo: "instalacao-conhecida" };
    }
    // marcador ausente + banco válido = prova suficiente de instalação
    // pré-W13 ou marcador nunca gravado → ADOÇÃO (N-1 → N incluído).
    return { seguro: true, acao: "adotar", motivo: "banco-valido-sem-marcador" };
  }

  // 4) Banco ausente/vazio — o caso sensível.
  if (MARCADOR_RUIM.has(s.marcador.status)) {
    return bloquear(`marcador-${s.marcador.status}`, "O marcador de proveniência está corrompido ou diverge desta instalação.");
  }
  if (s.marcador.status === "ok") {
    return bloquear("banco-perdido",
      "A instalação está registrada (marcador de proveniência), mas o banco de dados está ausente ou vazio. Isso NÃO é uma instalação nova. Restaure o banco a partir de backups\\ (ou do backup pré-update) e reinicie. Se não houver backup, avalie a perda total com o operador antes de qualquer reinstalação.");
  }
  // marcador ausente:
  if (AUTH_RUIM.has(s.auth.status)) {
    return bloquear(`autorizacao-${s.auth.status}`, "A autorização de bootstrap está corrompida ou diverge desta instalação.");
  }
  // Recibo: só "ausente" ou "ok" são conclusivos neste ponto — qualquer
  // outro estado (corrompido/incompatível/divergente/inconclusivo)
  // bloqueia ANTES de aceitar autorização pendente: erro de leitura
  // nunca vira ausência.
  if (s.recibo.status !== "ausente" && s.recibo.status !== "ok") {
    return bloquear(`recibo-${s.recibo.status}`,
      "O recibo de instalação está corrompido ou não pôde ser lido. Verifique o diretório de estado antes de reiniciar.");
  }
  // Bootstrap em andamento: validação semântica compartilhada —
  // envelope ok NÃO basta; tipo/etapa/autorizacaoId precisam ter prova
  // vinculada (autorização pendente ou consumida do MESMO ciclo) e o
  // marcador de proveniência precisa estar ausente. Inválido bloqueia
  // AQUI, antes do updater/build — não só no restaurador.
  const av = s.andamentoAval ?? { status: s.andamento.status };
  if (av.status !== "ausente" && av.status !== "valido") {
    return bloquear(`bootstrap-andamento-${av.status}`,
      `O marcador de bootstrap em andamento é inválido ou não pôde ser verificado (${av.motivo ?? av.status}). Investigue o state dir antes de reiniciar.`);
  }
  if (av.status === "valido") {
    // O avaliador já exige marcador ausente; instalação registrada com
    // banco perdido parou antes, no ramo "banco-perdido".
    // Recibo ok + andamento válido é contraditório (instalação
    // concluída não pode estar "em bootstrap") → fail-closed.
    if (s.recibo.status !== "ausente") {
      return bloquear("bootstrap-andamento-contraditorio",
        "Há bootstrap em andamento válido mas também recibo de instalação — estado contraditório. Investigue o state dir antes de reiniciar.");
    }
    return { seguro: true, acao: "prosseguir", motivo: "bootstrap-em-andamento" };
  }
  if (s.auth.status === "ok") {
    // bootstrap já autorizado e ainda não consumido — idempotente.
    return { seguro: true, acao: "prosseguir", motivo: "bootstrap-autorizado" };
  }
  if (s.recibo.status !== "ausente" || s.autorizacoesConsumidas > 0 || s.stateProtocolo === true) {
    // Estado de protocolo existe sem marcador e sem autorização:
    // instalação pré-W13 com estado, marcador removido ou estado
    // ambíguo — nunca assumir instalação nova.
    return bloquear("estado-ambiguo",
      "Há registros de estado externo mas nenhuma prova de instalação concluída neste caminho. Se esta for uma instalação anterior ao protocolo W13 com banco válido, o banco deveria existir — verifique o banco. Caso contrário, investigue o state dir antes de reiniciar.");
  }
  if (temEvidenciaLegado(s)) {
    return bloquear("possivel-instalacao-anterior",
      "Banco ausente, mas há backups/, arquivos de campanha ou configuração de uma instalação anterior. Isso não é um clone novo. Restaure o banco a partir dos backups ou, se a perda for confirmada, execute: node scripts\\bootstrap-install.mjs assumir-reinstalacao --confirmar");
  }
  // Clone novo de verdade: nenhuma evidência → primeiro bootstrap.
  return { seguro: true, acao: "autorizar-bootstrap", motivo: "primeira-instalação" };
}

/**
 * Executa o portão do boot: sonda + decide + aplica escritas.
 * Retorno: { codigo: 0|2, decisao, mensagem }.
 */
export async function executarPortao(opts = {}) {
  const repoDir = opts.repoDir ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m) => console.log(m));
  const mod = await estadoExterno();
  // O portão é o PRODUTOR: escreve autorização/recibo no state dir.
  // Sob MESTRE_HOME sem MESTRE_STATE_DIR esse diretório é o real —
  // escrever contaminaria a instalação verdadeira. Fail-closed.
  if (mod.estadoRealCompartilhado?.(env)) {
    log("[bootstrap] BLOQUEADO: sandbox sem MESTRE_STATE_DIR — o state dir resolvido é o real da instalação; defina MESTRE_STATE_DIR para isolar.");
    return { codigo: 2, decisao: { seguro: false, acao: "bloquear", motivo: "sandbox-sem-state-isolado" }, sonda: null };
  }
  const s = await sondarInstalacao(repoDir, env);
  const d = decidirPortao(s);

  if (!d.seguro) {
    log(`[bootstrap] BLOQUEADO: ${d.motivo}`);
    if (d.instrucao) log(`[bootstrap] ${d.instrucao}`);
    return { codigo: 2, decisao: d, sonda: s };
  }

  if (d.acao === "autorizar-bootstrap") {
    // Produtor confiável do uso único: este gate só roda sob Boot Lock,
    // interativamente, antes de qualquer operação mutável.
    mod.gravarAutorizacaoBootstrap(repoDir, env);
    log("[bootstrap] Primeira instalação detectada — autorização de uso único emitida.");
  } else if (d.acao === "adotar") {
    // Adoção: banco válido prova instalação existente (N-1 → N ou
    // instalação pré-W13). Marcador fora do state dir + recibo dentro.
    mod.gravarMarcadorInstalacao(repoDir, env, { origem: "adocao-banco-valido" });
    if (s.recibo.status === "ausente") mod.gravarReciboInstalacao(repoDir, env);
    mod.limparBootstrapAndamento(repoDir, env); // bootstrap concluído → adoção
    log("[bootstrap] Instalação existente adotada — marcador de proveniência gravado.");
  } else if (d.acao === "prosseguir" && s.banco.estado === "valido" && s.marcador.status === "ok" && s.recibo.status === "ausente") {
    // Reparação mínima: instalação conhecida sem recibo → regrava.
    mod.gravarReciboInstalacao(repoDir, env);
    mod.limparBootstrapAndamento(repoDir, env);
  }
  log(`[bootstrap] OK (${d.motivo}) — fluxo mutável liberado.`);
  return { codigo: 0, decisao: d, sonda: s };
}

/**
 * Avaliação SOMENTE-LEITURA para servidor/migrador: nunca escreve
 * marcador, recibo ou autorização. Retorno:
 * { seguroIniciar: bool, motivo, acao } — bloquear apenas quando a
 * decisão é fail-closed; "adotar"/"autorizar-bootstrap" não escrevem
 * aqui (o gate do .bat é o produtor).
 */
export async function verificarPortao(opts = {}) {
  const repoDir = opts.repoDir ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  const s = await sondarInstalacao(repoDir, env);
  const d = decidirPortao(s);
  if (!d.seguro) {
    return { seguroIniciar: false, motivo: d.motivo, instrucao: d.instrucao, acao: d.acao };
  }
  return { seguroIniciar: true, motivo: d.motivo, acao: d.acao };
}

/** Recuperação explícita: state dir perdido de instalação registrada
 *  (marcador ok). Recria o diretório de estado e o recibo — NÃO recria
 *  journals nem proteções (perdidos de verdade); o operador é avisado. */
export async function recuperarEstadoPerdido(opts = {}) {
  const repoDir = opts.repoDir ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  const mod = await estadoExterno();
  const marcador = mod.lerMarcadorInstalacao(repoDir, env);
  if (marcador.status !== "ok") {
    return { ok: false, motivo: `sem-marcador-valido:${marcador.status}` };
  }
  const s = await sondarInstalacao(repoDir, env);
  // Só recupera com ausência de conteúdo PROVADA: stateProtocolo true
  // (tem registros) ou null (leitura inconclusiva) bloqueiam — nunca
  // gravar recibo sobre estado que não foi possível verificar.
  if (s.stateProtocolo !== false) {
    return {
      ok: false,
      motivo: s.stateProtocolo === null ? "state-ilegivel" : "state-dir-tem-conteudo",
      detalhe: s.stateProtocolo === null
        ? "O diretório de estado existe mas não pôde ser lido — recuperação recusada."
        : "O diretório de estado não está vazio — não é o cenário de perda total.",
    };
  }
  if (mod.estadoRealCompartilhado?.(env)) {
    return { ok: false, motivo: "sandbox-sem-state-isolado", detalhe: "Defina MESTRE_STATE_DIR para isolar o state dir do sandbox." };
  }
  // Recibo precisa estar comprovadamente ausente — ok significa
  // instalação concluída (recusa); qualquer outro estado bloqueia:
  // erro de leitura nunca vira ausência.
  if (s.recibo.status !== "ausente") {
    return {
      ok: false,
      motivo: `recibo-${s.recibo.status}`,
      detalhe: s.recibo.status === "ok"
        ? "Já existe recibo de instalação concluída — reinstalação recusada."
        : "O recibo de instalação não pôde ser verificado — inspeção explícita necessária antes de assumir reinstalação.",
    };
  }
  mod.gravarReciboInstalacao(repoDir, env, { origem: "recuperacao-estado-perdido" });
  return {
    ok: true,
    aviso: "State dir recriado com novo recibo. Journals e marcadores de proteção anteriores foram PERDIDOS — verifique backups\\ manualmente antes de confiar na rotação.",
  };
}

/** Reinstalação assumida pelo operador: única saída para "tudo
 *  perdido" (sem marcador, sem banco, mas com evidência legada ou
 *  estado ambíguo). Exige --confirmar explícito. */
export async function assumirReinstalacao(opts = {}) {
  const repoDir = opts.repoDir ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  const mod = await estadoExterno();
  const marcador = mod.lerMarcadorInstalacao(repoDir, env);
  // --confirmar NÃO é bypass de proveniência: só autoriza quando o
  // marcador está COMPROVADAMENTE ausente. Corrompido/divergente/
  // incompatível/inconclusivo exigem inspeção e recuperação explícita
  // do marcador — emitir autorização aqui produziria sucesso sem estado
  // utilizável (o gate continuaria bloqueando pelo marcador ruim).
  if (marcador.status !== "ausente") {
    return {
      ok: false,
      motivo: `marcador-${marcador.status}`,
      detalhe: marcador.status === "inconclusivo"
        ? "Não foi possível verificar o marcador de proveniência (permissão/leitura)."
        : "O marcador de proveniência existe mas está corrompido, divergente ou incompatível. Inspecione o arquivo de proveniência e recupere-o explicitamente antes de assumir reinstalação.",
    };
  }
  const s = await sondarInstalacao(repoDir, env);
  // Estados admissíveis para reinstalação assumida: "ausente" ou
  // "vazio" (0 tabelas — prova de que não há dados a perder).
  // "valido" recusa (banco existe); "ilegivel"/"inconclusivo" recusam
  // porque --confirmar não pode contornar falha de leitura — estado
  // desconhecido nunca produz autorização.
  if (s.banco.estado === "valido") {
    return { ok: false, motivo: "banco-valido", detalhe: "Banco válido existe — reinstalação recusada." };
  }
  if (s.banco.estado !== "ausente" && s.banco.estado !== "vazio") {
    return {
      ok: false,
      motivo: `banco-${s.banco.estado}`,
      detalhe: `O estado do banco não pôde ser determinado (${s.banco.detalhe ?? s.banco.estado}). Reinstalação recusada — verifique o arquivo ${s.cam.db} primeiro.`,
    };
  }
  // Recibo inconclusivo/corrompido também bloqueia: --confirmar não
  // pode contornar falha de leitura do estado de instalação.
  if (s.recibo.status !== "ausente") {
    return {
      ok: false,
      motivo: `recibo-${s.recibo.status}`,
      detalhe: "O recibo de instalação não está comprovadamente ausente — inspeção explícita necessária antes de assumir reinstalação.",
    };
  }
  if (mod.estadoRealCompartilhado?.(env)) {
    return { ok: false, motivo: "sandbox-sem-state-isolado", detalhe: "Defina MESTRE_STATE_DIR para isolar o state dir do sandbox." };
  }
  mod.gravarAutorizacaoBootstrap(repoDir, env, { origem: "reinstalacao-assumida-operador" });
  return { ok: true, aviso: "Autorização de bootstrap emitida por decisão explícita do operador." };
}

// ---------- CLI ----------
const ehCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ehCli) {
  const cmd = process.argv[2];
  const confirmar = process.argv.includes("--confirmar");
  (async () => {
    if (cmd === "recuperar-estado") {
      const r = await recuperarEstadoPerdido();
      if (!r.ok) { console.error(`[bootstrap] recuperação recusada: ${r.motivo}${r.detalhe ? ` — ${r.detalhe}` : ""}`); process.exit(2); }
      console.log("[bootstrap] State dir recriado.");
      console.log(`[bootstrap] AVISO: ${r.aviso}`);
      process.exit(0);
    }
    if (cmd === "assumir-reinstalacao") {
      if (!confirmar) { console.error("[bootstrap] requer --confirmar explícito"); process.exit(2); }
      const r = await assumirReinstalacao();
      if (!r.ok) { console.error(`[bootstrap] recusado: ${r.motivo}${r.detalhe ? ` — ${r.detalhe}` : ""}`); process.exit(2); }
      console.log(`[bootstrap] ${r.aviso ?? "ok"}`);
      process.exit(0);
    }
    const r = await executarPortao();
    process.exit(r.codigo);
  })().catch((e) => {
    console.error(`[bootstrap] erro inesperado: ${e?.message ?? e}`);
    process.exit(2);
  });
}
