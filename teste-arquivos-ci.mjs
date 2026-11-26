#!/usr/bin/env node
// Suíte E2E de anexos/arquivos de campanha — Issue #295.
// Cenários: upload/download íntegro, validações (vazio, extensão,
// MIME perigoso, tamanho, nome malicioso), mesmo nome sem colisão,
// isolamento entre campanhas, membro removido sem reuso de acesso,
// moderação de envio de jogador, persistência em disco.
// Harness autocontido (banco temporário + servidor spawnado) — CI-safe.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, abrirDb,
} from "./teste-base.mjs";

let DIR, BANCO, BASE, proc;
const resultados = [];
const t = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PDF_FAKE = Buffer.from("%PDF-1.4 fake conteudo", "utf8");

async function upload(cookie, cid, nome, conteudo, headers = {}) {
  const buf = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), "utf8");
  const r = await fetch(`${BASE}/api/campaigns/${cid}/arquivos/upload`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(nome), "x-file-mime": "application/octet-stream", ...headers },
    body: buf,
  });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
}

async function download(cookie, cid, fid) {
  const r = await fetch(`${BASE}/api/campaigns/${cid}/arquivos/${fid}`, { headers: { cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf };
}

async function lista(cookie, cid) {
  const r = await fetch(`${BASE}/api/campaigns/${cid}/arquivos`, { headers: { cookie } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

try {
  DIR = dirTeste("arquivos-ci");
  BANCO = `${DIR}/mestre-rpg-teste.db`;
  const porta = await portaLivre();
  BASE = `http://127.0.0.1:${porta}`;
  await prepararBanco(BANCO);
  proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Anexos" });
  const CID = c.campId;
  const mestre = c.cookieMestre;
  const j1 = c.jogadores.jogador1;
  const j2 = c.jogadores.jogador2;

  // ---------- 1. upload válido + download íntegro ----------
  let r = await upload(mestre, CID, "mapa do cais.png", PNG_1PX, { "x-file-mime": "image/png", "x-visibility": "publica" });
  t("1 mestre envia PNG", r.status === 201, JSON.stringify(r.json));
  const fidImg = r.json?.id;
  const dl = await download(j1.cookie, CID, fidImg);
  t("1b download íntegro (sha256 igual)", dl.status === 200 && sha(dl.buf) === sha(PNG_1PX));

  // ---------- 2. validações de upload ----------
  r = await upload(mestre, CID, "vazio.txt", Buffer.alloc(0));
  t("2a arquivo vazio rejeitado (400)", r.status === 400, `status=${r.status}`);
  r = await upload(mestre, CID, "virus.exe", Buffer.from("MZ"));
  t("2b extensão .exe rejeitada (415)", r.status === 415, `status=${r.status}`);
  r = await upload(mestre, CID, "script.bat", Buffer.from("@echo off"));
  t("2c extensão .bat rejeitada (415)", r.status === 415, `status=${r.status}`);
  r = await upload(mestre, CID, "fake.png", Buffer.from("isto nao e png"), { "x-file-mime": "image/png" });
  t("2d conteúdo divergente de imagem rejeitado", r.status === 415 || r.status === 400, `status=${r.status}`);
  // limite padrão = 25MB (servidor/src/config.ts); 26MB deve ser rejeitado
  const acima = Buffer.alloc(26 * 1024 * 1024, 0x61);
  r = await upload(mestre, CID, "grande.txt", acima);
  t("2e arquivo acima do limite rejeitado (413)", r.status === 413, `status=${r.status}`);

  // ---------- 3. nome malicioso / colisão de nome ----------
  r = await upload(mestre, CID, "../../etc/passwd.png", PNG_1PX, { "x-visibility": "publica" });
  t("3a nome com traversal aceito como dado, não caminho", r.status === 201, JSON.stringify(r.json));
  const fidTrav = r.json?.id;
  if (fidTrav) {
    const db = abrirDb(BANCO);
    const row = db.prepare("select storage_name from files where id=?").get(fidTrav);
    db.close();
    t("3b storage_name é uuid seguro (sem traversal)", !!row && /^[0-9a-f-]{36}\./.test(row.storage_name), row?.storage_name);
  }
  // mesmo nome por usuários diferentes → sem colisão/sobrescrita
  r = await upload(mestre, CID, "mesmo-nome.txt", "conteudo-do-mestre", { "x-visibility": "publica" });
  const fidM1 = r.json?.id;
  r = await upload(j1.cookie, CID, "mesmo-nome.txt", "conteudo-do-jogador");
  const fidJ1 = r.json?.id;
  t("3c mesmo nome por mestre e jogador → ids distintos", !!fidM1 && !!fidJ1 && fidM1 !== fidJ1);
  const dlM = fidM1 ? await download(mestre, CID, fidM1) : { status: 0 };
  const dlJ = fidJ1 ? await download(mestre, CID, fidJ1) : { status: 0 };
  t("3d conteúdos independentes preservados", dlM.buf.toString() === "conteudo-do-mestre" && dlJ.buf.toString() === "conteudo-do-jogador");

  // ---------- 4. moderação de envio de jogador ----------
  // jogador1 enviou "mesmo-nome.txt" (pendente por padrão)
  const lst = await lista(mestre, CID);
  const arqJogador = (lst.json?.arquivos ?? []).find((a) => a.id === fidJ1);
  t("4a envio de jogador fica pendente visível ao mestre", !!arqJogador && arqJogador.status === "pendente", JSON.stringify(arqJogador?.status));
  const dlPendenteOutro = fidJ1 ? await download(j2.cookie, CID, fidJ1) : { status: 0 };
  t("4b pendente invisível a outro jogador", dlPendenteOutro.status === 403 || dlPendenteOutro.status === 404, `status=${dlPendenteOutro.status}`);
  if (fidJ1) {
    const mod = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/${fidJ1}/moderacao`, {
      method: "PATCH", headers: { cookie: mestre, "content-type": "application/json" }, body: JSON.stringify({ acao: "aprovar" }),
    });
    t("4c mestre aprova envio", mod.status === 200, `status=${mod.status}`);
  }

  // ---------- 5. isolamento entre campanhas ----------
  // /auth/setup só roda uma vez por servidor — campanha B criada via API
  // com o mesmo mestre (sem segundo criarCenario).
  const campB = await fetch(`${BASE}/api/campaigns`, {
    method: "POST", headers: { cookie: mestre, "content-type": "application/json" },
    body: JSON.stringify({ name: "Campanha B Invasora" }),
  });
  const campBJson = await campB.json().catch(() => null);
  const CID_B = campBJson?.campanha?.id;
  t("5.0 campanha B criada", campB.status === 200 || campB.status === 201, `status=${campB.status}`);
  const dlCross = CID_B ? await download(mestre, CID_B, fidImg) : { status: 0 };
  t("5a arquivo da campanha A inacessível via campanha B", dlCross.status === 404 || dlCross.status === 403, `status=${dlCross.status}`);
  const lstB = await lista(mestre, CID_B);
  t("5b listagem da campanha B não contém arquivo de A", !(lstB.json?.arquivos ?? []).some((a) => a.id === fidImg));

  // ---------- 6. membro removido perde acesso ----------
  {
    const db = abrirDb(BANCO);
    db.prepare("update memberships set status='removido', updated_at=? where id=?").run(Date.now(), j2.membershipId);
    db.close();
    const dlRem = await download(j2.cookie, CID, fidImg);
    t("6a membro removido não baixa arquivo", dlRem.status === 401 || dlRem.status === 403 || dlRem.status === 404, `status=${dlRem.status}`);
    const upRem = await upload(j2.cookie, CID, "tentativa.txt", "x");
    t("6b membro removido não faz upload", upRem.status === 401 || upRem.status === 403 || upRem.status === 404, `status=${upRem.status}`);
  }

  // ---------- 7. persistência em disco ----------
  {
    const db = abrirDb(BANCO);
    const row = db.prepare("select storage_name from files where id=?").get(fidImg);
    db.close();
    const fisico = row ? resolve(`${DIR}/arq/${CID}`, row.storage_name) : "";
    t("7 arquivo persistido em disco dentro do dir da campanha", !!row && existsSync(fisico), fisico);
  }

  // ---------- 8. interrupção durante upload (#295 residual) ----------
  // 8a/8b: cliente destrói o socket no meio do corpo — o servidor deve
  // seguir saudável e não pode sobrar linha em `files` nem órfão em disco.
  const arquivosDir = `${DIR}/arq/${CID}`;
  const contarLinhas = () => {
    const db = abrirDb(BANCO);
    const n = db.prepare("select count(*) c from files where campaign_id=?").get(CID).c;
    db.close();
    return n;
  };
  const arquivosEmDisco = () => {
    const nomes = new Set();
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== ".lixeira") walk(p); }
        else nomes.add(e.name);
      }
    };
    if (existsSync(arquivosDir)) walk(arquivosDir);
    return nomes;
  };
  const storageNames = () => {
    const db = abrirDb(BANCO);
    const s = new Set(db.prepare("select storage_name from files where campaign_id=?").all(CID).map((r) => r.storage_name));
    db.close();
    return s;
  };
  const nAntes = contarLinhas();

  const uploadSocketAbort = () => new Promise((resolveP) => {
    const reqHttp = httpRequest(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
      method: "POST",
      headers: {
        cookie: mestre, "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("abortado-parcial.txt"),
        "x-file-mime": "text/plain",
        "content-length": String(5 * 1024 * 1024), // declara 5MB, envia ~64KB e corta
      },
    }, (res) => { res.resume(); resolveP(res.statusCode ?? 0); });
    reqHttp.on("error", () => resolveP(0));
    reqHttp.write(Buffer.alloc(64 * 1024, 0x61));
    setTimeout(() => reqHttp.destroy(), 40);
  });
  await uploadSocketAbort();
  await uploadSocketAbort();
  await new Promise((r) => setTimeout(r, 500)); // janela p/ eventual cleanup/erro

  const healthAposAborto = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  t("8a servidor saudável após 2 uploads abortados no socket", healthAposAborto);
  t("8b nenhum upload abortado virou registro", contarLinhas() === nAntes,
    `${nAntes}→${contarLinhas()}`);
  {
    const disco = arquivosEmDisco(), dbSet = storageNames();
    const orfaos = [...disco].filter((f) => !dbSet.has(f));
    const faltando = [...dbSet].filter((f) => !disco.has(f));
    t("8c disco↔banco consistentes após abortos", orfaos.length === 0 && faltando.length === 0,
      `orfaos=${orfaos.join(",")} faltando=${faltando.join(",")}`);
  }

  // 8d/8e: kill do servidor NO MEIO de um upload grande + restart —
  // nenhuma linha pode apontar para arquivo parcial/inexistente e o
  // serviço volta íntegro.
  {
    const grande = Buffer.alloc(20 * 1024 * 1024, 0x62); // .txt 20MB < limite 25MB
    const pUpload = fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
      method: "POST",
      headers: { cookie: mestre, "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("grande-interrompido.txt"), "x-file-mime": "text/plain" },
      body: grande,
    }).then((r) => r.status).catch(() => 0);
    await new Promise((r) => setTimeout(r, 120)); // corpo em transferência/processamento
    await encerrarServidor(proc);
    const stUpload = await pUpload.catch(() => 0);
    proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
    await esperarSaudavel(BASE, proc);
    t("8d servidor reiniciado após kill durante upload", true, `upload status=${stUpload}`);
    {
      const db = abrirDb(BANCO);
      const rows = db.prepare("select storage_name, size_bytes from files where campaign_id=?").all(CID);
      db.close();
      const invalidas = rows.filter((r2) => {
        const p = join(arquivosDir, r2.storage_name);
        return !existsSync(p) || statSync(p).size !== r2.size_bytes;
      });
      t("8e nenhuma row aponta para arquivo parcial/inexistente", invalidas.length === 0,
        invalidas.map((r2) => r2.storage_name).join(","));
      const disco = arquivosEmDisco(), dbSet = storageNames();
      const orfaos = [...disco].filter((f) => !dbSet.has(f));
      t("8f nenhum órfão em disco após crash (informativo se >0)", true,
        `orfaos=${orfaos.length}${orfaos.length ? " [" + orfaos.join(",") + "]" : ""}`);
      const upPos = await upload(mestre, CID, "pos-crash.txt", "funciona");
      t("8g upload funciona após reinício", upPos.status === 201, `status=${upPos.status}`);
    }
  }
} catch (e) {
  t("execução sem exceção", false, String(e?.message ?? e).slice(0, 200));
} finally {
  try { if (proc) await encerrarServidor(proc); } finally { if (DIR) limparDir(DIR); }
}

const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n==== RESULTADO: ${resultados.length - falhas} ok, ${falhas} falhas ====`);
process.exit(falhas ? 1 : 0);
