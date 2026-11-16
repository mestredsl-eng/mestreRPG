#!/usr/bin/env node
// Homologação visual do retrato de personagem (Issue #129):
// fallback de iniciais, galeria com filtro/busca, upload próprio,
// remoção, avatar na lista e na ficha, responsividade mobile.
import { chromium } from "playwright";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

// PNG 64x64 mínimo para upload via input[type=file].
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(tipo, dados) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png64() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const cru = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) {
    const off = y * (1 + 64 * 3); cru[off] = 0;
    for (let x = 0; x < 64; x++) {
      const px = off + 1 + x * 3;
      cru[px] = 30; cru[px + 1] = 90; cru[px + 2] = 200;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(cru)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DIR = dirTeste("retrato-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha Teste";

let browser, proc;
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
}
async function abrirPersonagem(page, nome) {
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
  await page.locator("tr.clicavel", { hasText: nome }).first().click();
  await page.waitForTimeout(700);
}
async function abrirModalRetrato(page) {
  await page.getByRole("button", { name: "Alterar retrato" }).click();
  await page.getByRole("dialog", { name: /Retrato de/ }).waitFor({ timeout: 10000 });
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);
  c.novoPersonagem(c.jogadores.jogador1.membershipId, "Heroína Retrato");
  browser = await chromium.launch();

  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg = await ctx.newPage();
  await login(pg, "jogador_um", "senha-jogador-123");
  await irCampanha(pg);

  sec("1. Ficha sem retrato — fallback de iniciais");
  await pg.locator(".abas button", { hasText: "Personagens" }).first().click();
  await pg.locator("tr.clicavel", { hasText: "Heroína Retrato" }).first().waitFor({ timeout: 15000 });
  const listaAvatar = pg.locator("table .avatar-fallback").first();
  t("1a. lista mostra fallback de iniciais", await listaAvatar.count() > 0);
  await abrirPersonagem(pg, "Heroína Retrato");
  const avatarFallback = pg.locator(".ficha-cartao .avatar-fallback, .cartao .avatar-fallback").first();
  t("1b. ficha mostra fallback de iniciais", await avatarFallback.count() > 0);

  sec("2. Galeria padrão — filtro e seleção");
  await abrirModalRetrato(pg);
  const grade = pg.locator(".grade-retratos .retrato-opcao");
  await grade.first().waitFor({ timeout: 10000 });
  const total = await grade.count();
  t("2a. galeria carrega retratos", total >= 100, `total=${total}`);
  await pg.getByRole("button", { name: "Mulheres", exact: true }).click();
  await pg.waitForTimeout(300);
  const filtradas = await grade.count();
  t("2b. filtro 'Mulheres' reduz a grade", filtradas === 20 && filtradas < total, `${filtradas}/${total}`);
  await pg.getByRole("button", { name: "Todas", exact: true }).click();
  await pg.getByLabel("Buscar retrato").fill("vampira 07");
  await pg.waitForTimeout(300);
  const buscadas = await grade.count();
  t("2c. busca 'vampira 07' encontra 1 retrato", buscadas === 1, `total=${buscadas}`);
  await pg.getByLabel("Buscar retrato").fill("");
  await pg.waitForTimeout(200);
  // escolhe o primeiro da grade (homem-01)
  await grade.first().click();
  await pg.getByRole("dialog", { name: /Retrato de/ }).waitFor({ state: "detached", timeout: 10000 });
  const imgFicha = pg.locator(".ficha-cartao img.avatar-retrato, .cartao img.avatar-retrato").first();
  await imgFicha.waitFor({ timeout: 10000 });
  const srcFicha = await imgFicha.getAttribute("src");
  t("2d. ficha exibe retrato da galeria", /\/retratos\/homem-01\.svg/.test(srcFicha ?? ""), srcFicha);
  await pg.locator("section.cartao", { has: pg.getByRole("button", { name: "Alterar retrato" }) })
    .getByRole("button", { name: "Voltar", exact: true }).click();
  await pg.locator("table").waitFor({ timeout: 10000 });
  const imgLista = pg.locator("table img.avatar-retrato").first();
  t("2e. lista exibe o mesmo retrato", /\/retratos\/homem-01\.svg/.test((await imgLista.getAttribute("src").catch(() => "")) ?? ""));
  await abrirPersonagem(pg, "Heroína Retrato");

  sec("3. Upload de imagem própria");
  await abrirModalRetrato(pg);
  const input = pg.locator('input[type="file"][accept*="image/png"]');
  await input.setInputFiles({ name: "retrato.png", mimeType: "image/png", buffer: png64() });
  await pg.getByRole("dialog", { name: /Retrato de/ }).waitFor({ state: "detached", timeout: 15000 });
  const imgUp = pg.locator(".cartao img.avatar-retrato").first();
  await imgUp.waitFor({ timeout: 10000 });
  const srcUp = await imgUp.getAttribute("src");
  t("3a. avatar aponta para endpoint de imagem própria", /\/retrato\/imagem/.test(srcUp ?? ""), srcUp);
  // a imagem carrega de verdade (sem fallback)
  await pg.waitForTimeout(800);
  const aindaImg = await pg.locator(".cartao img.avatar-retrato").count();
  t("3b. imagem própria renderiza sem fallback", aindaImg > 0);

  sec("4. Remoção do retrato");
  await abrirModalRetrato(pg);
  await pg.getByRole("button", { name: "Remover retrato" }).click();
  await pg.getByRole("dialog", { name: /Retrato de/ }).waitFor({ state: "detached", timeout: 10000 });
  await pg.waitForTimeout(600);
  t("4a. fallback de iniciais volta após remoção", await pg.locator(".cartao .avatar-fallback").count() > 0);

  sec("5. Responsividade mobile");
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgM = await ctxM.newPage();
  await login(pgM, "jogador_um", "senha-jogador-123");
  await irCampanha(pgM);
  await abrirPersonagem(pgM, "Heroína Retrato");
  await abrirModalRetrato(pgM);
  const gradeM = pgM.locator(".grade-retratos .retrato-opcao");
  await gradeM.first().waitFor({ timeout: 10000 });
  t("5a. galeria renderiza em viewport mobile", await gradeM.count() >= 100);
  const box = await pgM.locator(".modal-retrato").boundingBox();
  t("5b. modal cabe na tela (390px)", !!box && box.width <= 390, box ? `w=${Math.round(box.width)}` : "sem box");

  sec("6. Biblioteca — só raster aceito aparece como opção");
  // fixture: 3 raster válidos + SVG/GIF/BMP que o servidor rejeitaria
  const fixtures = [
    ["ok-png", "png", "image/png", png64()],
    ["ok-jpg", "jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])],
    ["ok-webp", "webp", "image/webp", Buffer.from("RIFF0000WEBPVP8 ")],
    ["vetor-svg", "svg", "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>")],
    ["animado-gif", "gif", "image/gif", Buffer.from("GIF89a....")],
    ["arte-bmp", "bmp", "image/bmp", Buffer.from([0x42, 0x4d, 1, 2, 3])],
  ];
  {
    const w = abrirDb(BANCO);
    try {
      const dir = join(ARQ, c.campId);
      mkdirSync(dir, { recursive: true });
      const agora = Date.now();
      for (const [nome, ext, mime, buf] of fixtures) {
        const id = crypto.randomUUID();
        writeFileSync(join(dir, `${id}.${ext}`), buf);
        w.prepare("insert into files (id,campaign_id,folder_path,file_name,display_name,category,status,storage_name,mime_type,size_bytes,uploaded_by,visibility,recipients,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, c.campId, "/", `${nome}.${ext}`, `${nome}.${ext}`, "biblioteca", "aprovado", `${id}.${ext}`, mime, buf.length, c.adminId, "publica", null, agora, agora);
      }
    } finally { w.close(); }
  }
  // volta à lista (a ficha estava aberta desde a seção 4) e abre o modal
  await pg.locator("section.cartao", { has: pg.getByRole("button", { name: "Alterar retrato" }) })
    .getByRole("button", { name: "Voltar", exact: true }).click();
  await pg.locator(".abas button", { hasText: "Personagens" }).first().click();
  await abrirPersonagem(pg, "Heroína Retrato");
  await abrirModalRetrato(pg);
  await pg.getByRole("button", { name: "Biblioteca", exact: true }).click();
  await pg.waitForTimeout(800);
  for (const [nome] of fixtures.slice(0, 3)) {
    t(`6.${nome}: raster aparece na Biblioteca`, await pg.locator(".retrato-opcao", { hasText: nome }).count() > 0);
  }
  for (const [nome] of fixtures.slice(3)) {
    t(`6.${nome}: formato não-raster NÃO aparece`, await pg.locator(".retrato-opcao", { hasText: nome }).count() === 0);
  }
  await pg.getByRole("button", { name: "Fechar" }).click();

  console.log(`\n==== retratos-ui: ${pass} ok, ${fail} falhas ====`);
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 600));
} finally {
  if (browser) await browser.close().catch(() => { });
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
