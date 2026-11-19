import {
  movimentoEfetivo,
  normalizarPreferenciasVisuais,
  resolverTokensVisuais,
  type PreferenciasVisuais,
} from "./temasVisuais";

const ATRIBUTOS = [
  "data-intensidade",
  "data-cor-destaque",
  "data-superficies",
  "data-textura",
  "data-animacoes",
  "data-densidade",
  "data-movimento-efetivo",
] as const;

/** Chaves de token que este módulo pode gravar no <html> (saída do resolvedor). */
function chavesTokens(): string[] {
  return Object.keys(resolverTokensVisuais({ ...normalizarPreferenciasVisuais(null) }).css);
}

/** true quando o sistema operacional pede redução de movimento. */
export function sistemaPrefereReducao(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Normaliza o valor cru de `preferences.visual` (pode vir incompleto/legado). */
export function preferenciasVisuaisDe(bruto: unknown): PreferenciasVisuais {
  return normalizarPreferenciasVisuais(bruto);
}

/** Aplica as preferências salvas como tokens/atributos no <html>. */
export function aplicarPreferenciasVisuais(preferencias: PreferenciasVisuais): void {
  const raiz = document.documentElement;
  const { css, atributos } = resolverTokensVisuais(preferencias);
  for (const chave of chavesTokens()) raiz.style.removeProperty(chave);
  for (const [chave, valor] of Object.entries(css)) raiz.style.setProperty(chave, valor);
  for (const chave of ATRIBUTOS) raiz.removeAttribute(chave);
  for (const [chave, valor] of Object.entries(atributos)) raiz.setAttribute(chave, String(valor));
  raiz.setAttribute("data-movimento-efetivo", movimentoEfetivo(preferencias, sistemaPrefereReducao()));
}

/** Remove overrides inline — usado no logout para não vazar tema entre usuários. */
export function limparPreferenciasVisuais(): void {
  const raiz = document.documentElement;
  for (const chave of chavesTokens()) raiz.style.removeProperty(chave);
  for (const chave of ATRIBUTOS) raiz.removeAttribute(chave);
}

/** Tokens resolvidos como objeto de estilo inline — para o painel de prévia isolado. */
export function tokensVisuaisComoEstilo(preferencias: PreferenciasVisuais): Record<string, string> {
  return resolverTokensVisuais(preferencias).css;
}

/** Atributos data-* correspondentes — para o painel de prévia isolado. */
export function atributosVisuais(preferencias: PreferenciasVisuais): Record<string, string> {
  return resolverTokensVisuais(preferencias).atributos;
}

export type { PreferenciasVisuais };
