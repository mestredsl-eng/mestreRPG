import { z } from "zod";

/**
 * Núcleo do editor de fichas (spec §4–§8).
 *
 * A estrutura da ficha é JSON versionado em `sheet_versions.structure`.
 * Nada aqui é fixo: o mestre define seções, campos, tipos, visibilidade,
 * edição, fórmulas de campos calculados e configuração de pontos.
 */

// ---------- Tipos de campo (spec §4) ----------
export const TIPOS_CAMPO = [
  "texto",
  "texto_longo",
  "inteiro",
  "decimal",
  "moeda",
  "data",
  "checkbox",
  "selecao_unica",
  "selecao_multipla",
  "selecao_nivel", // elementos da biblioteca com nível (ex.: defeitos 1–5)
  "lista", // opções simples, um valor por linha
  "tabela", // registros com colunas próprias (repetível)
  "calculado",
  "referencia", // aponta para outro campo da ficha
] as const;
export type TipoCampo = (typeof TIPOS_CAMPO)[number];

// Classificação semântica opcional — usada por regras/testes futuros (spec §5)
export const TIPOS_SEMANTICOS = [
  "livre",
  "atributo",
  "habilidade",
  "conhecimento",
  "profissao",
  "especializacao",
  "poder",
  "vantagem",
  "defeito",
  "talento",
  "moeda",
  "item",
] as const;
export type TipoSemantico = (typeof TIPOS_SEMANTICOS)[number];

export const VISIBILIDADES = ["todos", "dono_mestre", "mestre", "selecionados"] as const;
export type Visibilidade = (typeof VISIBILIDADES)[number];

export const EDITAVEIS = ["jogador", "mestre", "ambos"] as const;
export type EditavelPor = (typeof EDITAVEIS)[number];

// ---------- Estruturas ----------

export const colunaTabelaSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  tipo: z.enum(["texto", "inteiro", "decimal", "moeda", "data", "selecao"]).default("texto"),
  opcoes: z.array(z.string().max(200)).max(200).optional(), // tipo "selecao"
});

export const campoSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  descricao: z.string().max(2000).optional(),
  tipo: z.enum(TIPOS_CAMPO),
  semantico: z.enum(TIPOS_SEMANTICOS).default("livre"),
  categoria: z.string().max(120).optional(), // ex.: Ciências, Tecnologia (spec §7.2)
  parentKey: z.string().max(80).optional(), // especialização → habilidade pai (spec §7.3)
  obrigatorio: z.boolean().default(false),
  padrao: z.unknown().optional(),
  minimo: z.number().optional(),
  maximo: z.number().optional(),
  maxCaracteres: z.number().int().positive().max(100000).optional(),
  opcoes: z.array(z.string().max(200)).max(500).optional(), // seleção única/múltipla/lista
  repetivel: z.boolean().default(false), // campo pode ter vários valores
  colunas: z.array(colunaTabelaSchema).max(30).optional(), // tipo "tabela"
  formula: z.string().max(2000).optional(), // tipo "calculado"
  referencia: z.string().max(80).optional(), // tipo "referencia" → id do campo alvo
  visibilidade: z.enum(VISIBILIDADES).default("todos"),
  destinatarios: z.array(z.string().max(80)).max(200).optional(), // p/ "selecionados"
  editavelPor: z.enum(EDITAVEIS).default("ambos"),
  // Opcional (não .default) para distinguir "não configurado" (fallback por
  // semântica) de "explicitamente desmarcado" (não elegível).
  usadoEmTestes: z.boolean().optional(),
  custoPontos: z.number().optional(), // custo por ponto adicional (spec §8.1)
  custoProgressivo: z.array(z.number()).max(100).optional(), // tabela de custo por nível deste campo (ex.: talentos)
  reservaPontos: z.string().max(80).optional(), // pool de pontos da campanha
  // Vínculo com a biblioteca de regras (Etapa 5): elemento específico ou tipo de elementos
  regra: z.object({ kind: z.string().max(40), key: z.string().max(80) }).optional(),
  regraKind: z.string().max(40).optional(), // p/ seleção/lista: opções vêm da biblioteca deste tipo
  // Carteira financeira (tabela com semantico "moeda"): saldo inicial separado
  // das movimentações; saldoEditavelPor controla quem altera o saldo inicial.
  carteira: z
    .object({ saldoEditavelPor: z.enum(EDITAVEIS).default("mestre") })
    .optional(),
});
export type CampoDef = z.infer<typeof campoSchema>;

