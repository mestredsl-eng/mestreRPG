// Internet pública 1.1.2 (#365 — fatia W9/W10, perfis públicos):
// ativação irreversível, perfil público por handle, edição pelo
// titular, avatar via pipeline `arquivos` e busca por handle.
// Contrato: ESPECIFICACAO §W9/W10 + D10/DP-4/DP-5/DP-7 + D12.
//
// Regras:
//  - perfil é OPCIONAL e segue o PERSONAGEM (characterId) — P7 e
//    ressurreição preservam; a linha existir É a ativação (sem flag).
//  - ativação/edição SÓ pelo titular atual da conta Internet do
//    personagem (contaAutorizadaPara — gate cumulativo) — mestre não
//    edita conteúdo diegético do perfil; leitura pública via gate de
//    leitor (conta elegível ou mestre, mesmo de sites/publicações).
//  - personagem com morte vigente → escrita negada (DP-5,
//    server-side); leitura segue normal.
//  - avatar referencia `files` da mesma campanha: só imagem com
//    status 'aprovado' (upload de jogador nasce 'pendente' — não
//    vaza conteúdo não moderado para superfície pública).
//  - perfil público expõe handle + nome público + descrição + avatar
//    + timeline de publicações — NUNCA ids internos (V-08/PROF-04).
//    Publicações anônimas (DP-1) só aparecem para o próprio titular,
//    marcadas `anonima`; `contatos` só com aresta aceita vigente.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, gt, gte, isNull, like, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import { existsSync, createReadStream } from "node:fs";
import { getDb } from "../db/index.js";
import {
  characters, files, internetAccounts, internetPages, internetPerfis,
  internetPublicacoes, internetSites, memberships,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import {
  codificarCursor, contaAutorizadaPara, contasDoUsuario,
  contatoAceitoEntre, decodificarCursor, mestreLeitorDaCampanha,
} from "../lib/conta-internet.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import { audit } from "../lib/audit.js";
import { morteVigente } from "../lib/morte.js";
import { classificarConteudoArquivo, inicioDoArquivo } from "../lib/conteudo-arquivo.js";
import { caminhoFisico } from "./arquivos.js";

const db = getDb();
export const internetPerfisRouter = Router({ mergeParams: true });
internetPerfisRouter.use(requireAuth);

const campanhaId = (req: Request) => req.params.campaignId as string;

function erroHttp(res: Response, status: number, erro: string) {
  res.status(status).json({ erro });
}

const limitePerfis = limiteUsuario({ nome: "internet-perfis", janelaMs: 60_000, max: 60 });

interface LeitorPublico {
  contas: (typeof internetAccounts.$inferSelect)[];
  viaMestre: boolean;
}

/** Mesmo gate de leitura da camada pública (internet-publica.ts):
 *  ≥1 conta Internet autorizada do requisitante OU papel mestre. */
async function resolverLeitor(req: Request, res: Response, cid: string): Promise<LeitorPublico | null> {
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const contas: (typeof internetAccounts.$inferSelect)[] = [];
  for (const conta of minhas) {
    const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
    if (auth) contas.push(auth.conta);
  }
  if (contas.length) return { contas, viaMestre: false };
  if (await mestreLeitorDaCampanha(cid, req.usuario!.id)) return { contas: [], viaMestre: true };
  erroHttp(res, 403, "Sem acesso à camada pública da Internet");
  return null;
}

/** Conta Internet do personagem na campanha (âncora do perfil — DP-4
 *  o handle público vem dela; sem conta não há localizador). */
async function contaDoPersonagem(cid: string, characterId: string) {
  const [conta] = await db.select().from(internetAccounts)
    .where(and(
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.characterId, characterId),
    )).limit(1);
  return conta ?? null;
}

async function perfilDoPersonagem(cid: string, characterId: string) {
  const [perfil] = await db.select().from(internetPerfis)
    .where(and(
      eq(internetPerfis.campaignId, cid),
      eq(internetPerfis.characterId, characterId),
    )).limit(1);
  return perfil ?? null;
}

