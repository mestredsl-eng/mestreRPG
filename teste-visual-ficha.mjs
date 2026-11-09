// Teste visual da ficha — sobe o servidor numa CÓPIA do banco real,
// navega até a ficha de um personagem real e captura screenshots +
// métricas de layout (sobreposição, overflow horizontal, limites) em
// 5 resoluções. Não grava nada no banco real (banco é cópia isolada).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";
import { chromium } from "playwright";

const DIR = "visual-ficha-limpeza/teste";
const BANCO = `${DIR}/mestre-rpg-teste.db`;
const SHOTS = "visual-ficha-limpeza/shots";
mkdirSync(DIR, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
for (const suf of ["", "-wal", "-shm"]) rmSync(BANCO + suf, { force: true });
{
  const orig = new Database("banco/mestre-rpg.db", { readonly: true });
  orig.prepare(`VACUUM INTO '${BANCO.replace(/\\/g, "/")}'`).run();
  orig.close();
}

function portaLivre() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function esperarSaudavel(base, proc) {
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { }
    if (proc.exitCode !== null) throw new Error("servidor morreu: " + proc.exitCode);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("timeout");
}
function sessaoDb() {
  const db = new Database(BANCO);
  const u = db.prepare("select id from users where username='administrador'").get();
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "visual", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return token;
}

const RESOLUCOES = [
  [1920, 1080], [1600, 900], [1366, 768], [768, 1024], [390, 844],
];

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = spawn("node", ["servidor/dist/index.js"], {
  env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: DIR + "/arq", MESTRE_BACKUPS: DIR + "/bks" },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stderr.on("data", (d) => process.stderr.write(d));

try {
  await esperarSaudavel(base, proc);
  const token = sessaoDb();
  const cookie = `mestre_rpg_session=${encodeURIComponent(token)}`;
  const api = async (metodo, path, body) => {
    const r = await fetch(base + "/api" + path, {
      method: metodo,
      headers: { "content-type": "application/json", cookie },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  // Garante um personagem com dados realistas na CÓPIA do banco
  // (versão rascunho da ficha real — a mesma que o editor mostra).
  const cid = "7a1c9c2e-3c7a-4805-9145-d8622d755a36"; // Caçadores & Caças
  const campanha = { id: cid, name: "Caçadores & Caças" };
  const sn = (pares) => pares.map(([key, nivel]) => ({ key, nivel }));
  const dados = {
    "5b0ca693": "Kaelen, o Exterminador Implacável das Sombras Eterna",
    "107c7c6f": 34,
    "8e468977": "Masculino:",
    "f13e57cf": "- Morena clara:",
    "8da47020": "investigador",
    "f1254168": sn([["forca",4],["destreza",3],["vitalidade",3],["inteligencia",2],["percepcao",3],["carisma",1],["vigor",2],["raciocinio",2],["aparencia",1],["manipulacao",1]]),
    "630f86ae": sn([["armas_de_fogo",3],["armas_brancas",2],["furtividade",2],["seguranca",1],["sobrevivencia",1],["conducao",1],["etiqueta",1],["performace",1],["influencer",1],["criminoso",1],["empatia_com_animal",1]]),
    "0094021c": sn([["artista",3],["lutador",2],["hacker",2],["lideranca",1],["intimidacao",1],["esquiva",1],["labia",1],["quimico",1],["tecnologia",1],["esportes",1],["prontidao",1]]),
    "46504ccd": sn([["ciencias",2],["investigacao",2],["medicina",1],["direito",1],["financas",1],["ocultismo",1],["computador",1],["linguistica",1],["politica",1],["geologia",1],["academicos",1]]),
    "11b55b5d": sn([["cego",2],["drogado",1],["passado_criminoso",2],["mentiroso",1],["agressivo",1],["audicao_debilitada",1],["coordenacao_motora_debilitada",1]]),
    "bb1573df": sn([["contatos_influentes",2],["chacra",3]]),
    "d2fd135b": sn([["coragem",2],["humanidade",1],["auto_controlhe",3]]),
    "95c409e4": sn([["magia",2],["feitico",1]]),
  };
  {
    const db = new Database(BANCO);
    db.prepare(`delete from characters where campaign_id=?`).run(cid);
    db.prepare(`insert into characters (id,campaign_id,membership_id,template_version_id,name,data,status,created_at,updated_at,overrides)
      values (?,?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), cid, "5572a784-9bf6-4e41-b284-62df0cf6f7b4",
        "2c9579b2-b290-4fe5-b8a7-0895887bab9f", "Visual Teste",
        JSON.stringify(dados), "ativo", Date.now(), Date.now(), "{}");
    db.close();
  }
  console.log(`campanha="${campanha.name}" (personagem visual inserido)`);

  const browser = await chromium.launch();

  for (const [w, h] of RESOLUCOES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: token, domain: "127.0.0.1", path: "/" }]);
    const page = await ctx.newPage();
    await page.goto(base + "/", { waitUntil: "networkidle" });
    // Campanhas → campanha → Personagens → primeiro personagem
    await page.getByRole("button", { name: "Campanhas" }).click();
    await page.locator(".cartao-campanha", { hasText: campanha.name }).first().click();
    await page.getByRole("button", { name: "Personagens" }).click();
    await page.locator("table.tabela tbody tr.clicavel").first().click();
    await page.locator(".ficha").waitFor({ timeout: 15000 });
    await page.waitForTimeout(600); // fontes/layout settle

    const metricas = await page.evaluate(() => {
      const doc = document.documentElement;
      const out = { hScroll: doc.scrollWidth - doc.clientWidth, sobreposicoes: [], foraDaSecao: [], fichaAltura: 0, secoes: [] };
      const ficha = document.querySelector(".ficha");
      if (ficha) out.fichaAltura = Math.round(ficha.getBoundingClientRect().height);
      document.querySelectorAll(".ficha .ficha-secao").forEach((sec) => {
        const r = sec.getBoundingClientRect();
        const itens = sec.querySelectorAll(".nivel-item").length;
        const s = {
          titulo: sec.querySelector("h3")?.textContent?.trim(),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          itens, campos: [],
        };
        sec.querySelectorAll(":scope > .campo").forEach((c) => {
          const cr = c.getBoundingClientRect();
          const sn = c.querySelector(".selecao-nivel");
          s.campos.push({
            label: c.querySelector(".campo-label")?.textContent?.trim().slice(0, 25),
            h: Math.round(cr.height), w: Math.round(cr.width),
            cols: sn ? getComputedStyle(sn).gridTemplateColumns.split(" ").length : null,
          });
        });
        out.secoes.push(s);
      });
      // 1) label sobrepondo conteúdo do mesmo campo
      document.querySelectorAll(".ficha .campo").forEach((campo) => {
        const label = campo.querySelector(":scope > .campo-label");
        const conteudo = label?.nextElementSibling;
        if (!label || !conteudo) return;
        const lr = label.getBoundingClientRect(), cr = conteudo.getBoundingClientRect();
        if (lr.bottom > cr.top + 1 && lr.height > 0 && cr.height > 0) {
          out.sobreposicoes.push({ campo: campo.className, label: label.textContent.trim().slice(0, 40), inv: lr.bottom - cr.top });
        }
      });
      // 2) itens de nível/cartões vazando da seção pai
      document.querySelectorAll(".ficha-secao").forEach((sec) => {
        const sr = sec.getBoundingClientRect();
        sec.querySelectorAll(".nivel-item, .opcoes label, input, select, textarea").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0) return;
          if (r.right > sr.right + 1 || r.left < sr.left - 1) {
            out.foraDaSecao.push({ secao: sec.querySelector("h3")?.textContent, el: el.className || el.tagName, excess: Math.round(Math.max(r.right - sr.right, sr.left - r.left)) });
          }
        });
      });
      // 3) transição Defeitos→Qualidades: mede gap real entre último item do campo anterior e o label
      const labels = [...document.querySelectorAll(".ficha .campo-label")];
      labels.forEach((lab, i) => {
        const txt = lab.textContent.trim().toLowerCase();
        if (!/qualidade|defeito/.test(txt)) return;
        const campo = lab.closest(".campo");
        const prev = campo?.previousElementSibling;
        if (!prev) return;
        const ultimoItem = prev.querySelector(".nivel-item:last-of-type, .opcoes label:last-of-type");
        if (!ultimoItem) return;
        const gap = lab.getBoundingClientRect().top - ultimoItem.getBoundingClientRect().bottom;
        out[`gap_${txt.slice(0, 12).replace(/\s/g, "_")}`] = Math.round(gap * 10) / 10;
      });
      return out;
    });

    const nome = `${w}x${h}`;
    await page.screenshot({ path: `${SHOTS}/${nome}.png`, fullPage: true });
    console.log(`\n== ${nome} ==`);
    console.log("  hScroll excedente(px):", metricas.hScroll, metricas.hScroll > 0 ? "FALHOU" : "ok");
    console.log("  altura .ficha(px):", metricas.fichaAltura);
    console.log("  sobreposições label→conteúdo:", metricas.sobreposicoes.length ? JSON.stringify(metricas.sobreposicoes) : "nenhuma");
    console.log("  elementos fora da seção:", metricas.foraDaSecao.length ? JSON.stringify(metricas.foraDaSecao.slice(0, 5)) : "nenhum");
    for (const k of Object.keys(metricas)) if (k.startsWith("gap_")) console.log(`  ${k}:`, metricas[k], "px");
    for (const s of metricas.secoes) {
      console.log(`    [${s.titulo}] x=${s.x} y=${s.y} w=${s.w} h=${s.h} itens=${s.itens}`);
      for (const c of s.campos ?? []) console.log(`      campo "${c.label}" w=${c.w} h=${c.h} colsSn=${c.cols}`);
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  proc.kill();
}
console.log("\nfim");
