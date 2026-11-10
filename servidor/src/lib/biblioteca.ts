import { z } from "zod";

/**
 * Acervo global de livros de regras — envelope oficial de
 * importação/exportação (formato "mestre-rpg-biblioteca", versão 1).
 *
 * Um livro exportado contém metadados + itens; a importação faz MERGE
 * por `kind:key` — itens ausentes no arquivo são sempre preservados e
 * conflitos exigem decisão explícita do usuário.
 */

export const FORMATO_ACERVO = "mestre-rpg-biblioteca";
export const VERSAO_FORMATO = 1;

const RE_REGEX_CHAVE = /^[a-z0-9_]+$/;
const TAM_MAX_DEFINITION = 64 * 1024; // 64 KB por definição
const MAX_LIVROS = 50;
const MAX_ITENS_LIVRO = 5000;

// ---------- Schemas ----------

export const metadadosLivroSchema = z.object({
  titulo: z.string().trim().min(1).max(200),
  descricao: z.string().max(4000).nullish(),
  autor: z.string().max(200).nullish(),
  sistema: z.string().max(120).nullish(),
  edicao: z.string().max(120).nullish(),
  tipo: z.enum(["livro", "suplemento"]).default("livro"),
  versao: z.number().int().min(0).max(1_000_000).optional(),
});

export const itemLivroSchema = z.object({
  kind: z.string().trim().min(1).max(60).regex(RE_REGEX_CHAVE, "kind: letras minúsculas, números e _"),
  key: z.string().trim().min(1).max(80).regex(RE_REGEX_CHAVE, "key: letras minúsculas, números e _"),
  name: z.string().trim().min(1).max(200),
  category: z.string().max(120).nullish(),
  parentKey: z.string().max(80).nullish(),
  definition: z.record(z.string(), z.unknown()).default({}),
  ordem: z.number().int().min(0).max(1_000_000).default(0),
});
export type ItemLivro = z.infer<typeof itemLivroSchema>;

export const livroExportadoSchema = metadadosLivroSchema.extend({
  id: z.string().max(80).optional(), // id do livro no acervo (round-trip)
  itens: z.array(itemLivroSchema).max(MAX_ITENS_LIVRO).default([]),
});
export type LivroExportado = z.infer<typeof livroExportadoSchema>;

export const envelopeImportacaoSchema = z.object({
  formato: z.literal(FORMATO_ACERVO),
  versao: z.literal(VERSAO_FORMATO),
  livros: z.array(livroExportadoSchema).min(1).max(MAX_LIVROS),
});
export type EnvelopeImportacao = z.infer<typeof envelopeImportacaoSchema>;

/** Decisão do usuário por livro/conflito na confirmação da importação. */
export const decisoesImportacaoSchema = z.object({
  decisoes: z.array(z.object({
    indice: z.number().int().min(0), // índice do livro dentro do envelope
    metadados: z.enum(["atualizar", "manter"]).default("manter"),
    itens: z.record(z.string(), z.enum(["atualizar", "manter"])).default({}),
  })).max(MAX_LIVROS),
});
export type DecisoesImportacao = z.infer<typeof decisoesImportacaoSchema>;

// ---------- Normalização / comparação ----------

const CAMPOS_META = ["titulo", "descricao", "autor", "sistema", "edicao", "tipo"] as const;

