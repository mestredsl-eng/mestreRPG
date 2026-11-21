import { randomInt, randomUUID } from "node:crypto";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { and, eq, inArray, sql, getTableColumns } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  sessions, turns, chatMessages, rolls, tests, characters, memberships, users, sheetVersions, files,
} from "../db/schema.js";
import { estruturaFichaSchema, mapaCampos, campoElegivelParaTeste, campoElegivelParaTesteNivel, type CampoDef, type EstruturaFicha } from "../lib/ficha.js";
import { mensagemVisivel } from "../routes/sessoes.js";
import { agendarAutosave } from "../lib/autosave.js";
import { permissoesDe } from "../lib/permissoes.js";
import { barreiraRestauracaoAtiva, emitirCampanha, emitirPrivadoCampanha, adquirirOperacaoCampanha, pausaTesteEmit, opCampanhaALS, leaseOperacaoALS, liberarLeasesALS } from "../lib/io.js";
import { carregarRegras, carregarRegrasSincrono, impressaoDigitalRegras, type RegrasCampanha } from "../lib/regras.js";
import { registrarUsoD10 } from "../lib/sangue.js";
import { resumoVitalidade } from "../lib/vida.js";
import { calcularIniciativa, INICIATIVA_DADOS_MAX, type ResultadoIniciativa } from "../lib/iniciativa.js";
import { avaliarD10, type AvaliacaoDadoD10 } from "../lib/d10.js";
import { npcFichaVisivel } from "../lib/npc-visibility.js";
import { inferirGeneroVozDaFicha } from "../lib/voz.js";
import {
  lerVtt, nevoaPadrao, tracoRevelarValido, donosDosTokens,
  vttParaDestinatario, VTT_MAX_BYTES, VTT_MAX_NOME, VTT_MAX_TOKENS, NEVOA_MAX_TRAÇOS,
  type TokenVtt, type VttState,
} from "../lib/vtt.js";
import { prepararVidaVtt, vidaNoEstado } from "../lib/vtt-vida.js";
import type { PapelVtt } from "../lib/vtt.js";
import { calibracaoValida } from "../lib/regua.js";
import {
  criarLimitadorSocket, chaveSocket, LIMITES_SOCKET_MESA,
  type AcaoMesaLimitada, type LimitadorSocket,
} from "../lib/socket-rate-limit.js";

const db = getDb();

// ---------- rate limit Socket.IO (Issue #68) ----------
// Um limitador por tipo de ação; a chave é `userId:acao`, então abas e
// sockets do mesmo usuário compartilham a cota. O limite é por
// instância do processo — a aplicação já possui trava de instância
// única, sem estado compartilhado entre processos.
const limitadoresMesa = new Map<AcaoMesaLimitada, LimitadorSocket>();
function limitadorMesa(acao: AcaoMesaLimitada): LimitadorSocket {
  let l = limitadoresMesa.get(acao);
  if (!l) {
    l = criarLimitadorSocket({ ...LIMITES_SOCKET_MESA[acao] });
    limitadoresMesa.set(acao, l);
  }
  return l;
}

/**
 * Consome 1 token da cota da ação. Deve ser chamado SOMENTE depois de
 * autenticação e validação estrutural mínima do payload, e ANTES de
 * resolverCtx, consultas caras, gravações e broadcasts. Ao exceder,
 * responde o ACK `{ ok:false, codigo:"RATE_LIMITED", retryAfterMs }`
 * (se o cliente enviou callback) e retorna false — nunca lança
 * exceção nem derruba a conexão.
 */
function consumirOuRecusar(socket: Socket, acao: AcaoMesaLimitada, cb?: (r: unknown) => void): boolean {
  const u = socket.data.usuario as Usuario | undefined;
  if (!u) return true; // handlers respondem "Não autenticado" adiante
  const r = limitadorMesa(acao).consumir(chaveSocket(u.id, acao));
  if (r.permitido) return true;
  cb?.({ ok: false, codigo: "RATE_LIMITED", erro: "Muitas ações em pouco tempo", retryAfterMs: r.retryAfterMs });
  return false;
}

// Serialização explícita das mutações da mesa virtual: o ciclo
// ler→validar→alterar→gravar→emitir precisa ser atômico por sessão.
// Hoje o driver síncrono (better-sqlite3) já serializa os handlers, mas
// esta fila garante a mesma propriedade se o driver virar assíncrono.
let filaVtt: Promise<unknown> = Promise.resolve();
function comLockVtt<T>(fn: () => Promise<T>): Promise<T> {
  const p = filaVtt.then(fn, fn);
  filaVtt = p.then(() => undefined, () => undefined);
  return p;
}

type Usuario = { id: string; username: string; displayName?: string | null };
type Papel = "mestre" | "jogador" | "espectador";

interface Ctx {
  sessao: typeof sessions.$inferSelect;
  membership: typeof memberships.$inferSelect;
  papel: Papel;
}

const LADOS_VALIDOS = new Set([4, 6, 8, 10, 20]);

// ---------- helpers ----------

async function resolverCtx(socket: Socket, sessionId: string): Promise<Ctx | { erro: string }> {
  const usuario = socket.data.usuario as Usuario | undefined;
  if (!usuario) return { erro: "Não autenticado" };
  let sessao: typeof sessions.$inferSelect | undefined;
  try {
    [sessao] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  } catch (e) {
    // vtt_state corrompido (JSON inválido) não pode derrubar a sessão inteira:
    // recarrega sem a coluna e segue com o estado VTT vazio (o módulo VTT
    // relê o texto bruto de forma defensiva e registra o problema).
    console.error(`[vtt] falha ao ler sessão ${sessionId} (vtt_state inválido?):`, e);
    const { vttState: _omit, ...colsSemVtt } = getTableColumns(sessions);
    const [row] = await db.select(colsSemVtt).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (row) sessao = { ...row, vttState: null } as typeof sessions.$inferSelect;
  }
  if (!sessao) return { erro: "Sessão não encontrada" };
  // barreira de restauração: enquanto a campanha está sendo substituída
  // nenhuma operação de mesa/entrada é autorizada — vale também para
  // operações que já passaram por uma checagem anterior, pois esta
  // revalidação acontece imediatamente antes da mutagem/emissão
  if (barreiraRestauracaoAtiva(sessao.campaignId)) return { erro: "Campanha em restauração" };
  const [m] = await db.select().from(memberships)
    .where(and(eq(memberships.campaignId, sessao.campaignId), eq(memberships.userId, usuario.id), eq(memberships.status, "ativo")))
    .limit(1);
  if (!m) return { erro: "Sem permissão nesta campanha" };
  // lease da operação inteira via AsyncLocalStorage: uma vez adquirido
  // aqui, cobre leituras, validações, mutações e emissões até o finally
  // do wrapper — a drenagem da restauração espera por ele. Se a
  // barreira já existe, a aquisição falha e a operação é recusada.
  // Reutiliza o lease já registrado por ESTA operação (ex.: registrarChat).
  if (opCampanhaALS.getStore() && !leaseOperacaoALS(sessao.campaignId)) {
    return { erro: "Campanha em restauração" };
  }
  return { sessao, membership: m, papel: m.role as Papel };
}

/**
 * Registra handler Socket.IO dentro de um contexto de operação de
 * campanha (AsyncLocalStorage): o resolverCtx adquire o lease uma vez
 * e o finally libera — cobrindo o ciclo completo mesmo com vários
 * awaits e chamadas internas (registrarChat etc.).
 */
function on(socket: Socket, evento: string, handler: (...args: never[]) => unknown) {
  socket.on(evento, (...args: unknown[]) => {
    void opCampanhaALS.run({ ops: new Map() }, async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (handler as (...a: any[]) => unknown)(...(args as any[]));
      } finally {
        liberarLeasesALS(); // uma liberação por campanha, garantida
      }
    });
  });
}

async function mestresDaCampanha(campaignId: string): Promise<string[]> {
  const rows = await db.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), eq(memberships.role, "mestre"), eq(memberships.status, "ativo")));
  return rows.map((r) => r.userId);
}

/** Classificação fail-closed da visibilidade de um TESTE:
 *  somente "publica" vai à sala; somente "privada" chega ao dono do
 *  personagem; "mestre"/"secreta"/desconhecida/inválida são exclusivas
 *  dos mestres atuais — nunca tratadas como públicas. */
function classeVisibilidadeTeste(v: unknown): "publica" | "privada" | "mestre" {
  return v === "publica" ? "publica" : v === "privada" ? "privada" : "mestre";
}

/** Visibilidade equivalente para o registro de chat derivado de um
 *  teste: mestre/secreta/desconhecida viram "mestre" — nunca "publica". */
function visibilidadeChatDoTeste(v: unknown): "publica" | "privada" | "mestre" {
  return classeVisibilidadeTeste(v);
}

/** Nome autoritativo de um elemento de campo `selecao_nivel`: biblioteca
 *  da campanha (regraKind) tem prioridade; opções manuais usam a própria
 *  chave como nome; sem correspondência, exibe a chave crua. */
async function nomeElementoTeste(campo: CampoDef, key: string, campaignId: string): Promise<string> {
  if (campo.regraKind) {
    try {
      const regras = await carregarRegras(campaignId);
      const el = regras.elementos.get(`${campo.regraKind}:${key}`);
      if (el?.name) return el.name;
    } catch { /* biblioteca indisponível — cai no fallback */ }
  }
  return key;
}

const UUID_TESTE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** R6.2 (Issue #186, contrato #7055515759 item 7): resolve se a
 *  rolagem D10 "efetivamente usa um Poder" e qual custo aplicar.
 *  - `elementoKey` do skillRef aponta para um elemento kind="poder"
 *    do ruleset ativo → identidade do Poder (ruleset-scoped, nunca
 *    campoId≅poderKey);
 *  - o elemento precisa constar na ficha ATUAL do personagem
 *    (revalidado na tx — ficha pode ter mudado desde o pedido);
 *  - custo vem de `config.sangue.poderes[key].custo` do ruleset —
 *    NUNCA do cliente; ausente/zero = gratuito;
 *  - `config.sangue.habilitado !== true` (ou config ausente) → roll
 *    D10 legado, sem débito nem escrita no ledger (P2-1);
 *  - campo ligado a Poder SEM identidade de elemento (escalar ou
 *    selecao_nivel sem `elementoKey`, e sem `regra.key` vinculada)
 *    → fail-closed `poder_nao_identificado`, sem roll nem débito
 *    parcial (P2-2) — nunca vira Poder gratuito silencioso.
 *  Retorna "erro" para fail-closed: poder sumiu da ficha, custo
 *  inválido, identidade de teste incompativel com o ledger ou Poder
 *  não identificável. */
function resolverCobrancaSangueD10(
  skillRef: unknown,
  dadosFicha: Record<string, unknown>,
  regras: RegrasCampanha,
  campoSel?: CampoDef | null,
):
  | { tipo: "livre" }
  | { tipo: "debitar"; custo: number; poderKey: string }
  | { tipo: "erro"; erro: "poder_nao_adquirido" | "poder_nao_identificado" | "custo_invalido" | "test_id_invalido" } {
  if (!skillRef || typeof skillRef !== "object" || Array.isArray(skillRef)) return { tipo: "livre" };
  // P2-1: recurso de Sangue desabilitado/ausente → comportamento D10
  // legado. O roll acontece normalmente, sem débito nem mutação do
  // ledger — `habilitado:false` nunca vira ativação gratuita.
  const cfgSangue = regras.config.sangue;
  if (!cfgSangue || cfgSangue.habilitado !== true) return { tipo: "livre" };
  const ref = skillRef as Record<string, unknown>;
  let elementoKey = typeof ref.elementoKey === "string" ? ref.elementoKey : "";
  // Posse por lista de elementos (selecao_nivel) só se aplica quando a
  // identidade veio do skillRef; vínculo `regra.key` do campo prova a
  // posse pelo próprio valor numérico do campo (revalidado abaixo).
  let posseLista = true;
  if (!elementoKey) {
    // P2-2: campo ligado a Poder sem `elementoKey` no skillRef.
    const ehPoder = !!campoSel && (campoSel.regraKind === "poder" || campoSel.regra?.kind === "poder");
    if (!ehPoder) return { tipo: "livre" };
    const keyRegra = campoSel!.regra?.kind === "poder" ? campoSel!.regra.key : "";
    if (!keyRegra) return { tipo: "erro", erro: "poder_nao_identificado" };
    elementoKey = keyRegra;
    posseLista = false;
  }
  // só debita quando o elemento é de fato um Poder das regras vigentes
  const elemento = regras.elementos.get(`poder:${elementoKey}`);
  if (!elemento) {
    // identidade vinda do vínculo do campo aponta para elemento
    // inexistente → fail-closed; elementoKey do cliente sem elemento
    // correspondente segue "não é teste de Poder" (livre) — EXCETO
    // quando o campo validado é ligado a Poder (regraKind/regra.kind):
    // uma key que some do ruleset entre o pedido e a rolagem nunca
    // pode virar D10 gratuito silencioso.
    if (!posseLista) return { tipo: "erro", erro: "poder_nao_identificado" };
    const ehPoderCampo = !!campoSel && (campoSel.regraKind === "poder" || campoSel.regra?.kind === "poder");
    if (ehPoderCampo) return { tipo: "erro", erro: "poder_nao_identificado" };
    return { tipo: "livre" };
  }
  // P1 refresh: o CampoDef atual é AUTORITATIVO — um campo conhecido
  // que NÃO é ligado a Poder nunca vira débito de Sangue, mesmo que
  // exista elemento kind="poder" homônimo no ruleset (ex.:
  // habilidade:poder_fogo × poder:poder_fogo). O elementoKey do
  // cliente não pode promover um campo não-Poder a teste de Poder.
  // campoSel null (campoId ausente da versão atual) preserva o
  // comportamento anterior — a identidade não pode ser provada.
  if (campoSel && campoSel.regraKind !== "poder" && campoSel.regra?.kind !== "poder") {
    return { tipo: "livre" };
  }
  const campoId = typeof ref.campoId === "string" ? ref.campoId : "";
  if (posseLista) {
    // revalidação de posse: o elemento precisa existir na ficha atual
    const lista = campoId && Array.isArray(dadosFicha[campoId])
      ? (dadosFicha[campoId] as { key?: unknown }[])
      : [];
    if (!lista.some((i) => i && typeof i === "object" && i.key === elementoKey)) {
      return { tipo: "erro", erro: "poder_nao_adquirido" };
    }
  } else {
    // vínculo regra.key: a posse é o valor numérico do próprio campo —
    // revalidado na ficha atual (pode ter mudado desde o pedido).
    // Convenção do motor (nivelNoVinculo/aplicarNivelDados): 0 = ausente
    // e valores não-positivos não representam nível adquirido — um campo
    // zerado/negativo NUNCA autoriza débito de Sangue por um Poder que o
    // sistema considera não adquirido.
    const campoRegraId = campoSel?.id ?? campoId;
    const v = campoRegraId ? dadosFicha[campoRegraId] : undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return { tipo: "erro", erro: "poder_nao_adquirido" };
    }
  }
  // Custo zero OU ausente = Poder gratuito — mas NUNCA retorna
  // "livre": a gratuidade é registrada no ledger (`usos["d10:<testId>"]`
  // + evento quantidade 0) para que retry/concorrência sejam
  // idempotentes (contrato #219 @ 7be6aab). Custo inválido segue
  // fail-closed; -0 é normalizado para 0.
  const custoBruto = (cfgSangue.poderes as Record<string, { custo?: unknown }> | undefined)?.[elementoKey]?.custo;
  if (custoBruto !== undefined && custoBruto !== null) {
    if (typeof custoBruto !== "number" || !Number.isFinite(custoBruto) || custoBruto < 0) {
      return { tipo: "erro", erro: "custo_invalido" };
    }
  }
  const custo = custoBruto ?? 0;
  return { tipo: "debitar", custo: custo === 0 ? 0 : custo, poderKey: elementoKey };
}

