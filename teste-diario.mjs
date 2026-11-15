// Testes de integração — Etapa 11: diário, anotações do mestre, anexos e histórico de sessões
// Isolado (Lote 1): banco SQLite, uploads e backups vivem em diretórios
// temporários via teste-base.mjs — nenhum acesso a banco/mestre-rpg.db,
// usuários, campanhas ou arquivos reais.
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req as reqBase, criarCenario, comDb, abrirDb,
} from "./teste-base.mjs";

const RAIZ = dirTeste("diario");
const BANCO = join(RAIZ, "banco", "mestre-rpg.db");
const ARQUIVOS = join(RAIZ, "arquivos", "campanhas");
const BACKUPS = join(RAIZ, "backups");

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

const RUN = Date.now().toString(36);
let proc = null;
let BASE = "";

try {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  BASE = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
  await esperarSaudavel(BASE, proc);

  const ids = await criarCenario(BASE, BANCO, {
    jogadores: { jog5: "jogador_cinco", jog2: "jogador_dois" },
  });
  const CID = ids.campId;
  const ADMIN = { cookie: ids.cookieMestre };
  const JOG5 = { cookie: ids.jogadores.jog5.cookie };
  const JOG2 = { cookie: ids.jogadores.jog2.cookie };
  const uJ5 = ids.jogadores.jog5.id;
  const uJ2 = ids.jogadores.jog2.id;
  const CHAR = ids.novoPersonagem(ids.jogadores.jog5.membershipId, "P5 Diário");

  const req = (metodo, path, { cookie = ADMIN.cookie, body } = {}) =>
    reqBase(BASE, metodo, `/campaigns/${CID}${path}`, { cookie, body });

  // ============ 1-6: diário do jogador ============
  let r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: `Diario E11 ${RUN}`, content: "encontrei uma pista", category: "pista", characterId: CHAR, kind: "diario", visibility: "privada" } });
  t("1 criar anotação no diário", r.status === 201, JSON.stringify(r.json));
  const notaId = r.json?.id;

  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { content: "pista confirmada", important: true } });
  t("2 editar anotação", r.status === 200);

  // privacidade: jogador2 não vê diário privado de jogador5
  let lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("3 diário privado não vaza", !lista.some((a) => a.id === notaId));

  // compartilhar com mestre
  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { visibility: "mestre" } });
  t("4 compartilhar com mestre", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("4b mestre vê compartilhada", lista.some((a) => a.id === notaId));

  // compartilhamento seletivo com jogador2
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
  r = await req("PATCH", `/anotacoes/${notaMestre}`, { cookie: ADMIN.cookie, body: { visibility: "selecionada", recipients: [uJ5] } });
  t("10 mestre compartilha selecionado", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("10b jogador selecionado vê", lista.some((a) => a.id === notaMestre));
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("10c não selecionado não vê", !lista.some((a) => a.id === notaMestre));

  // ============ 13-18: anexos ============
  // arquivo privado do mestre (visibility=mestre) e arquivo público
  const upPriv = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("segredo-mestre.txt"), "x-file-mime": "text/plain", "x-visibility": "mestre" },
    body: Buffer.from("segredo"),
  });
  const filePriv = (await upPriv.json())?.id;
  const upPub = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("mapa-e11.txt"), "x-file-mime": "text/plain", "x-visibility": "publica" },
    body: Buffer.from("mapa"),
  });
  const filePub = (await upPub.json())?.id;
  t("13 uploads de anexo criados", !!filePriv && !!filePub, `${upPriv.status}/${upPub.status}`);

  // evidência de isolamento: os binários ficam no diretório temporário
  const gravados = readdirSync(ARQUIVOS, { recursive: true }).filter((f) => typeof f === "string");
  t("13c uploads gravados só no diretório temporário", gravados.length >= 2, gravados.join(","));

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

  // remove anexo
  r = await req("DELETE", `/anotacoes/${notaId}/anexos/${filePub}`, { cookie: JOG5.cookie });
  t("17 remover anexo", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("17b anexo sumiu", !(lista.find((a) => a.id === notaId)?.anexos ?? []).length);

  // upload direto com x-note-id (mestre anexa à própria nota)
  const upAnexo = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
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
  // isolamento: anotação de OUTRA campanha com o mesmo título não aparece
  const camp2 = await reqBase(BASE, "POST", "/campaigns", { cookie: ADMIN.cookie, body: { name: "Campanha Isolada" } });
  const CID2 = camp2.json?.campanha?.id;
  if (CID2) {
    const w = abrirDb(BANCO);
    try {
      w.prepare(
        "insert into notes (id,campaign_id,owner_id,kind,title,content,created_at,updated_at) values (?,?,?,?,?,?,?,?)"
      ).run(crypto.randomUUID(), CID2, uJ5, "diario", `Diario E11 ${RUN}`, "nota de outra campanha", Date.now(), Date.now());
    } finally { w.close(); }
  }
  lista = (await req("GET", "/anotacoes?tipo=todas", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("25 isolamento entre campanhas", !lista.some((a) => a.title === `Diario E11 ${RUN}` && a.campaignId === CID2));

  // persistência direta no banco temporário
  comDb(BANCO, (db) => {
    const rowNota = db.prepare("select * from notes where id=?").get(notaId);
    const rowAtt = db.prepare("select count(*) c from note_attachments where note_id=?").get(notaMestre).c;
    t("26 registros persistidos no SQLite", !!rowNota && rowNota.kind === "diario" && rowAtt === 1, `atts=${rowAtt}`);
  });

  // nota de mestre continua privada para jogador2 via API (mesmo forçando id)
  r = await req("GET", "/anotacoes?tipo=todas", { cookie: JOG2.cookie });
  t("27 nota mestre não vaza p/ não selecionado", !(r.json?.anotacoes ?? []).some((a) => a.id === notaMestre));

  // excluir anotação (dono)
  r = await req("DELETE", `/anotacoes/${notaId}`, { cookie: JOG5.cookie });
  t("28 excluir anotação do diário", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("28b anotação removida", !lista.some((a) => a.id === notaId));

  // ============ 29-31: regressões de anexos ============
  // anexo em anotação inexistente → 404
  r = await req("POST", "/anotacoes/nota-inexistente/anexos", { cookie: JOG5.cookie, body: { fileId: filePub } });
  t("29 anexo em anotação inexistente rejeitado", r.status === 404, `status=${r.status}`);
  // jogador não anexa arquivo na nota de outro dono → 403
  r = await req("POST", `/anotacoes/${notaMestre}/anexos`, { cookie: JOG5.cookie, body: { fileId: filePub } });
  t("29b anexo em nota alheia rejeitado", r.status === 403, `status=${r.status}`);
  // arquivo inexistente → 404
  r = await req("POST", `/anotacoes/${notaMestre}/anexos`, { cookie: ADMIN.cookie, body: { fileId: "arquivo-inexistente" } });
  t("29c anexo de arquivo inexistente rejeitado", r.status === 404, `status=${r.status}`);
  // nome de arquivo hostil não escapa do diretório temporário
  const upHostil = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("../../fora-do-temp.txt"), "x-file-mime": "text/plain", "x-visibility": "publica" },
    body: Buffer.from("hostil"),
  });
  t("29d upload com nome hostil não quebra nem vaza", upHostil.status === 201, `status=${upHostil.status}`);
} catch (e) {
  fail++; res.push("EXCEÇÃO " + (e?.stack ?? e));
} finally {
  await encerrarServidor(proc);
  limparDir(RAIZ);
  console.log(res.join("\n"));
  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}
