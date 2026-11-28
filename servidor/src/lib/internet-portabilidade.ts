// D6 (#365): export/import do domínio público da Internet — pacote
// separado do backup interno (P9) e do snapshot de campanha.
//
// Regras (contrato D6 + matriz A1..A20 do INTERMEDIÁRIO):
//  - Export: sites, páginas, publicações e denúncias. NUNCA contas,
//    handles, userIds, memberships, contatos, conversas, participantes
//    ou mensagens. Toda referência de autoria é OPACA e nova por
//    pacote (anonRef/personagemRef/donoRef/autorRef/denuncianteRef =
//    UUID aleatório por entidade real × pacote, mapa em memória —
//    sem derivação de IDs internos, sem correlação entre exports).
//  - Publicação anônima (DP-1/A4): export zera autorContaId,
//    personagemId, fonteRef e qualquer ref de personagem — só
//    anonRef + conteúdo.
//  - Import: schema estrito fail-closed (sem campos desconhecidos,
//    enums fechados, limites de tamanho/contagem). Toda linha
//    importada nasce com *_conta_id NULL, personagem_id NULL,
//    origem='importado' → read-only para todos, inclusive mestre
//    (gate A12 nas rotas de escrita). origem='sistema' do pacote é
//    rebaixada para 'importado' — o import nunca fabrica sistema.
//  - Idempotência: IDs de linha preservados; reimport na mesma
//    campanha deduplica por ID existente (o conteúdo local vence).
//  - Denúncias: denunciante_ref opaca por pacote, resolvido_por
//    nunca viaja; contadores denuncia_aberta/denuncia_grave são
//    SEMPRE rederivados das linhas importadas (A16).
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import {
  internetDenuncias, internetPages, internetPublicacoes, internetSites,
} from "../db/schema.js";

const db = getDb();

const FORMATO = "internet-publica";
const VERSAO = 1;

// ---------- limites do pacote (A19) ----------
const MAX_COLECAO = 5000;
const MAX_CAMPO = 200_000;
const MAX_PACOTE_CHARS = 40 * 1024 * 1024;

const idSchema = z.string().uuid();
const texto = (max = 4000) => z.string().max(max);
const instante = z.string().datetime({ offset: true }).nullable().optional();

const sitePacoteSchema = z.object({
  id: idSchema,
  slug: texto(120),
  nome: texto(200),
  descricao: texto().nullable().optional(),
  status: z.enum(["ativo", "arquivado"]),
  donoRef: idSchema.nullable().optional(),
  criadoEm: instante,
  atualizadoEm: instante,
}).strict();

const paginaPacoteSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  slug: texto(120),
  titulo: texto(300),
  corpo: texto(MAX_CAMPO),
  formato: z.enum(["texto", "markdown-subset"]),
  status: z.enum(["rascunho", "publicado", "retirado", "arquivado"]),
  version: z.number().int().min(1),
  autorRef: idSchema.nullable().optional(),
  publicadoEm: instante,
  criadoEm: instante,
  atualizadoEm: instante,
}).strict();

const publicacaoPacoteSchema = z.object({
  id: idSchema,
  tipo: z.enum(["noticia", "post_perfil", "anuncio", "classificado"]),
  titulo: texto(300),
  corpo: texto(MAX_CAMPO),
  formato: z.enum(["texto", "markdown-subset"]),
  status: z.enum(["rascunho", "publicado", "retirado", "removido"]),
  visibilidade: z.enum(["campanha", "contatos"]),
  autorModo: z.enum(["identificado", "pseudonimo", "anonimo"]),
  pseudoNome: texto(120).nullable().optional(),
  autorRef: idSchema.nullable().optional(),
  personagemRef: idSchema.nullable().optional(),
  anonRef: idSchema.nullable().optional(),
  origem: z.enum(["usuario", "sistema", "importado"]),
  publicadoEm: instante,
  expiresAt: instante,
  retiradoEm: instante,
  retiradoMotivo: texto(200).nullable().optional(),
  version: z.number().int().min(1),
  criadoEm: instante,
  atualizadoEm: instante,
}).strict();

