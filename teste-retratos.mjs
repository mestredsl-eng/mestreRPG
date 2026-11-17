#!/usr/bin/env node
// Testes de API do retrato de personagem (Issue #129):
// galeria padrão, upload próprio, substituição/remoção, permissões,
// isolamento por campanha, NPC revelado e fallback de arquivo ausente.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, comDb, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

// fetch cru: body binário e redirect manual (req() só fala JSON).
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
const upload = (base, pid, cookie, nome, mime, buf) =>
  raw(base, "POST", `/characters/${pid}/retrato/upload`, {
    cookie, body: buf,
    headers: { "x-file-name": encodeURIComponent(nome), "content-type": mime },
  });

// PNG 64x64 válido gerado em código (IHDR+IDAT+IEND com CRC32).
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(tipo, dados) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png64(r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  const cru = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) {
    const off = y * (1 + 64 * 3);
    cru[off] = 0;
    for (let x = 0; x < 64; x++) {
      const px = off + 1 + x * 3;
      cru[px] = r; cru[px + 1] = g; cru[px + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(cru)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DIR = dirTeste("retrato");
const BANCO = `${DIR}/banco/mestre-rpg.db`;
const ARQ = `${DIR}/arquivos/campanhas`;
const BKS = `${DIR}/backups`;
let proc;

try {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  const BASE = `http://localhost:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { j1: "retr_j1", j2: "retr_j2" } });
  const cm = c.cookieMestre, cj1 = c.jogadores.j1.cookie, cj2 = c.jogadores.j2.cookie;
  const pjDono = c.novoPersonagem(c.jogadores.j1.membershipId, "PJ Retrato J1");
  const pjDono2 = c.novoPersonagem(c.jogadores.j2.membershipId, "PJ Retrato J2");

  sec("1. Personagem sem retrato — compatibilidade");
  const g0 = await req(BASE, "GET", `/characters/${pjDono}`, { cookie: cj1 });
  t("1a. retrato null em personagem antigo", g0.json?.personagem?.retrato === null || g0.json?.personagem?.retrato === undefined, JSON.stringify(g0.json?.personagem?.retrato));
  const img0 = await raw(BASE, "GET", `/characters/${pjDono}/retrato/imagem`, { cookie: cj1 });
  t("1b. imagem sem retrato → 404", img0.status === 404, `status=${img0.status}`);

  sec("2. Galeria padrão — seleção e persistência");
  const putGal = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "galeria", id: "homem-01" } } });
  t("2a. PUT galeria aceito", putGal.status === 200 && putGal.json?.retrato?.url === "/retratos/homem-01.svg", JSON.stringify(putGal.json));
  const g1 = await req(BASE, "GET", `/characters/${pjDono}`, { cookie: cj1 });
  t("2b. retrato persiste após GET", g1.json?.personagem?.retrato?.url === "/retratos/homem-01.svg");
  const imgG = await raw(BASE, "GET", `/characters/${pjDono}/retrato/imagem`, { cookie: cj1 });
  t("2c. endpoint imagem redireciona p/ estático", imgG.status === 302 && /\/retratos\/homem-01\.svg/.test(imgG.headers.get("location") ?? ""), `status=${imgG.status} loc=${imgG.headers.get("location")}`);
  const putInvalido = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "galeria", id: "nao-existe" } } });
  t("2d. id de galeria inválido → 400", putInvalido.status === 400, `status=${putInvalido.status}`);
  const putShape = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "galeria" } } });
  t("2e. payload malformado → 400", putShape.status === 400, `status=${putShape.status}`);

  sec("3. Upload próprio — válido e inválido");
  const pngOk = png64(200, 30, 30);
  const up = await upload(BASE, pjDono, cj1, "retrato.png", "image/png", pngOk);
  t("3a. upload PNG válido → 201", up.status === 201 && up.json?.retrato?.tipo === "arquivo", JSON.stringify(up.json).slice(0, 160));
  const imgUp = await raw(BASE, "GET", `/characters/${pjDono}/retrato/imagem`, { cookie: cj1 });
  t("3b. imagem servida com content-type png", imgUp.status === 200 && /image\/png/.test(imgUp.headers.get("content-type") ?? ""), `status=${imgUp.status} ct=${imgUp.headers.get("content-type")}`);
  const g2 = await req(BASE, "GET", `/characters/${pjDono}`, { cookie: cj1 });
  t("3c. retrato arquivo persiste no GET", g2.json?.personagem?.retrato?.tipo === "arquivo" && /retrato\/imagem/.test(g2.json?.personagem?.retrato?.url ?? ""));

  const upSvg = await upload(BASE, pjDono, cj1, "x.svg", "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"));
  t("3d. SVG rejeitado → 415", upSvg.status === 415, `status=${upSvg.status}`);
  const upFake = await upload(BASE, pjDono, cj1, "fake.png", "image/png", Buffer.from("isto nao e uma imagem png"));
  t("3e. conteúdo inválido disfarçado → 415", upFake.status === 415, `status=${upFake.status}`);
  const upTxt = await upload(BASE, pjDono, cj1, "notas.txt", "text/plain", Buffer.from("apenas texto"));
  t("3f. extensão não-imagem → 415", upTxt.status === 415, `status=${upTxt.status}`);
  const pngGrande = Buffer.from(pngOk);
  pngGrande.writeUInt32BE(99999, 16); pngGrande.writeUInt32BE(99999, 20);
  const upDim = await upload(BASE, pjDono, cj1, "grande.png", "image/png", pngGrande);
  t("3g. dimensões acima de 4096 → 415", upDim.status === 415, `status=${upDim.status}`);
  const gAposInvalidos = await req(BASE, "GET", `/characters/${pjDono}`, { cookie: cj1 });
  t("3h. uploads rejeitados preservam o retrato atual", gAposInvalidos.json?.personagem?.retrato?.tipo === "arquivo" && /retrato\/imagem/.test(gAposInvalidos.json?.personagem?.retrato?.url ?? ""), JSON.stringify(gAposInvalidos.json?.personagem?.retrato));

  sec("4. Substituição, remoção e arquivo preservado");
  const antes = comDb(BANCO, (db) => db.prepare("select count(*) n from files where campaign_id=?").get(c.campId).n);
  const putTroca = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "galeria", id: "mulher-07" } } });
  t("4a. troca arquivo→galeria aceita", putTroca.status === 200 && putTroca.json?.retrato?.url === "/retratos/mulher-07.svg");
  const depois = comDb(BANCO, (db) => db.prepare("select count(*) n from files where campaign_id=?").get(c.campId).n);
  t("4b. arquivo anterior NÃO apagado ao trocar retrato", depois === antes, `${antes}→${depois}`);
  const putNull = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: null } });
  t("4c. remoção aceita", putNull.status === 200 && putNull.json?.retrato === null);
  const g3 = await req(BASE, "GET", `/characters/${pjDono}`, { cookie: cj1 });
  t("4d. retrato ausente após remoção", g3.json?.personagem?.retrato === null || g3.json?.personagem?.retrato === undefined);
  const imgSome = await raw(BASE, "GET", `/characters/${pjDono}/retrato/imagem`, { cookie: cj1 });
  t("4e. imagem removida → 404", imgSome.status === 404, `status=${imgSome.status}`);

  sec("5. Permissões e isolamento");
  const putAlheio = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj2, body: { retrato: { tipo: "galeria", id: "homem-02" } } });
  t("5a. jogador não altera retrato alheio → 403", putAlheio.status === 403, `status=${putAlheio.status}`);
  const imgAlheia = await raw(BASE, "GET", `/characters/${pjDono}/retrato/imagem`, { cookie: cj2 });
  t("5b. imagem de personagem alheio → 403", imgAlheia.status === 403, `status=${imgAlheia.status}`);
  const camp2 = await req(BASE, "POST", "/campaigns", { cookie: cm, body: { name: "Campanha Dois" } });
  const camp2Id = camp2.json?.campanha?.id;
  const pjCamp2 = (() => {
    const w = abrirDb(BANCO);
    try {
      const id = crypto.randomUUID();
      const agora = Date.now();
      const mid = w.prepare("select id from memberships where campaign_id=? and user_id=(select id from users where username='mestre_teste')").get(camp2Id).id;
      w.prepare("insert into characters (id,campaign_id,membership_id,name,data,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(id, camp2Id, mid, "PJ Camp2", "{}", "aprovada", 0, agora, agora);
      return id;
    } finally { w.close(); }
  })();
  const fidCamp1 = comDb(BANCO, (db) => db.prepare("select id from files where campaign_id=? and category='retrato'").get(c.campId).id);
  const putCross = await req(BASE, "PUT", `/characters/${pjCamp2}/retrato`, { cookie: cm, body: { retrato: { tipo: "arquivo", arquivoId: fidCamp1 } } });
  t("5c. arquivoId de outra campanha → 400", putCross.status === 400, `status=${putCross.status}`);
  const imgCross = await raw(BASE, "GET", `/characters/${pjCamp2}/retrato/imagem`, { cookie: cj1 });
  t("5d. não-membro não lê retrato → 403/404", imgCross.status === 403 || imgCross.status === 404, `status=${imgCross.status}`);

  sec("6. NPC — mestre define; jogador só lê se ficha revelada");
  const npc = await req(BASE, "POST", `/campaigns/${c.campId}/characters`, { cookie: cm, body: { name: "NPC Retrato", isNpc: true } });
  const npcId = npc.json?.personagem?.id;
  t("6a. NPC criado", npc.status === 200 || npc.status === 201, `status=${npc.status}`);
  await req(BASE, "PUT", `/characters/${npcId}/retrato`, { cookie: cm, body: { retrato: { tipo: "galeria", id: "criatura-fantasma-01" } } });
  const imgNpcOculto = await raw(BASE, "GET", `/characters/${npcId}/retrato/imagem`, { cookie: cj1 });
  t("6b. NPC oculto: imagem → 403 para jogador", imgNpcOculto.status === 403, `status=${imgNpcOculto.status}`);
  await req(BASE, "POST", `/characters/${npcId}/npc-visibilidade`, { cookie: cm, body: { visivel: true } });
  const imgNpcVis = await raw(BASE, "GET", `/characters/${npcId}/retrato/imagem`, { cookie: cj1 });
  t("6c. NPC revelado: imagem → redirect estático", imgNpcVis.status === 302 || imgNpcVis.status === 301, `status=${imgNpcVis.status}`);
  const putNpcJ = await req(BASE, "PUT", `/characters/${npcId}/retrato`, { cookie: cj1, body: { retrato: { tipo: "galeria", id: "homem-03" } } });
  t("6d. jogador não altera retrato de NPC → 403", putNpcJ.status === 403, `status=${putNpcJ.status}`);

  sec("7. Arquivado é somente leitura");
  { const w = abrirDb(BANCO); try { w.prepare("update characters set status='arquivado' where id=?").run(pjDono2); } finally { w.close(); } }
  const putArq = await req(BASE, "PUT", `/characters/${pjDono2}/retrato`, { cookie: cj2, body: { retrato: { tipo: "galeria", id: "homem-04" } } });
  t("7a. retrato em arquivado → 403", putArq.status === 403, `status=${putArq.status}`);
  { const w = abrirDb(BANCO); try { w.prepare("update characters set status='aprovada' where id=?").run(pjDono2); } finally { w.close(); } }

  sec("8. Biblioteca — autorização e conteúdo raster");
  const SVG_ATIVO = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  const inserirArquivo = ({ nome, ext, mime, conteudo, status = "aprovado", visibility = "publica", recipients = null, uploadedBy }) => {
    const id = crypto.randomUUID();
    const storageName = `${id}.${ext}`;
    const dir = join(ARQ, c.campId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, storageName), conteudo);
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into files (id,campaign_id,folder_path,file_name,display_name,category,status,storage_name,mime_type,size_bytes,uploaded_by,visibility,recipients,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, c.campId, "/", nome, nome, "biblioteca", status, storageName, mime, conteudo.length, uploadedBy, visibility, recipients ? JSON.stringify(recipients) : null, Date.now(), Date.now());
    } finally { w.close(); }
    return id;
  };
  const pngBib = png64(10, 200, 10);
  const idPngOk = inserirArquivo({ nome: "arte.png", ext: "png", mime: "image/png", conteudo: pngBib, uploadedBy: c.jogadores.j1.id });
  const putBibOk = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idPngOk } } });
  t("8a. PNG aprovado+público da biblioteca → aceito", putBibOk.status === 200, `status=${putBibOk.status} ${JSON.stringify(putBibOk.json).slice(0, 120)}`);

  const idPrivado = inserirArquivo({ nome: "secreta.png", ext: "png", mime: "image/png", conteudo: png64(1, 2, 3), visibility: "mestre", uploadedBy: c.adminId });
  const putPrivJ = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idPrivado } } });
  t("8b. arquivo visibility=mestre → jogador recebe 403", putPrivJ.status === 403, `status=${putPrivJ.status}`);
  const pjMestre2 = c.novoPersonagem(c.membMestre, "PJ Mestre Dois");
  const putPrivM = await req(BASE, "PUT", `/characters/${pjMestre2}/retrato`, { cookie: cm, body: { retrato: { tipo: "arquivo", arquivoId: idPrivado } } });
  t("8c. mesmo arquivo → mestre consegue usar", putPrivM.status === 200, `status=${putPrivM.status}`);

  const idSel = inserirArquivo({ nome: "só-j2.png", ext: "png", mime: "image/png", conteudo: png64(4, 5, 6), visibility: "selecionada", recipients: [c.jogadores.j2.id], uploadedBy: c.adminId });
  const putSelJ1 = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idSel } } });
  t("8d. selecionada sem o usuário nos recipients → 403", putSelJ1.status === 403, `status=${putSelJ1.status}`);
  const putSelJ2 = await req(BASE, "PUT", `/characters/${pjDono2}/retrato`, { cookie: cj2, body: { retrato: { tipo: "arquivo", arquivoId: idSel } } });
  t("8e. destinatário consegue usar → 200", putSelJ2.status === 200, `status=${putSelJ2.status}`);

  const idPendente = inserirArquivo({ nome: "pendente.png", ext: "png", mime: "image/png", conteudo: png64(7, 8, 9), status: "pendente", uploadedBy: c.jogadores.j1.id });
  const putPend = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idPendente } } });
  t("8f. arquivo pendente de moderação → 403 mesmo para o uploader", putPend.status === 403, `status=${putPend.status}`);
  const idRejeitado = inserirArquivo({ nome: "rejeitado.png", ext: "png", mime: "image/png", conteudo: png64(7, 8, 9), status: "rejeitado", uploadedBy: c.jogadores.j1.id });
  const putRej = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idRejeitado } } });
  t("8g. arquivo rejeitado → 403", putRej.status === 403, `status=${putRej.status}`);

  const idSvgTxt = inserirArquivo({ nome: "notas.txt", ext: "txt", mime: "image/svg+xml", conteudo: SVG_ATIVO, uploadedBy: c.jogadores.j1.id });
  const putSvgTxt = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idSvgTxt } } });
  t("8h. SVG disfarçado de TXT (mime image/svg+xml) → 415", putSvgTxt.status === 415, `status=${putSvgTxt.status}`);
  const idSvg = inserirArquivo({ nome: "vetor.svg", ext: "svg", mime: "image/svg+xml", conteudo: SVG_ATIVO, uploadedBy: c.jogadores.j1.id });
  const putSvg = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idSvg } } });
  t("8i. SVG .svg na biblioteca → 415", putSvg.status === 415, `status=${putSvg.status}`);
  const pngComSvg = Buffer.concat([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")]);
  const idPngSvg = inserirArquivo({ nome: "fake.png", ext: "png", mime: "image/png", conteudo: pngComSvg, uploadedBy: c.jogadores.j1.id });
  const putPngSvg = await req(BASE, "PUT", `/characters/${pjDono}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idPngSvg } } });
  t("8j. conteúdo SVG com extensão/MIME png → 415", putPngSvg.status === 415, `status=${putPngSvg.status}`);

  sec("9. GET imagem rejeita referência legada não-raster");
  // referência gravada direto no banco (estado "legado" anterior à validação)
  { const w = abrirDb(BANCO); try {
    const dados = JSON.parse((w.prepare("select data from characters where id=?").get(pjDono2).data) || "{}");
    dados.__retrato = { tipo: "arquivo", arquivoId: idSvg };
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), pjDono2);
  } finally { w.close(); } }
  const imgLegado = await raw(BASE, "GET", `/characters/${pjDono2}/retrato/imagem`, { cookie: cj2 });
  t("9a. GET não serve SVG mesmo com referência gravada → 404", imgLegado.status === 404, `status=${imgLegado.status}`);
  const imgLegadoM = await raw(BASE, "GET", `/characters/${pjDono2}/retrato/imagem`, { cookie: cm });
  t("9b. mestre também recebe 404 (não há bypass)", imgLegadoM.status === 404, `status=${imgLegadoM.status}`);

  sec("10. SVG disfarçado de TXT — upload HTTP real da Biblioteca");
  const pjNovo = c.novoPersonagem(c.jogadores.j1.membershipId, "PJ Upload Real");
  // caminho real do usuário: POST genérico /arquivos/upload como mestre
  // (jogador teria status=pendente e cairia na regra de moderação antes
  // da validação raster — o cenário exige arquivo aprovado+público).
  const upReal = await raw(BASE, "POST", `/campaigns/${c.campId}/arquivos/upload`, {
    cookie: cm, body: SVG_ATIVO,
    headers: {
      "x-file-name": encodeURIComponent("notas.txt"),
      "x-file-mime": "image/svg+xml",
      "x-visibility": "publica",
      "content-type": "application/octet-stream",
    },
  });
  t("10a. upload genérico aceita o TXT (201) — biblioteca inalterada", upReal.status === 201 && !!upReal.json?.id, `status=${upReal.status} ${JSON.stringify(upReal.json).slice(0, 120)}`);
  const idUploadReal = upReal.json?.id;
  const putReal = await req(BASE, "PUT", `/characters/${pjNovo}/retrato`, { cookie: cj1, body: { retrato: { tipo: "arquivo", arquivoId: idUploadReal } } });
  t("10b. PUT retrato rejeita o arquivo → 415", putReal.status === 415, `status=${putReal.status}`);
  const imgReal = await raw(BASE, "GET", `/characters/${pjNovo}/retrato/imagem`, { cookie: cj1 });
  t("10c. GET imagem → 404 (personagem continua sem retrato)", imgReal.status === 404, `status=${imgReal.status}`);
  const gravado = comDb(BANCO, (db) => {
    const d = JSON.parse(db.prepare("select data from characters where id=?").get(pjNovo).data || "{}");
    return d.__retrato ?? null;
  });
  t("10d. nenhum retrato gravado em characters.data", gravado === null, JSON.stringify(gravado));

  console.log(`\n==== retratos: ${pass} ok, ${fail} falhas ====`);
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 500));
} finally {
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