async function nomeUsuario(id: string | null | undefined): Promise<string> {
  if (!id) return "Sistema";
  const [u] = await db.select({ username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, id)).limit(1);
  return u?.displayName || u?.username || "?";
}

/** Emite mensagem de chat respeitando visibilidade (spec §4/§14). */
async function emitirMensagem(io: SocketIOServer, msg: typeof chatMessages.$inferSelect) {
  // barreira de restauração: nada é entregue durante a substituição —
  // inclusive via usuario:* (salas privadas não são evacuadas)
  if (barreiraRestauracaoAtiva(msg.campaignId)) return;
  const autorNome = await nomeUsuario(msg.authorId);
  const payload = { ...msg, autorNome };
  if (!msg.sessionId) {
    io.to(`campanha:${msg.campaignId}`).emit("mesa:mensagem", payload);
    return;
  }
  const room = `sessao:${msg.sessionId}`;
  if (msg.visibility === "publica" || msg.visibility === "sistema") {
    io.to(room).emit("mesa:mensagem", payload);
    return;
  }
  // emissões privadas passam pela função central: destinatários são
  // revalidados como membros ATIVOS no instante do envio
  if (msg.visibility === "mestre" || msg.visibility === "secreta") {
    const mestres = await mestresDaCampanha(msg.campaignId);
    await emitirPrivadoCampanha(msg.campaignId, mestres, "mesa:mensagem", payload, ["mestre"]);
    return;
  }
  // privada: autor + destinatários — somente membros ainda ativos recebem
  const destinos = new Set<string>((msg.recipients ?? []) as string[]);
  if (msg.authorId) destinos.add(msg.authorId);
  await emitirPrivadoCampanha(msg.campaignId, [...destinos], "mesa:mensagem", payload);
}

// ---------- dados ----------

async function registrarChat(
  io: SocketIOServer,
  opts: {
    campaignId: string; sessionId?: string | null; authorId?: string | null;
    kind?: string; content: string; visibility?: string;
    recipients?: string[]; clientId?: string;
    speakerCharacterId?: string | null; speakerName?: string | null; speakerGender?: "feminina" | "masculina" | null;
  }
) {
  const id = opts.clientId && /^[0-9a-f-]{36}$/i.test(opts.clientId) ? opts.clientId : randomUUID();
  // lease de operação: reutiliza o lease JÁ registrado nesta operação
  // (ALS) — registrarChat dentro de um handler não adquire um segundo
  // lease nem pode falhar por barreira após a primeira gravação do
  // handler. Fora de contexto ALS, adquire/libera o próprio lease.
  const store = opCampanhaALS.getStore();
  const reutiliza = !!store?.ops.has(opts.campaignId);
  const liberar = reutiliza ? null : adquirirOperacaoCampanha(opts.campaignId);
  if (!reutiliza && !liberar) return null; // campanha em restauração: nada é gravado
  try {
    // gancho determinístico: pausa após a autorização, antes da mutação
    await pausaTesteEmit(JSON.stringify(opts));
    // barreira pode ter começado durante a pausa: aborta antes de gravar
    // SOMENTE quando este é um lease independente — dentro de uma
    // operação com lease do handler, a operação autorizada deve
    // completar o ciclo (o restore espera por ela na drenagem)
    if (!reutiliza && barreiraRestauracaoAtiva(opts.campaignId)) return null;
    try {
      await db.insert(chatMessages).values({
        id, campaignId: opts.campaignId, sessionId: opts.sessionId ?? null,
        authorId: opts.authorId ?? null, kind: opts.kind ?? "texto",
        content: opts.content, visibility: opts.visibility ?? "publica",
        recipients: opts.recipients ?? null,
        speakerCharacterId: opts.speakerCharacterId ?? null,
        speakerName: opts.speakerName ?? null,
        speakerGender: opts.speakerGender ?? null,
        createdAt: new Date(),
      });
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        const [existente] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
        if (existente) { await emitirMensagem(io, existente); return existente; }
      }
      throw e;
    }
    const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
    // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: chat_messages já foi
    // inserido — o lease (próprio ou ALS do handler) cobre até a emissão
    await pausaTesteEmit(JSON.stringify({ ...opts, fase: "pos-write" }));
    await emitirMensagem(io, msg);
    // Etapa 12: toda mutação de mesa que gera mensagem também agenda salvamento
    agendarAutosave(opts.campaignId);
    return msg;
  } finally {
    liberar?.(); // no-op quando o lease é do contexto ALS (wrapper libera)
  }
}

async function turnoAtual(sessionId: string) {
  const [t] = await db.select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1);
  return t;
}

// ---------- dados ----------

function rolarLados(lados: number, count: number): number[] {
  return Array.from({ length: count }, () => randomInt(1, lados + 1));
}

// ---------- registro ----------

export function registrarMesa(io: SocketIOServer) {
  // cada socket entra na sala do próprio usuário para mensagens direcionadas
  io.on("connection", (socket) => {
    const u = socket.data.usuario as Usuario | undefined;
    if (u) socket.join(`usuario:${u.id}`);
  });

  // ---------- presença ----------
  function presentes(sessionId: string): string[] {
    const room = io.sockets.adapter.rooms.get(`sessao:${sessionId}`);
    if (!room) return [];
    const ids = new Set<string>();
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      const uid = (s?.data.usuario as Usuario | undefined)?.id;
      if (uid) ids.add(uid);
    }
    return [...ids];
  }
  async function emitirPresenca(sessionId: string) {
    io.to(`sessao:${sessionId}`).emit("mesa:presenca", { sessionId, online: presentes(sessionId) });
  }

  // ---------- entrada/saída ----------
  socket_handlers(io, presentes, emitirPresenca);
}

// temporizador: duração entre 1 minuto e 24 horas (segundos)
const TIMER_DURACAO_MIN_S = 60;
const TIMER_DURACAO_MAX_S = 86400;
function duracaoTimerValida(seg: unknown): number | null {
  if (typeof seg !== "number" || !Number.isFinite(seg) || !Number.isInteger(seg)) return null;
  return seg >= TIMER_DURACAO_MIN_S && seg <= TIMER_DURACAO_MAX_S ? seg : null;
}
const ERRO_DURACAO_TIMER = "Duração inválida — use entre 1 e 1440 minutos";