/** Revalidação TOCTOU síncrona na tx (mesmo padrão de titularNaTx da
 *  escrita): conta ativa + personagem não arquivado + membership do
 *  requisitante ativa e dona do personagem. */
function titularNaTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  contaId: string, userId: string, cid: string,
): boolean {
  const [conta] = tx.select({
    characterId: internetAccounts.characterId,
    status: internetAccounts.status,
  }).from(internetAccounts)
    .where(and(eq(internetAccounts.id, contaId), eq(internetAccounts.campaignId, cid)))
    .limit(1).all();
  if (!conta || conta.status !== "ativa") return false;
  const [pers] = tx.select({
    membershipId: characters.membershipId,
    status: characters.status,
  }).from(characters)
    .where(and(eq(characters.id, conta.characterId), eq(characters.campaignId, cid)))
    .limit(1).all();
  if (!pers || pers.status === "arquivado") return false;
  const [mu] = tx.select({ role: memberships.role }).from(memberships)
    .where(and(
      eq(memberships.campaignId, cid),
      eq(memberships.userId, userId),
      eq(memberships.status, "ativo"),
    )).limit(1).all();
  if (!mu || (mu.role !== "mestre" && mu.role !== "jogador")) return false;
  const [dono] = tx.select({ userId: memberships.userId, status: memberships.status })
    .from(memberships)
    .where(and(
      eq(memberships.id, pers.membershipId),
      eq(memberships.campaignId, cid),
    )).limit(1).all();
  return !!dono && dono.status === "ativo" && dono.userId === userId;
}

/** Personagem tem morte vigente? (DP-5 — escrita negada enquanto a
 *  epoch `__morte` ativa não tiver `revertidaEm`.) */
async function personagemFalecido(cid: string, characterId: string): Promise<boolean> {
  const [pers] = await db.select({ data: characters.data }).from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!pers) return false;
  const dados = (typeof pers.data === "string" ? JSON.parse(pers.data) : pers.data) as Record<string, unknown>;
  return morteVigente(dados) !== null;
}

const MIMES_IMAGEM_AVATAR = /^image\//;
const EXT_IMAGEM = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** Avatar = arquivo da biblioteca da MESMA campanha, imagem real,
 *  já moderado (status 'aprovado'). Retorna o arquivo ou null. */
async function arquivoAvatarValido(cid: string, arquivoId: string) {
  const [f] = await db.select().from(files)
    .where(and(eq(files.id, arquivoId), eq(files.campaignId, cid)))
    .limit(1);
  if (!f || f.status !== "aprovado" || !f.storageName) return null;
  const ehImagem = (f.mimeType && MIMES_IMAGEM_AVATAR.test(f.mimeType))
    || EXT_IMAGEM.has((f.storageName.split(".").pop() ?? "").toLowerCase());
  return ehImagem ? f : null;
}

const ativarSchema = z.object({
  characterId: z.string().min(1).max(64),
  nomePublico: z.string().trim().min(1).max(80).nullish(),
  descricao: z.string().trim().max(2000).nullish(),
}).strict();

const editarSchema = z.object({
  characterId: z.string().min(1).max(64),
  nomePublico: z.string().trim().min(1).max(80).nullish(),
  descricao: z.string().trim().max(2000).nullish(),
  avatarFileId: z.string().min(1).max(64).nullish(),
}).strict();

/** Titular autorizado do personagem via conta Internet (com gate
 *  cumulativo) — retorna a conta ou null (caller decide 403/404). */
async function titularDaContaDoPersonagem(req: Request, cid: string, characterId: string) {
  const conta = await contaDoPersonagem(cid, characterId);
  if (!conta) return null;
  const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
  return auth ? { conta, auth } : null;
}

/** POST /perfil/ativar — ativação irreversível (D10): cria a linha do
 *  perfil uma única vez; repetição é idempotente (200 com o perfil).
 *  Não existe desativar/excluir/ocultar — esses verbos respondem 404. */
