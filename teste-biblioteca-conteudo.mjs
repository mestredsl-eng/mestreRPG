#!/usr/bin/env node
// Testes da entrega segura da Biblioteca (anti-XSS):
// GET /api/campaigns/:cid/arquivos/:fileId classifica o conteúdo REAL
// (extensão do storageName + magic bytes) — nunca confia no MIME
// declarado no upload. Conteúdo ativo/não verificável desce como
// anexo octet-stream com CSP sandbox; formatos legítimos seguem
// inline com MIME canônico.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, comDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

async function raw(base, metodo, path, { cookie, body, headers = {} } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo, redirect: "manual",
    headers: { cookie: cookie ?? "", ...headers },
    body,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch { }
  return { status: r.status, json, buf, headers: r.headers };
}
const upload = (base, cid, cookie, nome, mime, buf, extra = {}) =>
  raw(base, "POST", `/campaigns/${cid}/arquivos/upload`, {
    cookie, body: buf,
    headers: {
      "x-file-name": encodeURIComponent(nome), "x-file-mime": mime,
      "content-type": "application/octet-stream", ...extra,
    },
  });
const getArq = (base, cid, fid, cookie, dl = false) =>
  raw(base, "GET", `/campaigns/${cid}/arquivos/${fid}${dl ? "?download=1" : ""}`, { cookie });

// PNG 64x64 válido (mesmo gerador das outras suítes).
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
    for (let x = 0; x < 64; x++) { const px = off + 1 + x * 3; cru[px] = 200; cru[px + 1] = 40; cru[px + 2] = 40; }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(cru)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_MIN = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ");
const PDF_MIN = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
const WAV_MIN = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(20)]);
const MP3_MIN = Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00fake-mp3");
const ZIP_MIN = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const SVG_ATIVO = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert('xss')</script></svg>");
const HTML_ATIVO = Buffer.from("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>");

const DIR = dirTeste("conteudo-bib");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;

