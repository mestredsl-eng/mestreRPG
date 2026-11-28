// Internet pública 1.1.2 — live simulado (Streamer) + métricas
// básicas + Influencer-gate (ordem Dono 7232090197 item 3; threat
// model INTERMEDIÁRIO M1–M12/M24–M27/M30–M33; contrato PAI 7232560361).
//
// Regras:
//  - Live é presença EFÊMERA com texto básico — sem áudio/vídeo/mídia
//    real. TTL fixo 2h derivado na leitura (mesmo padrão expiresAt
//    D11 — nenhum job/cron). Uma live aberta por conta (índice
//    parcial UNIQUE).
//  - Gate fail-closed M1: `pericia:streamer` OU `profissao:streamer`
//    no ruleset ativo da ficha — resolvido por extrairEscolhas contra
//    a definição vigente (nunca label/body do cliente). Personagem
//    com morte vigente ou arquivado não entra ao vivo (M2).
//  - Live é identidade de perfil: conta identificada obrigatória —
//    não existe modo anônimo/pseudônimo para transmissão (M5).
//  - Diretório exige o mesmo gate de leitor da camada pública
//    (conta elegível ou mestre); conteúdo expirado some da leitura.
//  - Seguidores: aresta unidirecional idempotente; contador = COUNT
//    derivado, nunca campo incrementável (M7). Não entra no pacote
//    público D6 (grafo social é privado).
//  - Views: incremento atômico em internet-publica.ts só em matéria
//    publicada vigente servida (bruto, sem dedupe — decisão TG).
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  auditLogs, characters, internetAccounts, internetAoVivo, internetPerfis,
  internetSeguidores, sheetVersions,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { estruturaFichaSchema } from "../lib/ficha.js";
import { carregarRegrasSincrono, extrairEscolhas } from "../lib/regras.js";
import {
  contaAutorizadaPara, contasDoUsuario, mestreLeitorDaCampanha,
} from "../lib/conta-internet.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import { morteVigente } from "../lib/morte.js";
import { audit } from "../lib/audit.js";

const db = getDb();
export const internetLiveRouter = Router({ mergeParams: true });
internetLiveRouter.use(requireAuth);

const campanhaId = (req: Request) => req.params.campaignId as string;
const TTL_LIVE_MS = 2 * 60 * 60 * 1000; // 2h — derivado, sem job

function erroHttp(res: Response, status: number, erro: string) {
  res.status(status).json({ erro });
}

const limiteLive = limiteUsuario({ nome: "internet-live", janelaMs: 60_000, max: 60 });

const entrarSchema = z.object({
  characterId: z.string().min(1),
  titulo: z.string().min(3).max(120),
  descricao: z.string().max(2000).optional(),
}).strict();

/** Gate streamer fail-closed (M1/M24): pericia:streamer OU
 *  profissao:streamer selecionada na ficha contra o ruleset ativo.
 *  Mesma disciplina de ehJornalistaD8 — nunca label do cliente. */
async function ehStreamer(cid: string, characterId: string): Promise<boolean> {
  const [personagem] = await db.select().from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!personagem?.templateVersionId) return false;
  const [ver] = await db.select().from(sheetVersions)
    .where(eq(sheetVersions.id, personagem.templateVersionId)).limit(1);
  const parse = ver ? estruturaFichaSchema.safeParse(ver.structure) : null;
  if (!parse?.success) return false;
  const regras = carregarRegrasSincrono(db, cid);
  if (!regras) return false;
  const dados = (personagem.data ?? {}) as Record<string, unknown>;
  return extrairEscolhas(parse.data, dados, regras).some(
    (e) => e.selecionado && (e.elemento?.kind === "pericia" || e.elemento?.kind === "profissao")
      && e.elemento.key === "streamer",
  );
}

/** Gate de leitor público — mesmo de internet-perfis.ts. Devolve as
 *  contas autorizadas do requisitante (para marcar `minha` nas lives). */
async function leitorContas(req: Request, res: Response, cid: string): Promise<(typeof internetAccounts.$inferSelect)[] | null> {
  const contas: (typeof internetAccounts.$inferSelect)[] = [];
  for (const conta of await contasDoUsuario(cid, req.usuario!.id)) {
    const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
    if (auth) contas.push(auth.conta);
  }
  if (contas.length) return contas;
  if (await mestreLeitorDaCampanha(cid, req.usuario!.id)) return [];
  erroHttp(res, 403, "Sem acesso à camada pública da Internet");
  return null;
}

