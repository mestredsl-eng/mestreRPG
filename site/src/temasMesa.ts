// Temas da bandeja 3D da Mesa de Dados — preferência individual por
// usuário, persistida em users.preferences.temaMesa (JSON, sem migration).
// A bandeja é independente das cores dos dados (--dado-fundo/--dado-texto).

export const TEMAS_MESA_IDS = ["azul", "verde", "vinho", "madeira", "obsidiana"] as const;
export type TemaMesaId = (typeof TEMAS_MESA_IDS)[number];
export const TEMA_MESA_PADRAO: TemaMesaId = "azul";

export interface TemaMesa {
  id: TemaMesaId;
  nome: string;
  descricao: string;
  /** Cores aplicadas como variáveis CSS --mesa-* no documento. */
  feltro: string;
  feltroEscuro: string;
  borda: string;
  acabamento: string;
  luz: string;
  sombra: string;
  /** Degradê da prévia no seletor: [claro, escuro] + cor da borda. */
  previa: { claro: string; escuro: string; borda: string };
}

export const TEMAS_MESA: Record<TemaMesaId, TemaMesa> = {
  azul: {
    id: "azul",
    nome: "Feltro azul",
    descricao: "Clássico — o visual original da mesa.",
    feltro: "#263456",
    feltroEscuro: "#121828",
    borda: "rgba(130,144,189,.55)",
    acabamento: "rgba(255,255,255,.14)",
    luz: "rgba(255,255,255,.16)",
    sombra: "rgba(0,0,0,.22)",
    previa: { claro: "#3a4f7d", escuro: "#141b30", borda: "#8290bd" },
  },
  verde: {
    id: "verde",
    nome: "Feltro verde",
    descricao: "Cassino — feltro escuro com filetes dourados.",
    feltro: "#1d5c46",
    feltroEscuro: "#0c241b",
    borda: "rgba(212,175,55,.6)",
    acabamento: "rgba(232,201,106,.35)",
    luz: "rgba(214,255,230,.14)",
    sombra: "rgba(0,0,0,.3)",
    previa: { claro: "#2c7d5c", escuro: "#0f2b20", borda: "#d4af37" },
  },
  vinho: {
    id: "vinho",
    nome: "Feltro vinho",
    descricao: "Veludo profundo com acabamento rosé.",
    feltro: "#5c1f33",
    feltroEscuro: "#260d18",
    borda: "rgba(233,183,197,.5)",
    acabamento: "rgba(244,200,214,.3)",
    luz: "rgba(255,220,228,.14)",
    sombra: "rgba(0,0,0,.32)",
    previa: { claro: "#7d2c44", escuro: "#33101f", borda: "#e9b7c5" },
  },
  madeira: {
    id: "madeira",
    nome: "Madeira escura",
    descricao: "Mesa de madeira nobre, bordas em nogueira.",
    feltro: "#4a2f1d",
    feltroEscuro: "#221207",
    borda: "rgba(198,150,96,.6)",
    acabamento: "rgba(230,190,140,.28)",
    luz: "rgba(255,226,180,.12)",
    sombra: "rgba(0,0,0,.4)",
    previa: { claro: "#6b4426", escuro: "#2c1808", borda: "#c69660" },
  },
  obsidiana: {
    id: "obsidiana",
    nome: "Obsidiana",
    descricao: "Futurista — vidro negro com reflexos frios.",
    feltro: "#171a26",
    feltroEscuro: "#05060c",
    borda: "rgba(126,156,255,.55)",
    acabamento: "rgba(170,195,255,.3)",
    luz: "rgba(150,180,255,.18)",
    sombra: "rgba(0,0,0,.5)",
    previa: { claro: "#232a44", escuro: "#070912", borda: "#7e9cff" },
  },
};

export function ehTemaMesa(v: unknown): v is TemaMesaId {
  return typeof v === "string" && (TEMAS_MESA_IDS as readonly string[]).includes(v);
}

/** Aplica as variáveis CSS do tema no documento (escopo por usuário:
 *  cada navegador carrega as preferências da própria conta). */
export function aplicarTemaMesa(id: TemaMesaId) {
  const t = TEMAS_MESA[id] ?? TEMAS_MESA[TEMA_MESA_PADRAO];
  const r = document.documentElement.style;
  r.setProperty("--mesa-feltro", t.feltro);
  r.setProperty("--mesa-feltro-escuro", t.feltroEscuro);
  r.setProperty("--mesa-borda", t.borda);
  r.setProperty("--mesa-acabamento", t.acabamento);
  r.setProperty("--mesa-luz", t.luz);
  r.setProperty("--mesa-sombra", t.sombra);
  document.documentElement.dataset.temaMesa = t.id;
}
