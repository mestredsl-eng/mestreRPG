#!/usr/bin/env node
// Gerador da galeria padrão de retratos (Issue #129).
// Produz SVGs vetoriais originais e determinísticos em
// site/public/retratos/ + manifesto TS para o servidor validar ids.
// Arte 100% procedural do projeto — sem fontes externas, sem hotlinks.
// Uso: node scripts/gerar-retratos.mjs   (idempotente; regenera tudo)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR_SVG = join(RAIZ, "site", "public", "retratos");
const ARQ_MANIFESTO = join(RAIZ, "servidor", "src", "lib", "retratos.ts");

// ---------- PRNG determinístico ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const entre = (r, a, b) => a + r() * (b - a);
const ri = (r, a, b) => Math.floor(entre(r, a, b + 1));

// ---------- paletas ----------
const PELES = ["#f6d7b8", "#eec39a", "#d9a066", "#b97a4a", "#8a5432", "#6b4226", "#f9e4cf"];
const PELES_CLARAS = ["#e8e4f2", "#ddd6ea", "#cfc6e0", "#e6e0d4"];
const CABELOS = ["#2b2118", "#4a2f1d", "#6e4a2f", "#8a5a33", "#b08a4f", "#c9a227", "#7a7a7a", "#3d3d5c", "#8c3b3b", "#d8d8d8"];
const OLHOS = ["#3a2a1a", "#5a3a22", "#2e4a3a", "#4a5a8a", "#6a4a8a", "#7a3a3a"];
const ROUPAS = ["#5a4a6a", "#3f5a4a", "#6a3f3f", "#4a5a7a", "#7a5a3a", "#555f6e", "#6e4a6e", "#3a6a6a"];
const FUNDO_H = ["#2e3a55", "#3a2e4a", "#274a44", "#4a3a2e", "#3a3550", "#46324a"];
const FUNDO_CRIATURA = ["#2a2438", "#33272a", "#243038", "#2e3324", "#38283a", "#28322e"];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------- primitivas ----------
function fundo(id, cor1, cor2) {
  return `<defs>
    <linearGradient id="bg${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${cor1}"/><stop offset="1" stop-color="${cor2}"/>
    </linearGradient>
    <radialGradient id="hl${id}" cx="0.5" cy="0.38" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.22"/>
    </radialGradient>
  </defs>
  <rect width="200" height="200" fill="url(#bg${id})"/>
  <rect width="200" height="200" fill="url(#hl${id})"/>`;
}

function torso(corRoupa, decote = "simples") {
  // ombros + tronco até a base do quadro
  let extra = "";
  if (decote === "gola") extra = `<path d="M78 158 L100 172 L122 158 L122 178 L78 178 Z" fill="#1d1a24"/>`;
  if (decote === "capuz") extra = `<path d="M60 200 Q60 138 100 132 Q140 138 140 200 Z" fill="#241f30" opacity="0.85"/>`;
  return `<path d="M40 200 Q42 158 78 150 L122 150 Q158 158 160 200 Z" fill="${corRoupa}"/>
    <path d="M86 150 Q100 162 114 150 L110 142 Q100 150 90 142 Z" fill="#ffffff" opacity="0.18"/>${extra}`;
}

function pescoco(cor) {
  return `<path d="M88 128 L88 152 Q100 160 112 152 L112 128 Z" fill="${cor}"/>`;
}

function orelhas(cor, pontudas = false, longas = false) {
  const forma = pontudas
    ? `M60 92 L50 ${longas ? 78 : 86} L66 96 Z M140 92 L150 ${longas ? 78 : 86} L134 96 Z`
    : `M60 94 Q52 96 54 106 Q56 114 64 112 L66 100 Z M140 94 Q148 96 146 106 Q144 114 136 112 L134 100 Z`;
  return `<path d="${forma}" fill="${cor}"/>`;
}

