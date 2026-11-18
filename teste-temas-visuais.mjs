// Testes do catálogo visual puro (site/src/temasVisuais.ts):
// valores padrão, paleta fechada, normalização segura, resolução de
// tokens CSS, presets de atmosfera e precedência de movimento reduzido.
// Executar: npm exec --workspace servidor -- tsx teste-temas-visuais.mjs
import {
  VISUAL_PADRAO,
  INTENSIDADES, CORES_DESTAQUE, SUPERFICIES, TEXTURAS, ANIMACOES, DENSIDADES,
  PALETA_DESTAQUE,
  ATMOSFERAS_VISUAIS, atmosferaPorId,
  normalizarPreferenciasVisuais,
  resolverTokensVisuais,
  movimentoEfetivo,
} from "./site/src/temasVisuais.ts";

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};
const falhas = () => resultados.filter((r) => !r.ok);

const CAMPOS = ["intensidade", "corDestaque", "superficies", "textura", "animacoes", "densidade"];

// ---------- Valores padrão ----------
ok("VISUAL_PADRAO tem exatamente os 6 campos do contrato",
  CAMPOS.every((c) => c in VISUAL_PADRAO) && Object.keys(VISUAL_PADRAO).length === 6);
ok("VISUAL_PADRAO usa valores válidos do contrato",
  INTENSIDADES.includes(VISUAL_PADRAO.intensidade)
  && CORES_DESTAQUE.includes(VISUAL_PADRAO.corDestaque)
  && SUPERFICIES.includes(VISUAL_PADRAO.superficies)
  && TEXTURAS.includes(VISUAL_PADRAO.textura)
  && ANIMACOES.includes(VISUAL_PADRAO.animacoes)
  && DENSIDADES.includes(VISUAL_PADRAO.densidade));
ok("normalizar(null) devolve o padrão", JSON.stringify(normalizarPreferenciasVisuais(null)) === JSON.stringify(VISUAL_PADRAO));
ok("normalizar(undefined) devolve o padrão", JSON.stringify(normalizarPreferenciasVisuais(undefined)) === JSON.stringify(VISUAL_PADRAO));
ok("normalizar('texto') devolve o padrão", JSON.stringify(normalizarPreferenciasVisuais("imersiva")) === JSON.stringify(VISUAL_PADRAO));
ok("normalizar(42) devolve o padrão", JSON.stringify(normalizarPreferenciasVisuais(42)) === JSON.stringify(VISUAL_PADRAO));
ok("normalizar([]) devolve o padrão", JSON.stringify(normalizarPreferenciasVisuais([])) === JSON.stringify(VISUAL_PADRAO));
ok("normalizar({}) devolve o padrão", JSON.stringify(normalizarPreferenciasVisuais({})) === JSON.stringify(VISUAL_PADRAO));

// ---------- Normalização: campo a campo ----------
for (const [campo, lista] of [
  ["intensidade", INTENSIDADES], ["corDestaque", CORES_DESTAQUE],
  ["superficies", SUPERFICIES], ["textura", TEXTURAS],
  ["animacoes", ANIMACOES], ["densidade", DENSIDADES],
]) {
  for (const valor of lista) {
    const r = normalizarPreferenciasVisuais({ [campo]: valor });
    ok(`normalizar aceita ${campo}=${valor}`, r[campo] === valor && Object.keys(r).length === 6);
  }
  ok(`normalizar rejeita ${campo} inválido`,
    normalizarPreferenciasVisuais({ [campo]: "valor-inventado" })[campo] === VISUAL_PADRAO[campo]);
  ok(`normalizar rejeita ${campo} como objeto`,
    normalizarPreferenciasVisuais({ [campo]: { x: 1 } })[campo] === VISUAL_PADRAO[campo]);
}
// CSS arbitrário nunca passa.
{
  const r = normalizarPreferenciasVisuais({ corDestaque: "#ff0000; } body{display:none" });
  ok("corDestaque arbitrária cai no padrão", r.corDestaque === VISUAL_PADRAO.corDestaque);
  const r2 = normalizarPreferenciasVisuais({ textura: "url(javascript:alert(1))" });
  ok("textura arbitrária cai no padrão", r2.textura === VISUAL_PADRAO.textura);
}
// Objeto parcial + extras não propagados + imutabilidade.
{
  const entrada = { intensidade: "imersiva", hacker: "<script>", css: "body{color:red}" };
  const antes = JSON.stringify(entrada);
  const r = normalizarPreferenciasVisuais(entrada);
  ok("parcial preserva campo válido e padrão no resto",
    r.intensidade === "imersiva" && r.corDestaque === VISUAL_PADRAO.corDestaque);
  ok("extras não propagados", !("hacker" in r) && !("css" in r) && Object.keys(r).length === 6);
  ok("entrada não mutada", JSON.stringify(entrada) === antes);
  ok("resultado é objeto novo", r !== entrada);
}

