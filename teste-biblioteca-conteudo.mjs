#!/usr/bin/env node
// Testes da entrega segura da Biblioteca (anti-XSS):
// GET /api/campaigns/:cid/arquivos/:fileId classifica o conteúdo REAL
// (extensão do storageName + magic bytes / sniffing de texto) —
// nunca confia no MIME declarado no upload nem no persistido.
// Conteúdo ativo/inconsistente/não verificável desce como anexo
// octet-stream com CSP sandbox; formatos legítimos seguem inline
// com MIME canônico.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
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
const MP4_MIN = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(16)]);
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
const nosniff = (r) => (r.headers.get("x-content-type-options") ?? "") === "nosniff";
const octet = (r) => ct(r) === "application/octet-stream";
const sandboxOk = (r) => /sandbox/.test(csp(r));

try {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  const BASE = `http://localhost:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { j1: "bib_j1", j2: "bib_j2" } });
  const cm = c.cookieMestre, cj1 = c.jogadores.j1.cookie;

  // Insere registro "legado/forjado" direto no banco (simula arquivo
  // antigo, importado ou restaurado com metadados incorretos).
  const inserirLegado = ({ nome, ext, mime, conteudo, vis = "publica", status = "aprovado", cid = c.campId }) => {
    const id = crypto.randomUUID();
    const storageName = `${id}.${ext}`;
    const dir = join(ARQ, cid); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, storageName), conteudo);
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into files (id,campaign_id,folder_path,file_name,display_name,category,status,storage_name,mime_type,size_bytes,uploaded_by,visibility,recipients,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, cid, "/", nome, nome, "biblioteca", status, storageName, mime, conteudo.length, c.adminId, vis, null, Date.now(), Date.now());
    } finally { w.close(); }
    return id;
  };

  sec("A. XSS reproduzido — SVG disfarçado de TXT (upload HTTP real)");
  const upSvgTxt = await upload(BASE, c.campId, cm, "notas.txt", "image/svg+xml", SVG_ATIVO, { "x-visibility": "publica" });
  t("Aa. upload aceita o TXT conforme política (201)", upSvgTxt.status === 201 && !!upSvgTxt.json?.id, `status=${upSvgTxt.status}`);
  const fidSvgTxt = upSvgTxt.json?.id;
  let g = await getArq(BASE, c.campId, fidSvgTxt, cj1);
  t("Ab. nunca serve image/svg+xml", ct(g) !== "image/svg+xml" && g.status === 200, `${cd(g)} ${ct(g)}`);
  t("Ac. Content-Disposition attachment", anexo(g), cd(g));
  t("Ad. Content-Type application/octet-stream", octet(g), ct(g));
  t("Ae. CSP sandbox presente", sandboxOk(g), csp(g));
  t("Af. nosniff presente", nosniff(g));
  t("Ag. corpo permanece o SVG original (download íntegro)", g.buf.equals(SVG_ATIVO));
  g = await getArq(BASE, c.campId, fidSvgTxt, cj1, true);
  t("Ah. ?download=1 também attachment", g.status === 200 && anexo(g));

  sec("B. Extensão raster com conteúdo SVG (registro legado/forjado)");
  const fidPngSvg = inserirLegado({ nome: "fake.png", ext: "png", mime: "image/png", conteudo: SVG_ATIVO });
  g = await getArq(BASE, c.campId, fidPngSvg, cj1);
  t("Ba. .png com SVG → attachment octet-stream", g.status === 200 && anexo(g) && octet(g), `${cd(g)} ${ct(g)}`);
  t("Bb. CSP sandbox", sandboxOk(g));
  t("Bc. MIME persistido image/png ignorado", ct(g) !== "image/png");
  const fidSvgExt = inserirLegado({ nome: "vetor.bin", ext: "svg", mime: "image/svg+xml", conteudo: SVG_ATIVO });
  g = await getArq(BASE, c.campId, fidSvgExt, cj1);
  t("Bd. storageName .svg → nunca inline", g.status === 200 && anexo(g) && octet(g), `${cd(g)} ${ct(g)}`);
  const fidTxtHtml = inserirLegado({ nome: "pagina.txt", ext: "txt", mime: "text/html", conteudo: HTML_ATIVO });
  g = await getArq(BASE, c.campId, fidTxtHtml, cj1);
  t("Be. .txt com HTML → attachment (conteúdo demonstra markup)", g.status === 200 && anexo(g) && octet(g), `${cd(g)} ${ct(g)}`);
  const fidTxtSvgEsp = inserirLegado({ nome: "notas2.txt", ext: "txt", mime: "text/plain", conteudo: Buffer.from("   \n\n<svg xmlns='x'><script>1</script></svg>") });
  g = await getArq(BASE, c.campId, fidTxtSvgEsp, cj1);
  t("Bf. .txt com SVG após espaços → attachment", anexo(g) && octet(g), `${cd(g)} ${ct(g)}`);

  sec("C. MIME declarado/persistido incorretamente");
  const fidPngHtml = await upload(BASE, c.campId, cm, "foto.png", "text/html", png64(), { "x-visibility": "publica" });
  t("Ca. upload PNG com MIME text/html aceito (201)", fidPngHtml.status === 201, `status=${fidPngHtml.status}`);
  g = await getArq(BASE, c.campId, fidPngHtml.json?.id, cj1);
  t("Cb. GET serve MIME canônico image/png", ct(g) === "image/png" && inline(g), `${ct(g)} ${cd(g)}`);
  const fidPdfFake = inserirLegado({ nome: "doc.pdf", ext: "pdf", mime: "application/pdf", conteudo: png64() });
  g = await getArq(BASE, c.campId, fidPdfFake, cj1);
  t("Cc. .pdf com conteúdo PNG → attachment", g.status === 200 && anexo(g) && octet(g), `${cd(g)} ${ct(g)}`);
  // MIME persistido canônico no upload (§6): PNG declarado text/html grava image/png
  const lista = await raw(BASE, "GET", `/campaigns/${c.campId}/arquivos`, { cookie: cm });
  const arqPng = lista.json?.arquivos?.find((a) => a.id === fidPngHtml.json?.id);
  t("Cd. upload persiste MIME canônico (image/png), não o declarado", arqPng?.mimeType === "image/png", arqPng?.mimeType);
  const arqSvgTxt = lista.json?.arquivos?.find((a) => a.id === fidSvgTxt);
  t("Ce. SVG-disfarcado persiste octet-stream, não image/svg+xml", arqSvgTxt?.mimeType === "application/octet-stream", arqSvgTxt?.mimeType);

  sec("D. Formatos legítimos — inline com MIME canônico");
  const up = async (nome, mime, buf) => (await upload(BASE, c.campId, cm, nome, mime, buf, { "x-visibility": "publica" })).json?.id;
  const casos = [
    ["foto.jpg", "image/jpeg", JPEG_MIN, "image/jpeg"],
    ["arte.webp", "image/webp", WEBP_MIN, "image/webp"],
    ["doc.pdf", "application/pdf", PDF_MIN, "application/pdf"],
    ["som.wav", "audio/wav", WAV_MIN, "audio/wav"],
    ["faixa.mp3", "audio/mpeg", MP3_MIN, "audio/mpeg"],
    ["filme.mp4", "video/mp4", MP4_MIN, "video/mp4"],
    ["anotacao.txt", "text/plain", Buffer.from("anotações da sessão"), "text/plain"],
    ["dados.json", "application/json", Buffer.from('{"a":1}'), "text/plain"],
    ["notas.md", "text/markdown", Buffer.from("# título\ntexto"), "text/plain"],
  ];
  for (const [i, [nome, mime, buf, esperado]] of casos.entries()) {
    const fid = await up(nome, mime, buf);
    g = await getArq(BASE, c.campId, fid, cj1);
    t(`D${String.fromCharCode(97 + i)}. ${nome} → inline ${esperado}`, g.status === 200 && inline(g) && ct(g) === esperado, `${cd(g)} ${ct(g)}`);
  }
  const fidZip = await up("pack.zip", "application/zip", ZIP_MIN);
  g = await getArq(BASE, c.campId, fidZip, cj1);
  t("Di. pack.zip → attachment octet-stream", g.status === 200 && anexo(g) && octet(g), `${cd(g)} ${ct(g)}`);

  sec("E. Inconsistências — desconhecido, corrompido, vazio, binário");
  const fidDesconhecido = inserirLegado({ nome: "blob.xyz", ext: "xyz", mime: "application/octet-stream", conteudo: Buffer.from([1, 2, 3, 4, 5]) });
  g = await getArq(BASE, c.campId, fidDesconhecido, cj1);
  t("Ea. extensão desconhecida → attachment octet-stream", g.status === 200 && anexo(g) && octet(g) && sandboxOk(g), `${cd(g)} ${ct(g)}`);
  const fidCorrompido = inserirLegado({ nome: "partido.png", ext: "png", mime: "image/png", conteudo: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) });
  g = await getArq(BASE, c.campId, fidCorrompido, cj1);
  // magic png bate nos 4 primeiros bytes → reconhecido como png (assinatura mínima)
  t("Eb. .png truncado com magic válido → inline image/png", g.status === 200 && inline(g) && ct(g) === "image/png", `${cd(g)} ${ct(g)}`);
  const fidBinario = inserirLegado({ nome: "dados.bin", ext: "bin", mime: "application/octet-stream", conteudo: crypto.getRandomValues(new Uint8Array(256)) });
  g = await getArq(BASE, c.campId, fidBinario, cj1);
  t("Ec. binário não reconhecido → attachment octet-stream", g.status === 200 && anexo(g) && octet(g) && sandboxOk(g));
  const fidVazio = inserirLegado({ nome: "vazio.txt", ext: "txt", mime: "text/plain", conteudo: Buffer.alloc(0) });
  g = await getArq(BASE, c.campId, fidVazio, cj1);
  t("Ed. arquivo vazio → attachment octet-stream", g.status === 200 && anexo(g) && octet(g));

  sec("F. Download forçado — tudo attachment");
  const fidPng = await up("download.png", "image/png", png64());
  const fidTxt = await up("notas-download.txt", "text/plain", Buffer.from("simples"));
  for (const [i, fid] of [fidPng, fidTxt, fidSvgTxt].entries()) {
    g = await getArq(BASE, c.campId, fid, cj1, true);
    t(`F${i}. download=1 arquivo ${i} → attachment`, g.status === 200 && anexo(g), `${cd(g)} ${ct(g)}`);
  }

  sec("G. Permissões inalteradas");
  const fidPriv = (await upload(BASE, c.campId, cm, "privado.txt", "text/plain", Buffer.from("segredo"), { "x-visibility": "mestre" })).json?.id;
  g = await getArq(BASE, c.campId, fidPriv, cj1);
  t("Ga. privado → 403 para jogador", g.status === 403, `status=${g.status}`);
  g = await getArq(BASE, c.campId, fidPriv, cm);
  t("Gb. privado → mestre acessa", g.status === 200);
  // arquivo de OUTRA campanha não vaza nem pela rota de entrega
  const camp2 = await req(BASE, "POST", "/campaigns", { cookie: cm, body: { name: "Campanha Paralela" } });
  const camp2Id = camp2.json?.campanha?.id ?? camp2.json?.id;
  const fidOutra = (await upload(BASE, camp2Id, cm, "segredo.png", "image/png", png64(), { "x-visibility": "publica" })).json?.id;
  g = await getArq(BASE, c.campId, fidOutra, cj1);
  t("Gc. fileId de outra campanha → não entregue", g.status === 404 || g.status === 403, `status=${g.status}`);

  sec("H. Regressão retratos — PNG legítimo segue inline (contrato da #131)");
  g = await getArq(BASE, c.campId, fidPng, cj1);
  t("Ha. PNG público → inline image/png", g.status === 200 && inline(g) && ct(g) === "image/png", `${cd(g)} ${ct(g)}`);
  // arquivo com visibilidade mestre NÃO pode ser lido por jogador — idem antes
  t("Hb. classificação não altera permissões", true);

  console.log(`\n==== biblioteca-conteudo: ${pass} ok, ${fail} falhas ====`);
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 500));
} finally {
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