/** Conta Internet do personagem + titular atual (gate cumulativo). */
async function titularDoPersonagem(cid: string, characterId: string, userId: string) {
  const [conta] = await db.select().from(internetAccounts)
    .where(and(
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.characterId, characterId),
      eq(internetAccounts.status, "ativa"),
    )).limit(1);
  if (!conta) return null;
  const auth = await contaAutorizadaPara(conta.id, userId);
  if (!auth) return null;
  const [personagem] = await db.select().from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!personagem) return null;
  return { conta, personagem };
}

/** P2 (INTERMEDIÁRIO #402): streamer morto ou arquivado DURANTE a
 *  transmissão — revalidado na leitura, mesmo padrão derivado do
 *  TTL (sem job, sem escrita). Devolve os ids que não podem seguir
 *  ao vivo: status='arquivado' ou morteVigente no data. */
async function personagensForaDoAr(cid: string, personagemIds: string[]): Promise<Set<string>> {
  if (!personagemIds.length) return new Set();
  const rows = await db.select({
    id: characters.id, status: characters.status, data: characters.data,
  }).from(characters)
    .where(and(eq(characters.campaignId, cid), inArray(characters.id, personagemIds)));
  const fora = new Set<string>();
  for (const p of rows) {
    if (p.status === "arquivado"
      || morteVigente((p.data ?? {}) as Record<string, unknown>)) fora.add(p.id);
  }
  return fora;
}

function liveSerializada(l: typeof internetAoVivo.$inferSelect, agora = new Date()) {
  const vigente = !l.encerradoEm && l.expiraEm.getTime() > agora.getTime();
  return {
    id: l.id,
    titulo: l.titulo,
    descricao: l.descricao,
    // personagemId/contaId nunca saem — ids internos (V-08); a
    // identidade pública é o handle/nomePublico do perfil.
    iniciadoEm: l.iniciadoEm.toISOString(),
    expiraEm: l.expiraEm.toISOString(),
    vigente,
    criadoEm: l.createdAt.toISOString(),
  };
}