export const secaoSchema = z.object({
  id: z.string().min(1).max(80),
  titulo: z.string().min(1).max(160),
  descricao: z.string().max(2000).optional(),
  parentId: z.string().max(80).optional(), // subseção
  ordem: z.number().int().default(0),
  campos: z.array(campoSchema).max(300).default([]),
});
export type SecaoDef = z.infer<typeof secaoSchema>;

// Configuração de pontos — estrutura livre validada levemente (spec §6)
export const pontosConfigSchema = z.object({
  habilitado: z.boolean().default(false),
  pontosIniciais: z.number().default(0),
  pools: z
    .array(
      z.object({
        id: z.string().max(80),
        nome: z.string().max(120),
        pontos: z.number(),
      })
    )
    .max(50)
    .default([]),
  // Tabelas de custo customizáveis, ex.: { "talento": [1,2,3,4,5] } (spec §8.2)
  custos: z.record(z.string().max(80), z.array(z.number()).max(100)).default({}),
});
export type PontosConfig = z.infer<typeof pontosConfigSchema>;

export const estruturaFichaSchema = z.object({
  versao: z.literal(1).default(1),
  secoes: z.array(secaoSchema).max(100).default([]),
  pontos: pontosConfigSchema.default({ habilitado: false, pontosIniciais: 0, pools: [], custos: {} }),
});
export type EstruturaFicha = z.infer<typeof estruturaFichaSchema>;

// ---------- Utilidades de estrutura ----------

export function todosCampos(estrutura: EstruturaFicha): CampoDef[] {
  return estrutura.secoes.flatMap((s) => s.campos);
}

/** Semânticos elegíveis por fallback quando `usadoEmTestes` não existe no
 *  campo (estruturas antigas salvas antes da flag ou importadas). */
export const SEMANTICOS_TESTAVEIS_FALLBACK = new Set<TipoSemantico>([
  "atributo",
  "habilidade",
  "conhecimento",
  "talento",
]);

/**
 * Elegibilidade de um campo para desafios/testes D10 (spec Etapa C).
 *
 * - `usadoEmTestes: true` → elegível (ainda exige tipo numérico e semântica
 *   não excluída — moeda/item nunca são stats de teste).
 * - `usadoEmTestes: false` → não elegível.
 * - ausente → fallback: numérico + semântica de atributo/habilidade/
 *   conhecimento/talento. Campos numéricos "livres" (idade, crônica,
 *   contadores) não entram só por serem números.
 */
export function campoElegivelParaTeste(campo: Pick<CampoDef, "tipo" | "semantico" | "usadoEmTestes">): boolean {
  if (campo.tipo !== "inteiro" && campo.tipo !== "decimal") return false;
  if (campo.semantico === "moeda" || campo.semantico === "item") return false;
  if (campo.usadoEmTestes === true) return true;
  if (campo.usadoEmTestes === false) return false;
  return SEMANTICOS_TESTAVEIS_FALLBACK.has(campo.semantico);
}

export function mapaCampos(estrutura: EstruturaFicha): Map<string, CampoDef> {
  return new Map(todosCampos(estrutura).map((c) => [c.id, c]));
}

/** Avalia visibilidade efetiva de um campo para um usuário. */
export function campoVisivelPara(
  campo: CampoDef,
  override: { visibilidade?: Visibilidade; destinatarios?: string[] } | undefined,
  ehMestre: boolean,
  ehDono: boolean,
  userId: string,
  membershipId?: string
): boolean {
  const vis = override?.visibilidade ?? campo.visibilidade;
  const dest = override?.destinatarios ?? campo.destinatarios ?? [];
  switch (vis) {
    case "mestre":
      return ehMestre;
    case "dono_mestre":
      return ehMestre || ehDono;
    case "selecionados":
      return ehMestre || dest.includes(userId) || (membershipId ? dest.includes(membershipId) : false);
    case "todos":
    default:
      return true;
  }
}

