// Preferências visuais da conta — catálogo puro (Issue #132, etapa 2.2a).
// Sem React, API ou DOM global: normalização segura, catálogo fechado de
// cores de destaque, resolução em tokens CSS e regra de movimento reduzido.
// O contrato espelha o backend da PR #154: seis dimensões fechadas e
// objeto completo — nenhum valor fora das listas abaixo é aceito.

export const INTENSIDADES = Object.freeze(["discreta", "equilibrada", "imersiva"] as const);
export type IntensidadeVisual = (typeof INTENSIDADES)[number];

export const CORES_DESTAQUE = Object.freeze(["vinho", "ambar", "violeta", "cinza-frio"] as const);
export type CorDestaqueVisual = (typeof CORES_DESTAQUE)[number];

export const SUPERFICIES = Object.freeze(["padrao", "flat", "elevado"] as const);
export type SuperficieVisual = (typeof SUPERFICIES)[number];

export const TEXTURAS = Object.freeze(["nenhuma", "sutil", "intensa"] as const);
export type TexturaVisual = (typeof TEXTURAS)[number];

export const ANIMACOES = Object.freeze(["reduzido", "normal", "completo"] as const);
export type AnimacoesVisual = (typeof ANIMACOES)[number];

export const DENSIDADES = Object.freeze(["compacta", "padrao", "ampla"] as const);
export type DensidadeVisual = (typeof DENSIDADES)[number];

export interface PreferenciasVisuais {
  intensidade: IntensidadeVisual;
  corDestaque: CorDestaqueVisual;
  superficies: SuperficieVisual;
  textura: TexturaVisual;
  animacoes: AnimacoesVisual;
  densidade: DensidadeVisual;
}

// Mesmo formato enviado ao backend (PR #154). Identidade base: vinho,
// textura sutil, movimento normal — os padrões da identidade #134.
export const VISUAL_PADRAO: Readonly<PreferenciasVisuais> = Object.freeze({
  intensidade: "equilibrada",
  corDestaque: "vinho",
  superficies: "padrao",
  textura: "sutil",
  animacoes: "normal",
  densidade: "padrao",
});

// ---------- Paleta fechada de destaque ----------
// Apenas estas quatro cores podem virar tokens de destaque. `principal`
// alimenta --horror-vinho/--horror-destaque; `claro` os tons claros;
// `suave` as bordas/realces translúcidos. Nada de CSS arbitrário.

export interface CorDestaqueInfo {
  id: CorDestaqueVisual;
  nome: string;
  descricao: string;
  principal: string;
  claro: string;
  suave: string;
}

// A opacidade do token `suave` é específica de cada paleta: vinho mantém
// .24 para preservar a linguagem de bordas legada; os novos acentos usam .55.
// Consumidores não devem presumir alfa uniforme entre paletas.
// A opacidade do token `suave` é específica de cada paleta: vinho mantém
// .24 para preservar a linguagem de bordas legada; os novos acentos usam .55.
// Consumidores não devem presumir alfa uniforme entre paletas.
export const PALETA_DESTAQUE: Readonly<Record<CorDestaqueVisual, Readonly<CorDestaqueInfo>>> = Object.freeze({
  vinho: Object.freeze({
    id: "vinho",
    nome: "Vinho",
    descricao: "Acento da identidade — vinho profundo com rosé.",
    // Valores originais da identidade #134: o padrão não pode alterar
    // o visual de quem ainda não escolheu uma personalização.
    principal: "#8d3d4b",
    claro: "#b85c69",
    suave: "rgba(141,61,75,.24)",
  }),
  ambar: Object.freeze({
    id: "ambar",
    nome: "Âmbar",
    descricao: "Luz de vela e arquivo antigo — dourado queimado.",
    principal: "#b08d4f",
    claro: "#e3c98f",
    suave: "rgba(176,141,79,.55)",
  }),
  violeta: Object.freeze({
    id: "violeta",
    nome: "Violeta",
    descricao: "Ritual e ocultismo — violeta frio de velório.",
    principal: "#7a5f9e",
    claro: "#b9a4d6",
    suave: "rgba(122,95,158,.55)",
  }),
  "cinza-frio": Object.freeze({
    id: "cinza-frio",
    nome: "Cinza frio",
    descricao: "Hospital e expediente — aço sem calor.",
    principal: "#8a93a3",
    claro: "#c3c9d4",
    suave: "rgba(138,147,163,.55)",
  }),
});

// ---------- Normalização ----------
// Recebe unknown (payload do backend, storage, formulários) e devolve
// preferências válidas. Campo inválido/ausente cai no padrão; objetos
// extras são descartados; a entrada nunca é mutada.