// separado para legibilidade
function socket_handlers(
  io: SocketIOServer,
  presentes: (sessionId: string) => string[],
  emitirPresenca: (sessionId: string) => Promise<void>
) {
  io.on("connection", (socket) => {
    const usuario = () => socket.data.usuario as Usuario | undefined;

    /** mesa:entrar {sessionId} — válido para mestre/jogador/espectador ativo */
    on(socket, "mesa:entrar", async (payload: { sessionId?: string }, cb?: (r: unknown) => void) => {
      const sessionId = payload?.sessionId;
      if (!sessionId || !usuario()) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      if (!consumirOuRecusar(socket, "entrar", cb)) return;
      const ctx = await resolverCtx(socket, sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
      // Barreira de teste determinística (somente NODE_ENV=test +
      // MESTRE_VTT_BARRIER_MS): abre uma janela controlada entre a
      // validação inicial e a autorização final, permitindo reproduzir
      // troca de papel/membership no meio da entrada. Inerte em produção.
      if (process.env.NODE_ENV === "test") {
        const barreiraMs = Number(process.env.MESTRE_VTT_BARRIER_MS ?? 0);
        if (barreiraMs > 0) await new Promise((r) => setTimeout(r, barreiraMs));
      }
      // Seção crítica: o socket SÓ entra na sala depois da autorização
      // final. Enquanto não ingressa, nenhum evento da sala (mensagens
      // públicas/sistema emitidas via io.to(room)) pode alcançá-lo.
      // As leituras ocorrem dentro do lock para refletir mutações VTT
      // anteriores e serializar a entrada com mapa/token/névoa.
      await comLockVtt(async () => {
        const vttEntrar = await lerVtt(sessionId);
        const [donos, t] = await Promise.all([
          donosDosTokens(sessionId, vttEntrar.tokens),
          db.select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1).then((r) => r[0]),
        ]);
        // Revalidação final: membership, papel e status da sessão podem
        // ter mudado durante a espera do lock e as leituras. O join, o
        // emit e o ACK usam SOMENTE este contexto.
        const ctxF = await resolverCtx(socket, sessionId);
        if ("erro" in ctxF || ctxF.sessao.status === "encerrada") {
          cb?.({ ok: false, erro: "erro" in ctxF ? ctxF.erro : "Sessão encerrada" });
          return;
        }
        // revalidação atômica: sem await entre a checagem e o join —
        // ingresso não atravessa uma barreira que começou na espera
        if (barreiraRestauracaoAtiva(ctxF.sessao.campaignId)) {
          cb?.({ ok: false, erro: "Campanha em restauração" });
          return;
        }
        socket.join(`sessao:${sessionId}`);
        const papel = ctxF.papel;
        const uF = usuario()!;
        // vttParaDestinatario é a ÚNICA via de filtragem: cobre névoa
        // desligada, tokens ocultos (NPCs não revelados) e tokens do
        // próprio jogador — o atalho "névoa off → estado completo"
        // vazaria tokens ocultos para não-mestres.
        const visaoEntrar = papel === "mestre"
          ? vttEntrar
          : vttParaDestinatario(vttEntrar, papel as "jogador" | "espectador", uF.id, donos);
        const ctxVidaEntrar = await prepararVidaVtt(sessionId, vttEntrar.tokens);
        const vttEu = vidaNoEstado(ctxVidaEntrar, visaoEntrar, papel as PapelVtt, uF.id, ctxF.membership.id, donos);
        socket.emit("mesa:vtt", { sessionId, vtt: vttEu });
        const podeEnviar = papel !== "espectador" || permissoesDe(ctxF.membership).enviarMensagens === true;
        cb?.({
          ok: true, papel, podeEnviar,
          // vttState filtrado e sanitizado: JSON inválido ou névoa não vazam
          sessao: { ...ctxF.sessao, vttState: vttEu },
          turnos: t?.state ?? { ordem: [], atual: -1, ativo: false },
          presenca: presentes(sessionId),
          agora: Date.now(),
        });
        await emitirPresenca(sessionId);
        await registrarChat(io, {
          campaignId: ctxF.sessao.campaignId, sessionId, authorId: uF.id,
          kind: "evento", content: `${await nomeUsuario(uF.id)} entrou na mesa`, visibility: "publica",
        });
      });
    });

    on(socket, "mesa:sair", (payload: { sessionId?: string }, cb?: (r: unknown) => void) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) { cb?.({ ok: false }); return; }
      socket.leave(`sessao:${sessionId}`);
      void emitirPresenca(sessionId);
      cb?.({ ok: true });
    });

    // ---------- mesa virtual: mapa + tokens (Etapa 1) ----------
    // Estado persistido em sessions.vtt_state (JSON texto) — mesmo padrão do
    // temporizador. O servidor é autoridade: valida papel, associação do
    // token e coordenadas antes de gravar; emite `mesa:vtt` com o estado
    // completo somente após a persistência. Reconexão recebe o estado via
    // callback de `mesa:entrar` (sessao.vttState) e pelo emit fresco pós-join.
    // Mutações passam por comLockVtt (serialização explícita do ciclo
    // ler→validar→gravar→emitir, independente do driver).

    /**
     * Emissão filtrada por destinatário (Etapa 2 — névoa): cada socket da sala
     * recebe somente a visão autorizada. Papel e membership são revalidados
     * no banco a cada emissão — socket.data nunca é fonte de autorização.
     * Sockets sem usuário autenticado ou sem acesso atual não recebem nada.
     */
    const emitirVtt = async (sessionId: string, vtt: VttState) => {
      const room = `sessao:${sessionId}`;
      // sockets reais (não RemoteSocket): emissão direcionada funciona com
      // qualquer adaptador e preserva socket.data do socket local
      const sockets = [...io.sockets.sockets.values()].filter((s) => s.rooms.has(room));
      if (!sockets.length) return;
      const donos = await donosDosTokens(sessionId, vtt.tokens);
      const ctxVida = await prepararVidaVtt(sessionId, vtt.tokens);
      await Promise.all(sockets.map(async (s) => {
        const u = s.data.usuario as Usuario | undefined;
        if (!u) return;
        const ctx = await resolverCtx(s, sessionId);
        if ("erro" in ctx || ctx.sessao.status === "encerrada") return;
        const visao = vttParaDestinatario(vtt, ctx.papel, u.id, donos);
        s.emit("mesa:vtt", { sessionId, vtt: vidaNoEstado(ctxVida, visao, ctx.papel, u.id, ctx.membership.id, donos) });
      }));
    };
    /** Visão VTT do próprio requisitante (ACKs e mesa:entrar). */
    const vttParaUsuario = async (sessionId: string, vtt: VttState, papel: string, userId: string, membershipId?: string): Promise<VttState> => {
      // Mesma regra do mesa:entrar — névoa desligada NÃO libera tokens
      // ocultos para não-mestres; o filtro canônico decide tudo.
      const donos = await donosDosTokens(sessionId, vtt.tokens);
      const visao = papel === "mestre" ? vtt : vttParaDestinatario(vtt, papel as "jogador" | "espectador", userId, donos);
      const ctxVida = await prepararVidaVtt(sessionId, vtt.tokens);
      return vidaNoEstado(ctxVida, visao, papel as PapelVtt, userId, membershipId, donos);
    };

    const posicaoValida = (x: unknown, y: unknown): x is number =>
      typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1
      && typeof y === "number" && Number.isFinite(y) && y >= 0 && y <= 1;
    const corValida = (c: unknown): c is string =>
      typeof c === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c);
    /** Nome de token: string obrigatória quando informada; 1–60 chars após trim. */
    const nomeValido = (n: unknown): n is string =>
      typeof n === "string" && n.trim().length >= 1 && n.trim().length <= VTT_MAX_NOME;

    /** Dono efetivo do token: userId direto; senão o userId da membership do personagem. */
    async function donoDoToken(sessionId: string, token: TokenVtt): Promise<string | null> {
      if (token.userId) return token.userId;
      if (!token.personagemId) return null;
      const [s] = await db.select({ campaignId: sessions.campaignId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!s) return null;
      const [ch] = await db.select({ membershipId: characters.membershipId }).from(characters)
        .where(and(eq(characters.id, token.personagemId), eq(characters.campaignId, s.campaignId))).limit(1);
      if (!ch) return null;
      const [m] = await db.select({ userId: memberships.userId, status: memberships.status }).from(memberships)
        .where(eq(memberships.id, ch.membershipId)).limit(1);
      return m && m.status === "ativo" ? m.userId : null;
    }
    /** Jogador só move token cujo dono efetivo é ele. */
    async function tokenPertenceAoUsuario(sessionId: string, token: TokenVtt, userId: string): Promise<boolean> {
      return (await donoDoToken(sessionId, token)) === userId;
    }
    /**
     * Valida coerência dos vínculos userId/personagemId (P4): no máximo um
     * dono. Se ambos informados, o personagem precisa pertencer à membership
     * do mesmo usuário. Retorna { ok, userId, personagemId } ou { erro }.
     */
    async function validarVinculo(campaignId: string, userId: unknown, personagemId: unknown):
      Promise<{ ok: true; userId: string | null; personagemId: string | null; personagemNpc: boolean } | { ok: false; erro: string }> {
      let uid: string | null = null;
      let pid: string | null = null;
      let personagemNpc = false;
      if (userId !== undefined && userId !== null) {
        if (typeof userId !== "string" || !userId) return { ok: false, erro: "userId inválido" };
        const [mem] = await db.select({ id: memberships.id }).from(memberships)
          .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId), eq(memberships.status, "ativo"))).limit(1);
        if (!mem) return { ok: false, erro: "Usuário não é membro ativo" };
        uid = userId;
      }
      if (personagemId !== undefined && personagemId !== null) {
        if (typeof personagemId !== "string" || !personagemId) return { ok: false, erro: "personagemId inválido" };
        const [ch] = await db.select({ membershipId: characters.membershipId, isNpc: characters.isNpc }).from(characters)
          .where(and(eq(characters.id, personagemId), eq(characters.campaignId, campaignId))).limit(1);
        if (!ch) return { ok: false, erro: "Personagem não encontrado na campanha" };
        pid = personagemId;
        personagemNpc = ch.isNpc === true;
        if (uid) {
          const [mem] = await db.select({ userId: memberships.userId }).from(memberships)
            .where(and(eq(memberships.id, ch.membershipId), eq(memberships.status, "ativo"))).limit(1);
          if (!mem || mem.userId !== uid) return { ok: false, erro: "Personagem pertence a outro jogador" };
        }
      }
      return { ok: true, userId: uid, personagemId: pid, personagemNpc };
    }

    /** mesa:vtt:mapa {sessionId, acao:"definir"|"remover"|"calibrar", mapa?, regua?} — somente mestre. */
    on(socket, "mesa:vtt:mapa", async (payload: {
      sessionId?: string; acao?: string;
      mapa?: { fileId?: string; nome?: string; largura?: number; altura?: number } | null;
      regua?: unknown;
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      if (!consumirOuRecusar(socket, "vttMapa", cb)) return;
      const ctx = await resolverCtx(socket, sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      // P1: espectador é somente leitura — nenhuma mutação de mapa ou token
      if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectador não pode alterar a mesa" }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Somente o mestre altera o mapa" }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
      await comLockVtt(async () => {
        // revalida dentro da seção crítica: membership/papel podem mudar durante a espera do lock
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Somente o mestre altera o mapa" }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        if (payload.acao === "remover") {
          vtt.mapa = null;
        } else if (payload.acao === "calibrar") {
          // Régua de distância (Issue #125): calibração da sessão gravada
          // em vtt_state.regua. `regua: null` remove a calibração; valor
          // presente precisa passar na validação estrita (unidade ≤24,
          // números finitos positivos). A medição nunca trafega — só a
          // configuração, que é compartilhada por definição.
          if (payload.regua === null) {
            vtt.regua = null;
          } else if (calibracaoValida(payload.regua)) {
            const c = payload.regua;
            vtt.regua = { unidade: c.unidade.trim(), distanciaReferencia: c.distanciaReferencia, valorReferencia: c.valorReferencia };
          } else {
            cb?.({ ok: false, erro: "Calibração da régua inválida" }); return;
          }
        } else if (payload.acao === "definir") {
          const m = payload.mapa;
          if (!m || typeof m.fileId !== "string" || !m.fileId || m.fileId.length > 100) {
            cb?.({ ok: false, erro: "Mapa inválido" }); return;
          }
          // o arquivo precisa existir na biblioteca DESTA campanha, ser imagem
          // aprovada e visível a todos os participantes (P3: visibility pública)
          const [arq] = await db.select({ id: files.id, mimeType: files.mimeType, fileName: files.fileName, status: files.status, visibility: files.visibility })
            .from(files)
            .where(and(eq(files.id, m.fileId), eq(files.campaignId, ctx.sessao.campaignId))).limit(1);
          if (!arq || arq.status !== "aprovado") { cb?.({ ok: false, erro: "Imagem de mapa não encontrada" }); return; }
          if (arq.visibility !== "publica") { cb?.({ ok: false, erro: "Mapa precisa ter visibilidade pública para todos os participantes" }); return; }
          const ehImagem = (arq.mimeType ?? "").startsWith("image/")
            || /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(arq.fileName);
          if (!ehImagem) { cb?.({ ok: false, erro: "O mapa precisa ser uma imagem" }); return; }
          // dimensões intrínsecas da imagem (Issue #125): só positivas e
          // finitas; par incompleto/inválido é descartado (tabuleiro cai
          // na geometria aproximada do cliente em vez de distorcer).
          const dimOk = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
          const lw = dimOk(m.largura) ? m.largura : undefined;
          const ht = dimOk(m.altura) ? m.altura : undefined;
          vtt.mapa = {
            fileId: m.fileId,
            nome: typeof m.nome === "string" ? m.nome.slice(0, 140) : "Mapa",
            ...(lw !== undefined && ht !== undefined ? { largura: lw, altura: ht } : {}),
          };
        } else {
          cb?.({ ok: false, erro: "Ação inválida" }); return;
        }
        if (JSON.stringify(vtt).length > VTT_MAX_BYTES) { cb?.({ ok: false, erro: "Estado da mesa excede o limite" }); return; }
        await pausaTesteEmit(JSON.stringify(payload));
        await db.update(sessions).set({ vttState: vtt as never, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
        agendarAutosave(ctx.sessao.campaignId);
        // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: vttState persistido
        await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
        await emitirVtt(sessionId, vtt);
        cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u!.id, ctx.membership.id) });
      });
    });

    /** mesa:vtt:token {sessionId, acao, token} — mestre tudo; jogador só move o próprio. */
    on(socket, "mesa:vtt:token", async (payload: {
      sessionId?: string; acao?: string;
      token?: Partial<TokenVtt> & { id?: string };
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      if (!consumirOuRecusar(socket, "vttToken", cb)) return;
      const ctx = await resolverCtx(socket, sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      // P1: espectador é somente leitura — nenhuma mutação de mapa ou token
      if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectador não pode alterar a mesa" }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
      await comLockVtt(async () => {
        // revalida dentro da seção crítica: membership/papel podem mudar durante a espera do lock
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectador não pode alterar a mesa" }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        const t = payload.token ?? {};
        const acao = payload.acao;
        const ehMestre = ctx.papel === "mestre";
        const idx = typeof t.id === "string" ? vtt.tokens.findIndex((x) => x.id === t.id) : -1;
        const existente = idx >= 0 ? vtt.tokens[idx] : undefined;

        if (acao === "criar") {
          if (!ehMestre) { cb?.({ ok: false, erro: "Somente o mestre cria tokens" }); return; }
          // idempotência: se o cliente reenviou um criar com id já existente, não duplica
          if (typeof t.id === "string" && vtt.tokens.some((x) => x.id === t.id)) {
            cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u.id, ctx.membership.id), idempotente: true }); return;
          }
          if (vtt.tokens.length >= VTT_MAX_TOKENS) { cb?.({ ok: false, erro: `Limite de ${VTT_MAX_TOKENS} tokens por sessão atingido` }); return; }
          if (!posicaoValida(t.x, t.y)) { cb?.({ ok: false, erro: "Posição inválida" }); return; }
          // P7: nome precisa ser string válida quando informado
          if (t.nome !== undefined && !nomeValido(t.nome)) { cb?.({ ok: false, erro: "Nome de token inválido" }); return; }
          const nome = t.nome === undefined ? "Token" : (t.nome as string).trim().slice(0, VTT_MAX_NOME);
          const cor = corValida(t.cor) ? t.cor : "#888888";
          // P4: vínculos coerentes — personagem e usuário precisam ser do mesmo dono
          const vinc = await validarVinculo(ctx.sessao.campaignId, t.userId, t.personagemId);
          if (!vinc.ok) { cb?.({ ok: false, erro: vinc.erro }); return; }
          const idToken = typeof t.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(t.id) ? t.id : randomUUID();
          // Token vinculado a NPC nasce oculto por padrão — o mestre
          // decide explicitamente quando exibir aos jogadores.
          const oculto = t.oculto !== undefined ? !!t.oculto : vinc.personagemNpc;
          const novo: TokenVtt = {
            id: idToken, nome, cor, x: t.x as number, y: t.y as number,
            userId: vinc.userId, personagemId: vinc.personagemId, ativo: t.ativo !== false,
            ...(oculto ? { oculto: true } : {}),
          };
          vtt.tokens.push(novo);
        } else if (acao === "atualizar" || acao === "mover") {
          if (!existente) { cb?.({ ok: false, erro: "Token não encontrado" }); return; }
          if (!posicaoValida(t.x ?? existente.x, t.y ?? existente.y)) { cb?.({ ok: false, erro: "Posição inválida" }); return; }
          if (ehMestre) {
            if (t.nome !== undefined) {
              if (!nomeValido(t.nome)) { cb?.({ ok: false, erro: "Nome de token inválido" }); return; }
              existente.nome = t.nome.trim().slice(0, VTT_MAX_NOME);
            }
            if (t.cor !== undefined) {
              if (!corValida(t.cor)) { cb?.({ ok: false, erro: "Cor inválida" }); return; }
              existente.cor = t.cor;
            }
            if (t.ativo !== undefined) existente.ativo = !!t.ativo;
            if (t.oculto !== undefined) {
              if (t.oculto) existente.oculto = true; else delete existente.oculto;
            }
            if (t.userId !== undefined || t.personagemId !== undefined) {
              // P4: reatribuição valida coerência usuário×personagem.
              // Campos não enviados mantêm o vínculo atual.
              const novoUser = t.userId !== undefined ? t.userId : existente.userId;
              const novoPers = t.personagemId !== undefined ? t.personagemId : existente.personagemId;
              const vinc = await validarVinculo(ctx.sessao.campaignId, novoUser, novoPers);
              if (!vinc.ok) { cb?.({ ok: false, erro: vinc.erro }); return; }
              existente.userId = vinc.userId;
              existente.personagemId = vinc.personagemId;
              // Revincular a um NPC volta a ocultar por padrão (salvo
              // oculto explícito no mesmo payload).
              if (vinc.personagemNpc && t.oculto === undefined) existente.oculto = true;
            }
          } else {
            // jogador: somente posição do próprio token — nada mais
            if (!(await tokenPertenceAoUsuario(sessionId, existente, u.id))) {
              cb?.({ ok: false, erro: "Token não pertence a você" }); return;
            }
          }
          existente.x = t.x ?? existente.x;
          existente.y = t.y ?? existente.y;
        } else if (acao === "remover") {
          if (!ehMestre) { cb?.({ ok: false, erro: "Somente o mestre remove tokens" }); return; }
          if (!existente) { cb?.({ ok: false, erro: "Token não encontrado" }); return; }
          vtt.tokens.splice(idx, 1);
        } else {
          cb?.({ ok: false, erro: "Ação inválida" }); return;
        }
        if (JSON.stringify(vtt).length > VTT_MAX_BYTES) { cb?.({ ok: false, erro: "Estado da mesa excede o limite" }); return; }
        await pausaTesteEmit(JSON.stringify(payload));
        await db.update(sessions).set({ vttState: vtt as never, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
        agendarAutosave(ctx.sessao.campaignId);
        // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: vttState persistido
        await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
        await emitirVtt(sessionId, vtt);
        cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u.id, ctx.membership.id) });
      });
    });

    /**
     * mesa:vtt:nevoa {sessionId, acao, traco?} — somente mestre (Etapa 2).
     * acoes: "revelar" (traco {raioX,raioY,pontos[]} → id gerado no servidor),
     * "desfazer" (remove o último traço), "ocultarTudo" (ativa névoa sem
     * regiões), "revelarTudo" (desativa névoa; traços são preservados para
     * eventual reativação futura — a névoa desativada não os utiliza).
     */
    on(socket, "mesa:vtt:nevoa", async (payload: {
      sessionId?: string; acao?: string;
      traco?: { raioX?: number; raioY?: number; pontos?: { x: number; y: number }[] };
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      if (!consumirOuRecusar(socket, "vttNevoa", cb)) return;
      // Ordenação: a operação entra na fila VTT IMEDIATAMENTE, antes de
      // qualquer await. Como o transporte preserva a ordem por conexão,
      // uma sincronização posterior (mesa:vtt:nevoa:sincronizar) só
      // responde depois que esta operação terminar — nunca existe
      // mutação antiga pendente atrás de uma consulta de sincronização.
      await comLockVtt(async () => {
        // barreira determinística de teste (NODE_ENV=test apenas):
        // segura a operação DENTRO da seção crítica para provar que a
        // sincronização fica enfileirada atrás dela. Inerte em produção.
        if (process.env.NODE_ENV === "test") {
          const barreiraMs = Number(process.env.MESTRE_VTT_NEVOA_BARRIER_MS ?? 0);
          if (barreiraMs > 0) await new Promise((r) => setTimeout(r, barreiraMs));
        }
        // revalida dentro da seção crítica: membership/papel podem mudar durante a espera do lock
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Somente o mestre pode alterar a névoa" }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        if (!vtt.nevoa || typeof vtt.nevoa !== "object") vtt.nevoa = nevoaPadrao();
        const acao = payload.acao;
        if (acao === "revelar") {
          if (!vtt.nevoa.ativa) vtt.nevoa.ativa = true;
          const val = tracoRevelarValido(payload.traco);
          if (!val.ok) { cb?.({ ok: false, erro: val.erro }); return; }
          const totalAtual = vtt.nevoa.revelados.reduce((s, t) => s + t.pontos.length, 0);
          if (vtt.nevoa.revelados.length >= NEVOA_MAX_TRAÇOS) { cb?.({ ok: false, erro: `Limite de ${NEVOA_MAX_TRAÇOS} traços de névoa atingido` }); return; }
          if (totalAtual + val.traco.pontos.length > 1000) { cb?.({ ok: false, erro: "Limite de pontos de névoa atingido" }); return; }
          vtt.nevoa.revelados.push({ id: randomUUID(), ...val.traco });
        } else if (acao === "desfazer") {
          vtt.nevoa.revelados.pop();
        } else if (acao === "ocultarTudo") {
          vtt.nevoa = { ativa: true, revelados: [] };
        } else if (acao === "revelarTudo") {
          vtt.nevoa.ativa = false; // traços preservados; inertes enquanto desativada
        } else {
          cb?.({ ok: false, erro: "Ação inválida" }); return;
        }
        if (JSON.stringify(vtt).length > VTT_MAX_BYTES) { cb?.({ ok: false, erro: "Estado da mesa excede o limite" }); return; }
        await pausaTesteEmit(JSON.stringify(payload));
        await db.update(sessions).set({ vttState: vtt as never, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
        agendarAutosave(ctx.sessao.campaignId);
        // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: vttState persistido
        await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
        await emitirVtt(sessionId, vtt);
        cb?.({ ok: true, vtt: await vttParaUsuario(sessionId, vtt, ctx.papel, u.id, ctx.membership.id) });
      });
    });

    /**
     * mesa:vtt:nevoa:sincronizar {sessionId} — leitura autoritativa e
     * ORDENADA da névoa. Entra em comLockVtt imediatamente ao ser
     * recebido (antes de qualquer await), na mesma fila das mutações:
     * como o transporte preserva a ordem por conexão, a resposta só é
     * produzida depois que toda operação de névoa já entregue ao
     * servidor tiver terminado — e reflete o estado pós-operações.
     * Não modifica o VTT nem permissões. Não aceita papel do cliente.
     */
    on(socket, "mesa:vtt:nevoa:sincronizar", async (payload: { sessionId?: string },
      cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      await comLockVtt(async () => {
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        // revalidação final após as leituras assíncronas: papel/membership
        // podem ter mudado durante lerVtt/donosDosTokens
        const ctxF = await resolverCtx(socket, sessionId);
        if ("erro" in ctxF) { cb?.({ ok: false, erro: ctxF.erro }); return; }
        if (ctxF.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        cb?.({ ok: true, papel: ctxF.papel, vtt: await vttParaUsuario(sessionId, vtt, ctxF.papel, u.id, ctxF.membership.id) });
      });
    });

    /**
     * mesa:vtt:sincronizar {sessionId} — releitura autoritativa do VTT
     * completo (mapa+tokens+névoa+vida) para o requisitante. Usado pelo
     * cliente quando personagens:atualizados/regras:atualizadas podem ter
     * alterado HP/vitalidade sem emitir mesa:vtt. Não modifica estado.
     */
    on(socket, "mesa:vtt:sincronizar", async (payload: { sessionId?: string },
      cb?: (r: unknown) => void) => {
      const u = usuario();
      const sessionId = payload?.sessionId;
      if (!u || !sessionId) { cb?.({ ok: false, erro: "Não autenticado" }); return; }
      // cota ANTES de comLockVtt/resolverCtx: a sincronização faz
      // releituras e consultas caras — sem limite, um flood por socket
      // esgota a fila VTT para todos os participantes.
      if (!consumirOuRecusar(socket, "vttSync", cb)) return;
      await comLockVtt(async () => {
        const ctx = await resolverCtx(socket, sessionId);
        if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
        if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        const vtt = await lerVtt(sessionId);
        const ctxF = await resolverCtx(socket, sessionId);
        if ("erro" in ctxF) { cb?.({ ok: false, erro: ctxF.erro }); return; }
        if (ctxF.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }
        cb?.({ ok: true, papel: ctxF.papel, vtt: await vttParaUsuario(sessionId, vtt, ctxF.papel, u.id, ctxF.membership.id) });
      });
    });

    // ---------- chat / declarações ----------
    on(socket, "mesa:mensagem", async (payload: {
      sessionId?: string; content?: string; clientId?: string;
      visibilidade?: "publica" | "privada" | "secreta"; destinatarioUserId?: string; tipo?: "texto" | "acao";
      speakerCharacterId?: string; speakerNarrator?: boolean; speakerNarratorGender?: "feminina" | "masculina";
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.content?.trim()) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      if (!consumirOuRecusar(socket, "chat", cb)) return;
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      // espectador só envia mensagem se o mestre concedeu a permissão individual
      if (ctx.papel === "espectador" && permissoesDe(ctx.membership).enviarMensagens !== true) {
        cb?.({ ok: false, erro: "Espectadores não podem enviar mensagens" }); return;
      }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }

      const vis = payload.visibilidade ?? "publica";
      // espectador só participa do chat público — nunca envia privada/secreta
      if (ctx.papel === "espectador" && vis !== "publica") {
        cb?.({ ok: false, erro: "Espectadores só podem enviar mensagens públicas" }); return;
      }
      let visibility = "publica";
      let recipients: string[] | undefined;
      if (vis === "secreta") {
        if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre envia mensagens secretas" }); return; }
        visibility = "mestre";
      } else if (vis === "privada") {
        if (!payload.destinatarioUserId) { cb?.({ ok: false, erro: "Destinatário obrigatório" }); return; }
        // destinatário precisa ser membro ativo da campanha
        const [dm] = await db.select({ id: memberships.id }).from(memberships)
          .where(and(eq(memberships.campaignId, ctx.sessao.campaignId), eq(memberships.userId, payload.destinatarioUserId), eq(memberships.status, "ativo"))).limit(1);
        if (!dm) { cb?.({ ok: false, erro: "Destinatário inválido" }); return; }
        visibility = "privada";
        recipients = [payload.destinatarioUserId];
      }

      let speakerCharacterId: string | null = null;
      let speakerName: string | null = null;
      let speakerGender: "feminina" | "masculina" | null = null;
      if (payload.speakerNarrator === true) {
        if (ctx.papel !== "mestre" || payload.speakerCharacterId) {
          cb?.({ ok: false, erro: "Somente o mestre pode falar como narrador" }); return;
        }
        if (payload.speakerNarratorGender !== "feminina" && payload.speakerNarratorGender !== "masculina") {
          cb?.({ ok: false, erro: "Selecione a voz do narrador" }); return;
        }
        speakerName = "Narrador";
        speakerGender = payload.speakerNarratorGender;
      } else if (payload.speakerCharacterId) {
        const [personagem] = await db.select().from(characters)
          .where(and(eq(characters.id, payload.speakerCharacterId), eq(characters.campaignId, ctx.sessao.campaignId)))
          .limit(1);
        if (!personagem || personagem.status === "arquivado") {
          cb?.({ ok: false, erro: "Personagem de fala não encontrado ou arquivado" }); return;
        }
        if (ctx.papel !== "mestre" && (ctx.papel !== "jogador" || personagem.isNpc || personagem.membershipId !== ctx.membership.id)) {
          cb?.({ ok: false, erro: "Você não pode falar como este personagem" }); return;
        }
        speakerCharacterId = personagem.id;
        speakerName = personagem.name;
        if (personagem.templateVersionId) {
          const [versao] = await db.select({ structure: sheetVersions.structure })
            .from(sheetVersions).where(eq(sheetVersions.id, personagem.templateVersionId)).limit(1);
          speakerGender = inferirGeneroVozDaFicha(versao?.structure, personagem.data);
        }
      } else if (payload.speakerNarratorGender !== undefined) {
        cb?.({ ok: false, erro: "Gênero de narrador sem identidade de narrador" }); return;
      }

      const msg = await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: payload.tipo === "acao" ? "acao" : "texto",
        content: payload.content.trim().slice(0, 4000),
        visibility, recipients, clientId: payload.clientId,
        speakerCharacterId, speakerName, speakerGender,
      });
      cb?.({ ok: true, id: msg?.id });
    });

    // ---------- solicitações de teste (mestre) ----------
    // Contrato mínimo de skillRef para testes SEM campoId: apenas
    // {rotulo?, nome?} string curtas — qualquer outra forma é descartada
    // (null). Com campoId, a referência vem da estrutura validada e o
    // objeto do cliente nunca é aceito como substituto.
    const skillRefManual = (v: unknown): { rotulo?: string; nome?: string } | null => {
      if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
      const o = v as Record<string, unknown>;
      const out: { rotulo?: string; nome?: string } = {};
      if (typeof o.rotulo === "string" && o.rotulo.length <= 160) out.rotulo = o.rotulo;
      if (typeof o.nome === "string" && o.nome.length <= 160) out.nome = o.nome;
      return Object.keys(out).length ? out : null;
    };
    // Metadados de exibição do campo de teste (Issue #147): derivados
    // APENAS do skillRef já validado/persistido — nunca do payload do
    // cliente. Campos ausentes ou de tipo inesperado são omitidos.
    const campoDoSkillRef = (ref: unknown): Record<string, string> | null => {
      if (ref == null || typeof ref !== "object" || Array.isArray(ref)) return null;
      const o = ref as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const k of ["campoId", "rotulo", "campoRotulo", "tipo", "semantico", "categoria", "secao"] as const) {
        const v = o[k];
        if (typeof v === "string" && v.length <= 200) out[k] = v;
      }
      return Object.keys(out).length ? out : null;
    };
    on(socket, "mesa:teste:pedir", async (payload: {
      sessionId?: string; characterId?: string; rotulo?: string;
      campoId?: string; elementoKey?: string; skillRef?: unknown; bonus?: number; malus?: number;
      dadosLados?: number; dadosCount?: number; minimo?: number;
      visibilidade?: "publica" | "privada"; requestId?: string;
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.characterId) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      if (!consumirOuRecusar(socket, "testePedir", cb)) return;
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre solicita testes" }); return; }
      // validação runtime: o tipo TypeScript não protege contra valores
      // arbitrários — somente campo AUSENTE (undefined) assume o padrão
      // "publica"; null, "", "mestre", "secreta", desconhecidos, números
      // e objetos são rejeitados SEM gravar/emitir nada
      const visReq = payload.visibilidade === undefined ? "publica" : payload.visibilidade;
      if (visReq !== "publica" && visReq !== "privada") {
        cb?.({ ok: false, erro: "Visibilidade inválida" });
        return;
      }

      const [char] = await db.select().from(characters).where(and(eq(characters.id, payload.characterId), eq(characters.campaignId, ctx.sessao.campaignId))).limit(1);
      if (!char) { cb?.({ ok: false, erro: "Personagem não encontrado" }); return; }
      // Personagem arquivado não participa de novos testes — o histórico
      // de testes já realizados permanece intacto.
      if (char.status === "arquivado") { cb?.({ ok: false, erro: "Personagem arquivado — restaure-o para criar novos testes" }); return; }
      const [membroDono] = await db.select().from(memberships).where(eq(memberships.id, char.membershipId)).limit(1);
      if (!membroDono) { cb?.({ ok: false, erro: "Dono não encontrado" }); return; }

      // dados calculados no servidor: campoId → valor numérico da ficha; senão dadosCount explícito.
      // Testes de ficha (atributo/habilidade/ataque) são sempre D10 — o cliente não escolhe o dado.
      const dadosLados = payload.campoId ? 10 : (LADOS_VALIDOS.has(payload.dadosLados ?? 0) ? payload.dadosLados! : 20);
      const dadosFicha = (char.data ?? {}) as Record<string, unknown>;
      let valorCampo: number | null = null;
      // Rótulo de exibição autoritativo: com campoId válido, o nome do
      // campo/elemento vem da ESTRUTURA persistida — um rótulo forjado no
      // payload não pode renomear o que o jogador vai ver no desafio.
      let rotuloExibicao: string | null = null;
      let elementoTeste: { key: string; nome: string } | null = null;
      let campoSel: CampoDef | undefined;
      // Estrutura validada da ficha — reutilizada para derivar seção/tipo
      // do campo no skillRef enriquecido (Issue #147).
      let estruturaValida: EstruturaFicha | null = null;
      let campoInfo: Record<string, unknown> | null = null;
      // Regras da campanha carregadas sob demanda — somente quando o
      // campo é ligado a Poder E Sangue está habilitado (R6.2 P2:
      // validação de posse/key do Poder antes do INSERT).
      // P2 refresh: falha de carga ≠ Sangue desabilitado — `falhou`
      // distingue "ruleset inacessível" (fail-closed) de "config
      // confirmadamente sem Sangue" (legado).
      let regrasPedir: RegrasCampanha | null | undefined;
      let regrasPedirFalhou = false;
      const carregarRegrasPedir = async () => {
        if (regrasPedir === undefined) {
          try { regrasPedir = await carregarRegras(ctx.sessao.campaignId); }
          catch { regrasPedir = null; regrasPedirFalhou = true; }
        }
        return regrasPedir;
      };
      // Guard comum: campo ligado a Poder exige ruleset legível; só
      // pula a validação quando a carga CONFIRMA habilitado !== true.
      const validarPoderSeHabilitado = async (): Promise<"ok" | "legado" | "rejeita"> => {
        const regras = await carregarRegrasPedir();
        if (regrasPedirFalhou || !regras) return "rejeita";
        return regras.config.sangue?.habilitado === true ? "ok" : "legado";
      };
      const rejeitarCampo = (motivo: string, detalhe?: string) => {
        console.warn(`[mesa] teste:pedir rejeitado — ${motivo}${detalhe ? ` (${detalhe})` : ""} (campoId=${payload.campoId}, elemento=${payload.elementoKey ?? "-"}, personagem=${char.id}, versao=${char.templateVersionId ?? "nenhuma"})`);
        cb?.({ ok: false, erro: "Campo não é elegível para teste" });
      };
      // Elegibilidade do campo de teste: com campoId, a estrutura publicada
      // da ficha é obrigatória e precisa passar no parse — sem ela não há
      // como provar elegibilidade, então a solicitação é rejeitada (o
      // cliente nunca é fonte de confiança para validar o próprio campo).
      if (payload.campoId) {
        if (!char.templateVersionId) {
          rejeitarCampo("personagem sem versão de ficha");
          return;
        }
        const [ver] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, char.templateVersionId)).limit(1);
        if (!ver) {
          rejeitarCampo("versão de ficha não encontrada");
          return;
        }
        const parse = estruturaFichaSchema.safeParse(ver.structure);
        if (!parse.success) {
          rejeitarCampo(`estrutura inválida (${parse.error.issues.length} problema(s) de schema)`);
          return;
        }
        estruturaValida = parse.data;
        campoSel = mapaCampos(parse.data).get(payload.campoId);
        if (!campoSel) {
          rejeitarCampo("campo não elegível");
          return;
        }
        if (campoSel.tipo === "selecao_nivel") {
          // Desafio por ELEMENTO: o mestre escolhe um item da lista (ex.:
          // "Computador") e o nível individual dele define os dados
          // positivos. O campo inteiro nunca vira um número.
          if (!campoElegivelParaTesteNivel(campoSel)) {
            rejeitarCampo("campo não elegível");
            return;
          }
          // a chave é comparada com o valor persistido na ficha — espaços
          // fazem parte da identidade do elemento e nunca são removidos
          const key = typeof payload.elementoKey === "string" ? payload.elementoKey : "";
          const lista = Array.isArray(dadosFicha[campoSel.id]) ? (dadosFicha[campoSel.id] as { key?: unknown; nivel?: unknown }[]) : [];
          const item = key ? lista.find((i) => i && typeof i === "object" && i.key === key) : undefined;
          const nivel = item && typeof item.nivel === "number" && Number.isFinite(item.nivel) ? item.nivel : null;
          // R6.2 P2: campo ligado a Poder + Sangue habilitado → a key
          // precisa existir na ficha com nível inteiro 1..5 (contrato
          // selecao_nivel — frações não são nível de lista) E no
          // ruleset ativo como kind="poder". Recusa ANTES do INSERT.
          const ehPoderSel = campoSel.regraKind === "poder" || campoSel.regra?.kind === "poder";
          if (ehPoderSel) {
            const modo = await validarPoderSeHabilitado();
            if (modo === "rejeita") {
              rejeitarCampo("ruleset indisponível para validar Poder");
              return;
            }
            if (modo === "ok") {
              const regras = regrasPedir!;
              const keyNoRuleset = !!key && regras.elementos.has(`poder:${key}`);
              const nivelOk = typeof nivel === "number" && Number.isInteger(nivel) && nivel >= 1 && nivel <= 5;
              if (!keyNoRuleset || !nivelOk) {
                rejeitarCampo("poder sem nível/key válida no ruleset");
                return;
              }
            }
          }
          if (!key || nivel === null || nivel < 1) {
            rejeitarCampo("elemento sem nível na ficha");
            return;
          }
          valorCampo = nivel;
          elementoTeste = { key, nome: await nomeElementoTeste(campoSel, key, ctx.sessao.campaignId) };
          rotuloExibicao = elementoTeste.nome;
        } else {
          if (!campoElegivelParaTeste(campoSel)) {
            rejeitarCampo("campo não elegível");
            return;
          }
          const v = dadosFicha[campoSel.id];
          if (typeof v !== "number" || !Number.isFinite(v)) {
            // campo elegível mas sem valor numérico persistido — nunca
            // cair no dadosCount do cliente como fallback
            rejeitarCampo("campo sem valor numérico na ficha");
            return;
          }
          // R6.2 P2: campo escalar vinculado a Poder (regra.kind=
          // "poder" + regra.key) + Sangue habilitado → a key derivada
          // do vínculo precisa existir no ruleset ativo e o valor
          // precisa ser número finito > 0 (0.5 é nível válido —
          // convenção nivelNoVinculo; 0/negativo = não adquirido).
          const ehPoderEsc = campoSel.regraKind === "poder" || campoSel.regra?.kind === "poder";
          if (ehPoderEsc) {
            const modo = await validarPoderSeHabilitado();
            if (modo === "rejeita") {
              rejeitarCampo("ruleset indisponível para validar Poder");
              return;
            }
            if (modo === "ok") {
              const regras = regrasPedir!;
              const keyRegra = campoSel.regra?.kind === "poder" ? campoSel.regra.key : "";
              const keyNoRuleset = !!keyRegra && regras.elementos.has(`poder:${keyRegra}`);
              if (!keyNoRuleset || !(v > 0)) {
                rejeitarCampo("poder sem nível/key válida no ruleset");
                return;
              }
            }
          }
          valorCampo = v;
          rotuloExibicao = campoSel.label;
        }
        // Seção que contém o campo (estrutura já validada) — exibição
        // no histórico; derivada no servidor, nunca do cliente.
        const secao = estruturaValida?.secoes.find((sec) =>
          sec.campos.some((c) => c.id === payload.campoId)
        )?.titulo ?? null;
        campoInfo = {
          campoId: payload.campoId,
          rotulo: campoSel!.label,
          tipo: campoSel!.tipo,
          semantico: campoSel!.semantico,
          ...(campoSel!.categoria ? { categoria: campoSel!.categoria } : {}),
          ...(secao ? { secao } : {}),
        };
      }
      // Referência autoritativa ÚNICA do desafio: com campoId validado,
      // campoId + label reais da estrutura persistida (enriquecido com
      // tipo/semântica/categoria/seção); sem campoId, só o contrato
      // mínimo — objetos arbitrários do cliente nunca chegam à
      // persistência, ao evento nem ao chat.
      const skillRefFinal: unknown = payload.campoId
        ? elementoTeste
          ? { ...(campoInfo ?? {}), campoId: payload.campoId, rotulo: rotuloExibicao, elementoKey: elementoTeste.key, campoRotulo: campoSel?.label }
          : (campoInfo ?? { campoId: payload.campoId, rotulo: rotuloExibicao })
        : skillRefManual(payload.skillRef);
      // pool: base = dados positivos (valor do campo ou dadosCount); bonus/malus ajustam
      const positivos = Math.round((valorCampo ?? payload.dadosCount ?? 1) + (payload.bonus ?? 0));
      const negativos = Math.max(0, Math.round(payload.malus ?? 0));
      let count = Math.min(Math.max(0, positivos - negativos), 30);

      // pausa determinística (teste) + revalidação da barreira após a
      // autorização e antes da mutação — operação em voo é cancelada
      await pausaTesteEmit(JSON.stringify(payload));
      const id = payload.requestId ?? randomUUID();
      const agora = new Date();
      try {
        await db.insert(tests).values({
          id, campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id,
          characterId: char.id, requestedBy: u.id,
          skillRef: skillRefFinal as never,
          modifiers: { bonus: payload.bonus ?? 0, malus: negativos, valorCampo, positivos } as never,
          diceCount: count, diceSides: dadosLados,
          target: payload.minimo ?? null,
          status: "pendente",
          visibility: visReq,
          requestId: payload.requestId ?? null,
          createdAt: agora, updatedAt: agora,
        });
      } catch (e) {
        if (String(e).includes("UNIQUE") && payload.requestId) {
          const [ex] = await db.select().from(tests).where(and(eq(tests.campaignId, ctx.sessao.campaignId), eq(tests.requestId, payload.requestId))).limit(1);
          cb?.({ ok: true, id: ex?.id, duplicado: true });
          return;
        }
        throw e;
      }

      // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: tests já foi
      // inserido — o lease do handler cobre até as emissões finais
      await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));

      // notifica: sala recebe versão pública; dono recebe completa (com alvo se privada)
      const nomeChar = char.name;
      const nomeAutor = await nomeUsuario(u.id);
      const pool = { positivos, negativos, dadosLados };
      const publico = {
        id, sessionId: ctx.sessao.id, characterId: char.id, characterName: nomeChar,
        requestedByName: nomeAutor, rotulo: rotuloExibicao ?? payload.rotulo ?? null,
        skillRef: skillRefFinal, // referência autoritativa; mínimo NÃO vai
        status: "pendente", createdAt: agora,
        // visibilidade explícita e coerente em TODOS os payloads —
        // o cliente nunca precisa adivinhar o contrato
        visibility: visReq,
      };
      // Dificuldade (`alvo`) é reservada ao mestre: cada audiência recebe
      // um objeto PRÓPRIO — o payload do dono/jogador nunca carrega o
      // campo, nem por spread acidental do objeto administrativo.
      const dadosTeste = { lados: dadosLados, count };
      if (visReq === "privada") {
        // privada: dono recebe os dados do próprio teste SEM alvo;
        // mestres ATUAIS recebem a versão administrativa com alvo
        const payloadDono = { ...publico, dados: dadosTeste, pool, privado: true };
        await emitirPrivadoCampanha(ctx.sessao.campaignId, [membroDono.userId], "mesa:teste", payloadDono);
        const mestresPriv = await mestresDaCampanha(ctx.sessao.campaignId);
        await emitirPrivadoCampanha(ctx.sessao.campaignId, mestresPriv, "mesa:teste", { ...payloadDono, alvo: payload.minimo ?? null }, ["mestre"]);
      } else {
        // pública: sala e dono recebem sem alvo; mestres recebem a
        // versão administrativa com alvo via canal privado
        io.to(`sessao:${ctx.sessao.id}`).emit("mesa:teste", { ...publico, dados: dadosTeste, pool });
        io.to(`usuario:${membroDono.userId}`).emit("mesa:teste", {
          ...publico, dados: dadosTeste, pool, privado: false,
        });
        const mestresPub = await mestresDaCampanha(ctx.sessao.campaignId);
        await emitirPrivadoCampanha(ctx.sessao.campaignId, mestresPub, "mesa:teste", {
          ...publico, alvo: payload.minimo ?? null, dados: dadosTeste, pool, privado: false,
        }, ["mestre"]);
      }
      // mesa:teste:detalhe carrega o ALVO (dificuldade reservada):
      // NUNCA vai à sala coletiva e NÃO vai ao dono — o evento não tem
      // consumidor no frontend para jogadores; somente mestres atuais,
      // via canal privado usuario:* com visibilidade explícita.
      const mestresDet = await mestresDaCampanha(ctx.sessao.campaignId);
      await emitirPrivadoCampanha(ctx.sessao.campaignId, mestresDet, "mesa:teste:detalhe", {
        id, alvo: payload.minimo ?? null,
        dados: dadosTeste, pool,
        visibility: "privada",
      }, ["mestre"]);

      await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: "teste", content: `${nomeAutor} solicitou teste para ${nomeChar}${(rotuloExibicao ?? payload.rotulo) ? ` (${rotuloExibicao ?? payload.rotulo})` : ""}`,
        visibility: visReq,
        recipients: visReq === "privada" ? [membroDono.userId] : undefined,
      });
      cb?.({ ok: true, id });
    });

    // ---------- rolar teste pendente (dono do personagem ou mestre) ----------
    on(socket, "mesa:teste:rolar", async (payload: { testId?: string; requestId?: string }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.testId) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      if (!consumirOuRecusar(socket, "testeRolar", cb)) return;
      // leitura inicial APENAS para localizar a sessão/lease: o registro
      // completo é RELIDO sob o lease — um teste lido antes de uma
      // restauração nunca é usado como fonte de dados para a escrita
      const [ref] = await db.select({ sessionId: tests.sessionId }).from(tests).where(eq(tests.id, payload.testId)).limit(1);
      if (!ref?.sessionId) { cb?.({ ok: false, erro: "Teste não encontrado" }); return; }
      const ctx = await resolverCtx(socket, ref.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      const [teste] = await db.select().from(tests).where(eq(tests.id, payload.testId)).limit(1);
      if (!teste || !teste.sessionId || teste.sessionId !== ref.sessionId) { cb?.({ ok: false, erro: "Teste não encontrado" }); return; }
      const [char] = await db.select().from(characters).where(eq(characters.id, teste.characterId)).limit(1);
      const [membroDono] = char ? await db.select().from(memberships).where(eq(memberships.id, char.membershipId)).limit(1) : [null];
      const ehDono = membroDono?.userId === u.id;
      if (ctx.papel !== "mestre" && !ehDono) { cb?.({ ok: false, erro: "Só o dono do personagem ou o mestre rolam" }); return; }
      // visibilidade ANTES da idempotência: teste reservado a mestres
      // (mestre/secreta/desconhecida/vazia) não pode ser rolado pelo
      // dono — e o ACK não pode devolver resultado, estado ou
      // confirmação de rolagem a quem não tem autorização
      if (ctx.papel !== "mestre" && classeVisibilidadeTeste(teste.visibility) === "mestre") {
        cb?.({ ok: false, erro: "Somente o mestre pode rolar este teste" });
        return;
      }
      // SEM fast-path de idempotência aqui: qualquer retry — inclusive
      // de teste já 'rolado' — precisa alcançar a transação, onde a
      // autorização ATUAL é revalidada antes do ACK jaRolado.
      // personagem arquivado não rola — fail-closed (revalidado na tx)
      if (char?.status === "arquivado") { cb?.({ ok: false, erro: "Personagem arquivado não pode rolar testes" }); return; }

      // ---------- FASE 1 — pré-carga assíncrona ----------
      // Regras são resolvidas aqui só para a impressão digital: dentro da
      // transação a config é RELIDA e comparada — se mudou entre a
      // pré-carga e o commit, a rolagem aborta em vez de gravar com
      // regra obsoleta (R6.1).
      const regras = await carregarRegras(teste.campaignId);
      const fingerprintRegras = impressaoDigitalRegras(regras);

      await pausaTesteEmit(JSON.stringify(payload));
      // Identidade da rolagem ≠ chave de idempotência do cliente:
      // rollId é sempre UUID próprio (dois testId com o mesmo
      // requestId NÃO podem colidir na PK). A idempotência do caminho
      // de teste é garantida por tests.status (pendente→rolado dentro
      // da tx); requestId é persistido como chave COMPOSTA por teste
      // para não colidir no UNIQUE (campaign_id, request_id) nem
      // devolver roll de outro teste.
      const rollId = randomUUID();
      const requestIdPersistido = payload.requestId
        ? `teste:${payload.testId}:${payload.requestId}`
        : null;
      const agora = new Date();
      // R6.2: nome do autor para o evento __sangue — resolvido ANTES da
      // tx (sem await dentro); só é usado se houver débito de Sangue.
      const autorNomeSangue = await nomeUsuario(u.id);

      // ---------- FASE 2 — transação SQLite síncrona ----------
      // Sem `await` dentro: tudo que pode mudar entre a pré-carga e a
      // escrita é RELIDO sob a transação — teste, membership do ator,
      // personagem/dono, regras (fingerprint) e dados de vitalidade.
      // Apenas um concorrente transiciona pendente→rolado; o perdedor
      // recebe a resposta idempotente do estado já gravado.
      type TxTesteRolar =
        | { tipo: "ok"; rollId: string; teste: typeof tests.$inferSelect; characterName?: string;
            papel: Papel; donoUserId?: string; resultados: number[]; total: number;
            countFinal: number; vitalidade: VitalidadeRoll | null; d10: D10Roll | null;
            sangue?: { custo: number; saldoResultante: number } }
        | { tipo: "jaRolado"; status: string }
        | { tipo: "naoEncontrado" } | { tipo: "semPermissao" } | { tipo: "donoPerdido" }
        | { tipo: "arquivado" } | { tipo: "visibilidade" }
        | { tipo: "sessaoInvalida" } | { tipo: "personagemInvalido" }
        | { tipo: "bloqueado"; nomePersonagem: string; nomeVitalidade: string }
        | { tipo: "regrasMudaram" }
        | { tipo: "poderNaoAdquirido" }
        | { tipo: "sangueInsuficiente"; saldo: number; custo: number }
        | { tipo: "cobrancaErro"; erro: string };
      type VitalidadeRoll = { nivel: number; nome: string; penalidadeDados: number; dadosOriginais: number; dadosFinais: number; excecaoMestre?: boolean };
      type D10Roll = { minimo: number; lancados: number; sucessos: number; falhas: number; avaliacao?: AvaliacaoDadoD10[] };
      let txRes: TxTesteRolar;
      try {
        txRes = db.transaction((tx): TxTesteRolar => {
          // membership do ator — papel/status podem ter mudado na pré-carga
          const [mTx] = tx.select().from(memberships)
            .where(and(eq(memberships.campaignId, ctx.sessao.campaignId), eq(memberships.userId, u.id), eq(memberships.status, "ativo")))
            .limit(1).all();
          if (!mTx) return { tipo: "semPermissao" };
          const papelTx = mTx.role as Papel;

          const [tTx] = tx.select().from(tests).where(eq(tests.id, payload.testId!)).limit(1).all();
          if (!tTx || !tTx.sessionId || tTx.sessionId !== ref.sessionId || tTx.campaignId !== ctx.sessao.campaignId) {
            return { tipo: "naoEncontrado" };
          }

          // sessão relida sob a tx: precisa existir, pertencer à
          // campanha do teste e não estar encerrada
          const [sTx] = tx.select().from(sessions).where(eq(sessions.id, tTx.sessionId)).limit(1).all();
          if (!sTx || sTx.campaignId !== tTx.campaignId || sTx.status === "encerrada") {
            return { tipo: "sessaoInvalida" };
          }

          // personagem precisa existir, pertencer à MESMA campanha do
          // teste e não estar arquivado
          const [cTx] = tx.select().from(characters).where(eq(characters.id, tTx.characterId)).limit(1).all();
          if (!cTx || cTx.campaignId !== tTx.campaignId) return { tipo: "personagemInvalido" };
          if (cTx.status === "arquivado") return { tipo: "arquivado" };
          // membership do dono: mesma campanha do teste, status ativo —
          // membership inativa/removida ou de outra campanha não
          // confere titularidade
          const [mdTx] = tx.select().from(memberships)
            .where(and(eq(memberships.id, cTx.membershipId), eq(memberships.campaignId, tTx.campaignId), eq(memberships.status, "ativo")))
            .limit(1).all();
          const ehDonoTx = mdTx?.userId === u.id;
          if (papelTx !== "mestre" && !ehDonoTx) return { tipo: "donoPerdido" };
          if (papelTx !== "mestre" && classeVisibilidadeTeste(tTx.visibility) === "mestre") return { tipo: "visibilidade" };

          // Idempotência SÓ depois da autorização atual: um teste já
          // rolado confirma duplicidade (jaRolado) somente se o ator
          // ainda tiver acesso — sessão válida, personagem da campanha,
          // titularidade/visibilidade revalidadas acima. Sem isso, quem
          // perdeu a posse durante a pausa pré-commit receberia ACK de
          // confirmação baseado em autorização obsoleta.
          if (tTx.status !== "pendente") return { tipo: "jaRolado", status: tTx.status };

          const regrasTx = carregarRegrasSincrono(tx, tTx.campaignId);
          if (!regrasTx || impressaoDigitalRegras(regrasTx) !== fingerprintRegras) return { tipo: "regrasMudaram" };

          // Vitalidade recalculada com dados FRESCOS do personagem — o
          // jogador não pode ignorar a penalidade e o mestre mantém a
          // exceção de ação bloqueada.
          let vitalidade: VitalidadeRoll | null = null;
          let countFinal = tTx.diceCount;
          if (cTx) {
            const vit = resumoVitalidade(regrasTx.config.vitalidade, (cTx.data ?? {}) as Record<string, unknown>);
            if (vit) {
              if (vit.bloqueiaAcoes && papelTx !== "mestre") {
                return { tipo: "bloqueado", nomePersonagem: cTx.name, nomeVitalidade: vit.nome };
              }
              countFinal = Math.max(0, tTx.diceCount - vit.penalidadeDados);
              vitalidade = {
                nivel: vit.nivel, nome: vit.nome, penalidadeDados: vit.penalidadeDados,
                dadosOriginais: tTx.diceCount, dadosFinais: countFinal,
                excecaoMestre: vit.bloqueiaAcoes && papelTx === "mestre" ? true : undefined,
              };
            }
          }

          const resultados = rolarLados(tTx.diceSides, countFinal);
          const total = resultados.reduce((a, b) => a + b, 0);

          // R6.2 — cobrança de Sangue (Issue #186, contrato
          // #7055515759 item 7): se a rolagem usa um Poder com custo
          // configurado, o débito acontece na MESMA transação do roll +
          // transição pendente→rolado. usoId `d10:<testId>` é
          // idempotente no ledger — retry/concorrência nunca debita
          // duas vezes; jaRolado retorna antes daqui.
          // P2-2: para detectar campo ligado a Poder sem identidade de
          // elemento, resolve o CampoDef da estrutura da ficha — somente
          // quando Sangue está habilitado e o skillRef não traz
          // elementoKey (selecao_nivel já se identifica sozinha).
          let campoSelD10: CampoDef | null = null;
          const refSkill = tTx.skillRef && typeof tTx.skillRef === "object" && !Array.isArray(tTx.skillRef)
            ? tTx.skillRef as Record<string, unknown> : null;
          const refCampoId = typeof refSkill?.campoId === "string" ? refSkill.campoId : "";
          const refElementoKey = typeof refSkill?.elementoKey === "string" ? refSkill.elementoKey : "";
          // campoSel carregado para AMBOS os caminhos (escalar e
          // selecao_nivel) — necessário para detectar campo ligado a
          // Poder quando a key some do ruleset entre pedido e rolagem
          // (fail-closed, nunca tipo:"livre").
          if (
            regrasTx.config.sangue?.habilitado === true &&
            refCampoId && cTx.templateVersionId
          ) {
            const [verD10] = tx.select({ structure: sheetVersions.structure })
              .from(sheetVersions).where(eq(sheetVersions.id, cTx.templateVersionId)).limit(1).all();
            const parseD10 = verD10 ? estruturaFichaSchema.safeParse(verD10.structure) : null;
            if (parseD10?.success) {
              campoSelD10 = mapaCampos(parseD10.data).get(refCampoId) ?? null;
            }
          }
          const cobranca = resolverCobrancaSangueD10(
            tTx.skillRef,
            (cTx.data ?? {}) as Record<string, unknown>,
            regrasTx,
            campoSelD10,
          );
          if (cobranca.tipo === "erro") {
            if (cobranca.erro === "poder_nao_adquirido") return { tipo: "poderNaoAdquirido" };
            if (cobranca.erro === "poder_nao_identificado") return { tipo: "cobrancaErro", erro: "poder_nao_identificado" };
            if (cobranca.erro === "test_id_invalido") return { tipo: "cobrancaErro", erro: "test_id_invalido" };
            return { tipo: "cobrancaErro", erro: "custo_invalido" };
          }
          let dadosComSangue: Record<string, unknown> | null = null;
          let sangueInfo: { custo: number; saldoResultante: number } | undefined;
          if (cobranca.tipo === "debitar") {
            // o ledger C2 só aceita ids UUID — testId fora do formato é
            // fail-closed (nunca debita com identidade ambígua)
            if (!UUID_TESTE_RE.test(tTx.id)) return { tipo: "cobrancaErro", erro: "test_id_invalido" };
            const resSangue = registrarUsoD10((cTx.data ?? {}) as Record<string, unknown>, {
              personagemId: cTx.id,
              testId: tTx.id,
              custo: cobranca.custo,
              autorId: u.id,
              autorNome: autorNomeSangue,
              motivo: `Teste D10 (${tTx.id})`,
              requestId: payload.requestId ?? null,
            });
            if (!resSangue.ok) {
              if (resSangue.codigo === "saldo_insuficiente") {
                return { tipo: "sangueInsuficiente", saldo: resSangue.saldo ?? 0, custo: cobranca.custo };
              }
              return { tipo: "cobrancaErro", erro: resSangue.codigo };
            }
            dadosComSangue = resSangue.dados;
            sangueInfo = { custo: cobranca.custo, saldoResultante: resSangue.estado.saldo };
          }

          // Desafio D10: sucessos/falhas calculados no servidor com a meta
          // da campanha — o navegador não pode alterar o mínimo.
          let d10: D10Roll | null = null;
          if (tTx.diceSides === 10) {
            const minimo = regrasTx.config.dados?.d10SucessoMinimo ?? 6;
            const av = avaliarD10(resultados, minimo);
            d10 = { minimo, lancados: resultados.length, sucessos: av.sucessos, falhas: av.falhas, avaliacao: av.avaliacao };
          }

          tx.insert(rolls).values({
            id: rollId, campaignId: tTx.campaignId, sessionId: tTx.sessionId,
            characterId: tTx.characterId, userId: u.id,
            dice: [{ sides: tTx.diceSides, count: countFinal }] as never,
            results: { dados: resultados, total, soma: total, vitalidade, d10, campo: campoDoSkillRef(tTx.skillRef) } as never,
            reason: `teste:${tTx.id}`, visibility: tTx.visibility,
            requestId: requestIdPersistido, createdAt: agora,
          }).run();
          tx.update(tests).set({ status: "rolado", rollId, updatedAt: agora }).where(eq(tests.id, tTx.id)).run();
          if (dadosComSangue) {
            tx.update(characters).set({ data: dadosComSangue, updatedAt: agora }).where(eq(characters.id, cTx.id)).run();
          }

          return {
            tipo: "ok", rollId, teste: tTx, characterName: cTx.name, papel: papelTx,
            donoUserId: mdTx?.userId, resultados, total, countFinal, vitalidade, d10,
            ...(sangueInfo ? { sangue: sangueInfo } : {}),
          };
        });
      } catch (e) {
        // UNIQUE só pode vir de rolls_request_idx (campaign_id,
        // request_id) — a chave já é composta por teste, então o roll
        // encontrado é necessariamente DESTE teste; reason é
        // conferida como segunda trava contra qualquer divergência.
        if (String(e).includes("UNIQUE") && requestIdPersistido) {
          const [ex] = await db.select().from(rolls).where(and(
            eq(rolls.campaignId, teste.campaignId),
            eq(rolls.requestId, requestIdPersistido),
            eq(rolls.reason, `teste:${payload.testId}`),
          )).limit(1);
          if (ex) { cb?.({ ok: true, rollId: ex.id, duplicado: true }); return; }
        }
        // falha dentro da transação → rollback total já garantido;
        // responde erro no ACK em vez de derrubar o handler sem resposta
        console.error("[mesa:teste:rolar] falha na transação:", e);
        cb?.({ ok: false, erro: "Falha ao registrar a rolagem" });
        return;
      }

      // Respostas de aborto da transação — mesmos contratos da
      // pré-carga; nada foi gravado (rollback total garantido pelo tx).
      if (txRes.tipo === "jaRolado") { cb?.({ ok: true, id: payload.testId, status: txRes.status, jaRolado: true }); return; }
      if (txRes.tipo === "naoEncontrado") { cb?.({ ok: false, erro: "Teste não encontrado" }); return; }
      if (txRes.tipo === "semPermissao") { cb?.({ ok: false, erro: "Sem permissão nesta campanha" }); return; }
      if (txRes.tipo === "donoPerdido") { cb?.({ ok: false, erro: "Só o dono do personagem ou o mestre rolam" }); return; }
      if (txRes.tipo === "arquivado") { cb?.({ ok: false, erro: "Personagem arquivado não pode rolar testes" }); return; }
      if (txRes.tipo === "sessaoInvalida") { cb?.({ ok: false, erro: "Sessão encerrada ou inválida" }); return; }
      if (txRes.tipo === "personagemInvalido") { cb?.({ ok: false, erro: "Personagem inválido para este teste" }); return; }
      if (txRes.tipo === "visibilidade") { cb?.({ ok: false, erro: "Somente o mestre pode rolar este teste" }); return; }
      if (txRes.tipo === "bloqueado") {
        cb?.({ ok: false, erro: `Ação bloqueada: ${txRes.nomePersonagem} está ${txRes.nomeVitalidade} e não pode agir normalmente` });
        return;
      }
      if (txRes.tipo === "regrasMudaram") {
        cb?.({ ok: false, erro: "Regras da campanha alteradas durante a rolagem — tente novamente" });
        return;
      }
      if (txRes.tipo === "poderNaoAdquirido") {
        cb?.({ ok: false, erro: "Poder não consta mais na ficha do personagem" });
        return;
      }
      if (txRes.tipo === "sangueInsuficiente") {
        cb?.({ ok: false, erro: `Sangue insuficiente para o custo do Poder (saldo ${txRes.saldo}, custo ${txRes.custo})`, codigo: "sangue_insuficiente" });
        return;
      }
      if (txRes.tipo === "cobrancaErro") {
        cb?.({ ok: false, erro: `Cobrança de Sangue recusada (${txRes.erro})` });
        return;
      }

      // ---------- FASE 3 — pós-commit assíncrono ----------
      // Somente agora o roll existe de forma durável: nenhum socket ou
      // broadcast pode anunciar rolagem revertida pela transação.
      const { teste: tTx, resultados, total, countFinal, vitalidade, d10 } = txRes;
      const payloadRoll = {
        id: rollId, testId: tTx.id, sessionId: tTx.sessionId,
        characterId: tTx.characterId, characterName: txRes.characterName,
        userId: u.id, rolador: await nomeUsuario(u.id),
        papel: txRes.papel, solicitante: await nomeUsuario(tTx.requestedBy),
        campo: campoDoSkillRef(tTx.skillRef),
        dados: resultados, total, lados: tTx.diceSides, count: countFinal,
        dadosOriginais: tTx.diceCount, vitalidade, d10,
        alvo: tTx.target, // só mestres recebem via filtro abaixo
        visibility: tTx.visibility, createdAt: agora,
      };
      // `alvo` (dificuldade) só existe no objeto dos mestres — sala,
      // dono e qualquer outro destinatário recebem o payload SEM o
      // campo (não null, não placeholder: a propriedade não existe)
      const { alvo: _alvoReservado, ...payloadRollSemAlvo } = payloadRoll;
      // fail-closed: SOMENTE "publica" vai à sala coletiva — "privada"
      // vai só a dono+mestres; "mestre"/"secreta"/desconhecida vão
      // exclusivamente aos mestres atuais (nunca à sala, nunca ao dono)
      const classeRoll = classeVisibilidadeTeste(tTx.visibility);
      if (classeRoll === "publica") {
        io.to(`sessao:${tTx.sessionId}`).emit("mesa:rolagem", { ...payloadRollSemAlvo, visibility: "publica" });
      }
      // emissões privadas revalidam membership ativa no instante do envio;
      // o dono recebe o resultado SEM a dificuldade — somente quando o
      // teste é explicitamente "privada" (ou "publica", sanitizada)
      if (txRes.donoUserId && classeRoll !== "mestre") {
        await emitirPrivadoCampanha(tTx.campaignId, [txRes.donoUserId], "mesa:rolagem", payloadRollSemAlvo);
      }
      const mestres = await mestresDaCampanha(tTx.campaignId);
      await emitirPrivadoCampanha(tTx.campaignId, mestres, "mesa:rolagem", payloadRoll, ["mestre"]);

      // gancho determinístico PÓS-COMMIT: rolls e tests já foram
      // escritos na mesma transação — o lease do handler DEVE cobrir
      // até o fim, inclusive o registrarChat (que reutiliza o mesmo
      // lease ALS)
      await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
      agendarAutosave(tTx.campaignId);
      // R6.2: débito de Sangue alterou characters.data — mesmo contrato
      // do endpoint individual de XP (pós-commit, nunca antes).
      if (txRes.sangue) {
        emitirCampanha(tTx.campaignId, "personagens:atualizados", { characterId: tTx.characterId });
      }
      await registrarChat(io, {
        campaignId: tTx.campaignId, sessionId: tTx.sessionId, authorId: u.id,
        kind: "rolagem",
        content: `${await nomeUsuario(u.id)} rolou ${vitalidade ? `${vitalidade.dadosOriginais}d${tTx.diceSides} → vitalidade ${vitalidade.nome} (−${vitalidade.penalidadeDados}) → ${countFinal}d${tTx.diceSides}` : `${tTx.diceCount}d${tTx.diceSides}`} → ${resultados.length ? resultados.join(", ") : "(sem dados)"} = ${total}${d10 ? ` · D10: ${d10.sucessos}/${d10.lancados} sucessos (mín ${d10.minimo})` : ""}`,
        visibility: visibilidadeChatDoTeste(tTx.visibility),
        recipients: classeRoll === "privada" && txRes.donoUserId ? [txRes.donoUserId] : undefined,
      });
      cb?.({ ok: true, id: rollId, dados: resultados, total, count: countFinal, dadosOriginais: tTx.diceCount, vitalidade, d10 });
    });

    // ---------- rolagem livre ----------
    on(socket, "mesa:rolar", async (payload: {
      sessionId?: string; dados?: { sides: number; count: number }[];
      motivo?: string; visibilidade?: "publica" | "privada"; requestId?: string;
      d10?: { positivos?: number; negativos?: number; minimo?: number };
      modo?: string;
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.dados?.length) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      if (!consumirOuRecusar(socket, "rolagem", cb)) return;
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel === "espectador") { cb?.({ ok: false, erro: "Espectadores não podem rolar" }); return; }
      if (ctx.sessao.status === "encerrada") { cb?.({ ok: false, erro: "Sessão encerrada" }); return; }

      const dadosValidados = payload.dados.slice(0, 5).map((d) => ({
        sides: LADOS_VALIDOS.has(d.sides) ? d.sides : 20,
        count: Math.min(Math.max(1, Math.round(d.count) || 1), 30),
      }));
      const grupos = dadosValidados.map((d) => ({ ...d, resultados: rolarLados(d.sides, d.count) }));
      const total = grupos.reduce((s, g) => s + g.resultados.reduce((a, b) => a + b, 0), 0);

      // Lançador D10: dados negativos consomem positivos; sucessos = valor >= mínimo.
      let d10: { positivos: number; negativos: number; minimo: number; lancados: number; sucessos: number; falhas: number; avaliacao?: AvaliacaoDadoD10[] } | null = null;
      if (payload.d10) {
        const pos = Math.round(payload.d10.positivos ?? NaN);
        const neg = Math.round(payload.d10.negativos ?? NaN);
        if (!Number.isFinite(pos) || !Number.isFinite(neg) || pos < 0 || neg < 0 || pos > 30 || neg > 30) {
          cb?.({ ok: false, erro: "Dados D10 inválidos" });
          return;
        }
        const efetivos = Math.max(0, pos - neg);
        const resD10 = grupos.length === 1 && grupos[0].sides === 10 ? grupos[0].resultados : null;
        if (!resD10 || resD10.length !== efetivos) {
          cb?.({ ok: false, erro: "Quantidade de dados D10 inconsistente com a rolagem" });
          return;
        }

        // A dificuldade é regra da campanha, não dado confiável do cliente.
        // O campo minimo do payload é aceito por compatibilidade com versões
        // antigas do frontend e deliberadamente ignorado: qualquer socket
        // pode forjar esse campo. O valor autoritativo é relido do ruleset
        // ativo desta campanha em cada rolagem.
        const regras = await carregarRegras(ctx.sessao.campaignId);
        const minimo = regras.config.dados?.d10SucessoMinimo ?? 6;
        const av = avaliarD10(resD10, minimo);
        d10 = { positivos: pos, negativos: neg, minimo, lancados: resD10.length, sucessos: av.sucessos, falhas: av.falhas, avaliacao: av.avaliacao };
      }

      // Modo explícito "dano": totalização genérica, sem contagem de sucessos D10.
      const modoDano = payload.modo === "dano" && !payload.d10 ? "dano" : null;
      const rollId = payload.requestId ?? randomUUID();
      const agora = new Date();
      const vis = payload.visibilidade === "privada" ? "privada" : "publica";
      await pausaTesteEmit(JSON.stringify(payload));
      try {
        await db.insert(rolls).values({
          id: rollId, campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id,
          characterId: null, userId: u.id,
          dice: dadosValidados as never,
          results: { grupos, total, d10, modo: modoDano } as never,
          reason: payload.motivo?.slice(0, 300) ?? null,
          visibility: vis, requestId: payload.requestId ?? null, createdAt: agora,
        });
      } catch (e) {
        if (String(e).includes("UNIQUE") && payload.requestId) { cb?.({ ok: true, id: rollId, duplicado: true }); return; }
        throw e;
      }
      const rollPayload = {
        id: rollId, sessionId: ctx.sessao.id, userId: u.id, rolador: await nomeUsuario(u.id),
        papel: ctx.papel,
        grupos: grupos.map((g) => ({ lados: g.sides, resultados: g.resultados })),
        total, motivo: payload.motivo ?? (modoDano ? "Dano" : null), visibility: vis, createdAt: agora, d10, modo: modoDano,
      };
      if (vis === "publica") io.to(`sessao:${ctx.sessao.id}`).emit("mesa:rolagem", rollPayload);
      else if (!barreiraRestauracaoAtiva(ctx.sessao.campaignId)) {
        await emitirPrivadoCampanha(ctx.sessao.campaignId, [u.id], "mesa:rolagem", rollPayload);
        const mestres = await mestresDaCampanha(ctx.sessao.campaignId);
        await emitirPrivadoCampanha(ctx.sessao.campaignId, mestres, "mesa:rolagem", rollPayload, ["mestre"]);
      }
      // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: rolls já foi
      // escrito — o lease do handler cobre até o registrarChat final
      await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
      await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: "rolagem",
        content: `${rollPayload.rolador} rolou ${grupos.map((g) => `${g.count}d${g.sides}`).join(" + ")} → ${total}${payload.motivo ? ` (${payload.motivo})` : ""}${d10 ? ` · D10: ${d10.sucessos}/${d10.lancados} sucessos (mín ${d10.minimo})` : ""}`,
        visibility: vis === "privada" ? "privada" : "publica",
        recipients: vis === "privada" ? [u.id, ...(await mestresDaCampanha(ctx.sessao.campaignId))] : undefined,
      });
      cb?.({ ok: true, id: rollId, grupos, total, d10, modo: modoDano });
    });

    // ---------- decisão do mestre ----------
    on(socket, "mesa:teste:decidir", async (payload: { testId?: string; outcome?: string; nota?: string }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.testId || !payload.outcome) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      if (!consumirOuRecusar(socket, "testeDecidir", cb)) return;
      // mesma regra de teste:rolar — leitura inicial só localiza a
      // sessão; o registro é relido sob o lease antes de qualquer uso
      const [ref] = await db.select({ sessionId: tests.sessionId }).from(tests).where(eq(tests.id, payload.testId)).limit(1);
      if (!ref?.sessionId) { cb?.({ ok: false, erro: "Teste não encontrado" }); return; }
      const ctx = await resolverCtx(socket, ref.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      const [teste] = await db.select().from(tests).where(eq(tests.id, payload.testId)).limit(1);
      if (!teste || !teste.sessionId || teste.sessionId !== ref.sessionId) { cb?.({ ok: false, erro: "Teste não encontrado" }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre decide" }); return; }
      const outcomes = ["sucesso", "parcial", "falha", "falha_critica", "personalizado"];
      if (!outcomes.includes(payload.outcome)) { cb?.({ ok: false, erro: "Resultado inválido" }); return; }
      await pausaTesteEmit(JSON.stringify(payload));
      await db.update(tests).set({ status: "decidido", outcome: payload.outcome, outcomeNote: payload.nota?.slice(0, 2000) ?? null, updatedAt: new Date() }).where(eq(tests.id, teste.id));
      // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: tests já foi
      // atualizado — o lease cobre emissões e registrarChat finais
      await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
      const [char] = await db.select().from(characters).where(eq(characters.id, teste.characterId)).limit(1);
      const decisao = {
        testId: teste.id, sessionId: teste.sessionId, characterId: teste.characterId,
        characterName: char?.name, outcome: payload.outcome, nota: payload.nota ?? null,
        decididoPor: await nomeUsuario(u.id), visibility: teste.visibility,
      };
      // fail-closed: só "publica" vai à sala; "privada" só a
      // mestre+dono; "mestre"/"secreta"/desconhecida só a mestres
      const classeDec = classeVisibilidadeTeste(teste.visibility);
      if (classeDec === "publica") {
        io.to(`sessao:${teste.sessionId}`).emit("mesa:decisao", { ...decisao, nota: decisao.nota, visibility: "publica" });
      }
      // versão integral: só mestres e dono ATUAL do personagem — e o
      // dono somente quando o teste é explicitamente "privada"
      const mestres = await mestresDaCampanha(teste.campaignId);
      await emitirPrivadoCampanha(teste.campaignId, mestres, "mesa:decisao", decisao, ["mestre"]);
      let donoUserId: string | null = null;
      if (char) {
        const [md] = await db.select().from(memberships).where(eq(memberships.id, char.membershipId)).limit(1);
        donoUserId = md?.userId ?? null;
        if (donoUserId && classeDec !== "mestre") {
          await emitirPrivadoCampanha(teste.campaignId, [donoUserId], "mesa:decisao", decisao);
        }
      }
      await registrarChat(io, {
        campaignId: teste.campaignId, sessionId: teste.sessionId, authorId: u.id,
        kind: "decisao", content: `Decisão: ${payload.outcome}${payload.nota ? ` — ${payload.nota}` : ""}`,
        // a nota narrativa segue a mesma classificação do teste —
        // decisão reservada NUNCA vira mensagem pública
        visibility: visibilidadeChatDoTeste(teste.visibility),
        recipients: classeDec === "privada" && donoUserId ? [donoUserId] : undefined,
      });
      cb?.({ ok: true });
    });

    // ---------- turnos (mestre) ----------
    on(socket, "mesa:turno", async (payload: {
      sessionId?: string; acao?: string;
      ordem?: string[]; primeiro?: number; pular?: number; dados?: number; npcs?: string[];
    }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.acao) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      if (payload.acao === "iniciativa" && (
        !Number.isInteger(payload.dados ?? 1) || (payload.dados ?? 1) < 1 || (payload.dados ?? 1) > INICIATIVA_DADOS_MAX
        || (payload.npcs !== undefined && (!Array.isArray(payload.npcs) || payload.npcs.length > 20
          || payload.npcs.some((id) => typeof id !== "string" || !id.trim())
          || new Set(payload.npcs).size !== payload.npcs.length))
      )) { cb?.({ ok: false, erro: "Dados de iniciativa inválidos" }); return; }
      if (!consumirOuRecusar(socket, "turno", cb)) return;
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre controla turnos" }); return; }

      let t = await turnoAtual(payload.sessionId);
      await pausaTesteEmit(JSON.stringify(payload));
      if (!t) {
        const id = randomUUID();
        await db.insert(turns).values({ id, sessionId: payload.sessionId, state: { ordem: [], atual: -1, ativo: false }, updatedBy: u.id, updatedAt: new Date() });
        [t] = await db.select().from(turns).where(eq(turns.id, id)).limit(1);
      }
      const state = { ...((t.state ?? {}) as Record<string, unknown>) } as {
        ordem?: string[]; atual?: number; ativo?: boolean; iniciativa?: ResultadoIniciativa[];
      };
      state.ordem = state.ordem ?? [];
      const n = state.ordem.length;

      const rotuloMembro = async (membershipId: string) => {
        const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId)).limit(1);
        if (!m) return "?";
        return nomeUsuario(m.userId);
      };
      const rotuloAtor = async (atorId: string) => {
        if (!atorId.startsWith("npc:")) return rotuloMembro(atorId);
        const [npc] = await db.select({ name: characters.name }).from(characters).where(and(
          eq(characters.id, atorId.slice(4)), eq(characters.campaignId, ctx.sessao.campaignId),
        )).limit(1);
        return npc?.name ?? "NPC";
      };

      switch (payload.acao) {
        case "iniciar": {
          if (payload.ordem?.length) state.ordem = payload.ordem;
          // Sem participantes válidos não existe sequência de turnos:
          // recusa antes de persistir {ativo:true, ordem:[]} — estado
          // que quebrava a renderização da mesa no cliente.
          const nn = state.ordem.length;
          if (nn === 0) { cb?.({ ok: false, erro: "Sem participantes para iniciar os turnos" }); return; }
          delete state.iniciativa;
          state.ativo = true;
          state.atual = payload.primeiro !== undefined ? Math.min(Math.max(0, payload.primeiro), nn - 1) : 0;
          break;
        }
        case "iniciativa": {
          const npcIds = payload.npcs ?? [];
          const jogadores = await db.select({
            membershipId: memberships.id, username: users.username, displayName: users.displayName,
          }).from(memberships).innerJoin(users, eq(memberships.userId, users.id)).where(and(
            eq(memberships.campaignId, ctx.sessao.campaignId),
            eq(memberships.role, "jogador"), eq(memberships.status, "ativo"),
          ));
          const npcs = npcIds.length ? await db.select({
            id: characters.id, name: characters.name, data: characters.data,
          }).from(characters).innerJoin(memberships, eq(characters.membershipId, memberships.id)).where(and(
            eq(characters.campaignId, ctx.sessao.campaignId), eq(characters.isNpc, true),
            eq(characters.status, "aprovada"), eq(memberships.status, "ativo"), inArray(characters.id, npcIds),
          )) : [];
          if (npcs.length !== npcIds.length || npcs.some((npc) => !npcFichaVisivel(npc.data))) {
            cb?.({ ok: false, erro: "NPC inválido ou ainda não revelado" });
            return;
          }
          const participantes = [
            ...jogadores.map((j) => ({ atorId: j.membershipId, nome: j.displayName || j.username })),
            ...npcs.map((npc) => ({ atorId: `npc:${npc.id}`, nome: npc.name })),
          ];
          if (!participantes.length) { cb?.({ ok: false, erro: "Nenhum participante elegível para iniciativa" }); return; }
          state.iniciativa = calcularIniciativa(participantes, payload.dados ?? 1, (quantidade) => rolarLados(20, quantidade));
          state.ordem = state.iniciativa.map((resultado) => resultado.atorId);
          state.ativo = true;
          state.atual = 0;
          break;
        }
        case "avancar":
          if (state.ativo && n > 0) state.atual = ((state.atual ?? -1) + 1) % n;
          break;
        case "voltar":
          if (state.ativo && n > 0) state.atual = ((state.atual ?? 0) - 1 + n) % n;
          break;
        case "pular": {
          const pular = payload.pular ?? 1;
          if (state.ativo && n > 0) state.atual = (((state.atual ?? -1) + pular) % n + n) % n;
          break;
        }
        case "definirOrdem":
          if (Array.isArray(payload.ordem)) {
            state.ordem = payload.ordem; delete state.iniciativa;
            if (state.atual !== undefined && state.atual >= state.ordem.length) state.atual = state.ordem.length - 1;
            // Ordem esvaziada encerra a sequência — {ativo:true, ordem:[]}
            // é estado inválido que a mesa não consegue renderizar.
            if (!state.ordem.length) state.ativo = false;
          }
          break;
        case "encerrar":
          state.ativo = false;
          delete state.iniciativa;
          break;
        default:
          cb?.({ ok: false, erro: "Ação inválida" }); return;
      }

      await pausaTesteEmit(JSON.stringify(payload));
      await db.update(turns).set({ state: state as never, updatedBy: u.id, updatedAt: new Date() }).where(eq(turns.id, t.id));
      // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: turns persistido —
      // o lease cobre emissão e registrarChat finais
      await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
      io.to(`sessao:${payload.sessionId}`).emit("mesa:turnos", { sessionId: payload.sessionId, turnos: state });
      const atualId = state.ativo && state.atual !== undefined && state.atual >= 0 ? state.ordem[state.atual] : null;
      const rotulo = atualId ? state.iniciativa?.find((r) => r.atorId === atualId)?.nome ?? await rotuloAtor(atualId) : null;
      await registrarChat(io, {
        campaignId: ctx.sessao.campaignId, sessionId: ctx.sessao.id, authorId: u.id,
        kind: "evento",
        content: payload.acao === "iniciar" ? `Turnos iniciados${rotulo ? ` — começa ${rotulo}` : ""}`
          : payload.acao === "iniciativa" ? `Iniciativa (${payload.dados ?? 1}d20): ${(state.iniciativa ?? []).map((r) => `${r.nome} (${r.dados.join(" + ")} = ${r.total})`).join(" → ")}`
          : payload.acao === "encerrar" ? "Sequência de turnos encerrada"
          : payload.acao === "avancar" || payload.acao === "voltar" || payload.acao === "pular" ? `Turno: ${rotulo ?? "—"}`
          : "Ordem de turnos atualizada",
        visibility: "publica",
      });
      cb?.({ ok: true, turnos: state });
    });

    // ---------- temporizador (mestre) ----------
    on(socket, "mesa:timer", async (payload: { sessionId?: string; acao?: string; duracaoSegundos?: number }, cb?: (r: unknown) => void) => {
      const u = usuario();
      if (!u || !payload?.sessionId || !payload.acao) { cb?.({ ok: false, erro: "Dados inválidos" }); return; }
      if (!consumirOuRecusar(socket, "turno", cb)) return;
      const ctx = await resolverCtx(socket, payload.sessionId);
      if ("erro" in ctx) { cb?.({ ok: false, erro: ctx.erro }); return; }
      if (ctx.papel !== "mestre") { cb?.({ ok: false, erro: "Só o mestre controla o temporizador" }); return; }

      // colunas explícitas: select() completo parsearia vtt_state (json) e
      // uma corrupção ali derrubaria o temporizador junto com a mesa virtual
      const [s] = await db.select({ id: sessions.id, campaignId: sessions.campaignId, timerState: sessions.timerState })
        .from(sessions).where(eq(sessions.id, payload.sessionId)).limit(1);
      if (!s) { cb?.({ ok: false, erro: "Sessão não encontrada" }); return; }
      const atual = (s.timerState ?? {}) as { status?: string; remainingMs?: number; totalMs?: number; endsAt?: number };
      const agora = Date.now();
      let novo: Record<string, unknown>;

      switch (payload.acao) {
        case "iniciar": {
          const seg = duracaoTimerValida(payload.duracaoSegundos ?? 300);
          if (seg === null) { cb?.({ ok: false, erro: ERRO_DURACAO_TIMER }); return; }
          const dur = seg * 1000;
          novo = { status: "rodando", endsAt: agora + dur, remainingMs: dur, totalMs: dur };
          break;
        }
        case "pausar": {
          const rest = atual.endsAt ? Math.max(0, atual.endsAt - agora) : (atual.remainingMs ?? 0);
          novo = { status: "pausado", remainingMs: rest, totalMs: atual.totalMs ?? rest };
          break;
        }
        case "retomar": {
          const rest = atual.remainingMs ?? 0;
          novo = rest > 0 ? { status: "rodando", endsAt: agora + rest, remainingMs: rest, totalMs: atual.totalMs ?? rest } : { status: "parado", remainingMs: 0, totalMs: atual.totalMs ?? 0 };
          break;
        }
        case "reiniciar": {
          let seg: number;
          if (payload.duracaoSegundos !== undefined) {
            const v = duracaoTimerValida(payload.duracaoSegundos);
            if (v === null) { cb?.({ ok: false, erro: ERRO_DURACAO_TIMER }); return; }
            seg = v;
          } else {
            seg = atual.totalMs ? Math.ceil(atual.totalMs / 1000) : 300;
          }
          const dur = seg * 1000;
          novo = { status: "rodando", endsAt: agora + dur, remainingMs: dur, totalMs: dur };
          break;
        }
        case "encerrar":
          novo = { status: "parado", remainingMs: 0, totalMs: atual.totalMs ?? 0 };
          break;
        default:
          cb?.({ ok: false, erro: "Ação inválida" }); return;
      }
      await pausaTesteEmit(JSON.stringify(payload));
      await db.update(sessions).set({ timerState: novo as never, updatedAt: new Date() }).where(eq(sessions.id, s.id));
      agendarAutosave(s.campaignId);
      // gancho determinístico PÓS-PRIMEIRA-GRAVAÇÃO: timerState persistido
      await pausaTesteEmit(JSON.stringify({ ...payload, fase: "pos-write" }));
      const estadoTimer = { sessionId: s.id, ...novo, servidorAgora: agora };
      io.to(`sessao:${s.id}`).emit("mesa:timer", estadoTimer);
      cb?.({ ok: true, timer: estadoTimer });
    });
  });

  // ---------- ticker do temporizador (sincronização servidor→clientes) ----------
  setInterval(async () => {
    try {
      // só as colunas do timer: vtt_state corrompido não pode parar o ticker
      const rodando = await db.select({ id: sessions.id, campaignId: sessions.campaignId, timerState: sessions.timerState }).from(sessions);
      for (const s of rodando) {
        const ts = s.timerState as { status?: string; endsAt?: number; remainingMs?: number; totalMs?: number } | null;
        if (!ts || ts.status !== "rodando") continue;
        // barreira/lease: o ticker NÃO pode persistir estado calculado
        // sobre dados pré-restore — pula a sessão durante restauração
        // e segura um lease durante a escrita+emissão de cada parada
        if (barreiraRestauracaoAtiva(s.campaignId)) continue;
        const relTick = adquirirOperacaoCampanha(s.campaignId);
        if (!relTick) continue; // corrida: barreira subiu entre a checagem e a aquisição
        try {
        // recuperação pós-restart: se endsAt faltar, reconstrói a partir de remainingMs persistido
        const endsAt = ts.endsAt ?? (ts.remainingMs ? Date.now() + ts.remainingMs : 0);
        if (!endsAt) {
          const parado = { status: "parado", remainingMs: 0, totalMs: ts.totalMs ?? 0 };
          await db.update(sessions).set({ timerState: parado as never }).where(eq(sessions.id, s.id));
          agendarAutosave(s.campaignId);
          io.to(`sessao:${s.id}`).emit("mesa:timer", { sessionId: s.id, ...parado, servidorAgora: Date.now() });
          continue;
        }
        const rest = Math.max(0, endsAt - Date.now());
        if (rest <= 0) {
          const parado = { status: "parado", remainingMs: 0, totalMs: ts.totalMs ?? 0 };
          await db.update(sessions).set({ timerState: parado as never }).where(eq(sessions.id, s.id));
          agendarAutosave(s.campaignId);
          io.to(`sessao:${s.id}`).emit("mesa:timer", { sessionId: s.id, ...parado, servidorAgora: Date.now() });
        } else {
          io.to(`sessao:${s.id}`).emit("mesa:timer", {
            sessionId: s.id, status: "rodando", remainingMs: rest, totalMs: ts.totalMs, endsAt: ts.endsAt, servidorAgora: Date.now(),
          });
        }
        } finally {
          relTick();
        }
      }
    } catch { /* ticker não pode derrubar o servidor */ }
  }, 1000);
}

// expõe helpers usados por outros módulos
export { emitirMensagem, mestresDaCampanha, nomeUsuario, registrarChat, rolarLados };