// ---------- Paleta fechada ----------
ok("PALETA_DESTAQUE cobre exatamente as 4 cores do contrato",
  Object.keys(PALETA_DESTAQUE).sort().join(",") === [...CORES_DESTAQUE].sort().join(","));
for (const cor of CORES_DESTAQUE) {
  const info = PALETA_DESTAQUE[cor];
  ok(`paleta ${cor}: campos completos e hex válidos`,
    /^#[0-9a-f]{6}$/i.test(info.principal) && /^#[0-9a-f]{6}$/i.test(info.claro)
    && typeof info.nome === "string" && info.nome.length > 0
    && typeof info.descricao === "string" && info.descricao.length > 0);
}
// Cada cor gera tokens de destaque distintos e dentro da paleta.
{
  const vistos = new Set();
  for (const cor of CORES_DESTAQUE) {
    const { css } = resolverTokensVisuais({ ...VISUAL_PADRAO, corDestaque: cor });
    vistos.add(css["--horror-destaque"]);
    ok(`cor ${cor}: --horror-vinho segue a paleta`, css["--horror-vinho"] === PALETA_DESTAQUE[cor].principal);
    ok(`cor ${cor}: --horror-vinho-claro segue a paleta`, css["--horror-vinho-claro"] === PALETA_DESTAQUE[cor].claro);
  }
  ok("4 destaques produzem 4 cores distintas", vistos.size === 4);
}