internetPerfisRouter.post("/perfil/ativar", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const body = ativarSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const { characterId, nomePublico, descricao } = body.data;

  const [pers] = await db.select({ id: characters.id, campaignId: characters.campaignId, status: characters.status })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!pers || pers.status === "arquivado") { erroHttp(res, 404, "Personagem não encontrado"); return; }

  const conta = await contaDoPersonagem(cid, characterId);
  if (!conta) { erroHttp(res, 404, "Conta Internet do personagem não encontrada"); return; }

  // Escrita de ativação = ação do titular (gate cumulativo) — mestre
  // sem conta própria não ativa perfil alheio (conteúdo diegético).
  const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
  if (!auth) { erroHttp(res, 403, "Sem autorização sobre o personagem"); return; }

  const existente = await perfilDoPersonagem(cid, characterId);
  if (existente) {
    res.status(200).json({ perfil: existente });
    return;
  }

  // DP-5 dentro da tx: morte vigente lida na mesma seção crítica —
  // ativar é a escrita mais sensível do módulo (irreversível, D10).
  // Corrida de ativação simultânea: UNIQUE(character_id) resolve —
  // o perdedor relê a linha vencedora e responde 200 idempotente,
  // nunca 500.
  let resultado: { row?: typeof internetPerfis.$inferSelect; falha?: "titular" | "morto" };
  try {
    resultado = db.transaction((tx): { row?: typeof internetPerfis.$inferSelect; falha?: "titular" | "morto" } => {
    if (!titularNaTx(tx, conta.id, req.usuario!.id, cid)) return { falha: "titular" };
    const [dado] = tx.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
      .limit(1).all();
    const dados = (typeof dado?.data === "string" ? JSON.parse(dado.data) : dado?.data ?? {}) as Record<string, unknown>;
    if (morteVigente(dados)) return { falha: "morto" };
    const [row] = tx.insert(internetPerfis).values({
      id: crypto.randomUUID(),
      campaignId: cid,
      characterId,
      nomePublico: nomePublico ?? null,
      descricao: descricao ?? null,
      avatarFileId: null,
      ativadoEm: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning().all();
    return { row };
    });
  } catch {
    // UNIQUE(character_id) — outra ativação venceu a corrida; relê e
    // responde idempotente como se a linha já existisse.
    const vencedora = await perfilDoPersonagem(cid, characterId);
    if (vencedora) { res.status(200).json({ perfil: vencedora }); return; }
    throw new Error("falha_na_ativacao_de_perfil");
  }
  if (resultado.falha === "morto") { erroHttp(res, 403, "personagem_falecido"); return; }
  if (!resultado.row) { erroHttp(res, 403, "Titularidade alterada durante a operação"); return; }

  await audit(req, "internet.perfil.ativado", { characterId }, { campaignId: cid });
  res.status(201).json({ perfil: resultado.row });
});

/** GET /perfil?characterId= — visão do próprio titular (edição):
 *  inclui avatarFileId e ids internos — rota autenticada do dono. */
internetPerfisRouter.get("/perfil", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const characterId = typeof req.query.characterId === "string" ? req.query.characterId : "";
  if (!characterId) { erroHttp(res, 400, "characterId obrigatório"); return; }

  const perfil = await perfilDoPersonagem(cid, characterId);
  if (!perfil) { erroHttp(res, 404, "Perfil não ativado"); return; }

  const titular = await titularDaContaDoPersonagem(req, cid, characterId);
  const mestre = titular ? false : await mestreLeitorDaCampanha(cid, req.usuario!.id);
  if (!titular && !mestre) { erroHttp(res, 404, "Perfil não encontrado"); return; }

  const conta = await contaDoPersonagem(cid, characterId);
  res.json({
    perfil: {
      id: perfil.id,
      characterId: perfil.characterId,
      handle: conta?.handle ?? null,
      nomePublico: perfil.nomePublico,
      descricao: perfil.descricao,
      avatarFileId: perfil.avatarFileId,
      ativadoEm: perfil.ativadoEm,
      falecido: await personagemFalecido(cid, characterId),
    },
  });
});

