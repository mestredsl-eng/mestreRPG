import { estruturaFichaSchema } from "./ficha.js";

export type GeneroVoz = "feminina" | "masculina";

function normalizar(valor: string): string {
  return valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function textoDoValor(valor: unknown): string[] {
  if (typeof valor === "string" || typeof valor === "number") return [String(valor)];
  if (Array.isArray(valor)) return valor.flatMap(textoDoValor);
  if (valor && typeof valor === "object") {
    const obj = valor as Record<string, unknown>;
    for (const chave of ["label", "nome", "value", "valor", "name", "key"]) {
      if (obj[chave] !== undefined && obj[chave] !== null) return textoDoValor(obj[chave]);
    }
  }
  return [];
}

export function inferirGeneroVozDaFicha(estruturaBruta: unknown, dadosBrutos: unknown): GeneroVoz | null {
  const estrutura = estruturaFichaSchema.safeParse(estruturaBruta);
  if (!estrutura.success || !dadosBrutos || typeof dadosBrutos !== "object" || Array.isArray(dadosBrutos)) return null;
  const dados = dadosBrutos as Record<string, unknown>;
  const campos = estrutura.data.secoes.flatMap((secao) => secao.campos).filter((campo) =>
    campo.visibilidade === "todos" && /sexo|g[eê]nero|gender/i.test(campo.id + " " + campo.label)
  );
  for (const campo of campos) {
    for (const valor of textoDoValor(dados[campo.id]).map(normalizar)) {
      if (/^(f|fem|feminino|feminina|mulher|female|woman)$/.test(valor)) return "feminina";
      if (/^(m|masc|masculino|masculina|homem|male|man)$/.test(valor)) return "masculina";
    }
  }
  return null;
}