const denunciaPacoteSchema = z.object({
  id: idSchema,
  publicacaoId: idSchema,
  denuncianteRef: idSchema,
  motivo: texto(500),
  denunciaGrave: z.union([z.literal(0), z.literal(1)]),
  status: z.enum(["aberta", "contestada", "em_analise", "auto_removida", "resolvida_admin", "encerrada"]),
  resolucao: texto(500).nullable().optional(),
  prazoContestacaoEm: instante,
  criadoEm: instante,
  atualizadoEm: instante,
}).strict();

const estadoSchema = z.object({
  sites: z.array(sitePacoteSchema).max(MAX_COLECAO),
  paginas: z.array(paginaPacoteSchema).max(MAX_COLECAO),
  publicacoes: z.array(publicacaoPacoteSchema).max(MAX_COLECAO),
  denuncias: z.array(denunciaPacoteSchema).max(MAX_COLECAO),
}).strict();

const pacoteSchema = z.object({
  formato: z.literal(FORMATO),
  versao: z.literal(VERSAO),
  exportadoEm: z.string().datetime({ offset: true }).optional(),
  campanha: z.object({ nome: texto(200) }).strict().optional(),
  estado: estadoSchema,
}).strict();

export type PacoteInternetPublica = z.infer<typeof pacoteSchema>;

// ---------- EXPORT ----------

/** Mapa entidade real → ref opaca nova por pacote. Chave = contaId/
 *  characterId/etc; valor = UUID aleatório. Nunca serializado. */