/** PATCH /perfil — edição livre de nome público/descrição/avatar
 *  (D10/D4/DP-7). Titular apenas; personagem falecido → 403 (DP-5).
 *  Não existe endpoint de desativar/excluir — a irreversibilidade é
 *  estrutural (D10). */
internetPerfisRouter.patch("/perfil", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const body = editarSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }
  const { characterId, nomePublico, descricao, avatarFileId } = body.data;
  if (nomePublico === undefined && descricao === undefined && avatarFileId === undefined) {
    erroHttp(res, 400, "Nada para editar"); return;
  }

  const perfil = await perfilDoPersonagem(cid, characterId);
  if (!perfil) { erroHttp(res, 404, "Perfil não encontrado"); return; }

  const titular = await titularDaContaDoPersonagem(req, cid, characterId);
  if (!titular) { erroHttp(res, 403, "Sem autorização sobre o personagem"); return; }

  // DP-5: morte vigente → somente-leitura, enforcement server-side.
  if (await personagemFalecido(cid, characterId)) {
    erroHttp(res, 403, "personagem_falecido"); return;
  }

  // avatarFileId explícito (inclusive null = remover avatar) precisa
  // apontar para imagem aprovada da mesma campanha.
  if (avatarFileId !== undefined && avatarFileId !== null) {
    const f = await arquivoAvatarValido(cid, avatarFileId);
    if (!f) { erroHttp(res, 400, "avatar_invalido"); return; }
  }

  // DP-5 TOCTOU (TG #368 7234188619): o check de morte também é
  // refeito DENTRO da tx — um __morte gravado entre o fast-path e o
  // commit não pode passar. O pré-check externo fica como fast-path.
  const atualizado = db.transaction((tx) => {
    if (!titularNaTx(tx, titular.conta.id, req.usuario!.id, cid)) return "titular" as const;
    const [dado] = tx.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
      .limit(1).all();
    const dados = (typeof dado?.data === "string" ? JSON.parse(dado.data) : dado?.data ?? {}) as Record<string, unknown>;
    if (morteVigente(dados)) return "morto" as const;
    const [row] = tx.update(internetPerfis).set({
      ...(nomePublico !== undefined ? { nomePublico } : {}),
      ...(descricao !== undefined ? { descricao } : {}),
      ...(avatarFileId !== undefined ? { avatarFileId } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(internetPerfis.id, perfil.id),
      eq(internetPerfis.campaignId, cid),
    )).returning().all();
    return row ?? null;
  });
  if (atualizado === "titular") { erroHttp(res, 403, "Titularidade alterada durante a operação"); return; }
  if (atualizado === "morto") { erroHttp(res, 403, "personagem_falecido"); return; }
  if (!atualizado) { erroHttp(res, 403, "Titularidade alterada durante a operação"); return; }

  await audit(req, "internet.perfil.editado", { characterId }, { campaignId: cid });
  res.json({ perfil: atualizado });
});

/** POST /perfil/avatar — atalho de PATCH para o avatar (DP-7). */
internetPerfisRouter.post("/perfil/avatar", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const body = z.object({
    characterId: z.string().min(1).max(64),
    arquivoId: z.string().min(1).max(64),
  }).strict().safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos"); return; }

  const perfil = await perfilDoPersonagem(cid, body.data.characterId);
  if (!perfil) { erroHttp(res, 404, "Perfil não encontrado"); return; }
  const titular = await titularDaContaDoPersonagem(req, cid, body.data.characterId);
  if (!titular) { erroHttp(res, 403, "Sem autorização sobre o personagem"); return; }
  if (await personagemFalecido(cid, body.data.characterId)) {
    erroHttp(res, 403, "personagem_falecido"); return;
  }
  const f = await arquivoAvatarValido(cid, body.data.arquivoId);
  if (!f) { erroHttp(res, 400, "avatar_invalido"); return; }

  // DP-5 TOCTOU: morte revalidada dentro da tx (mesmo padrão do PATCH).
  const atualizado = db.transaction((tx) => {
    if (!titularNaTx(tx, titular.conta.id, req.usuario!.id, cid)) return "titular" as const;
    const [dado] = tx.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.id, body.data.characterId), eq(characters.campaignId, cid)))
      .limit(1).all();
    const dados = (typeof dado?.data === "string" ? JSON.parse(dado.data) : dado?.data ?? {}) as Record<string, unknown>;
    if (morteVigente(dados)) return "morto" as const;
    const [row] = tx.update(internetPerfis).set({
      avatarFileId: f.id, updatedAt: new Date(),
    }).where(and(
      eq(internetPerfis.id, perfil.id),
      eq(internetPerfis.campaignId, cid),
    )).returning().all();
    return row ?? null;
  });
  if (atualizado === "titular") { erroHttp(res, 403, "Titularidade alterada durante a operação"); return; }
  if (atualizado === "morto") { erroHttp(res, 403, "personagem_falecido"); return; }
  if (!atualizado) { erroHttp(res, 403, "Titularidade alterada durante a operação"); return; }
  await audit(req, "internet.perfil.avatar", { characterId: body.data.characterId, arquivoId: f.id }, { campaignId: cid });
  res.json({ perfil: atualizado });
});