function rosto(corPele, olhosCor, expressao = 0) {
  // cabeça + rosto neutro; expressao: 0 neutro, 1 sério, 2 leve sorriso
  const boca = expressao === 2
    ? `<path d="M92 122 Q100 128 108 122" stroke="#7a4038" stroke-width="2.4" fill="none" stroke-linecap="round"/>`
    : expressao === 1
      ? `<path d="M93 124 L107 124" stroke="#7a4038" stroke-width="2.4" stroke-linecap="round"/>`
      : `<path d="M94 123 Q100 126 106 123" stroke="#7a4038" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  return `<ellipse cx="100" cy="94" rx="37" ry="43" fill="${corPele}"/>
    ${orelhas(corPele)}
    <ellipse cx="84" cy="92" rx="6.5" ry="4.2" fill="#ffffff"/>
    <ellipse cx="116" cy="92" rx="6.5" ry="4.2" fill="#ffffff"/>
    <circle cx="85" cy="93" r="3.1" fill="${olhosCor}"/><circle cx="115" cy="93" r="3.1" fill="${olhosCor}"/>
    <circle cx="85" cy="93" r="1.4" fill="#1c1a22"/><circle cx="115" cy="93" r="1.4" fill="#1c1a22"/>
    <path d="M78 82 Q84 79 90 81 M110 81 Q116 79 122 82" stroke="#3a2c20" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M99 96 Q97 104 100 107 Q103 104 101 96" fill="none" stroke="#00000022" stroke-width="1.6"/>
    ${boca}`;
}

// ---------- cabelos ----------
function cabeloCurto(cor, estilo, r) {
  switch (estilo) {
    case 0: return `<path d="M62 92 Q60 52 100 50 Q140 52 138 92 Q136 66 118 62 Q128 74 124 84 Q112 66 96 64 Q80 64 74 76 Q66 70 62 92 Z" fill="${cor}"/>`;
    case 1: return `<path d="M60 96 L64 58 L76 66 L72 52 L88 58 L86 46 L100 54 L114 46 L112 58 L128 52 L124 66 L136 58 L140 96 Q120 70 100 68 Q80 70 60 96 Z" fill="${cor}"/>`;
    case 2: return `<path d="M62 94 Q58 50 100 48 Q142 50 138 94 L132 78 Q128 62 100 60 Q72 62 68 78 Z" fill="${cor}"/><path d="M66 60 L74 52 L80 60 L88 50 L96 58 L104 50 L112 60 L120 52 L128 60 L134 54" stroke="${cor}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
    case 3: return `<path d="M60 98 Q56 48 100 46 Q144 48 140 98 Q138 72 128 62 Q140 78 134 92 Q120 68 100 66 Q80 68 66 92 Q60 78 72 62 Q62 72 60 98 Z" fill="${cor}"/>`;
    default: return `<path d="M62 92 Q60 52 100 50 Q140 52 138 92 Q134 64 100 60 Q66 64 62 92 Z" fill="${cor}"/>`;
  }
}

function cabeloLongo(cor, r) {
  const variante = ri(r, 0, 2);
  const costas = variante === 0
    ? `<path d="M58 96 Q52 170 62 200 L138 200 Q148 170 142 96 Q146 130 138 96 Q128 66 100 62 Q72 66 62 96 Q54 130 58 96 Z" fill="${cor}"/>`
    : variante === 1
      ? `<path d="M60 94 Q54 160 66 200 L134 200 Q146 160 140 94 Q142 140 132 100 Q120 66 100 62 Q80 66 68 100 Q58 140 60 94 Z" fill="${cor}"/>`
      : `<path d="M60 94 Q56 150 64 200 L136 200 Q144 150 140 94 L134 110 Q138 160 132 200 L68 200 Q62 160 66 110 Z" fill="${cor}"/>`;
  const topo = `<path d="M62 92 Q60 50 100 48 Q140 50 138 92 Q134 62 100 58 Q66 62 62 92 Z" fill="${cor}"/>`;
  return costas + topo;
}

function barba(cor, estilo) {
  if (estilo === 0) return "";
  if (estilo === 1) return `<path d="M74 116 Q78 138 100 142 Q122 138 126 116 Q118 128 100 129 Q82 128 74 116 Z" fill="${cor}" opacity="0.9"/>`;
  return `<path d="M72 112 Q76 134 100 138 Q124 134 128 112 Q124 124 112 126 Q104 118 100 118 Q96 118 88 126 Q76 124 72 112 Z" fill="${cor}"/>`;
}