function mapaRefs() {
  const m = new Map<string, string>();
  return (chave: string | null | undefined): string | null => {
    if (!chave) return null;
    let r = m.get(chave);
    if (!r) { r = crypto.randomUUID(); m.set(chave, r); }
    return r;
  };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function exportarDominioPublico(campaignId: string, nomeCampanha = ""): Promise<PacoteInternetPublica> {
  const [sites, paginas, pubs, denuncias] = await Promise.all([
    db.select().from(internetSites).where(eq(internetSites.campaignId, campaignId)),
    // P2 (INTERMEDIÁRIO 7232738783): rascunho é trabalho não
    // publicado de jogador — pacote PÚBLICO não o transporta
    // (backup full-fidelity é o EstadoCampanha, não este pacote).
    db.select().from(internetPages).where(and(eq(internetPages.campaignId, campaignId), ne(internetPages.status, "rascunho"))),
    db.select().from(internetPublicacoes).where(and(eq(internetPublicacoes.campaignId, campaignId), ne(internetPublicacoes.status, "rascunho"))),
    db.select().from(internetDenuncias).where(eq(internetDenuncias.campaignId, campaignId)),
  ]);

  const refDono = mapaRefs();
  const refAutor = mapaRefs();
  const refPersonagem = mapaRefs();
  const refAnon = mapaRefs();
  const refDenunciante = mapaRefs();

  return {
    formato: FORMATO,
    versao: VERSAO,
    exportadoEm: new Date().toISOString(),
    campanha: { nome: nomeCampanha.slice(0, 200) },
    estado: {
      sites: sites.map((s) => ({
        id: s.id, slug: s.slug, nome: s.nome, descricao: s.descricao,
        status: s.status as "ativo" | "arquivado",
        donoRef: refDono(s.ownerContaId),
        criadoEm: iso(s.createdAt), atualizadoEm: iso(s.updatedAt),
      })),
      paginas: paginas.map((p) => ({
        id: p.id, siteId: p.siteId, slug: p.slug, titulo: p.titulo,
        corpo: p.corpo, formato: p.formato as "texto" | "markdown-subset",
        status: p.status as "rascunho" | "publicado" | "retirado" | "arquivado",
        version: p.version,
        autorRef: refAutor(p.autorContaId),
        publicadoEm: iso(p.publishedAt),
        criadoEm: iso(p.createdAt), atualizadoEm: iso(p.updatedAt),
      })),
      publicacoes: pubs.map((p) => {
        const anonimo = p.autorModo === "anonimo";
        // A4/DP-1: anônimo exporta SÓ anonRef + conteúdo — zera conta,
        // personagem, fonteRef e qualquer ref que o desanonimize.
        // Agrupamento: anonRef deriva da conta real (mesmo anônimo
        // compartilha ref dentro do pacote) ou do autorAnonRef
        // persistido de import anterior.
        const anonKey = p.autorContaId ?? p.autorAnonRef ?? `sem:${p.id}`;
        return {
          id: p.id, tipo: p.tipo as "noticia" | "post_perfil" | "anuncio" | "classificado",
          titulo: p.titulo, corpo: p.corpo,
          formato: p.formato as "texto" | "markdown-subset",
          status: p.status as "rascunho" | "publicado" | "retirado" | "removido",
          visibilidade: p.visibilidade as "campanha" | "contatos",
          autorModo: p.autorModo as "identificado" | "pseudonimo" | "anonimo",
          pseudoNome: p.autorModo === "pseudonimo" ? p.pseudoNome : null,
          autorRef: anonimo ? null : refAutor(p.autorContaId),
          personagemRef: anonimo ? null : refPersonagem(p.personagemId),
          anonRef: anonimo ? refAnon(anonKey) : null,
          origem: p.origem as "usuario" | "sistema" | "importado",
          publicadoEm: iso(p.publicadoEm), expiresAt: iso(p.expiresAt),
          retiradoEm: iso(p.retiradoEm), retiradoMotivo: p.retiradoMotivo,
          version: p.version,
          criadoEm: iso(p.createdAt), atualizadoEm: iso(p.updatedAt),
        };
      }),
      denuncias: denuncias.map((n) => ({
        id: n.id, publicacaoId: n.publicacaoId,
        // ref por (denunciante real × pacote); denunciante sem conta
        // local (importado) agrupa pela ref persistida
        denuncianteRef: refDenunciante(n.denuncianteContaId ?? n.denuncianteRef) ?? n.denuncianteRef,
        motivo: n.motivo, denunciaGrave: n.denunciaGrave as 0 | 1,
        status: n.status as "aberta" | "contestada" | "em_analise" | "auto_removida" | "resolvida_admin" | "encerrada",
        resolucao: n.resolucao,
        prazoContestacaoEm: iso(n.prazoContestacaoEm),
        criadoEm: iso(n.createdAt), atualizadoEm: iso(n.updatedAt),
      })),
    },
  };
}

// ---------- IMPORT ----------

export interface ResultadoImportacao {
  ok: boolean;
  erro?: string;
  importadas?: { sites: number; paginas: number; publicacoes: number; denuncias: number };
  jaExistentes?: number;
  rejeitadas?: { tipo: string; id: string; motivo: string }[];
}

const parseData = (isoStr: string | null | undefined): Date | null =>
  isoStr ? new Date(isoStr) : null;

/** Importa o pacote D6 na campanha alvo. Tudo dentro de UMA transação:
 *  qualquer erro estrutural aborta integralmente. Refs internas são
 *  resolvidas dentro do pacote ou do estado local da campanha —
 *  linha órfã é rejeitada com relatório, nunca gera FK para fora. */
export async function importarDominioPublico(
  campaignId: string, pacoteBruto: unknown,
): Promise<ResultadoImportacao> {
  if (typeof pacoteBruto === "string" && pacoteBruto.length > MAX_PACOTE_CHARS) {
    return { ok: false, erro: "pacote_grande_demais" };
  }
  const brutoStr = JSON.stringify(pacoteBruto ?? {});
  if (brutoStr.length > MAX_PACOTE_CHARS) return { ok: false, erro: "pacote_grande_demais" };

  const parsed = pacoteSchema.safeParse(pacoteBruto);
  if (!parsed.success) {
    return { ok: false, erro: "pacote_invalido", rejeitadas: [{ tipo: "pacote", id: "-", motivo: "schema" }] };
  }
  const pacote = parsed.data;
  const est = pacote.estado;

  // ids duplicados DENTRO do pacote → fail-closed (A19)
  const checaDuplicados = (itens: { id: string }[], nome: string) => {
    const vistos = new Set<string>();
    for (const i of itens) {
      if (vistos.has(i.id)) return `${nome}: id duplicado ${i.id}`;
      vistos.add(i.id);
    }
    return null;
  };
  for (const [nome, itens] of [
    ["sites", est.sites], ["paginas", est.paginas],
    ["publicacoes", est.publicacoes], ["denuncias", est.denuncias],
  ] as const) {
    const dup = checaDuplicados(itens, nome);
    if (dup) return { ok: false, erro: "pacote_invalido", rejeitadas: [{ tipo: nome, id: "-", motivo: dup }] };
  }

  const rel: ResultadoImportacao = {
    ok: true,
    importadas: { sites: 0, paginas: 0, publicacoes: 0, denuncias: 0 },
    jaExistentes: 0,
    rejeitadas: [],
  };

  const agora = new Date();

  db.transaction((tx) => {
    // IDs de linha são PKs GLOBAIS — importar o mesmo pacote em
    // outra campanha exige remap: pacoteId → id local. Linha com id
    // existente NA campanha alvo = dedupe (conteúdo local vence);
    // id existente em OUTRA campanha = remap para UUID novo; ids
    // das dependências (siteId/publicacaoId) traduzem pelo mapa.
    const siteMap = new Map<string, string>();
    const pubMap = new Map<string, string>();

    // 1) sites — slug UNIQUE(campaignId,slug): colisão com id
    //    divergente rejeita a linha (A7).
    for (const s of est.sites) {
      const [global] = tx.select({ id: internetSites.id, campaignId: internetSites.campaignId, ownerContaId: internetSites.ownerContaId })
        .from(internetSites).where(eq(internetSites.id, s.id)).limit(1).all();
      if (global?.campaignId === campaignId) {
        rel.jaExistentes!++;
        // P1 residual (INTERMEDIÁRIO 7232925593 / PoC Gerente
        // 7232846030): dedupe por id NÃO prova linhagem — o pacote
        // pode reivindicar o UUID de um site local de jogador e
        // pendurar páginas publicadas sem autor. siteMap só resolve
        // âncora para site SEM dono local (importado ou domínio
        // admin do mestre — residual aceito/documentado).
        if (global.ownerContaId == null) siteMap.set(s.id, s.id);
        continue;
      }
      const localId = global ? crypto.randomUUID() : s.id;
      const [slugOcupado] = tx.select({ id: internetSites.id }).from(internetSites)
        .where(and(eq(internetSites.campaignId, campaignId), eq(internetSites.slug, s.slug))).limit(1).all();
      if (slugOcupado) {
        rel.rejeitadas!.push({ tipo: "site", id: s.id, motivo: "slug_conflitante" });
        continue;
      }
      tx.insert(internetSites).values({
        id: localId, campaignId, slug: s.slug, nome: s.nome,
        descricao: s.descricao ?? null,
        ownerContaId: null, // D6: nunca vincula conta local
        status: s.status,
        createdAt: parseData(s.criadoEm) ?? agora,
        updatedAt: parseData(s.atualizadoEm) ?? agora,
      }).run();
      rel.importadas!.sites++;
      siteMap.set(s.id, localId);
    }

    // 2) páginas — siteId resolve via siteMap (pacote) ou direto
    //    (site pré-existente na campanha). Página sem site → rejeita.
    for (const p of est.paginas) {
      const [global] = tx.select({ id: internetPages.id, campaignId: internetPages.campaignId })
        .from(internetPages).where(eq(internetPages.id, p.id)).limit(1).all();
      if (global?.campaignId === campaignId) { rel.jaExistentes!++; continue; }
      const localId = global ? crypto.randomUUID() : p.id;
      // P1 (INTERMEDIÁRIO 7232671701): siteId resolve SOMENTE pelo
      // mapa do que esta tx inseriu/dedupou — um UUID de site local
      // pré-existente fora do pacote NÃO é âncora válida (página
      // importada não pode pendurar em site que não veio junto).
      const siteIdLocal = siteMap.get(p.siteId);
      if (!siteIdLocal) {
        rel.rejeitadas!.push({ tipo: "pagina", id: p.id, motivo: "site_orfao" });
        continue;
      }
      const [slugOcupado] = tx.select({ id: internetPages.id }).from(internetPages)
        .where(and(eq(internetPages.siteId, siteIdLocal), eq(internetPages.slug, p.slug))).limit(1).all();
      if (slugOcupado) {
        rel.rejeitadas!.push({ tipo: "pagina", id: p.id, motivo: "slug_conflitante" });
        continue;
      }
      tx.insert(internetPages).values({
        id: localId, siteId: siteIdLocal, campaignId, slug: p.slug,
        titulo: p.titulo, corpo: p.corpo, formato: p.formato,
        status: p.status, version: p.version,
        autorContaId: null,
        publishedAt: parseData(p.publicadoEm),
        createdAt: parseData(p.criadoEm) ?? agora,
        updatedAt: parseData(p.atualizadoEm) ?? agora,
      }).run();
      rel.importadas!.paginas++;
    }

    // 3) publicações — origem SEMPRE 'importado' (A13/A18); conta,
    //    personagem e fonteRef nunca vêm do pacote.
    for (const p of est.publicacoes) {
      const [global] = tx.select({ id: internetPublicacoes.id, campaignId: internetPublicacoes.campaignId, origem: internetPublicacoes.origem })
        .from(internetPublicacoes).where(eq(internetPublicacoes.id, p.id)).limit(1).all();
      if (global?.campaignId === campaignId) {
        rel.jaExistentes!++;
        // P1 residual: pubMap só ancora denúncia em publicação com
        // linhagem de pacote (origem='importado') — pub local
        // ('usuario'/'sistema') não é alvo de denúncia forjada.
        if (global.origem === "importado") pubMap.set(p.id, p.id);
        continue;
      }
      // P2-4 (INTERMEDIÁRIO 7232738783): 'contatos' exige aresta com
      // o autor — importado nasce autorContaId NULL → zumbi
      // permanente (invisível e, pelo fail-closed da denúncia,
      // inmodificável). Rejeita com relatório em vez de fabricar
      // conteúdo morto; mapear p/ 'campanha' exporia o restrito.
      if (p.visibilidade === "contatos") {
        rel.rejeitadas!.push({ tipo: "publicacao", id: p.id, motivo: "visibilidade_insatisfativel" });
        continue;
      }
      const localId = global ? crypto.randomUUID() : p.id;
      tx.insert(internetPublicacoes).values({
        id: localId, campaignId, tipo: p.tipo, titulo: p.titulo, corpo: p.corpo,
        formato: p.formato, status: p.status, visibilidade: p.visibilidade,
        autorModo: p.autorModo,
        pseudoNome: p.autorModo === "pseudonimo" ? (p.pseudoNome ?? null) : null,
        autorContaId: null,
        // anon importado guarda a ref do pacote p/ agrupar reexports
        autorAnonRef: p.autorModo === "anonimo" ? (p.anonRef ?? null) : null,
        origem: "importado",
        fonteRef: null, personagemId: null,
        publicadoEm: parseData(p.publicadoEm),
        expiresAt: parseData(p.expiresAt),
        retiradoEm: parseData(p.retiradoEm),
        retiradoMotivo: p.retiradoMotivo ?? null,
        // contadores rederivados das denúncias abaixo (A16)
        denunciaAberta: 0, denunciaGrave: 0,
        version: p.version,
        createdAt: parseData(p.criadoEm) ?? agora,
        updatedAt: parseData(p.atualizadoEm) ?? agora,
      }).run();
      rel.importadas!.publicacoes++;
      pubMap.set(p.id, localId);
    }

    // 4) denúncias — publicacaoId resolve via pubMap (pacote) ou
    //    direto (publicação pré-existente na campanha).
    const pubIdsAfetadas = new Set<string>();
    for (const n of est.denuncias) {
      const [global] = tx.select({ id: internetDenuncias.id, campaignId: internetDenuncias.campaignId })
        .from(internetDenuncias).where(eq(internetDenuncias.id, n.id)).limit(1).all();
      if (global?.campaignId === campaignId) { rel.jaExistentes!++; continue; }
      const localId = global ? crypto.randomUUID() : n.id;
      // P1 (INTERMEDIÁRIO 7232671701): publicacaoId resolve SOMENTE
      // pelo mapa — denúncia forjada contra publicação local
      // pré-existente (resolvida_admin, contadores) é rejeitada.
      const pubIdLocal = pubMap.get(n.publicacaoId);
      if (!pubIdLocal) {
        rel.rejeitadas!.push({ tipo: "denuncia", id: n.id, motivo: "publicacao_orfa" });
        continue;
      }
      try {
        tx.insert(internetDenuncias).values({
          id: localId, campaignId, publicacaoId: pubIdLocal,
          denuncianteContaId: null,
          // P2-2: prefixo 'pkg:' — pacote pode trazer o UUID de uma
          // conta local como denuncianteRef e a UNIQUE bloquearia a
          // denúncia legítima da vítima. Refs importadas nunca
          // colidem com conta.id (refs locais são UUIDs crus).
          denuncianteRef: `pkg:${n.denuncianteRef}`,
          motivo: n.motivo, denunciaGrave: n.denunciaGrave,
          status: n.status, resolucao: n.resolucao ?? null,
          resolvidoPor: null,
          prazoContestacaoEm: parseData(n.prazoContestacaoEm),
          createdAt: parseData(n.criadoEm) ?? agora,
          updatedAt: parseData(n.atualizadoEm) ?? agora,
        }).run();
        rel.importadas!.denuncias++;
        pubIdsAfetadas.add(pubIdLocal);
      } catch (e) {
        // UNIQUE(publicacao_id, denunciante_ref) — duplicata lógica.
        // P2-3: só isso é rejeição; qualquer outro erro propaga e
        // derruba a tx (fail-closed, nada de relatório falso).
        if (String(e).includes("UNIQUE")) {
          rel.rejeitadas!.push({ tipo: "denuncia", id: n.id, motivo: "denuncia_duplicada" });
        } else throw e;
      }
    }

    // 5) contadores server-derived (A16): abertas = denúncias com
    //    status='aberta' (mesma semântica do POST /denunciar —
    //    terminais não podem disparar o limiar de remoção); graves =
    //    as graves DENTRO das abertas. INTERMEDIÁRIO O1 #399.
    //    Só toca em publicações do pacote (ids locais).
    const pubsAfetadas = new Set([...pubMap.values(), ...pubIdsAfetadas]);
    if (pubsAfetadas.size) {
      const todas = tx.select({
        publicacaoId: internetDenuncias.publicacaoId,
        n: sql<number>`count(*)`,
        graves: sql<number>`sum(${internetDenuncias.denunciaGrave})`,
      }).from(internetDenuncias)
        .where(and(
          eq(internetDenuncias.campaignId, campaignId),
          eq(internetDenuncias.status, "aberta"),
        ))
        .groupBy(internetDenuncias.publicacaoId).all();
      const porPub = new Map(todas.map((r) => [r.publicacaoId, r]));
      for (const pid of pubsAfetadas) {
        const c = porPub.get(pid);
        tx.update(internetPublicacoes).set({
          denunciaAberta: c?.n ?? 0,
          denunciaGrave: c?.graves ?? 0,
          updatedAt: agora,
        }).where(and(eq(internetPublicacoes.id, pid), eq(internetPublicacoes.campaignId, campaignId))).run();
      }
    }
  });

  return rel;
}