interface PerfilPublico {
  perfil: typeof internetPerfis.$inferSelect;
  conta: typeof internetAccounts.$inferSelect;
  personagem: typeof characters.$inferSelect;
}

async function perfilPorHandle(cid: string, handle: string): Promise<PerfilPublico | null> {
  const [conta] = await db.select().from(internetAccounts)
    .where(and(
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.handle, handle),
      eq(internetAccounts.status, "ativa"),
    )).limit(1);
  if (!conta) return null;
  const perfil = await perfilDoPersonagem(cid, conta.characterId);
  if (!perfil) return null;
  const [personagem] = await db.select().from(characters)
    .where(and(
      eq(characters.id, conta.characterId),
      eq(characters.campaignId, cid),
      ne(characters.status, "arquivado"),
    ))
    .limit(1);
  if (!personagem) return null;
  return { perfil, conta, personagem };
}

/** Publicações do perfil (timeline pública): SOMENTE
 *  `visibilidade='campanha'` — `contatos` NUNCA aparece em
 *  timeline/busca/agregado (contrato §3, sem exceção de aresta;
 *  só leitura direta autorizada). status 'publicado', não expiradas
 *  (D11 derivado) e anônimas restritas ao titular (DP-1) — tudo no
 *  SQL ANTES do LIMIT: os 50 retornados são os últimos VISÍVEIS.
 *  Serialização mínima: nenhum id interno (V-08). */
async function timelineDoPerfil(
  cid: string, conta: typeof internetAccounts.$inferSelect,
  ehTitular: boolean,
) {
  const rows = await db.select({
    id: internetPublicacoes.id,
    tipo: internetPublicacoes.tipo,
    titulo: internetPublicacoes.titulo,
    corpo: internetPublicacoes.corpo,
    formato: internetPublicacoes.formato,
    status: internetPublicacoes.status,
    visibilidade: internetPublicacoes.visibilidade,
    autorModo: internetPublicacoes.autorModo,
    pseudoNome: internetPublicacoes.pseudoNome,
    publicadoEm: internetPublicacoes.publicadoEm,
    expiresAt: internetPublicacoes.expiresAt,
  }).from(internetPublicacoes)
    .where(and(
      eq(internetPublicacoes.campaignId, cid),
      eq(internetPublicacoes.autorContaId, conta.id),
      eq(internetPublicacoes.status, "publicado"),
      eq(internetPublicacoes.visibilidade, "campanha"),
      or(isNull(internetPublicacoes.expiresAt), gte(internetPublicacoes.expiresAt, new Date())),
      ...(ehTitular ? [] : [ne(internetPublicacoes.autorModo, "anonimo")]),
    ))
    .orderBy(desc(internetPublicacoes.publicadoEm), desc(internetPublicacoes.id))
    .limit(50);

  return rows.map((p) => ({
    id: p.id,
    tipo: p.tipo,
    titulo: p.titulo,
    corpo: p.corpo,
    formato: p.formato,
    publicadoEm: p.publicadoEm,
    ...(p.autorModo === "anonimo" ? { anonima: true } : {}),
    ...(p.autorModo === "pseudonimo" && p.pseudoNome ? { pseudoNome: p.pseudoNome } : {}),
  }));
}