// ---------- categorias ----------
function humano(id, r, feminino) {
  const pele = pick(r, PELES);
  const cabelo = pick(r, CABELOS);
  const olhos = pick(r, OLHOS);
  const roupa = pick(r, ROUPAS);
  const fundoCor = pick(r, FUNDO_H);
  const longo = feminino ? r() < 0.65 : r() < 0.15;
  const cabeloHtml = longo ? cabeloLongo(cabelo, r) : cabeloCurto(cabelo, ri(r, 0, 4), r);
  const b = feminino ? pick(r, [0, 0, 1, 2]) : pick(r, [0, 1, 1, 2, 3]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#171a26")}
${torso(roupa, pick(r, ["simples", "gola", "simples"]))}
${pescoco(pele)}
${rosto(pele, olhos, ri(r, 0, 2))}
${cabeloHtml}
${barba(cabelo, b)}
</svg>`;
}

function vampiro(id, r, feminino) {
  const pele = pick(r, PELES_CLARAS);
  const cabelo = pick(r, ["#1a1626", "#241d33", "#2e2438", "#3a2f4a"]);
  const olhos = pick(r, ["#8a1f2d", "#a02030", "#701a24"]);
  const roupa = pick(r, ["#1d1a26", "#241f2e", "#2e2438", "#1a1f2e"]);
  const fundoCor = pick(r, ["#3a1f2e", "#2e1a30", "#331f28", "#2a2038"]);
  // cabelo colado para trás + entrada em V
  const franja = `<path d="M64 88 Q66 52 100 50 Q134 52 136 88 L128 76 Q124 62 100 60 Q76 62 72 76 Z" fill="${cabelo}"/>
    <path d="M92 56 L100 66 L108 56 L104 50 L96 50 Z" fill="${pele}"/>`;
  const cabeloLongoHtml = feminino ? cabeloLongo(cabelo, r) : "";
  const presa = feminino
    ? `<path d="M60 96 Q54 160 64 200 L72 200 Q64 150 68 104 Z M140 96 Q146 160 136 200 L128 200 Q136 150 132 104 Z" fill="${cabelo}"/>`
    : "";
  // presas + sorriso
  const rostoV = rosto(pele, olhos, 1)
    .replace(/<path d="M93 124 L107 124"[^/]*\/>/, "")
    .replace(/<path d="M94 123[^/]*\/>/, `<path d="M90 120 Q100 128 110 120" stroke="#5a2a30" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M94 124 L97 131 L100 124 L103 131 L106 124" fill="#f4f0e8"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#140f1c")}
${torso(roupa, "gola")}
${pescoco(pele)}
${rostoV}
${franja}${presa}${cabeloLongoHtml}
</svg>`;
}

function lobisomem(id, r) {
  const pelagem = pick(r, ["#6e5138", "#5a4630", "#7a5c40", "#4e3d2c", "#8a6a48"]);
  const pelagemEscura = "#3e2f22";
  const olhos = pick(r, ["#e8c53a", "#d8a03a", "#c8d84a"]);
  const roupa = pick(r, ["#4a3a2c", "#3a3028", "#54432f"]);
  const fundoCor = pick(r, ["#3a2e22", "#2e2620", "#40301f"]);
  const cabeça = `<ellipse cx="100" cy="96" rx="40" ry="44" fill="${pelagem}"/>
    <path d="M62 84 L48 66 L74 78 Z M138 84 L152 66 L126 78 Z" fill="${pelagem}"/>
    <ellipse cx="82" cy="96" rx="7" ry="4.6" fill="#ffd76a"/><ellipse cx="118" cy="96" rx="7" ry="4.6" fill="#ffd76a"/>
    <ellipse cx="82" cy="96" rx="2.6" ry="4" fill="#1a120c"/><ellipse cx="118" cy="96" rx="2.6" ry="4" fill="#1a120c"/>
    <path d="M78 84 Q82 80 88 82 M112 82 Q118 80 122 84" stroke="${pelagemEscura}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <ellipse cx="100" cy="116" rx="17" ry="12" fill="${pelagemEscura}"/>
    <ellipse cx="100" cy="112" rx="7" ry="5" fill="${pelagemEscura}"/>
    <path d="M94 120 L97 127 L100 120 L103 127 L106 120" fill="#efe6d4"/>
    <path d="M70 108 Q62 112 64 122 Q68 116 74 114 M130 108 Q138 112 136 122 Q132 116 126 114" fill="${pelagem}"/>`;
  const costas = `<path d="M56 200 Q56 158 92 150 L108 150 Q144 158 144 200 Z" fill="${pelagem}"/>
    <path d="M76 152 L84 168 L92 154 L100 170 L108 154 L116 168 L124 152 L120 200 L80 200 Z" fill="${pelagemEscura}" opacity="0.55"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#191510")}
${costas}
${cabeça}
</svg>`;
}

// ---------- criaturas (40) ----------
function fantasma(id, r) {
  const tom = pick(r, ["#cfe8ff", "#d8f0e0", "#e8dcff", "#ffe8d0", "#d0f0f0"]);
  const olho = pick(r, ["#2a3a55", "#3a2a4a", "#2a4a3a"]);
  const fundoCor = pick(r, FUNDO_CRIATURA);
  const ondas = Array.from({ length: 4 }, (_, i) => {
    const x = 62 + i * 24;
    return `<path d="M${x} 168 q6 -10 12 0 q6 10 12 0" stroke="${tom}" stroke-width="10" fill="none" stroke-linecap="round" opacity="0.9"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#10141f")}
<path d="M60 60 Q60 30 100 30 Q140 30 140 60 L140 150 Q134 160 128 150 Q122 162 116 150 Q110 160 104 150 Q98 162 92 150 Q86 160 80 150 Q74 162 68 150 Q62 160 60 148 Z" fill="${tom}" opacity="0.92"/>
<ellipse cx="84" cy="86" rx="7" ry="10" fill="${olho}"/><ellipse cx="116" cy="86" rx="7" ry="10" fill="${olho}"/>
<ellipse cx="86" cy="83" rx="2.4" ry="3.4" fill="#ffffff"/><ellipse cx="118" cy="83" rx="2.4" ry="3.4" fill="#ffffff"/>
${ri(r, 0, 1) ? `<ellipse cx="100" cy="112" rx="9" ry="7" fill="${olho}"/>` : `<path d="M92 112 Q100 118 108 112" stroke="${olho}" stroke-width="3" fill="none" stroke-linecap="round"/>`}
${ondas}
</svg>`;
}

function esqueleto(id, r) {
  const osso = pick(r, ["#e8e2d0", "#ddd5c0", "#efe8d8"]);
  const fundoCor = pick(r, FUNDO_CRIATURA);
  const chamas = ri(r, 0, 1) === 0
    ? `<ellipse cx="100" cy="70" rx="34" ry="40" fill="#ff9a3a" opacity="0.18"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#14100c")}
${chamas}
<path d="M62 200 Q60 160 78 152 L122 152 Q140 160 138 200 Z" fill="#2c2620"/>
<path d="M74 152 L126 152 L120 200 L80 200 Z" fill="#241f1a"/>
<ellipse cx="100" cy="98" rx="34" ry="38" fill="${osso}"/>
<ellipse cx="86" cy="92" rx="9" ry="11" fill="#14100c"/><ellipse cx="114" cy="92" rx="9" ry="11" fill="#14100c"/>
<path d="M92 112 L108 112 L100 122 Z" fill="#14100c"/>
<path d="M88 130 Q100 136 112 130" stroke="#14100c" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M62 84 Q54 96 60 106 M138 84 Q146 96 140 106" stroke="${osso}" stroke-width="4" fill="none"/>
</svg>`;
}

function orc(id, r) {
  const pele = pick(r, ["#5a7a3a", "#6a8a44", "#4e6e34", "#7a8a4a"]);
  const cabelo = pick(r, ["#3a2c1c", "#2c2418", "#4a3a24"]);
  const roupa = pick(r, ["#4a3a2c", "#3c3226", "#54432f"]);
  const fundoCor = pick(r, FUNDO_CRIATURA);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#121a10")}
${torso(roupa, "gola")}
${pescoco(pele)}
<ellipse cx="100" cy="96" rx="38" ry="43" fill="${pele}"/>
<path d="M64 82 L50 66 L76 76 Z M136 82 L150 66 L124 76 Z" fill="${pele}"/>
<path d="M66 88 Q72 60 100 58 Q128 60 134 88 Q118 72 100 70 Q82 72 66 88 Z" fill="${cabelo}"/>
<ellipse cx="84" cy="94" rx="6" ry="3.6" fill="#e8d84a"/><ellipse cx="116" cy="94" rx="6" ry="3.6" fill="#e8d84a"/>
<ellipse cx="84" cy="94" rx="2.4" ry="3" fill="#1a120c"/><ellipse cx="116" cy="94" rx="2.4" ry="3" fill="#1a120c"/>
<path d="M76 80 Q84 76 92 79 M108 79 Q116 76 124 80" stroke="${cabelo}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
<path d="M96 108 L104 108 L100 114 Z" fill="${pele}"/>
<path d="M88 122 Q100 130 112 122" stroke="#3a2c1c" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M82 120 L88 130 L94 120 L100 131 L106 120 L112 131 L118 120" fill="#efe6d4"/>
</svg>`;
}

function slime(id, r) {
  const corpo = pick(r, ["#5ac86a", "#4ab8d8", "#8a6ae0", "#e08a4a", "#d85a8a"]);
  const corpoEscuro = "#00000033";
  const fundoCor = pick(r, FUNDO_CRIATURA);
  const olhos = ri(r, 0, 1) === 0
    ? `<ellipse cx="80" cy="100" rx="8" ry="11" fill="#ffffff"/><ellipse cx="120" cy="100" rx="8" ry="11" fill="#ffffff"/>
       <circle cx="81" cy="102" r="3.4" fill="#1a2430"/><circle cx="121" cy="102" r="3.4" fill="#1a2430"/>`
    : `<circle cx="82" cy="100" r="5" fill="#1a2430"/><circle cx="118" cy="100" r="5" fill="#1a2430"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#10141f")}
<path d="M48 170 Q40 96 100 88 Q160 96 152 170 Q146 178 140 170 Q136 180 130 170 Q124 180 118 170 Q112 180 106 170 Q100 180 94 170 Q88 180 82 170 Q76 180 70 170 Q64 180 58 170 Q52 178 48 170 Z" fill="${corpo}"/>
<ellipse cx="72" cy="130" rx="10" ry="6" fill="${corpoEscuro}"/><ellipse cx="130" cy="146" rx="8" ry="5" fill="${corpoEscuro}"/>
${olhos}
<path d="M90 122 Q100 128 110 122" stroke="#1a2430" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`;
}

function demonio(id, r) {
  const pele = pick(r, ["#8a3a3a", "#7a3038", "#94404a", "#6e2f3a"]);
  const chifre = pick(r, ["#d8c8a8", "#c8b898", "#e0d0b0"]);
  const roupa = pick(r, ["#2e1a22", "#241a20", "#33202a"]);
  const fundoCor = pick(r, ["#3a1a1a", "#2e1620", "#401818"]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#160c10")}
${torso(roupa, "gola")}
${pescoco(pele)}
<path d="M64 78 L54 44 L80 62 Z M136 78 L146 44 L120 62 Z" fill="${chifre}"/>
<ellipse cx="100" cy="96" rx="38" ry="44" fill="${pele}"/>
<ellipse cx="84" cy="92" rx="6.5" ry="3.8" fill="#ffd84a"/><ellipse cx="116" cy="92" rx="6.5" ry="3.8" fill="#ffd84a"/>
<ellipse cx="84" cy="92" rx="2.2" ry="3.4" fill="#1a0c0c"/><ellipse cx="116" cy="92" rx="2.2" ry="3.4" fill="#1a0c0c"/>
<path d="M76 80 Q84 74 92 79 M108 79 Q116 74 124 80" stroke="#3a1414" stroke-width="3.4" fill="none" stroke-linecap="round"/>
<path d="M88 118 L94 132 L100 120 L106 132 L112 118" fill="#efe6d4"/>
<path d="M90 132 Q100 140 110 132" stroke="#3a1414" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`;
}

function mumia(id, r) {
  const pano = pick(r, ["#d8cdb4", "#cfc4a8", "#e0d6bc", "#c8b89a"]);
  const sombra = "#a89878";
  const fundoCor = pick(r, FUNDO_CRIATURA);
  const faixas = [120, 132, 144, 156].map((y, i) =>
    `<path d="M60 ${y} Q100 ${y + (i % 2 ? 8 : -4)} 140 ${y}" stroke="${sombra}" stroke-width="4" fill="none" opacity="0.7"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#161310")}
${torso(pano, "gola")}
<path d="M62 200 Q62 156 100 152 Q138 156 138 200 Z" fill="${pano}"/>
${faixas.replace(/M60/g, "M58").replace(/140/g, "142")}
<ellipse cx="100" cy="96" rx="36" ry="42" fill="${pano}"/>
<ellipse cx="86" cy="92" rx="7" ry="8" fill="#241f18"/><ellipse cx="114" cy="92" rx="7" ry="8" fill="#241f18"/>
<circle cx="88" cy="90" r="2.2" fill="#d8c89a"/><circle cx="116" cy="90" r="2.2" fill="#d8c89a"/>
<path d="M90 114 L110 114 L100 124 Z" fill="#241f18"/>
<path d="M92 128 Q100 133 108 128" stroke="#241f18" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M64 70 Q60 96 66 116 M136 70 Q140 96 134 116" stroke="${sombra}" stroke-width="5" fill="none" opacity="0.6"/>
</svg>`;
}

function golem(id, r) {
  const pedra = pick(r, ["#8a8578", "#7a7568", "#948e80", "#6e6a60"]);
  const fundoCor = pick(r, FUNDO_CRIATURA);
  const musgo = pick(r, ["#5a7a3a", "#4e6e34", "#6a8a44"]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="retrato">
${fundo(id, fundoCor, "#141210")}
<path d="M52 200 Q50 156 84 148 L116 148 Q150 156 148 200 Z" fill="${pedra}"/>
<path d="M70 152 L80 170 L92 154 L104 172 L116 154 L128 170 L130 152 Z" fill="${musgo}" opacity="0.7"/>
<path d="M64 92 L56 70 L78 82 Z M136 92 L144 70 L122 82 Z" fill="${pedra}"/>
<path d="M62 90 Q62 48 100 46 Q138 48 138 90 L134 76 Q128 60 100 58 Q72 60 66 76 Z" fill="${pedra}"/>
<rect x="80" y="80" width="16" height="12" rx="3" fill="#2a2620"/><rect x="104" y="80" width="16" height="12" rx="3" fill="#2a2620"/>
<rect x="86" y="83" width="5" height="6" rx="2" fill="#e8c53a"/><rect x="110" y="83" width="5" height="6" rx="2" fill="#e8c53a"/>
<path d="M90 112 L110 112 L100 122 Z" fill="#2a2620"/>
<path d="M66 116 Q74 122 82 118 M134 118 Q126 122 118 118" stroke="#2a2620" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>`;
}

const CRIATURAS = [
  ["fantasma", fantasma, 10],
  ["esqueleto", esqueleto, 8],
  ["orc", orc, 7],
  ["slime", slime, 6],
  ["demonio", demonio, 5],
  ["mumia", mumia, 4],
];

// ---------- manifesto ----------
const CATEGORIAS = [
  ["homem", "Homem humano", 20, (id, r) => humano(id, r, false)],
  ["mulher", "Mulher humana", 20, (id, r) => humano(id, r, true)],
  ["vampiro", "Vampiro", 20, (id, r) => vampiro(id, r, false)],
  ["vampira", "Vampira", 20, (id, r) => vampiro(id, r, true)],
  ["lobisomem", "Lobisomem", 20, (id, r) => lobisomem(id, r)],
];

const manifesto = [];
mkdirSync(DIR_SVG, { recursive: true });
let total = 0;

for (const [cat, rotulo, qtd, gen] of CATEGORIAS) {
  for (let i = 1; i <= qtd; i++) {
    const id = `${cat}-${String(i).padStart(2, "0")}`;
    const r = mulberry32(0x9e37 + cat.length * 131 + i * 17);
    const svg = gen(id, r);
    writeFileSync(join(DIR_SVG, `${id}.svg`), svg + "\n");
    manifesto.push({ id, arquivo: `${id}.svg`, categoria: cat, rotulo: `${rotulo} ${String(i).padStart(2, "0")}` });
    total++;
  }
}

// criaturas: distribuição fixa por subtipo
let restante = 40;
for (const [sub, gen, n] of CRIATURAS) {
  const qtd = Math.min(n, restante);
  for (let i = 1; i <= qtd; i++) {
    const id = `criatura-${sub}-${String(i).padStart(2, "0")}`;
    const r = mulberry32(0x51a7 + sub.length * 977 + i * 31);
    const svg = gen(id, r);
    writeFileSync(join(DIR_SVG, `${id}.svg`), svg + "\n");
    manifesto.push({ id, arquivo: `${id}.svg`, categoria: "criatura", rotulo: `${sub} ${i}` });
    total++;
  }
  restante -= qtd;
}

// fallback caso a distribuição não feche 40
for (let i = 1; restante > 0 && i <= 60; i++) {
  const sub = CRIATURAS[i % CRIATURAS.length][0];
  const gen = CRIATURAS[i % CRIATURAS.length][1];
  const id = `criatura-${sub}-${String(i).padStart(2, "0")}`;
  const r = mulberry32(0x51a7 + i * 131);
  writeFileSync(join(DIR_SVG, `${id}.svg`), gen(id, r) + "\n");
  manifesto.push({ id, arquivo: `${id}.svg`, categoria: "criatura", rotulo: `${sub} extra ${i}` });
  restante--; total++;
}

// índice JSON para o picker do site (mesma fonte do manifesto TS)
writeFileSync(join(DIR_SVG, "indice.json"), JSON.stringify({ retratos: manifesto }, null, 1) + "\n");

// manifesto TS para validação server-side (sem depender de site/dist)
const linhas = manifesto.map((m) => `  { id: ${JSON.stringify(m.id)}, arquivo: ${JSON.stringify(m.arquivo)}, categoria: ${JSON.stringify(m.categoria)}, rotulo: ${JSON.stringify(m.rotulo)} },`).join("\n");
writeFileSync(ARQ_MANIFESTO, `// GERADO por scripts/gerar-retratos.mjs — não editar à mão.
// Galeria padrão de retratos (Issue #129): arte SVG procedural original
// do projeto, servida estaticamente em /retratos/. Ver CREDITOS-RETRATOS.md.
export interface RetratoGaleria {
  id: string;
  arquivo: string;
  categoria: "homem" | "mulher" | "vampiro" | "vampira" | "lobisomem" | "criatura";
  rotulo: string;
}

export const RETRATOS_GALERIA: readonly RetratoGaleria[] = [
${linhas}
] as const;

const POR_ID = new Map(RETRATOS_GALERIA.map((r) => [r.id, r]));

export function retratoGaleriaPorId(id: string): RetratoGaleria | null {
  return POR_ID.get(id) ?? null;
}

/** Caminho público estável do retrato (servido pelo build do site). */
export function urlRetratoGaleria(r: RetratoGaleria): string {
  return \`/retratos/\${r.arquivo}\`;
}
`);

console.log(`retratos gerados: ${total} em ${DIR_SVG}`);
console.log(`manifesto: ${ARQ_MANIFESTO}`);