/** O usuário pode editar este campo nesta ficha? */
export function campoEditavelPor(
  campo: CampoDef,
  override: { editavelPor?: EditavelPor } | undefined,
  ehMestre: boolean,
  statusPersonagem: string
): boolean {
  if (ehMestre) return true; // mestre sempre pode editar (spec §7)
  if (statusPersonagem === "bloqueada") return false;
  const ed = override?.editavelPor ?? campo.editavelPor;
  return ed === "jogador" || ed === "ambos";
}

// ---------- Avaliador de fórmulas (campos calculados) ----------
// Suporta: literais numéricos, {ref} para campos, + - * /, parênteses,
// e funções sum(), count(), avg(), min(), max(), len() sobre campos
// repetíveis ou numéricos. Nada de eval() — parser próprio e seguro.

type Token = { t: "num"; v: number } | { t: "ref"; v: string } | { t: "id"; v: string } | { t: "op"; v: string } | { t: "lp" } | { t: "rp" } | { t: "virg" };

function tokenizar(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      tokens.push({ t: "num", v: Number(expr.slice(i, j)) });
      i = j; continue;
    }
    if (ch === "{") {
      const fim = expr.indexOf("}", i);
      if (fim === -1) throw new Error("Referência não fechada");
      tokens.push({ t: "ref", v: expr.slice(i + 1, fim).trim() });
      i = fim + 1; continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      tokens.push({ t: "id", v: expr.slice(i, j) });
      i = j; continue;
    }
    if ("+-*/".includes(ch)) { tokens.push({ t: "op", v: ch }); i++; continue; }
    if (ch === "(") { tokens.push({ t: "lp" }); i++; continue; }
    if (ch === ")") { tokens.push({ t: "rp" }); i++; continue; }
    if (ch === ",") { tokens.push({ t: "virg" }); i++; continue; }
    throw new Error(`Caractere inesperado: ${ch}`);
  }
  return tokens;
}

/**
 * Avalia a fórmula de um campo calculado.
 * `dados` = valores da ficha (campo calculado não precisa estar presente).
 */
