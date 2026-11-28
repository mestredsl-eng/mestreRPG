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
import { and, desc, eq, like } from "drizzle-orm";
import { existsSync, createReadStream } from "node:fs";
import { getDb } from "../db/index.js";
import {
  characters, files, internetAccounts, internetPerfis,
  internetPublicacoes, memberships,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import {
  contaAutorizadaPara, contasDoUsuario, contatoAceitoEntre,
  mestreLeitorDaCampanha,
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

  const perfil = db.transaction((tx) => {
    if (!titularNaTx(tx, conta.id, req.usuario!.id, cid)) return null;
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
    return row;
  });
  if (!perfil) { erroHttp(res, 403, "Titularidade alterada durante a operação"); return; }

  await audit(req, "internet.perfil.ativado", { characterId }, { campaignId: cid });
  res.status(201).json({ perfil });
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

  const atualizado = db.transaction((tx) => {
    if (!titularNaTx(tx, titular.conta.id, req.usuario!.id, cid)) return null;
    const [row] = tx.update(internetPerfis).set({
      ...(nomePublico !== undefined ? { nomePublico } : {}),
      ...(descricao !== undefined ? { descricao } : {}),
      ...(avatarFileId !== undefined ? { avatarFileId } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(internetPerfis.id, perfil.id),
      eq(internetPerfis.campaignId, cid),
    )).returning().all();
    return row;
  });
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

  const atualizado = db.transaction((tx) => {
    if (!titularNaTx(tx, titular.conta.id, req.usuario!.id, cid)) return null;
    const [row] = tx.update(internetPerfis).set({
      avatarFileId: f.id, updatedAt: new Date(),
    }).where(and(
      eq(internetPerfis.id, perfil.id),
      eq(internetPerfis.campaignId, cid),
    )).returning().all();
    return row;
  });
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
    .where(and(eq(characters.id, conta.characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!personagem) return null;
  return { perfil, conta, personagem };
}

/** Publicações do perfil: status 'publicado', não expiradas (D11
 *  derivado na leitura), `contatos` só com aresta aceita vigente,
 *  anônimas só para o próprio titular (marcadas, jamais identificadas
 *  — DP-1/AD-08). Serialização mínima: nenhum id interno (V-08). */
async function timelineDoPerfil(
  cid: string, conta: typeof internetAccounts.$inferSelect,
  leitor: LeitorPublico, ehTitular: boolean,
) {
  const agora = Date.now();
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
    ))
    .orderBy(desc(internetPublicacoes.publicadoEm), desc(internetPublicacoes.id))
    .limit(50);

  const visiveis = rows.filter((p) => {
    if (p.expiresAt && p.expiresAt.getTime() < agora) return false; // expirado derivado
    if (p.autorModo === "anonimo" && !ehTitular) return false;     // DP-1: some p/ terceiros
    return true;
  });

  // `contatos`: a aresta é por par autor↔leitor — UMA aresta aceita
  // vigente entre a conta do autor e qualquer conta do leitor libera
  // todas as publicações `contatos` do perfil (mesma regra do feed).
  // Mestre sem conta própria não tem aresta → não vê `contatos`.
  const temContatos = visiveis.some((p) => p.visibilidade === "contatos");
  let podeVerContatos = false;
  if (temContatos) {
    for (const lc of leitor.contas) {
      if (await contatoAceitoEntre(db, cid, conta.id, lc.id)) { podeVerContatos = true; break; }
    }
  }

  return visiveis
    .filter((p) => p.visibilidade !== "contatos" || podeVerContatos)
    .map((p) => ({
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
  const dados = await timelineDoPerfil(cid, alvo.conta, leitor, ehTitular);
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

/** GET /busca?q= — D12: perfil localizado por HANDLE somente;
 *  displayName/nome público NÃO indexam (SEARCH-06). Escopo perfis
 *  nesta fatia; demais escopos chegam na fatia W2. */
internetPerfisRouter.get("/busca", requirePapel("mestre", "jogador"), limitePerfis, async (req, res) => {
  const cid = campanhaId(req);
  const leitor = await resolverLeitor(req, res, cid);
  if (!leitor) return;

  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  if (!q) { erroHttp(res, 400, "Consulta vazia"); return; }

  const rows = await db.select({
    handle: internetAccounts.handle,
    nomePublico: internetPerfis.nomePublico,
    nomePersonagem: characters.name,
  }).from(internetPerfis)
    .innerJoin(internetAccounts, and(
      eq(internetAccounts.characterId, internetPerfis.characterId),
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.status, "ativa"),
    ))
    .innerJoin(characters, and(
      eq(characters.id, internetPerfis.characterId),
      eq(characters.campaignId, cid),
    ))
    .where(and(
      eq(internetPerfis.campaignId, cid),
      like(internetAccounts.handle, `%${q}%`),
    ))
    .orderBy(internetAccounts.handle)
    .limit(20);

  res.json({
    consulta: q,
    perfis: rows.map((r) => ({
      handle: r.handle,
      nomePublico: r.nomePublico ?? r.nomePersonagem,
    })),
  });
});