function norm(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

/** Comparação estável de definition (chaves ordenadas recursivamente). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export function mesmoItem(a: ItemLivro, b: { name: string; category: string | null; parentKey: string | null; definition: unknown; ordem: number }): boolean {
  return (
    a.name === b.name &&
    norm(a.category) === norm(b.category) &&
    norm(a.parentKey) === norm(b.parentKey) &&
    canonical(a.definition ?? {}) === canonical(b.definition ?? {}) &&
    (a.ordem ?? 0) === b.ordem
  );
}

export interface ItemDb {
  id: string;
  kind: string;
  key: string;
  name: string;
  category: string | null;
  parentKey: string | null;
  definition: unknown;
  ordem: number;
}

export interface LivroDb {
  id: string;
  titulo: string;
  descricao: string | null;
  autor: string | null;
  sistema: string | null;
  edicao: string | null;
  tipo: string;
  versao: number;
}

export interface ConflitoItem {
  kind: string;
  key: string;
  name: string;
  campos: string[]; // campos que divergem
}

export interface DiffLivro {
  bookId: string | null;       // null = livro novo
  titulo: string;
  acao: "novo" | "atualizar";
  metadadosAlterados: { campo: string; de: unknown; para: unknown }[];
  itensNovos: ItemLivro[];
  itensIdenticos: number;
  itensAlterados: ItemLivro[]; // conflitos — só aplicam com decisão "atualizar"
  conflitos: ConflitoItem[];
  itensAusentesPreservados: number;
  totalItensExistentes: number;
}

/** Diff de um livro do envelope contra o livro existente no banco (ou null). */
export function diffLivro(livro: LivroExportado, existente: LivroDb | null, itensDb: ItemDb[]): DiffLivro {
  const mapaDb = new Map(itensDb.map((i) => [`${i.kind}:${i.key}`, i]));
  const vistos = new Set<string>();

  const itensNovos: ItemLivro[] = [];
  const itensAlterados: ItemLivro[] = [];
  const conflitos: ConflitoItem[] = [];
  let identicos = 0;

  for (const item of livro.itens) {
    const ck = `${item.kind}:${item.key}`;
    vistos.add(ck);
    const db = mapaDb.get(ck);
    if (!db) { itensNovos.push(item); continue; }
    if (mesmoItem(item, db)) { identicos++; continue; }
    const campos: string[] = [];
    if (item.name !== db.name) campos.push("name");
    if (norm(item.category) !== norm(db.category)) campos.push("category");
    if (norm(item.parentKey) !== norm(db.parentKey)) campos.push("parentKey");
    if (canonical(item.definition ?? {}) !== canonical(db.definition ?? {})) campos.push("definition");
    if ((item.ordem ?? 0) !== db.ordem) campos.push("ordem");
    itensAlterados.push(item);
    conflitos.push({ kind: item.kind, key: item.key, name: item.name, campos });
  }

  const ausentes = itensDb.length - vistos.size;

  const metadadosAlterados: DiffLivro["metadadosAlterados"] = [];
  if (existente) {
    for (const campo of CAMPOS_META) {
      const novo = livro[campo];
      const velho = existente[campo as keyof LivroDb];
      // tipo sempre definido (default livro); demais comparam normalizado
      if (campo === "tipo" ? novo !== velho : norm(novo) !== norm(velho)) {
        metadadosAlterados.push({ campo, de: velho ?? null, para: novo ?? null });
      }
    }
  }

  return {
    bookId: existente?.id ?? null,
    titulo: livro.titulo,
    acao: existente ? "atualizar" : "novo",
    metadadosAlterados,
    itensNovos,
    itensIdenticos: identicos,
    itensAlterados,
    conflitos,
    itensAusentesPreservados: Math.max(0, ausentes),
    totalItensExistentes: itensDb.length,
  };
}

/** Chave estável de conflito para decisões: "kind:key". */
export const chaveConflito = (kind: string, key: string) => `${kind}:${key}`;

/** Serializa um livro do banco para o envelope oficial (export/backup). */
export function livroParaEnvelope(book: LivroDb & { formatoVersao?: number }, itens: ItemDb[]) {
  return {
    id: book.id,
    titulo: book.titulo,
    descricao: book.descricao ?? null,
    autor: book.autor ?? null,
    sistema: book.sistema ?? null,
    edicao: book.edicao ?? null,
    tipo: book.tipo,
    versao: book.versao,
    formatoVersao: book.formatoVersao ?? VERSAO_FORMATO,
    itens: [...itens]
      .sort((a, b) => a.ordem - b.ordem || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        key: i.key,
        name: i.name,
        category: i.category ?? null,
        parentKey: i.parentKey ?? null,
        definition: i.definition ?? {},
        ordem: i.ordem,
      })),
  };
}