function umDe<T extends string>(valor: unknown, lista: readonly T[], padrao: T): T {
  return typeof valor === "string" && (lista as readonly string[]).includes(valor)
    ? (valor as T)
    : padrao;
}

export function normalizarPreferenciasVisuais(entrada: unknown): PreferenciasVisuais {
  if (typeof entrada !== "object" || entrada === null || Array.isArray(entrada)) {
    return { ...VISUAL_PADRAO };
  }
  const bruto = entrada as Record<string, unknown>;
  return {
    intensidade: umDe(bruto.intensidade, INTENSIDADES, VISUAL_PADRAO.intensidade),
    corDestaque: umDe(bruto.corDestaque, CORES_DESTAQUE, VISUAL_PADRAO.corDestaque),
    superficies: umDe(bruto.superficies, SUPERFICIES, VISUAL_PADRAO.superficies),
    textura: umDe(bruto.textura, TEXTURAS, VISUAL_PADRAO.textura),
    animacoes: umDe(bruto.animacoes, ANIMACOES, VISUAL_PADRAO.animacoes),
    densidade: umDe(bruto.densidade, DENSIDADES, VISUAL_PADRAO.densidade),
  };
}

// ---------- Resolução em tokens ----------
// Mapa tipado de custom properties (--*) e atributos data-* prontos para
// a futura camada visual aplicar. Nada aqui toca o documento.

export interface TokensVisuais {
  css: Record<string, string>;
  atributos: Record<string, string>;
}

// Multiplicadores derivados — consumidos depois pelo CSS.
const INTENSIDADE_VALOR: Record<IntensidadeVisual, string> = {
  discreta: "0.7",
  equilibrada: "1",
  imersiva: "1.35",
};
const TEXTURA_OPACIDADE: Record<TexturaVisual, string> = {
  nenhuma: "0",
  sutil: "0.14",
  intensa: "0.3",
};
const DENSIDADE_VALOR: Record<DensidadeVisual, string> = {
  compacta: "0.88",
  padrao: "1",
  ampla: "1.14",
};
const SUPERFICIE_VALORES: Record<SuperficieVisual, { superficie: string; elevada: string; sombra: string }> = {
  padrao: {
    superficie: "#1b1720",
    elevada: "#211b26",
    sombra: "0 14px 36px rgba(0,0,0,.28)",
  },
  flat: {
    superficie: "#1b1720",
    elevada: "#1b1720",
    sombra: "0 4px 12px rgba(0,0,0,.14)",
  },
  elevado: {
    superficie: "#1b1720",
    elevada: "#2a2331",
    sombra: "0 20px 48px rgba(0,0,0,.4)",
  },
};

function hexParaRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbaDe(hex: string, alfa: number): string {
  const [r, g, b] = hexParaRgb(hex);
  return `rgba(${r},${g},${b},${alfa})`;
}

export function resolverTokensVisuais(preferencias: PreferenciasVisuais): TokensVisuais {
  const prefs = normalizarPreferenciasVisuais(preferencias);
  const destaque = PALETA_DESTAQUE[prefs.corDestaque];
  const superficie = SUPERFICIE_VALORES[prefs.superficies];

  return {
    css: {
      // Base da identidade Terror & Mistério (referência: #134).
      "--horror-noite": "#0b0a0f",
      "--horror-carvao": "#131118",
      "--horror-texto": "#eee7e8",
      "--horror-texto-suave": "#b4a9b1",
      // Destaque vem exclusivamente da paleta fechada.
      "--horror-vinho": destaque.principal,
      "--horror-vinho-claro": destaque.claro,
      "--horror-destaque": destaque.principal,
      "--horror-destaque-claro": destaque.claro,
      "--horror-destaque-suave": destaque.suave,
      // Dourado estrutural da identidade, não o acento selecionado.
      // O acento ativo deve ser consumido por --horror-destaque*.
      "--horror-ambar": "#b99a62",
      // Bordas tingidas pelo destaque escolhido.
      // Sem personalização, preservar inclusive as bordas originais da
      // identidade #134; as demais paletas derivam bordas do próprio acento.
      "--horror-borda": prefs.corDestaque === "vinho"
        ? "rgba(154, 111, 125, .24)"
        : rgbaDe(destaque.principal, 0.24),
      "--horror-borda-forte": prefs.corDestaque === "vinho"
        ? "rgba(177, 91, 105, .48)"
        : rgbaDe(destaque.principal, 0.48),
      // Superfícies conforme a preferência.
      "--horror-superficie": superficie.superficie,
      "--horror-superficie-elevada": superficie.elevada,
      "--horror-sombra": superficie.sombra,
      // Tokens derivados das preferências.
      "--horror-intensidade": INTENSIDADE_VALOR[prefs.intensidade],
      "--horror-textura-opacidade": TEXTURA_OPACIDADE[prefs.textura],
      "--horror-densidade": DENSIDADE_VALOR[prefs.densidade],
      "--horror-movimento": prefs.animacoes,
    },
    atributos: {
      "data-intensidade": prefs.intensidade,
      "data-cor-destaque": prefs.corDestaque,
      "data-superficies": prefs.superficies,
      "data-textura": prefs.textura,
      "data-animacoes": prefs.animacoes,
      "data-densidade": prefs.densidade,
    },
  };
}