/** GET /perfis/:handle — perfil público (W9/W10): 404 idêntico para
 *  inexistente/não-ativado/outra campanha (anti-enumeração). Expõe
 *  handle, nome público (default = nome do personagem), descrição,
 *  avatar e timeline — nunca ids internos. */
internetPerfisRouter.get("/perfis/:handle", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const handle = String(req.params.handle ?? "").slice(0, 80);
  const leitor = await resolverLeitor(req, res, cid);
  if (!leitor) return;

  const alvo = await perfilPorHandle(cid, handle);
  if (!alvo) { erroHttp(res, 404, "Perfil não encontrado"); return; }

  const ehTitular = await contaAutorizadaPara(alvo.conta.id, req.usuario!.id)
    .then((a) => !!a);
  const dados = await timelineDoPerfil(cid, alvo.conta, ehTitular);
  const falecido = morteVigente(
    (typeof alvo.personagem.data === "string"
      ? JSON.parse(alvo.personagem.data)
      : alvo.personagem.data) as Record<string, unknown>,
  ) !== null;

  res.json({
    perfil: {
      handle: alvo.conta.handle,
      nomePublico: alvo.perfil.nomePublico ?? alvo.personagem.name,
      descricao: alvo.perfil.descricao,
      avatar: alvo.perfil.avatarFileId ? { arquivoId: alvo.perfil.avatarFileId } : null,
      personagemFalecido: falecido,
      publicacoes: dados,
    },
  });
});

/** GET /perfis/:handle/avatar — entrega do avatar do perfil: só
 *  imagem aprovada da mesma campanha; classificação de conteúdo real
 *  na entrega (mesma disciplina de /arquivos/:fileId). */
internetPerfisRouter.get("/perfis/:handle/avatar", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const handle = String(req.params.handle ?? "").slice(0, 80);
  const leitor = await resolverLeitor(req, res, cid);
  if (!leitor) return;

  const alvo = await perfilPorHandle(cid, handle);
  if (!alvo?.perfil.avatarFileId) { erroHttp(res, 404, "Avatar não encontrado"); return; }
  const f = await arquivoAvatarValido(cid, alvo.perfil.avatarFileId);
  if (!f || !f.storageName) { erroHttp(res, 404, "Avatar indisponível"); return; }
  const caminho = caminhoFisico(cid, f.storageName);
  if (!caminho || !existsSync(caminho)) { erroHttp(res, 404, "Avatar indisponível"); return; }

  const classe = classificarConteudoArquivo(f.storageName, inicioDoArquivo(caminho));
  if (!classe.mime.startsWith("image/")) { erroHttp(res, 404, "Avatar indisponível"); return; }
  res.setHeader("Content-Type", classe.mime);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.displayName ?? f.fileName)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  createReadStream(caminho).pipe(res);
});

// ---------- W2 — pesquisa multi-escopo (D12/SEARCH-01..10) ----------

interface ItemBuscaInterno {
  escopo: "site" | "pagina" | "publicacao" | "perfil";
  /** Chave de ordenação/cursor — id interno (site/página/publicação)
   *  ou handle público (perfil). Uso exclusivo server-side: NUNCA
   *  serializada na resposta (V-08). */
  chave: string;
  titulo: string;
  trecho: string | null;
  /** Referência de navegação pública — slug do site, siteSlug/pageSlug,
   *  id público da publicação ou handle do perfil. */
  ref: string;
  ref2?: string;
  criadoEmMs: number;
}

const TRECHO_BUSCA = 240;
const LIMITE_BUSCA = 20;
const LIKE_MAX = 80;

function trechoDe(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length > TRECHO_BUSCA ? limpo.slice(0, TRECHO_BUSCA) + "…" : limpo || null;
}