export function avaliarFormula(
  formula: string,
  dados: Record<string, unknown>,
  estrutura: EstruturaFicha
): number | string {
  const tokens = tokenizar(formula);
  const campos = mapaCampos(estrutura);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function valorCampo(id: string): unknown {
    if (!(id in dados)) {
      const def = campos.get(id);
      if (def?.padrao !== undefined) return def.padrao;
      return undefined;
    }
    return dados[id];
  }

  function nums(v: unknown): number[] {
    if (Array.isArray(v)) return v.map((x) => Number(typeof x === "object" && x !== null ? (x as Record<string, unknown>).valor ?? x : x)).filter((n) => !Number.isNaN(n));
    const n = Number(v);
    return Number.isNaN(n) ? [] : [n];
  }

  function parseExpr(): number {
    let valor = parseTermo();
    while (peek()?.t === "op" && (peek() as { v: string }).v.match(/[+-]/)) {
      const op = (next() as { v: string }).v;
      const dir = parseTermo();
      valor = op === "+" ? valor + dir : valor - dir;
    }
    return valor;
  }
  function parseTermo(): number {
    let valor = parseFator();
    while (peek()?.t === "op" && (peek() as { v: string }).v.match(/[*/]/)) {
      const op = (next() as { v: string }).v;
      const dir = parseFator();
      valor = op === "*" ? valor * dir : dir === 0 ? 0 : valor / dir;
    }
    return valor;
  }
  function parseFator(): number {
    const tok = next();
    if (!tok) throw new Error("Fórmula incompleta");
    if (tok.t === "num") return tok.v;
    if (tok.t === "lp") {
      const v = parseExpr();
      if (next()?.t !== "rp") throw new Error("Parêntese não fechado");
      return v;
    }
    if (tok.t === "ref") {
      const v = valorCampo(tok.v);
      const n = nums(v);
      return n.length ? n.reduce((a, b) => a + b, 0) : 0;
    }
    if (tok.t === "id") {
      // função: nome(args)
      if (peek()?.t !== "lp") throw new Error(`Identificador inesperado: ${tok.v}`);
      next(); // (
      const args: number[][] = [];
      while (peek() && peek()!.t !== "rp") {
        const argTok = next();
        if (argTok.t === "ref") {
          const bruto = valorCampo(argTok.v);
          if (argTok.v && Array.isArray(bruto) && bruto.length && typeof bruto[0] === "object" && bruto[0] !== null) {
            // tabela: usa coluna "valor"/"quantidade" se existir
            args.push(nums(bruto.map((r) => (r as Record<string, unknown>).valor ?? (r as Record<string, unknown>).quantidade ?? 0)));
          } else {
            args.push(nums(bruto));
          }
        } else if (argTok.t === "num") {
          args.push([argTok.v]);
        } else {
          throw new Error("Função aceita apenas campos ou números");
        }
        if (peek()?.t === "virg") next();
      }
      if (next()?.t !== "rp") throw new Error("Função não fechada");
      const todos = args.flat();
      switch (tok.v) {
        case "sum": return todos.reduce((a, b) => a + b, 0);
        case "count": return todos.length;
        case "avg": return todos.length ? todos.reduce((a, b) => a + b, 0) / todos.length : 0;
        case "min": return todos.length ? Math.min(...todos) : 0;
        case "max": return todos.length ? Math.max(...todos) : 0;
        default: throw new Error(`Função desconhecida: ${tok.v}`);
      }
    }
    throw new Error("Token inesperado na fórmula");
  }

  const resultado = parseExpr();
  if (pos !== tokens.length) throw new Error("Fórmula malformada");
  return Number.isInteger(resultado) ? resultado : Math.round(resultado * 1000) / 1000;
}

/** Extrai as referências {campo} de uma fórmula (para validar existência). */
export function referenciasFormula(formula: string): string[] {
  const refs = new Set<string>();
  for (const m of formula.matchAll(/\{([^}]+)\}/g)) refs.add(m[1].trim());
  return [...refs];
}

/** Calcula todos os campos "calculado" de uma ficha. */
export function calcularCampos(estrutura: EstruturaFicha, dados: Record<string, unknown>): Record<string, number | string> {
  const saida: Record<string, number | string> = {};
  for (const campo of todosCampos(estrutura)) {
    if (campo.tipo !== "calculado" || !campo.formula) continue;
    try {
      saida[campo.id] = avaliarFormula(campo.formula, dados, estrutura);
    } catch {
      saida[campo.id] = "—";
    }
  }
  return saida;
}

// ---------- Pontos e custos (spec §6, §8) ----------

export interface PoolPontos {
  id: string;
  nome: string;
  disponiveis: number;
  gastos: number;
  saldo: number;
  cedidos?: number;    // pontos transferidos para outras reservas
  recebidos?: number;  // pontos recebidos de outras reservas
}

export interface TransferenciaPontos {
  de: string;
  para: string;
  pontos: number;
}

export interface DetalheCusto {
  campoId: string;
  label: string;
  poolId: string;
  custo: number;
}

export interface ResultadoPontos {
  habilitado: boolean;
  pools: PoolPontos[];
  detalhes: DetalheCusto[];
  erros: string[];
  transferencias?: TransferenciaPontos[];
}

const POOL_PADRAO = "principal";

/**
 * Calcula o custo em pontos de cada campo numérico configurado.
 *
 * Regras (todas configuráveis pela estrutura, nada fixo):
 * - `campo.custoPontos`: custo fixo por ponto acima da base
 *   (base = padrao ?? minimo ?? 0).
 * - `pontos.custos[semantico]`: tabela progressiva — custos[i] é o custo de
 *   subir do nível i para i+1 (ex.: talentos [1,2,3,4,5] — spec §8.2).
 *   Tem prioridade sobre custoPontos quando ambos existem.
 * - `campo.reservaPontos`: pool que paga o campo; sem reserva usa o pool
 *   "principal" (ou o primeiro pool). `pontosIniciais` soma no pool padrão.
 */