/** POST /ao-vivo — entrar ao vivo (Streamer). */
internetLiveRouter.post("/ao-vivo", limiteLive, async (req, res) => {
  const cid = campanhaId(req);
  const body = entrarSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const b = body.data;

  const titular = await titularDoPersonagem(cid, b.characterId, req.usuario!.id);
  if (!titular) { erroHttp(res, 404, "Personagem não elegível"); return; }
  // P2 (INTERMEDIÁRIO #402): arquivado é somente leitura — não
  // transmite (mesma regra do perfilPorHandle/perfil ativar).
  if (titular.personagem.status === "arquivado") { erroHttp(res, 403, "personagem_arquivado"); return; }
  // M2: morto não transmite — presença de morto é fraude diegética.
  if (morteVigente((titular.personagem.data ?? {}) as Record<string, unknown>)) { erroHttp(res, 403, "personagem_falecido"); return; }
  if (!(await ehStreamer(cid, b.characterId))) {
    erroHttp(res, 403, "Personagem sem perícia/profissão streamer no ruleset ativo"); return;
  }

  const agora = new Date();
  // live vigente existente → 409 (índice parcial UNIQUE cobre corrida)
  const [vigente] = await db.select({ id: internetAoVivo.id }).from(internetAoVivo)
    .where(and(
      eq(internetAoVivo.contaId, titular.conta.id),
      isNull(internetAoVivo.encerradoEm),
      gt(internetAoVivo.expiraEm, agora),
    )).limit(1);
  if (vigente) { erroHttp(res, 409, "Já existe live aberta para esta conta"); return; }

  const id = crypto.randomUUID();
  try {
    db.transaction((tx) => {
      // TG #402 P1 — lazy-close D11: live expirada por TTL fica com
      // encerrado_em NULL para sempre e o índice parcial UNIQUE
      // travaria a conta (409 eterno — /sair exige id que o
      // diretório não expõe mais). Fecha as expiradas da conta na
      // mesma tx antes do insert; custo zero, cobre a corrida.
      tx.update(internetAoVivo).set({ encerradoEm: agora, updatedAt: agora })
        .where(and(
          eq(internetAoVivo.contaId, titular.conta.id),
          isNull(internetAoVivo.encerradoEm),
          lte(internetAoVivo.expiraEm, agora),
        )).run();
      tx.insert(internetAoVivo).values({
        id, campaignId: cid, contaId: titular.conta.id,
        personagemId: b.characterId, titulo: b.titulo, descricao: b.descricao ?? null,
        iniciadoEm: agora, expiraEm: new Date(agora.getTime() + TTL_LIVE_MS),
        createdAt: agora, updatedAt: agora,
      }).run();
      tx.insert(auditLogs).values({
        id: crypto.randomUUID(), actorId: req.usuario!.id, campaignId: cid,
        guildId: null, action: "internet.ao_vivo.entrar",
        detail: { liveId: id, contaId: titular.conta.id }, createdAt: agora,
      }).run();
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { erroHttp(res, 409, "Já existe live aberta para esta conta"); return; }
    throw e;
  }
  await audit(req, "internet.ao_vivo.entrar", { liveId: id }, { campaignId: cid });
  res.status(201).json({ live: { id, vigente: true, expiraEm: new Date(agora.getTime() + TTL_LIVE_MS).toISOString() } });
});

/** POST /ao-vivo/:id/sair — encerrar a própria live. */
internetLiveRouter.post("/ao-vivo/:id/sair", limiteLive, async (req, res) => {
  const cid = campanhaId(req);
  const [live] = await db.select().from(internetAoVivo)
    .where(and(eq(internetAoVivo.id, req.params.id), eq(internetAoVivo.campaignId, cid)))
    .limit(1);
  if (!live) { erroHttp(res, 404, "Live não encontrada"); return; }
  const auth = await contaAutorizadaPara(live.contaId, req.usuario!.id);
  if (!auth) { erroHttp(res, 404, "Live não encontrada"); return; }
  const agora = new Date();
  await db.update(internetAoVivo).set({ encerradoEm: agora, updatedAt: agora })
    .where(and(eq(internetAoVivo.id, live.id), isNull(internetAoVivo.encerradoEm))).run();
  await audit(req, "internet.ao_vivo.sair", { liveId: live.id }, { campaignId: cid });
  res.json({ ok: true });
});

/** GET /ao-vivo — diretório de lives vigentes (gate de leitor). */
internetLiveRouter.get("/ao-vivo", async (req, res) => {
  const cid = campanhaId(req);
  const minhas = await leitorContas(req, res, cid);
  if (!minhas) return;
  const agora = new Date();
  const lives = await db.select().from(internetAoVivo)
    .where(and(
      eq(internetAoVivo.campaignId, cid),
      isNull(internetAoVivo.encerradoEm),
      gt(internetAoVivo.expiraEm, agora),
    ))
    .orderBy(desc(internetAoVivo.iniciadoEm)).limit(100);
  // enriquece com handle/nome público do perfil (sem ids internos)
  const contaIds = [...new Set(lives.map((l) => l.contaId))];
  const contas = contaIds.length
    ? await db.select().from(internetAccounts).where(inArray(internetAccounts.id, contaIds))
    : [];
  const contaPorId = new Map(contas.map((c) => [c.id, c] as const));
  const charIds = [...new Set(contas.map((c) => c.characterId))];
  const perfis = charIds.length
    ? await db.select().from(internetPerfis).where(inArray(internetPerfis.characterId, charIds))
    : [];
  const perfilPorChar = new Map(perfis.map((p) => [p.characterId, p] as const));
  // P2: lives de streamer morto/arquivado somem do diretório —
  // revalidação derivada na leitura (a linha segue até o TTL).
  const charVivoPorConta = new Map(contas.map((c) => [c.id, c.characterId] as const));
  const foraDoAr = await personagensForaDoAr(cid, [...new Set(contas.map((c) => c.characterId))]);
  const livesVigentes = lives.filter((l) => {
    const charId = charVivoPorConta.get(l.contaId);
    return !charId || !foraDoAr.has(charId);
  });
  res.json({
    lives: livesVigentes.map((l) => {
      const conta = contaPorId.get(l.contaId);
      const perfil = conta ? perfilPorChar.get(conta.characterId) : undefined;
      return {
        ...liveSerializada(l, agora),
        // `minha` = live de conta autorizada do próprio leitor — única
        // marca de titularidade exposta (nunca ids internos).
        minha: minhas.some((c) => c.id === l.contaId),
        handle: conta?.handle ?? null,
        nomePublico: perfil?.nomePublico ?? conta?.displayName ?? null,
      };
    }),
  });
});

/** GET /ao-vivo/:id — detalhe da live vigente. */
internetLiveRouter.get("/ao-vivo/:id", async (req, res) => {
  const cid = campanhaId(req);
  const minhas = await leitorContas(req, res, cid);
  if (!minhas) return;
  const [live] = await db.select().from(internetAoVivo)
    .where(and(eq(internetAoVivo.id, req.params.id), eq(internetAoVivo.campaignId, cid)))
    .limit(1);
  const agora = new Date();
  if (!live || live.encerradoEm || live.expiraEm.getTime() <= agora.getTime()) {
    erroHttp(res, 404, "Live não encontrada"); return;
  }
  const [conta] = await db.select().from(internetAccounts).where(eq(internetAccounts.id, live.contaId)).limit(1);
  // P2: detalhe de live de streamer morto/arquivado → 404 (mesmo
  // tratamento de expirada — não vaza que existiu).
  if (conta) {
    const fora = await personagensForaDoAr(cid, [conta.characterId]);
    if (fora.has(conta.characterId)) { erroHttp(res, 404, "Live não encontrada"); return; }
  }
  const [perfil] = conta
    ? await db.select().from(internetPerfis).where(eq(internetPerfis.characterId, conta.characterId)).limit(1)
    : [undefined];
  res.json({
    live: {
      ...liveSerializada(live, agora),
      minha: minhas.some((c) => c.id === live.contaId),
      handle: conta?.handle ?? null,
      nomePublico: perfil?.nomePublico ?? conta?.displayName ?? null,
    },
  });
});

// ---------- Seguidores (métricas básicas — aresta idempotente) ----------

const contaPorHandle = async (cid: string, handle: string) => {
  const [conta] = await db.select().from(internetAccounts)
    .where(and(
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.handle, handle),
      eq(internetAccounts.status, "ativa"),
    )).limit(1);
  return conta ?? null;
};

/** Conta seguidora: `origemContaId` explícito quando informado
 *  (mesmo padrão de /contatar — D9), senão a mais antiga autorizada
 *  do requisitante. Ordem determinística — nunca "primeira da query". */
async function contaSeguidora(cid: string, userId: string, origemContaId?: string) {
  const contas = (await contasDoUsuario(cid, userId))
    .slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const autorizadas: typeof contas = [];
  for (const conta of contas) {
    if (await contaAutorizadaPara(conta.id, userId)) autorizadas.push(conta);
  }
  if (origemContaId) return autorizadas.find((c) => c.id === origemContaId) ?? null;
  return autorizadas[0] ?? null;
}

const seguirSchema = z.object({ origemContaId: z.string().min(1).optional() }).strict();

async function contagemSeguidores(cid: string, contaId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(internetSeguidores)
    .where(and(eq(internetSeguidores.campaignId, cid), eq(internetSeguidores.alvoContaId, contaId)));
  return r?.n ?? 0;
}

/** POST /contas/:handle/seguir — aresta unidirecional idempotente. */
internetLiveRouter.post("/contas/:handle/seguir", limiteLive, async (req, res) => {
  const cid = campanhaId(req);
  const body = seguirSchema.safeParse(req.body ?? {});
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  if (!(await leitorContas(req, res, cid))) return;
  const alvo = await contaPorHandle(cid, req.params.handle);
  if (!alvo) { erroHttp(res, 404, "Conta não encontrada"); return; }
  const seguidor = await contaSeguidora(cid, req.usuario!.id, body.data.origemContaId);
  if (!seguidor) { erroHttp(res, 403, "Sem conta elegível para seguir"); return; }
  if (seguidor.id === alvo.id) { erroHttp(res, 400, "Não é possível seguir a si mesmo"); return; }
  await db.insert(internetSeguidores).values({
    id: crypto.randomUUID(), campaignId: cid,
    seguidorContaId: seguidor.id, alvoContaId: alvo.id, createdAt: new Date(),
  }).onConflictDoNothing().run();
  res.json({ seguidores: await contagemSeguidores(cid, alvo.id) });
});

/** POST /contas/:handle/deixar-de-seguir — remove a aresta (idempotente). */
internetLiveRouter.post("/contas/:handle/deixar-de-seguir", limiteLive, async (req, res) => {
  const cid = campanhaId(req);
  const body = seguirSchema.safeParse(req.body ?? {});
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  if (!(await leitorContas(req, res, cid))) return;
  const alvo = await contaPorHandle(cid, req.params.handle);
  if (!alvo) { erroHttp(res, 404, "Conta não encontrada"); return; }
  const seguidor = await contaSeguidora(cid, req.usuario!.id, body.data.origemContaId);
  if (!seguidor) { erroHttp(res, 403, "Sem conta elegível"); return; }
  await db.delete(internetSeguidores)
    .where(and(
      eq(internetSeguidores.campaignId, cid),
      eq(internetSeguidores.seguidorContaId, seguidor.id),
      eq(internetSeguidores.alvoContaId, alvo.id),
    )).run();
  res.json({ seguidores: await contagemSeguidores(cid, alvo.id) });
});