// ---------- Resolução de tokens ----------
{
  const { css, atributos } = resolverTokensVisuais(VISUAL_PADRAO);
  ok("tokens base da identidade #134 presentes",
    ["--horror-noite", "--horror-carvao", "--horror-superficie", "--horror-superficie-elevada",
      "--horror-borda", "--horror-vinho", "--horror-vinho-claro", "--horror-ambar", "--horror-sombra"]
      .every((k) => typeof css[k] === "string" && css[k].length > 0));
  ok("paleta vinho preserva os acentos originais da identidade #134",
    PALETA_DESTAQUE.vinho.principal === "#8d3d4b"
    && PALETA_DESTAQUE.vinho.claro === "#b85c69"
    && PALETA_DESTAQUE.vinho.suave === "rgba(141,61,75,.24)");
  ok("VISUAL_PADRAO preserva exatamente as bordas originais da identidade #134",
    css["--horror-borda"] === "rgba(154, 111, 125, .24)"
    && css["--horror-borda-forte"] === "rgba(177, 91, 105, .48)");
  ok("VISUAL_PADRAO preserva as cores-base da identidade #134",
    css["--horror-noite"] === "#0b0a0f"
    && css["--horror-carvao"] === "#131118"
    && css["--horror-superficie"] === "#1b1720"
    && css["--horror-superficie-elevada"] === "#211b26"
    && css["--horror-vinho"] === "#8d3d4b"
    && css["--horror-vinho-claro"] === "#b85c69"
    && css["--horror-ambar"] === "#b99a62");
  ok("atributos semânticos refletem as 6 preferências",
    CAMPOS.every((c) => atributos[`data-${c.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}`] !== undefined ||
      Object.values(atributos).includes(VISUAL_PADRAO[c])));
  ok("toda custom property começa com --", Object.keys(css).every((k) => k.startsWith("--")));
  ok("nenhum valor CSS é arbitrário (sem ;{} url() script)",
    Object.values(css).every((v) => !/[;{}]|url\s*\(|javascript|expression|@import/i.test(v)));
}
// Cada intensidade produz multiplicador distinto.
{
  const mapa = {};
  for (const i of INTENSIDADES) mapa[i] = resolverTokensVisuais({ ...VISUAL_PADRAO, intensidade: i }).css["--horror-intensidade"];
  ok("3 intensidades → 3 multiplicadores distintos", new Set(Object.values(mapa)).size === 3, JSON.stringify(mapa));
}
// Cada superfície produz superfícies/sombra distintas e coerentes.
{
  const padrao = resolverTokensVisuais({ ...VISUAL_PADRAO, superficies: "padrao" }).css;
  const flat = resolverTokensVisuais({ ...VISUAL_PADRAO, superficies: "flat" }).css;
  const elevado = resolverTokensVisuais({ ...VISUAL_PADRAO, superficies: "elevado" }).css;
  ok("flat: elevada == superficie e sombra mínima",
    flat["--horror-superficie-elevada"] === flat["--horror-superficie"] && flat["--horror-sombra"] !== padrao["--horror-sombra"]);
  ok("elevado: sombra mais forte que padrao",
    elevado["--horror-superficie-elevada"] !== padrao["--horror-superficie-elevada"]);
  ok("superficie base é sempre a mesma", padrao["--horror-superficie"] === flat["--horror-superficie"] && padrao["--horror-superficie"] === elevado["--horror-superficie"]);
}
// Cada textura produz opacidade distinta (0 / intermediária / máxima).
{
  const vals = TEXTURAS.map((t) => resolverTokensVisuais({ ...VISUAL_PADRAO, textura: t }).css["--horror-textura-opacidade"]);
  ok("nenhuma textura = opacidade 0", vals[0] === "0");
  ok("3 texturas → opacidades crescentes", parseFloat(vals[1]) > 0 && parseFloat(vals[2]) > parseFloat(vals[1]));
}
// Cada densidade produz multiplicador distinto.
{
  const mapa = {};
  for (const d of DENSIDADES) mapa[d] = resolverTokensVisuais({ ...VISUAL_PADRAO, densidade: d }).css["--horror-densidade"];
  ok("compacta < padrao < ampla", parseFloat(mapa.compacta) < parseFloat(mapa.padrao) && parseFloat(mapa.ampla) > parseFloat(mapa.padrao), JSON.stringify(mapa));
}
// resolverTokensVisuais normaliza entrada inválida sem lançar.
ok("resolverTokensVisuais tolera objeto incompleto",
  typeof resolverTokensVisuais({ intensidade: "imersiva" }).css["--horror-intensidade"] === "string");

// ---------- Atmosferas ----------
ok("exatamente 5 atmosferas", ATMOSFERAS_VISUAIS.length === 5);
ok("ids únicos", new Set(ATMOSFERAS_VISUAIS.map((a) => a.id)).size === 5);
const NOMES = ["Arquivo Oculto", "Investigação Noturna", "Ocultismo", "Terror Psicológico", "Mistério Sobrenatural"];
for (const nome of NOMES) {
  const a = ATMOSFERAS_VISUAIS.find((x) => x.nome === nome);
  ok(`preset "${nome}" existe com descrição`, !!a && typeof a.descricao === "string" && a.descricao.length > 0);
  if (a) {
    const p = a.preferencias;
    ok(`preset "${nome}" tem preferências completas e válidas`,
      CAMPOS.every((c) => Object.keys(p).length === 6 &&
        { intensidade: INTENSIDADES, corDestaque: CORES_DESTAQUE, superficies: SUPERFICIES, textura: TEXTURAS, animacoes: ANIMACOES, densidade: DENSIDADES }[c].includes(p[c])));
    ok(`preset "${nome}" resolve tokens sem erro`, Object.keys(resolverTokensVisuais(p).css).length > 0);
  }
}
ok("atmosferaPorId encontra e rejeita desconhecido",
  atmosferaPorId("ocultismo")?.nome === "Ocultismo" && atmosferaPorId("inexistente") === undefined);
// Presets distintos entre si (não são o mesmo objeto com nome diferente).
ok("presets produzem combinações de tokens distintas",
  new Set(ATMOSFERAS_VISUAIS.map((a) => JSON.stringify(resolverTokensVisuais(a.preferencias).css))).size === 5);

// ---------- Movimento reduzido ----------
const base = { ...VISUAL_PADRAO };
ok("SO reduce + app completo → reduzido", movimentoEfetivo({ ...base, animacoes: "completo" }, true) === "reduzido");
ok("SO reduce + app normal → reduzido", movimentoEfetivo({ ...base, animacoes: "normal" }, true) === "reduzido");
ok("SO reduce + app reduzido → reduzido", movimentoEfetivo({ ...base, animacoes: "reduzido" }, true) === "reduzido");
ok("SO permite + app reduzido → reduzido", movimentoEfetivo({ ...base, animacoes: "reduzido" }, false) === "reduzido");
ok("SO permite + app normal → normal", movimentoEfetivo({ ...base, animacoes: "normal" }, false) === "normal");
ok("SO permite + app completo → completo", movimentoEfetivo({ ...base, animacoes: "completo" }, false) === "completo");
ok("movimentoEfetivo normaliza entrada inválida sem lançar",
  movimentoEfetivo({ animacoes: "inventado" }, false) === VISUAL_PADRAO.animacoes);

// ---------- Resumo ----------
const f = falhas();
console.log(`\n${resultados.length - f.length} ok / ${f.length} falhas`);
if (f.length) {
  for (const r of f) console.log(`FALHOU: ${r.nome}`);
  process.exit(1);
}