export function calcularPontos(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>
): ResultadoPontos {
  const cfg = estrutura.pontos;
  if (!cfg?.habilitado) return { habilitado: false, pools: [], detalhes: [], erros: [] };

  const pools = new Map<string, PoolPontos>();
  const garantirPool = (id: string, nome?: string) => {
    if (!pools.has(id)) pools.set(id, { id, nome: nome ?? id, disponiveis: 0, gastos: 0, saldo: 0 });
    return pools.get(id)!;
  };

  // Pools declarados + pool padrão implícito
  for (const p of cfg.pools ?? []) garantirPool(p.id, p.nome).disponiveis += p.pontos;
  const padrao = cfg.pools?.find((p) => p.id === POOL_PADRAO) ?? cfg.pools?.[0];
  const poolPadraoId = padrao?.id ?? POOL_PADRAO;
  garantirPool(poolPadraoId, padrao?.nome ?? "Principal").disponiveis += cfg.pontosIniciais ?? 0;

  const detalhes: DetalheCusto[] = [];
  const erros: string[] = [];

  for (const campo of todosCampos(estrutura)) {
    const valor = dados[campo.id];
    if (typeof valor !== "number" || Number.isNaN(valor)) continue;
    if (campo.custoPontos === undefined && !campo.custoProgressivo?.length && !cfg.custos?.[campo.semantico]) continue;

    const base = typeof campo.padrao === "number" ? campo.padrao : (campo.minimo ?? 0);
    const diff = valor - base;
    if (diff <= 0) continue;

    const poolId = campo.reservaPontos ?? poolPadraoId;
    const pool = garantirPool(poolId);
    let custo = 0;

    const tabela = campo.custoProgressivo?.length ? campo.custoProgressivo : cfg.custos?.[campo.semantico];
    if (tabela?.length) {
      // custo progressivo: soma custos[base..valor-1]
      for (let nivel = base; nivel < valor; nivel++) {
        const c = tabela[nivel];
        custo += typeof c === "number" ? c : (campo.custoPontos ?? 0);
      }
    } else {
      custo = diff * (campo.custoPontos ?? 0);
    }

    // Custos negativos concedem pontos (ex.: defeito custo -1 = +1 ponto).
    // gastos pode ficar negativo — o saldo final é que importa.
    if (custo === 0) continue;
    pool.gastos += custo;
    detalhes.push({ campoId: campo.id, label: campo.label, poolId, custo });
  }

  const saida: PoolPontos[] = [];
  for (const pool of pools.values()) {
    pool.saldo = pool.disponiveis - pool.gastos;
    saida.push(pool);
    if (pool.saldo < 0) erros.push(`Pool "${pool.nome}": pontos insuficientes (saldo ${pool.saldo})`);
  }
  return { habilitado: true, pools: saida, detalhes, erros };
}

/** Valida se os dados estouram algum pool. Retorna null se OK. */
export function validarPontos(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>
): { ok: boolean; pontos: ResultadoPontos } {
  const pontos = calcularPontos(estrutura, dados);
  return { ok: pontos.erros.length === 0, pontos };
}

// ---------- Validação de dados da ficha ----------

export interface ResultadoValidacao {
  ok: boolean;
  dados: Record<string, unknown>;
  erros: Record<string, string>;
}

function valorPadrao(campo: CampoDef): unknown {
  if (campo.padrao !== undefined) return campo.padrao;
  switch (campo.tipo) {
    case "checkbox": return false;
    case "selecao_multipla": case "selecao_nivel": case "lista": case "tabela": return campo.repetivel || campo.tipo !== "tabela" ? [] : [];
    default: return campo.repetivel ? [] : "";
  }
}