const cd = (r) => r.headers.get("content-disposition") ?? "";
const ct = (r) => (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
const csp = (r) => r.headers.get("content-security-policy") ?? "";
const inline = (r) => /inline/.test(cd(r)) && !/attachment/.test(cd(r));
const anexo = (r) => /attachment/.test(cd(r));

try {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  const BASE = `http://localhost:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { j1: "bib_j1", j2: "bib_j2" } });
  const cm = c.cookieMestre, cj1 = c.jogadores.j1.cookie;

  sec("1. SVG disfarçado de TXT — upload real, entrega segura");
  const upSvgTxt = await upload(BASE, c.campId, cm, "notas.txt", "image/svg+xml", SVG_ATIVO, { "x-visibility": "publica" });
  t("1a. biblioteca aceita o TXT (201)", upSvgTxt.status === 201 && !!upSvgTxt.json?.id, `status=${upSvgTxt.status}`);
  const fidSvgTxt = upSvgTxt.json?.id;
  let g = await getArq(BASE, c.campId, fidSvgTxt, cj1);
  // .txt é entregue como text/plain canônico — conteúdo SVG vira texto
  // inerte na tela; jamais image/svg+xml executável.
  t("1b. GET nunca serve image/svg+xml", ct(g) !== "image/svg+xml" && g.status === 200, `${cd(g)} ${ct(g)}`);
  t("1c. Content-Type canônico text/plain", ct(g) === "text/plain", ct(g));
  t("1d. MIME declarado ignorado", !(g.headers.get("content-type") ?? "").includes("svg"));
  t("1e. nosniff preservado", r_nosniff(g));
  t("1f. corpo permanece o SVG original (download íntegro)", g.buf.equals(SVG_ATIVO));
  g = await getArq(BASE, c.campId, fidSvgTxt, cj1, true);
  t("1g. ?download=1 também attachment", g.status === 200 && anexo(g));

  sec("2. Conteúdo ativo disfarçado de raster (legado/forjado)");
  // .png com conteúdo SVG — upload bloquearia; arquivo "legado" via banco
  const inserirLegado = ({ nome, ext, mime, conteudo, vis = "publica", status = "aprovado" }) => {
    const id = crypto.randomUUID();
    const storageName = `${id}.${ext}`;
    const dir = join(ARQ, c.campId); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, storageName), conteudo);
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into files (id,campaign_id,folder_path,file_name,display_name,category,status,storage_name,mime_type,size_bytes,uploaded_by,visibility,recipients,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, c.campId, "/", nome, nome, "biblioteca", status, storageName, mime, conteudo.length, c.adminId, vis, null, Date.now(), Date.now());
    } finally { w.close(); }
    return id;
  };
  const fidPngSvg = inserirLegado({ nome: "fake.png", ext: "png", mime: "image/png", conteudo: SVG_ATIVO });
  g = await getArq(BASE, c.campId, fidPngSvg, cj1);
  t("2a. .png com conteúdo SVG → attachment octet-stream", g.status === 200 && anexo(g) && ct(g) === "application/octet-stream", `${cd(g)} ${ct(g)}`);
  t("2b. CSP sandbox no disfarçado", /sandbox/.test(csp(g)));
  const fidSvgExt = inserirLegado({ nome: "vetor.bin", ext: "svg", mime: "image/svg+xml", conteudo: SVG_ATIVO });
  g = await getArq(BASE, c.campId, fidSvgExt, cj1);
  t("2c. storageName .svg → nunca inline", g.status === 200 && anexo(g) && ct(g) === "application/octet-stream", `${cd(g)} ${ct(g)}`);
  const fidTxtHtml = inserirLegado({ nome: "pagina.txt", ext: "txt", mime: "text/html", conteudo: HTML_ATIVO });
  g = await getArq(BASE, c.campId, fidTxtHtml, cj1);
  t("2d. .txt com HTML → inline text/plain (inerte)", g.status === 200 && inline(g) && ct(g) === "text/plain", `${cd(g)} ${ct(g)}`);

  sec("3. MIME forjado — declarado não é prova");
  const fidPngHtml = await upload(BASE, c.campId, cm, "foto.png", "text/html", png64(), { "x-visibility": "publica" });
  t("3a. upload PNG com MIME text/html aceito (201)", fidPngHtml.status === 201, `status=${fidPngHtml.status}`);
  g = await getArq(BASE, c.campId, fidPngHtml.json?.id, cj1);
  t("3b. GET serve MIME canônico image/png (não text/html)", ct(g) === "image/png" && inline(g), `${ct(g)} ${cd(g)}`);
  const fidPdfFake = inserirLegado({ nome: "doc.pdf", ext: "pdf", mime: "application/pdf", conteudo: png64() });
  g = await getArq(BASE, c.campId, fidPdfFake, cj1);
  t("3c. .pdf com conteúdo PNG → attachment", g.status === 200 && anexo(g), `${cd(g)} ${ct(g)}`);

  sec("4. Formatos legítimos — inline preservado");
  const up = async (nome, mime, buf) => (await upload(BASE, c.campId, cm, nome, mime, buf, { "x-visibility": "publica" })).json?.id;
  const casos = [
    ["foto.jpg", "image/jpeg", JPEG_MIN, "image/jpeg"],
    ["arte.webp", "image/webp", WEBP_MIN, "image/webp"],
    ["doc.pdf", "application/pdf", PDF_MIN, "application/pdf"],
    ["som.wav", "audio/wav", WAV_MIN, "audio/wav"],
    ["faixa.mp3", "audio/mpeg", MP3_MIN, "audio/mpeg"],
    ["anotacao.txt", "text/plain", Buffer.from("anotações da sessão"), "text/plain"],
    ["dados.json", "application/json", Buffer.from('{"a":1}'), "text/plain"],
  ];
  for (const [i, [nome, mime, buf, esperado]] of casos.entries()) {
    const fid = await up(nome, mime, buf);
    g = await getArq(BASE, c.campId, fid, cj1);
    t(`4.${String.fromCharCode(97 + i)} ${nome} → inline ${esperado}`, g.status === 200 && inline(g) && ct(g) === esperado, `${cd(g)} ${ct(g)}`);
  }
  const fidZip = await up("pack.zip", "application/zip", ZIP_MIN);
  g = await getArq(BASE, c.campId, fidZip, cj1);
  t("4.h pack.zip → attachment octet-stream", g.status === 200 && anexo(g) && ct(g) === "application/octet-stream", `${cd(g)} ${ct(g)}`);

  sec("5. Download explícito e permissões");
  const fidPng = await up("download.png", "image/png", png64());
  g = await getArq(BASE, c.campId, fidPng, cj1, true);
  t("5a. ?download=1 → attachment com MIME canônico", g.status === 200 && anexo(g) && ct(g) === "image/png", `${cd(g)} ${ct(g)}`);
  t("5b. corpo do download íntegro", g.buf.equals(png64()));
  const fidPriv = (await upload(BASE, c.campId, cm, "privado.txt", "text/plain", Buffer.from("segredo"), { "x-visibility": "mestre" })).json?.id;
  g = await getArq(BASE, c.campId, fidPriv, cj1);
  t("5c. privado → 403 para jogador (permissão intacta)", g.status === 403, `status=${g.status}`);
  g = await getArq(BASE, c.campId, fidPriv, cm);
  t("5d. privado → mestre acessa", g.status === 200);

  console.log(`\n==== biblioteca-conteudo: ${pass} ok, ${fail} falhas ====`);
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 500));
} finally {
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}
function r_nosniff(r) { return (r.headers.get("x-content-type-options") ?? "") === "nosniff"; }
process.exit(fail ? 1 : 0);
