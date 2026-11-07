// Testes de integração — Etapa 9: biblioteca de arquivos das campanhas
import Database from "better-sqlite3";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";
const CID2 = "1de51765-25aa-4713-b3f4-1ca866d10a27";
const U_JOG2 = "d3d69771-964b-43cd-9013-9208b50165b3";
const MEMBERSHIP_JOG2 = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, U_JOG2).id;
const DIR_CID = resolve("arquivos/campanhas", CID);

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t9-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");
const JOG5 = sessaoHttp("jogador_e5");
const JOG2 = sessaoHttp("jogador2");

async function req(metodo, path, { cookie = ADMIN.cookie, body, cid = CID } = {}) {
  const r = await fetch(`${API}/campaigns/${cid}${path}`, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json };
}

async function upload(cookie, nome, conteudo, headers = {}, cid = CID) {
  const buf = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, "utf8");
  const r = await fetch(`${API}/campaigns/${cid}/arquivos/upload`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(nome), "x-file-mime": "application/octet-stream", ...headers },
    body: buf,
  });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
}

async function download(cookie, fid, cid = CID) {
  const r = await fetch(`${API}/campaigns/${cid}/arquivos/${fid}`, { headers: { cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, tipo: r.headers.get("content-type") };
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let fidImagem, fidPdf, fidPublico, fidPrivado, fidMestreSel, fidJogador, fidSnap, pastaMapas, pastaNpcs;

try {
  // ============ 1-6: mestre envia e organiza ============
  let r = await upload(ADMIN.cookie, "mapa.png", PNG_1PX, { "x-file-mime": "image/png", "x-display-name": "Mapa do cais", "x-category": "mapas", "x-visibility": "publica" });
  t("1 mestre envia imagem", r.status === 201, JSON.stringify(r.json));
  fidImagem = r.json?.id;

  r = await upload(ADMIN.cookie, "regras.pdf", "%PDF-1.4 fake", { "x-file-mime": "application/pdf", "x-visibility": "mestre", "x-display-name": "Regras internas" });
  t("2 mestre envia PDF", r.status === 201, JSON.stringify(r.json));
  fidPdf = r.json?.id;

  r = await req("POST", "/arquivos/pastas", { body: { name: "Mapas" } });
  t("3a mestre cria pasta", r.status === 201);
  pastaMapas = r.json?.id;
  r = await req("POST", "/arquivos/pastas", { body: { name: "NPCs", parentId: pastaMapas } });
  pastaNpcs = r.json?.id;

  // move arquivo para a pasta
  r = await req("PATCH", `/arquivos/${fidImagem}`, { body: { folderId: pastaMapas, category: "mapas" } });
  t("4 mestre move arquivo entre pastas", r.status === 200);

  // renomeia (displayName)
  r = await req("PATCH", `/arquivos/${fidImagem}`, { body: { displayName: "Mapa do cais E9", description: "Mapa da cena do crime" } });
  t("5 mestre renomeia arquivo", r.status === 200);

  // exclui arquivo (confirmação é responsabilidade da UI; API exige dono/mestre)
  r = await upload(ADMIN.cookie, "temp.txt", "lixo", { "x-visibility": "mestre" });
  const fidTemp = r.json?.id;
  r = await req("DELETE", `/arquivos/${fidTemp}`);
  t("6 mestre exclui arquivo", r.status === 200);
  const sumiu = !db.prepare("select id from files where id=?").get(fidTemp);
  const naLixeira = readdirSync(resolve(DIR_CID, ".lixeira")).some((f) => f.startsWith(fidTemp));
  t("6b exclusão vai p/ lixeira (recuperável)", sumiu && naLixeira);

  // pasta não vazia não exclui
  r = await req("DELETE", `/arquivos/pastas/${pastaMapas}`);
  t("6c pasta não vazia rejeita exclusão", r.status === 409);

  // ============ 7-9: visibilidade ============
  r = await upload(ADMIN.cookie, "aviso.txt", "todos veem", { "x-visibility": "publica" });
  fidPublico = r.json?.id;
  r = await upload(ADMIN.cookie, "segredo.txt", "só mestre", { "x-visibility": "mestre" });
  fidPrivado = r.json?.id;
  r = await upload(ADMIN.cookie, "dica.txt", "só jog5", { "x-visibility": "selecionada", "x-recipients": "4c7999c1-b12e-4cd2-acb6-4188ab9bf657" });
  fidMestreSel = r.json?.id;

  let dl = await download(JOG5.cookie, fidImagem);
  t("7a jogador acessa imagem compartilhada", dl.status === 200 && dl.buf.equals(PNG_1PX));
  dl = await download(JOG5.cookie, fidPublico);
  t("7b jogador acessa arquivo público", dl.status === 200);
  dl = await download(JOG5.cookie, fidPrivado);
  t("8 jogador não acessa arquivo privado", dl.status === 403);
  dl = await download(ADMIN.cookie, fidPrivado);
  t("8b mestre acessa privado", dl.status === 200);
  dl = await download(JOG5.cookie, fidMestreSel);
  t("8c selecionado acessa", dl.status === 200);
  dl = await download(JOG2.cookie, fidMestreSel);
  t("8d não-selecionado não acessa", dl.status === 403);

  // espectador
  db.prepare("update memberships set role='espectador' where id=?").run(MEMBERSHIP_JOG2);
  let lista = (await req("GET", "/arquivos", { cookie: JOG2.cookie })).json?.arquivos ?? [];
  const idsEsp = new Set(lista.map((a) => a.id));
  t("9a espectador vê só autorizados", idsEsp.has(fidPublico) && idsEsp.has(fidImagem) && !idsEsp.has(fidPrivado) && !idsEsp.has(fidMestreSel), [...idsEsp].join(","));
  dl = await download(JOG2.cookie, fidPublico);
  t("9b espectador baixa público", dl.status === 200);
  dl = await download(JOG2.cookie, fidPrivado);
  t("9c espectador não baixa privado", dl.status === 403);
  db.prepare("update memberships set role='jogador' where id=?").run(MEMBERSHIP_JOG2);

  // ============ 10-12: envio por jogador ============
  r = await upload(JOG5.cookie, "nota_jogador.txt", "anexo do jogador", { "x-visibility": "publica" });
  t("10a jogador envia quando autorizado", r.status === 201, JSON.stringify(r.json));
  fidJogador = r.json?.id;
  let arq = db.prepare("select status,visibility from files where id=?").get(fidJogador);
  t("10b envio fica pendente e visível só ao mestre", arq.status === "pendente" && arq.visibility === "mestre");
  dl = await download(JOG2.cookie, fidJogador);
  t("10c pendente invisível p/ outros jogadores", dl.status === 403);

  // bloqueio por config
  await req("PUT", "/regras/config", { body: { arquivos: { jogadoresEnviam: false, espectadorVe: true, formatosExtras: [] } } });
  r = await upload(JOG5.cookie, "outro.txt", "x");
  t("11 jogador não envia quando bloqueado", r.status === 403, `status=${r.status}`);
  await req("PUT", "/regras/config", { body: { arquivos: { jogadoresEnviam: true, espectadorVe: true, formatosExtras: [] } } });

  // moderacao
  r = await req("PATCH", `/arquivos/${fidJogador}/moderacao`, { body: { acao: "aprovar" } });
  t("12a mestre aprova envio", r.status === 200);
  dl = await download(JOG2.cookie, fidJogador);
  // rejeitado antes de aprovar? visibility mestre — após aprovar ainda é mestre; jogador vê? não (visibility mestre)
  t("12b moderação registrada", db.prepare("select status from files where id=?").get(fidJogador).status === "aprovado");
  r = await req("PATCH", `/arquivos/${fidJogador}/moderacao`, { cookie: JOG5.cookie, body: { acao: "rejeitar" } });
  t("12c jogador não modera", r.status === 403);

  // jogador não edita/exclui arquivo alheio
  r = await req("PATCH", `/arquivos/${fidImagem}`, { cookie: JOG5.cookie, body: { displayName: "hack" } });
  t("12d jogador não edita arquivo alheio", r.status === 403);
  r = await req("DELETE", `/arquivos/${fidImagem}`, { cookie: JOG5.cookie });
  t("12e jogador não exclui arquivo alheio", r.status === 403);

  // ============ 13-17: segurança ============
  r = await upload(ADMIN.cookie, "isolado.txt", "só E4", {}, CID2);
  const fidE4 = r.json?.id;
  dl = await download(ADMIN.cookie, fidE4, CID);
  t("13 campanhas isoladas", dl.status === 404);
  lista = (await req("GET", "/arquivos", { cookie: ADMIN.cookie })).json?.arquivos ?? [];
  t("13b arquivo de outra campanha não lista", !lista.some((a) => a.id === fidE4));

  dl = await download(JOG2.cookie, fidPrivado);
  t("14 URL sem autorização nega", dl.status === 403);
  const semCookie = await fetch(`${API}/campaigns/${CID}/arquivos/${fidPublico}`);
  t("14b sem cookie nega", semCookie.status === 401);

  r = await upload(ADMIN.cookie, "virus.exe", "MZ", {});
  t("15 upload .exe rejeitado", r.status === 415, `status=${r.status}`);
  r = await upload(ADMIN.cookie, "script.bat", "@echo", {});
  t("15b upload .bat rejeitado", r.status === 415);

  const grande = Buffer.alloc(26 * 1024 * 1024, 1); // 26MB > 25MB
  r = await upload(ADMIN.cookie, "grande.png", grande, {});
  t("16 upload acima do limite rejeitado", r.status === 413 || r.status === 500, `status=${r.status}`);

  r = await upload(ADMIN.cookie, "../../../etc/passwd.png", "x", {});
  t("17 nome malicioso não altera caminho", r.status === 201);
  const fidTrav = r.json?.id;
  const arqTrav = db.prepare("select storage_name from files where id=?").get(fidTrav);
  t("17b storage_name é uuid seguro", /^[0-9a-f-]{36}\./.test(arqTrav.storage_name), arqTrav.storage_name);
  const fisico = resolve(DIR_CID, arqTrav.storage_name);
  t("17c arquivo gravado dentro do dir da campanha", fisico.startsWith(resolve(DIR_CID)) && existsSync(fisico));

  // ============ 18: persistência ============
  dl = await download(ADMIN.cookie, fidImagem);
  t("18 arquivo disponível via API (persistido em disco)", dl.status === 200);

  // ============ 19-22: snapshots ============
  const snapAntes = db.prepare("select count(*) c from files where campaign_id=?").get(CID).c;
  r = await req("POST", "/snapshots", { body: { description: "Snapshot arquivos E9" } });
  const snapId = r.json?.id;
  const snapData = JSON.parse(db.prepare("select data from snapshots where id=?").get(snapId).data);
  t("19 snapshot registra arquivos", (snapData.files ?? []).length >= snapAntes, `${(snapData.files ?? []).length} vs ${snapAntes}`);

  // exclui arquivo (vai p/ lixeira) e restaura snapshot → deve recuperar da lixeira
  await req("DELETE", `/arquivos/${fidPdf}`);
  r = await req("POST", `/snapshots/${snapId}/restaurar`, { body: { confirmacao: "RESTAURAR" } });
  t("20 restauração recupera arquivos", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
  const arqPos = db.prepare("select id, storage_name from files where id=?").get(fidPdf);
  const vivoPos = arqPos?.storage_name && existsSync(resolve(DIR_CID, arqPos.storage_name));
  t("20b arquivo físico restaurado da lixeira", !!arqPos && vivoPos);

  // arquivo ausente: snapshot contém o arquivo, mas o físico é perdido antes do restore
  r = await upload(ADMIN.cookie, "vai_sumir.txt", "conteúdo", { "x-visibility": "publica" });
  const fidSumiu = r.json?.id;
  r = await req("POST", "/snapshots", { body: { description: "Com arquivo" } });
  const snapCom = r.json?.id;
  await req("DELETE", `/arquivos/${fidSumiu}`); // row some, físico → lixeira
  // remove a cópia da lixeira para simular perda total
  const snapRow = JSON.parse(db.prepare("select data from snapshots where id=?").get(snapCom).data);
  const fSumiu = (snapRow.files ?? []).find((f) => f.id === fidSumiu);
  if (fSumiu?.storageName) {
    const lix = resolve(DIR_CID, ".lixeira", fSumiu.storageName);
    if (existsSync(lix)) rmSync(lix);
  }
  r = await req("POST", `/snapshots/${snapCom}/restaurar`, { body: { confirmacao: "RESTAURAR" } });
  const ausentes = r.json?.arquivosAusentes ?? [];
  const linhaSumiu = db.prepare("select file_name from files where id=?").get(fidSumiu);
  t("21 restauração informa arquivos ausentes", r.status === 200 && ausentes.includes(linhaSumiu?.file_name ?? "x") && !!linhaSumiu, JSON.stringify({ ausentes, linhaSumiu }));
  await req("DELETE", `/arquivos/${fidSumiu}`); // limpa o registro sem físico

  // 22: referências consistentes — todo file row tem storage_name e arquivo físico ou lixeira
  const orfaos = db.prepare("select id, storage_name from files where campaign_id=? and storage_name is not null").all(CID)
    .filter((f) => f.id !== fidSumiu && !existsSync(resolve(DIR_CID, f.storage_name)) && !existsSync(resolve(DIR_CID, ".lixeira", f.storage_name)));
  t("22 sem referências quebradas", orfaos.length === 0, JSON.stringify(orfaos.map((o) => o.id)));
} catch (e) {
  fail++; res.push("EXCEÇÃO " + (e?.stack ?? e));
} finally {
  db.prepare("update memberships set role='jogador' where id=?").run(MEMBERSHIP_JOG2);
}

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