// ---------- Números no formato brasileiro ----------
// Aceita número ou texto "1.111,11" / "1111.11" / "500". Vírgula é decimal;
// ponto só é milhar quando seguido de exatamente 3 dígitos sem vírgula.
export function parseNumeroBR(v: unknown): number | null {
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  const temVirg = s.includes(",");
  const temPonto = s.includes(".");
  if (temVirg && temPonto) {
    // O último separador é o decimal.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (temVirg) {
    s = s.replace(",", ".");
  } else if (temPonto && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ""); // "1.111" = mil e cento e onze
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

const SEM_ACENTO = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Normaliza linhas de tabela antes de validar: números BRL -> number,
 *  seleção -> trim e, em carteiras, tipo -> "entrada"/"saida" canônico. */
function normalizarTabela(campo: CampoDef, valor: unknown): unknown {
  if (!Array.isArray(valor)) return valor;
  const ehCarteira = !!campo.carteira;
  return valor.map((reg) => {
    if (typeof reg !== "object" || reg === null) return reg;
    const out = { ...(reg as Record<string, unknown>) };
    for (const col of campo.colunas ?? []) {
      const v = out[col.key];
      if (v === undefined || v === "") continue;
      if (col.tipo === "moeda" || col.tipo === "decimal") {
        const n = parseNumeroBR(v);
        if (n !== null) out[col.key] = n;
      } else if (col.tipo === "inteiro") {
        const n = parseNumeroBR(v);
        if (n !== null && Number.isInteger(n)) out[col.key] = n;
      } else if (col.tipo === "selecao" && typeof v === "string") {
        out[col.key] = v.trim();
      }
    }
    if (ehCarteira && typeof out.tipo === "string") {
      const t = SEM_ACENTO(out.tipo);
      if (t === "entrada" || t === "saida") out.tipo = t;
    }
    return out;
  });
}

/** Resumo financeiro de uma carteira: entradas, saídas e saldo
 *  (saldo inicial + entradas - saídas). Valores derivados das linhas. */
export function resumoCarteira(linhas: unknown, saldoInicial: number): { entradas: number; saidas: number; saldo: number } {
  let entradas = 0;
  let saidas = 0;
  if (Array.isArray(linhas)) {
    for (const reg of linhas) {
      if (typeof reg !== "object" || reg === null) continue;
      const r = reg as Record<string, unknown>;
      const valor = parseNumeroBR(r.valor) ?? 0;
      const tipo = typeof r.tipo === "string" ? SEM_ACENTO(r.tipo) : "";
      if (tipo === "entrada") entradas += valor;
      else if (tipo === "saida") saidas += valor;
    }
  }
  return { entradas, saidas, saldo: saldoInicial + entradas - saidas };
}

function validarValor(campo: CampoDef, valor: unknown, dados: Record<string, unknown>, estrutura: EstruturaFicha): string | null {
  if (valor === undefined || valor === null || valor === "") {
    return campo.obrigatorio ? "Campo obrigatório" : null;
  }
  const numero = (v: unknown) => typeof v === "number" && !Number.isNaN(v);
  switch (campo.tipo) {
    case "texto": case "texto_longo": {
      const vals = Array.isArray(valor) ? valor : [valor];
      for (const v of vals) {
        if (typeof v !== "string") return "Deve ser texto";
        if (campo.maxCaracteres && v.length > campo.maxCaracteres) return `Máximo de ${campo.maxCaracteres} caracteres`;
      }
      return null;
    }
    case "inteiro": {
      const nums = (Array.isArray(valor) ? valor : [valor]) as unknown[];
      for (const v of nums) {
        if (!numero(v) || !Number.isInteger(v)) return "Deve ser número inteiro";
        if (campo.minimo !== undefined && (v as number) < campo.minimo) return `Mínimo: ${campo.minimo}`;
        if (campo.maximo !== undefined && (v as number) > campo.maximo) return `Máximo: ${campo.maximo}`;
      }
      return null;
    }
    case "decimal": case "moeda": {
      const nums = (Array.isArray(valor) ? valor : [valor]) as unknown[];
      for (const v of nums) {
        if (!numero(v)) return "Deve ser número";
        if (campo.minimo !== undefined && (v as number) < campo.minimo) return `Mínimo: ${campo.minimo}`;
        if (campo.maximo !== undefined && (v as number) > campo.maximo) return `Máximo: ${campo.maximo}`;
      }
      return null;
    }
    case "data": {
      const vals = Array.isArray(valor) ? valor : [valor];
      for (const v of vals) if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return "Data inválida";
      return null;
    }
    case "checkbox":
      return typeof valor === "boolean" ? null : "Deve ser verdadeiro/falso";
    case "selecao_unica": {
      if (campo.opcoes?.length && !campo.opcoes.includes(String(valor))) return "Opção inválida";
      return null;
    }
    case "selecao_multipla": case "lista": {
      const vals = Array.isArray(valor) ? valor : [valor];
      if (campo.opcoes?.length) {
        for (const v of vals) if (!campo.opcoes.includes(String(v))) return `Opção inválida: ${String(v)}`;
      }
      return null;
    }
    case "selecao_nivel": {
      // Formato: [{ key: string, nivel: int 1..5 }] — elementos da biblioteca
      // com grau (ex.: defeitos). Chaves duplicadas são rejeitadas.
      if (!Array.isArray(valor)) return "Deve ser uma lista";
      const vistos = new Set<string>();
      for (const item of valor) {
        if (typeof item !== "object" || item === null) return "Item inválido";
        const { key, nivel } = item as Record<string, unknown>;
        if (typeof key !== "string" || !key) return "Item sem chave de elemento";
        if (vistos.has(key)) return `Elemento duplicado: ${key}`;
        vistos.add(key);
        if (typeof nivel !== "number" || !Number.isInteger(nivel) || nivel < 1 || nivel > 5) {
          return `Nível inválido para ${key} (1 a 5)`;
        }
      }
      return null;
    }
    case "tabela": {
      if (!Array.isArray(valor)) return "Deve ser uma lista";
      // Inventário (semantico "item"): colunas conhecidas têm regras
      // próprias — não-negativos e munição ≤ capacidade máxima.
      const ehInventario = campo.semantico === "item";
      const COLS_NAO_NEG = ["quantidade", "peso", "espaco", "valor_compra", "municao", "municao_max"] as const;
      for (const item of valor) {
        if (typeof item !== "object" || item === null) return "Item inválido";
        const reg = item as Record<string, unknown>;
        for (const col of campo.colunas ?? []) {
          const v = reg[col.key];
          if (v === undefined || v === "") continue;
          if (col.tipo === "inteiro" && (!numero(v) || !Number.isInteger(v))) return `Coluna ${col.label}: inteiro esperado`;
          if ((col.tipo === "decimal" || col.tipo === "moeda") && !numero(v)) return `Coluna ${col.label}: número esperado`;
          if (col.tipo === "selecao" && col.opcoes?.length && !col.opcoes.includes(String(v))) {
            return `Coluna ${col.label}: opção inválida`;
          }
        }
        // Carteira financeira: todo registro precisa de tipo entrada/saída
        // e valor monetário não-negativo.
        if (campo.carteira) {
          const tipo = typeof reg.tipo === "string" ? SEM_ACENTO(reg.tipo) : "";
          if (tipo !== "entrada" && tipo !== "saida") return "Tipo da movimentação deve ser Entrada ou Saída";
          const valorMov = parseNumeroBR(reg.valor);
          if (valorMov === null) return "Valor da movimentação inválido";
          if (valorMov < 0) return "Valor da movimentação não pode ser negativo";
        }
        if (ehInventario) {
          for (const k of COLS_NAO_NEG) {
            const v = reg[k];
            if (v === undefined || v === "") continue;
            if (!numero(v)) return `Coluna ${k}: número esperado`;
            if ((v as number) < 0) return `Coluna ${k}: não pode ser negativa`;
          }
          const mun = reg.municao, munMax = reg.municao_max;
          if (numero(mun) && numero(munMax) && (mun as number) > (munMax as number)) {
            return "Munição atual não pode ultrapassar a capacidade máxima";
          }
        }
      }
      return null;
    }
    case "calculado":
      return null; // nunca editável diretamente
    case "referencia": {
      const alvo = campo.referencia ? mapaCampos(estrutura).get(campo.referencia) : undefined;
      if (!alvo) return "Referência inválida";
      // referência guarda a chave do campo alvo — deve existir na ficha
      const chaves = new Set(Object.keys(dados));
      return typeof valor === "string" && chaves.has(valor) ? null : "Referência deve apontar para um campo da ficha";
    }
    default:
      return null;
  }
}

/**
 * Valida e saneia os dados enviados para a ficha.
 * - Remove campos calculados e referências não autorizadas.
 * - Aplica padrões para campos ausentes.
 * - `estrito` = true exige obrigatórios (usado ao submeter para aprovação).
 */
export function validarFicha(
  estrutura: EstruturaFicha,
  dadosEntrada: Record<string, unknown>,
  opcoes: { apenasCamposPermitidos?: Set<string>; estrito?: boolean; aplicarPadroes?: boolean; carteirasSaldo?: Set<string> } = {}
): ResultadoValidacao {
  const dados: Record<string, unknown> = {};
  const erros: Record<string, string> = {};
  const campos = todosCampos(estrutura);

  for (const campo of campos) {
    if (campo.tipo === "calculado") continue; // calculado nunca vem do cliente
    const permitir = !opcoes.apenasCamposPermitidos || opcoes.apenasCamposPermitidos.has(campo.id);
    // Carteira: saldo inicial via chave sintética "<id>::saldo" — só para
    // quem tem permissão (mestre sempre; jogador conforme configuração).
    if (campo.carteira) {
      const chaveSaldo = `${campo.id}::saldo`;
      if (chaveSaldo in dadosEntrada) {
        const v = dadosEntrada[chaveSaldo];
        if (!opcoes.carteirasSaldo?.has(campo.id)) {
          erros[campo.id] = "Saldo inicial só pode ser alterado pelo mestre";
        } else if (v !== undefined && v !== null && v !== "") {
          const n = parseNumeroBR(v);
          if (n === null) erros[campo.id] = "Saldo inicial inválido";
          else dados[chaveSaldo] = n;
        }
      }
    }
    let valor = permitir && campo.id in dadosEntrada ? dadosEntrada[campo.id] : undefined;
    // Checkbox tolera 0/1 de registros antigos e padrões numéricos.
    if (campo.tipo === "checkbox" && (valor === 0 || valor === 1)) valor = valor === 1;

    // Vazio (undefined/null/"") é "ausente": obrigatório só é exigido no
    // modo estrito (submissão p/ aprovação); valor vazio enviado limpa o campo.
    if (valor === undefined || valor === null || valor === "") {
      if (opcoes.estrito && campo.obrigatorio) { erros[campo.id] = "Campo obrigatório"; continue; }
      if (campo.padrao !== undefined && opcoes.aplicarPadroes !== false) { dados[campo.id] = campo.padrao; continue; }
      if (valor !== undefined) dados[campo.id] = valor;
      continue;
    }
    // Registro antigo: tabela com escalar (ex.: saldo digitado antes da tabela
    // existir) vira linha única — em carteiras, o escalar é o saldo inicial.
    if (campo.tipo === "tabela" && !Array.isArray(valor)) {
      if (campo.carteira) {
        const n = parseNumeroBR(valor);
        if (n !== null) dados[`${campo.id}::saldo`] = n;
        dados[campo.id] = [];
      } else {
        dados[campo.id] = [{ valor }];
      }
      continue;
    }
    if (campo.tipo === "tabela") valor = normalizarTabela(campo, valor);
    const erro = validarValor(campo, valor, dados, estrutura);
    if (erro) {
      erros[campo.id] = erro;
      continue;
    }
    dados[campo.id] = valor;
  }

  // Campos enviados que não existem no modelo são descartados (nunca confiamos no cliente)
  return { ok: Object.keys(erros).length === 0, dados, erros };
}
