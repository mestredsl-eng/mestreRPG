// Testes de integração — Etapa 11: diário, anotações do mestre, anexos e histórico de sessões
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";   // Caçadores & Caçados
const CID2 = "1de51765-25aa-4713-b3f4-1ca866d10a27";  // Campanha Teste E4
const CHAR_T3 = "fc54075d-6eb0-4692-bff0-b225d404da41"; // personagem de jogador_e5

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t11-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");
const JOG5 = sessaoHttp("jogador_e5");
const JOG2 = sessaoHttp("jogador2");

async function req(metodo, path, { cookie = ADMIN.cookie, body, cid = CID, raw } = {}) {
  const r = await fetch(`${API}/campaigns/${cid}${path}`, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

const RUN = Date.now().toString(36);

try {
  // ============ 1-6: diário do jogador ============
  let r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: `Diario E11 ${RUN}`, content: "encontrei uma pista", category: "pista", characterId: CHAR_T3, kind: "diario", visibility: "privada" } });
  t("1 criar anotação no diário", r.status === 201, JSON.stringify(r.json));
  const notaId = r.json?.id;

  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { content: "pista confirmada", important: true } });
  t("2 editar anotação", r.status === 200);

  // privacidade: jogador2 não vê diário privado de jogador_e5
  let lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("3 diário privado não vaza", !lista.some((a) => a.id === notaId));

  // compartilhar com mestre
  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { visibility: "mestre" } });
  t("4 compartilhar com mestre", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("4b mestre vê compartilhada", lista.some((a) => a.id === notaId));

  // compartilhamento seletivo com jogador2
  const uJ2 = db.prepare("select id from users where username='jogador2'").get().id;
  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { visibility: "selecionada", recipients: [uJ2] } });
  t("5 compartilhar com selecionado", r.status === 200, JSON.stringify(r.json));
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("5b selecionado recebe", lista.some((a) => a.id === notaId));

  // personagem errado é rejeitado
  r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: "x", kind: "diario", characterId: "inexistente" } });
  t("6 characterId inválido rejeitado", r.status === 400);

  // ============ 7-12: anotações do mestre ============
  r = await req("POST", "/anotacoes", { cookie: ADMIN.cookie, body: { title: `Mestre E11 ${RUN}`, content: "segredo do mestre", kind: "mestre", category: "misterio", visibility: "privada" } });
  t("7 mestre cria anotação privada", r.status === 201);
  const notaMestre = r.json?.id;

  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("8 jogador não vê nota privada do mestre", !lista.some((a) => a.id === notaMestre));

  // jogador tenta criar nota de mestre → 403
  r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: "fake", kind: "mestre" } });
  t("9 jogador não cria nota de mestre", r.status === 403);

  // mestre compartilha com jogador selecionado
  const uJ5 = db.prepare("select id from users where username='jogador_e5'").get().id;
  r = await req("PATCH", `/anotacoes/${notaMestre}`, { cookie: ADMIN.cookie, body: { visibility: "selecionada", recipients: [uJ5] } });
  t("10 mestre compartilha selecionado", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("10b jogador selecionado vê", lista.some((a) => a.id === notaMestre));
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("10c não selecionado não vê", !lista.some((a) => a.id === notaMestre));

  // ============ 13-18: anexos ============
  // arquivo privado do mestre (visibility=mestre) e arquivo público
  const upPriv = await fetch(`${API}/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("segredo-mestre.txt"), "x-file-mime": "text/plain", "x-visibility": "mestre" },
    body: Buffer.from("segredo"),
  });
  const filePriv = (await upPriv.json())?.id;
  const upPub = await fetch(`${API}/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("mapa-e11.txt"), "x-file-mime": "text/plain", "x-visibility": "publica" },
    body: Buffer.from("mapa"),
  });
  const filePub = (await upPub.json())?.id;
  t("13 uploads de anexo criados", !!filePriv && !!filePub, `${upPriv.status}/${upPub.status}`);

  // anexa arquivo público à nota do jogador
  r = await req("POST", `/anotacoes/${notaId}/anexos`, { cookie: JOG5.cookie, body: { fileId: filePub } });
  t("14 anexar arquivo à anotação", r.status === 201, JSON.stringify(r.json));

  // jogador NÃO pode anexar arquivo privado do mestre
  r = await req("POST", `/anotacoes/${notaId}/anexos`, { cookie: JOG5.cookie, body: { fileId: filePriv } });
  t("15 anexo de arquivo invisível rejeitado", r.status === 403, `status=${r.status}`);

  // lista traz o anexo
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  const notaLista = lista.find((a) => a.id === notaId);
  t("16 anexo aparece na listagem", (notaLista?.anexos ?? []).some((a) => a.fileId === filePub), JSON.stringify(notaLista?.anexos));

  // jogador2 não vê a nota (agora selecionada p/ ele na verdade — usa outra nota privada)
  // remove anexo
  r = await req("DELETE", `/anotacoes/${notaId}/anexos/${filePub}`, { cookie: JOG5.cookie });
  t("17 remover anexo", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("17b anexo sumiu", !(lista.find((a) => a.id === notaId)?.anexos ?? []).length);

  // upload direto com x-note-id (mestre anexa à própria nota)
  const upAnexo = await fetch(`${API}/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("anexo-nota.txt"), "x-file-mime": "text/plain", "x-visibility": "publica", "x-note-id": notaMestre },
    body: Buffer.from("conteudo anexo"),
  });
  t("18 upload com x-note-id", upAnexo.status === 201, `status=${upAnexo.status}`);
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("18b anexo criado via upload", (lista.find((a) => a.id === notaMestre)?.anexos ?? []).length === 1);

  // ============ 19-24: histórico de sessões ============
  r = await req("POST", "/sessoes", { cookie: ADMIN.cookie, body: { name: `Sessão E11 ${RUN}` } });
  const sid = r.json?.sessao?.id;
  const numSessao = r.json?.sessao?.number;
  t("19 criar sessão", r.status === 201 && !!sid);

  // gera uma alteração auditável dentro da sessão (resumo pelo mestre)
  await req("PATCH", `/sessoes/${sid}`, { cookie: ADMIN.cookie, body: { summary: "resumo e11" } });
  r = await req("PATCH", `/sessoes/${sid}`, { cookie: ADMIN.cookie, body: { status: "encerrada" } });
  t("20 encerrar sessão", r.status === 200);

  const hist = (await req("GET", `/sessoes/${sid}/historico`, { cookie: JOG5.cookie })).json;
  t("21 histórico tem número da sessão", hist?.sessao?.number === numSessao && numSessao > 0);
  t("22 histórico tem datas e duração", !!hist?.sessao?.startedAt && !!hist?.sessao?.endedAt && hist?.duracaoMs >= 0, `dur=${hist?.duracaoMs}`);
  t("23 histórico tem resumo", hist?.resumo === "resumo e11");
  t("24 histórico tem alterações relevantes", Array.isArray(hist?.alteracoes) && hist.alteracoes.length > 0, JSON.stringify(hist?.alteracoes?.map((a) => a.action)));
  t("24b jogador não vê detalhe interno das alterações", hist?.alteracoes?.every((a) => a.detalhe === undefined));

  const histM = (await req("GET", `/sessoes/${sid}/historico`, { cookie: ADMIN.cookie })).json;
  t("24c mestre vê detalhe das alterações", histM?.alteracoes?.some((a) => a.detalhe !== undefined));

  // ============ 25-28: integridade, isolamento, persistência ============
  // isolamento: anotação da outra campanha não aparece
  lista = (await req("GET", "/anotacoes?tipo=todas", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("25 isolamento entre campanhas", !lista.some((a) => a.title === `Diario E11 ${RUN}` && a.campaignId === CID2));

  // persistência direta no banco
  const rowNota = db.prepare("select * from notes where id=?").get(notaId);
  const rowAtt = db.prepare("select count(*) c from note_attachments where note_id=?").get(notaMestre).c;
  t("26 registros persistidos no SQLite", !!rowNota && rowNota.kind === "diario" && rowAtt === 1, `atts=${rowAtt}`);

  // nota de mestre continua privada para jogador2 via API (mesmo forçando id)
  r = await req("GET", "/anotacoes?tipo=todas", { cookie: JOG2.cookie });
  t("27 nota mestre não vaza p/ não selecionado", !(r.json?.anotacoes ?? []).some((a) => a.id === notaMestre));

  // excluir anotação (dono)
  r = await req("DELETE", `/anotacoes/${notaId}`, { cookie: JOG5.cookie });
  t("28 excluir anotação do diário", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("28b anotação removida", !lista.some((a) => a.id === notaId));
} catch (e) {
  fail++; res.push("EXCEÇÃO " + (e?.stack ?? e));
}

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