// ---------- Movimento reduzido ----------
// O sistema operacional sempre prevalece: prefers-reduced-motion: reduce
// reduz movimento mesmo com o app em "completo". O app pode reduzir,
// nunca contrariar a acessibilidade do SO. O estado do sistema chega por
// argumento — este módulo não lê window.matchMedia.

export type MovimentoEfetivo = AnimacoesVisual;

export function movimentoEfetivo(
  preferencias: PreferenciasVisuais,
  sistemaPrefereReducao: boolean,
): MovimentoEfetivo {
  const prefs = normalizarPreferenciasVisuais(preferencias);
  if (sistemaPrefereReducao || prefs.animacoes === "reduzido") return "reduzido";
  return prefs.animacoes;
}

// ---------- Atmosferas predefinidas ----------
// Catálogo local e explicável dentro da identidade permanente de
// Terror & Mistério — sem fantasia genérica nem ficção científica.
// Nenhum preset é aplicado automaticamente; a escolha é sempre do usuário.

export interface AtmosferaVisual {
  id: string;
  nome: string;
  descricao: string;
  preferencias: Readonly<PreferenciasVisuais>;
}

export const ATMOSFERAS_VISUAIS: readonly Readonly<AtmosferaVisual>[] = Object.freeze([
  Object.freeze({
    id: "arquivo-oculto",
    nome: "Arquivo Oculto",
    descricao:
      "Gabinete abafado: discreto, superfícies planas e densidade compacta para fichas e registros sem distração.",
    preferencias: Object.freeze({
      intensidade: "discreta",
      corDestaque: "vinho",
      superficies: "flat",
      textura: "nenhuma",
      animacoes: "reduzido",
      densidade: "compacta",
    }),
  }),
  Object.freeze({
    id: "investigacao-noturna",
    nome: "Investigação Noturna",
    descricao:
      "Ronda sob chuva: equilibrado, âmbar de lampião, textura sutil e movimento normal para ler pistas sem pressa.",
    preferencias: Object.freeze({
      intensidade: "equilibrada",
      corDestaque: "ambar",
      superficies: "padrao",
      textura: "sutil",
      animacoes: "normal",
      densidade: "padrao",
    }),
  }),
  Object.freeze({
    id: "ocultismo",
    nome: "Ocultismo",
    descricao:
      "Círculo de velas: imersivo, violeta ritual, texturas intensas e animações completas para sessões de invocação.",
    preferencias: Object.freeze({
      intensidade: "imersiva",
      corDestaque: "violeta",
      superficies: "elevado",
      textura: "intensa",
      animacoes: "completo",
      densidade: "ampla",
    }),
  }),
  Object.freeze({
    id: "terror-psicologico",
    nome: "Terror Psicológico",
    descricao:
      "Paranoia clínica: cinza frio, superfícies elevadas e movimento reduzido — a ameaça está nos detalhes.",
    preferencias: Object.freeze({
      intensidade: "imersiva",
      corDestaque: "cinza-frio",
      superficies: "elevado",
      textura: "intensa",
      animacoes: "reduzido",
      densidade: "padrao",
    }),
  }),
  Object.freeze({
    id: "misterio-sobrenatural",
    nome: "Mistério Sobrenatural",
    descricao:
      "O caso clássico: equilíbrio perfeito, vinho da casa, textura sutil e densidade ampla para narração e investigação.",
    preferencias: Object.freeze({
      intensidade: "equilibrada",
      corDestaque: "vinho",
      superficies: "padrao",
      textura: "sutil",
      animacoes: "normal",
      densidade: "ampla",
    }),
  }),
]);

export function atmosferaPorId(id: string): AtmosferaVisual | undefined {
  return ATMOSFERAS_VISUAIS.find((a) => a.id === id);
}