/** GET /busca?q=&cursor=&limit= — D12: visibilidade aplicada ANTES de
 *  resultados/ordenação/paginação; conteúdo invisível não influencia
 *  contagens nem cursores. Escopos: sites (nome/slug/descrição),
 *  páginas (só publicadas de sites ativos), publicações (só
 *  `visibilidade='campanha'` — `contatos` nunca, expiradas fora no
 *  SQL), perfis (SÓ handle — displayName/nome público fora do
 *  índice, SEARCH-06). Paginação keyset (ts,chave) DESC unificada
 *  com L+1 por categoria — sem caps truncadores. V-08: a resposta
 *  serializa allowlist sem PK interna de site/página. */
internetPerfisRouter.get("/busca", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const leitor = await resolverLeitor(req, res, cid);
  if (!leitor) return;

  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, LIKE_MAX) : "";
  if (!q) { erroHttp(res, 400, "Consulta vazia"); return; }
  const limit = Math.min(Math.max(Number(req.query.limit) || LIMITE_BUSCA, 1), 50);
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const cursor = cursorRaw ? decodificarCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) { erroHttp(res, 400, "Cursor inválido"); return; }

  const padrao = `%${q}%`;

  // Paginação keyset POR CATEGORIA (ordem do Dono 7234231687): cada
  // fonte aplica no SQL todos os predicados de visibilidade/status/
  // expiração + o cursor global, ordena (ts DESC, chave DESC) e traz
  // no máximo L+1. Como nenhum item na posição >L+1 de uma fonte pode
  // entrar no top L+1 global, L+1 por fonte basta — sem cap truncador
  // (os antigos LIMIT 50/50/100/20 ocultavam resultados válidos).
  const cTs = cursor?.createdAt.getTime();
  const cKey = cursor?.messageId ?? "";
  const aposCursor = (ts: SQLWrapper, chave: SQLWrapper) => (
    cTs === undefined ? undefined
      : sql`((${ts} < ${cTs}) OR ((${ts} = ${cTs}) AND (${chave} < ${cKey})))`
  );
  const lotes = limit + 1;

  // ---- sites: ativos da campanha, nome/slug/descrição ----
  const sitesRows = await db.select({
    id: internetSites.id, slug: internetSites.slug, nome: internetSites.nome,
    descricao: internetSites.descricao, createdAt: internetSites.createdAt,
  }).from(internetSites)
    .where(and(
      eq(internetSites.campaignId, cid),
      eq(internetSites.status, "ativo"),
      or(like(internetSites.nome, padrao), like(internetSites.slug, padrao), like(internetSites.descricao, padrao)),
      aposCursor(internetSites.createdAt, internetSites.id),
    ))
    .orderBy(desc(internetSites.createdAt), desc(internetSites.id))
    .limit(lotes);

  // ---- páginas: só publicadas de sites ativos ----
  const paginasRows = await db.select({
    id: internetPages.id, slug: internetPages.slug, titulo: internetPages.titulo,
    corpo: internetPages.corpo, siteSlug: internetSites.slug,
    createdAt: internetPages.createdAt,
  }).from(internetPages)
    .innerJoin(internetSites, and(
      eq(internetSites.id, internetPages.siteId),
      eq(internetSites.status, "ativo"),
    ))
    .where(and(
      eq(internetPages.campaignId, cid),
      eq(internetPages.status, "publicado"),
      or(like(internetPages.titulo, padrao), like(internetPages.corpo, padrao), like(internetPages.slug, padrao)),
      aposCursor(internetPages.createdAt, internetPages.id),
    ))
    .orderBy(desc(internetPages.createdAt), desc(internetPages.id))
    .limit(lotes);

  // ---- publicações: contrato §3 — `contatos` NUNCA em busca (sem
  // exceção de aresta), só publicadas, não expiradas (D11 derivado
  // no SQL, antes do corte). Timestamp de ordenação =
  // coalesce(publicadoEm, createdAt).
  const tsPub = sql`coalesce(${internetPublicacoes.publicadoEm}, ${internetPublicacoes.createdAt})`;
  const pubsRows = await db.select({
    id: internetPublicacoes.id, tipo: internetPublicacoes.tipo,
    titulo: internetPublicacoes.titulo, corpo: internetPublicacoes.corpo,
    publicadoEm: internetPublicacoes.publicadoEm,
    createdAt: internetPublicacoes.createdAt,
  }).from(internetPublicacoes)
    .where(and(
      eq(internetPublicacoes.campaignId, cid),
      eq(internetPublicacoes.status, "publicado"),
      eq(internetPublicacoes.visibilidade, "campanha"),
      or(isNull(internetPublicacoes.expiresAt), gte(internetPublicacoes.expiresAt, new Date())),
      or(like(internetPublicacoes.titulo, padrao), like(internetPublicacoes.corpo, padrao)),
      aposCursor(tsPub, internetPublicacoes.id),
    ))
    .orderBy(sql`${tsPub} DESC`, desc(internetPublicacoes.id))
    .limit(lotes);

  // ---- perfis: SÓ handle indexa (SEARCH-06) ----
  const perfisRows = await db.select({
    handle: internetAccounts.handle,
    nomePublico: internetPerfis.nomePublico,
    nomePersonagem: characters.name,
    ativadoEm: internetPerfis.ativadoEm,
  }).from(internetPerfis)
    .innerJoin(internetAccounts, and(
      eq(internetAccounts.characterId, internetPerfis.characterId),
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.status, "ativa"),
    ))
    .innerJoin(characters, and(
      eq(characters.id, internetPerfis.characterId),
      eq(characters.campaignId, cid),
      ne(characters.status, "arquivado"),
    ))
    .where(and(
      eq(internetPerfis.campaignId, cid),
      like(internetAccounts.handle, padrao),
      aposCursor(internetPerfis.ativadoEm, internetAccounts.handle),
    ))
    .orderBy(desc(internetPerfis.ativadoEm), desc(internetAccounts.handle))
    .limit(lotes);

  // ---- merge + ordenação estável + paginação keyset ----
  // Ordenação global = mesmo comparador das fontes (ts DESC, chave
  // DESC). `chave`/`criadoEmMs` são internos: a resposta usa
  // allowlist — site/página nunca expõem PK (V-08); publicação
  // mantém o id PÚBLICO em `ref`; perfil usa handle.
  const itens: ItemBuscaInterno[] = [
    ...sitesRows.map((s) => ({
      escopo: "site" as const, chave: s.id, titulo: s.nome,
      trecho: trechoDe(s.descricao), ref: s.slug,
      criadoEmMs: s.createdAt.getTime(),
    })),
    ...paginasRows.map((p) => ({
      escopo: "pagina" as const, chave: p.id, titulo: p.titulo,
      trecho: trechoDe(p.corpo), ref: p.siteSlug, ref2: p.slug,
      criadoEmMs: p.createdAt.getTime(),
    })),
    ...pubsRows.map((p) => ({
      escopo: "publicacao" as const, chave: p.id,
      titulo: `[${p.tipo}] ${p.titulo}`, trecho: trechoDe(p.corpo), ref: p.id,
      criadoEmMs: (p.publicadoEm ?? p.createdAt).getTime(),
    })),
    ...perfisRows.map((p) => ({
      escopo: "perfil" as const, chave: p.handle, titulo: `@${p.handle}`,
      trecho: p.nomePublico ?? p.nomePersonagem, ref: p.handle,
      criadoEmMs: p.ativadoEm.getTime(),
    })),
  ].sort((a, b) => b.criadoEmMs - a.criadoEmMs || (a.chave < b.chave ? 1 : -1));

  const pagina = itens.slice(0, limit);
  const ultimo = pagina[pagina.length - 1];
  const proximoCursor = itens.length > limit && ultimo
    ? codificarCursor(new Date(ultimo.criadoEmMs), ultimo.chave)
    : null;

  res.json({
    resultados: pagina.map(({ chave: _chave, criadoEmMs: _ms, ...item }) => item),
    nextCursor: proximoCursor,
  });
});
