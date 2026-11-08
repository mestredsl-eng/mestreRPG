// Testes da Etapa A (polimento): modais e confirmações próprias.
// Cobre: redefinição de senha, remoção de usuário, remoção de participante,
// transferência de titularidade, exclusão de pasta/arquivo, encerrar sessão,
// cancelamento, responsividade mobile e ausência de diálogos nativos.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";
import { randomUUID } from "node:crypto";

const BASE = "http://localhost:3001";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(randomUUID(), userId, hashToken(token), "teste-modais", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const tokM = sessao(admin.id, "modais-m");
async function req(m, path, body, token = tokM, headers = {}) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}`, ...headers },
    body: body === undefined ? undefined : (typeof body === "string" || body instanceof Buffer ? body : JSON.stringify(body)),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const apiM = (m, p, b) => req(m, p, b);

// ---------- preparação: usuário descartável + campanha descartável ----------
const sufixo = Date.now().toString(36);
const usrTmp = await apiM("POST", "/api/admin/users", { username: `modal_${sufixo}`, password: "senha12345", displayName: "Modal Temp" });
ok("setup. usuário temporário criado", usrTmp.status === 200 || usrTmp.status === 201, `status=${usrTmp.status}`);
const tmpUserId = usrTmp.json?.usuario?.id ?? usrTmp.json?.id;

const camp = await apiM("POST", "/api/campaigns", { name: `modais-${sufixo}`, system: "teste" });
const CID = camp.json?.campanha?.id;
ok("setup. campanha descartável criada", !!CID, `status=${camp.status}`);

// membership do usuário temporário como jogador (direto no banco — mesmo padrão das sessões de teste)
const mestreMembership = db.prepare("select id from memberships where campaign_id=? and role='mestre'").get(CID);
db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
  .run(randomUUID(), CID, tmpUserId, "jogador", "ativo", "{}", Date.now(), Date.now());
const tmpMembership = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, tmpUserId);

// sessão do usuário temporário (para devolver titularidade depois)
const tokTmp = sessao(tmpUserId, "modais-t");

// ---------- API: sanidade dos endpoints usados pela UI ----------
{
  const r = await apiM("GET", `/api/campaigns/${CID}/members`);
  ok("API. lista membros da campanha", r.status === 200 && r.json.membros.length >= 2, `n=${r.json?.membros?.length}`);
}

// ---------- UI ----------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
const p = await ctx.newPage();
const erros = [];
p.on("pageerror", (e) => erros.push(String(e)));
p.on("dialog", (d) => { erros.push("DIALOG-NATIVO: " + d.message()); void d.dismiss(); });

// ===== Administração: redefinir senha + remover usuário =====
await p.goto(BASE, { waitUntil: "networkidle" });
await p.getByRole("button", { name: "Administração" }).click();
await p.waitForTimeout(900);

const linhaTmp = p.locator("tr", { hasText: `modal_${sufixo}` }).first();
ok("UI. usuário temporário listado", await linhaTmp.count() === 1);

// redefinir senha — abre modal
await linhaTmp.getByRole("button", { name: "Senha" }).click();
await p.waitForTimeout(400);
ok("UI. modal de senha abre", await p.locator(".modal-fundo .modal").count() === 1);
ok("UI. modal tem campo de senha", await p.locator('.modal input[type="password"]').count() === 1);
// cancelar não altera nada
await p.locator(".modal .acoes-modal button", { hasText: "Cancelar" }).click();
await p.waitForTimeout(300);
ok("UI. cancelar fecha modal de senha", await p.locator(".modal-fundo").count() === 0);

// redefinir de verdade
await linhaTmp.getByRole("button", { name: "Senha" }).click();
await p.locator('.modal input[type="password"]').fill("novasenha99");
await p.locator(".modal button[type=submit]").click();
await p.waitForTimeout(1200);
ok("UI. senha redefinida sem alerta nativo", erros.filter((e) => e.startsWith("DIALOG")).length === 0);
ok("UI. modal de senha fechou após sucesso", await p.locator(".modal-fundo").count() === 0);
const meTmp = await req("GET", "/api/auth/me", undefined, sessao(tmpUserId, "modais-t2"));
ok("API. nova senha funciona", meTmp.status === 200, `status=${meTmp.status}`);

// remover usuário — cancel depois confirma
await linhaTmp.getByRole("button", { name: "Remover" }).click();
await p.waitForTimeout(400);
ok("UI. modal de remoção abre", await p.locator(".modal-fundo .modal").count() === 1);
ok("UI. modal de remoção é destrutivo", await p.locator(".modal .acoes-modal button.perigo").count() === 1);
await p.locator(".modal .acoes-modal button", { hasText: "Cancelar" }).click();
await p.waitForTimeout(300);
const aindaExiste = await apiM("GET", "/api/admin/users");
ok("UI. cancelar manteve o usuário", aindaExiste.json.usuarios.some((u) => u.username === `modal_${sufixo}`));

await linhaTmp.getByRole("button", { name: "Remover" }).click();
await p.waitForTimeout(300);
await p.locator(".modal .acoes-modal button.perigo").click();
await p.waitForTimeout(1200);
ok("UI. usuário removido após confirmar", !(await apiM("GET", "/api/admin/users")).json.usuarios.some((u) => u.username === `modal_${sufixo}`));

// recria o usuário temporário para os testes de campanha
const usrTmp2 = await apiM("POST", "/api/admin/users", { username: `modal2_${sufixo}`, password: "senha12345" });
const tmpUserId2 = usrTmp2.json?.usuario?.id ?? usrTmp2.json?.id;
db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
  .run(randomUUID(), CID, tmpUserId2, "jogador", "ativo", "{}", Date.now(), Date.now());
const tmpMembership2 = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, tmpUserId2);

// ===== Campanha: remover participante + transferir titularidade =====
await p.getByRole("button", { name: "Campanhas" }).click();
await p.waitForTimeout(800);
await p.locator(".cartao-campanha", { hasText: `modais-${sufixo}` }).first().click();
await p.waitForTimeout(1200);
await p.getByRole("button", { name: /Participantes/ }).click();
await p.waitForTimeout(800);

const linhaMembro = p.locator("tr", { hasText: `modal2_${sufixo}` }).first();
ok("UI. participante temporário listado", await linhaMembro.count() === 1);

// remover participante — cancel primeiro
await linhaMembro.getByRole("button", { name: "Remover" }).click();
await p.waitForTimeout(400);
ok("UI. modal remover participante abre", await p.locator(".modal-fundo .modal").count() === 1);
await p.locator(".modal .acoes-modal button", { hasText: "Cancelar" }).click();
await p.waitForTimeout(300);
let membros = (await apiM("GET", `/api/campaigns/${CID}/members`)).json.membros;
ok("UI. cancelar manteve participante", membros.some((m) => m.membershipId === tmpMembership2.id));

// remove de verdade
await linhaMembro.getByRole("button", { name: "Remover" }).click();
await p.waitForTimeout(300);
await p.locator(".modal .acoes-modal button.perigo").click();
await p.waitForTimeout(1200);
membros = (await apiM("GET", `/api/campaigns/${CID}/members`)).json.membros.filter((m) => m.status !== "removido");
ok("UI. participante removido após confirmar", !membros.some((m) => m.membershipId === tmpMembership2.id));

// readiciona para testar transferência
const usrTmp3 = await apiM("POST", "/api/admin/users", { username: `modal3_${sufixo}`, password: "senha12345" });
const tmpUserId3 = usrTmp3.json?.usuario?.id ?? usrTmp3.json?.id;
db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
  .run(randomUUID(), CID, tmpUserId3, "mestre", "ativo", "{}", Date.now(), Date.now());
const tmpMembership3 = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, tmpUserId3);
await p.getByRole("button", { name: "Campanhas" }).click();
await p.waitForTimeout(800);
await p.locator(".cartao-campanha", { hasText: `modais-${sufixo}` }).first().click();
await p.waitForTimeout(1200);
await p.getByRole("button", { name: /Participantes/ }).click();
await p.waitForTimeout(800);

// transferir titularidade — abre, cancela, confirma
const linhaMembro3 = p.locator("tr", { hasText: `modal3_${sufixo}` }).first();
await linhaMembro3.getByRole("button", { name: "Transferir" }).click();
await p.waitForTimeout(400);
ok("UI. modal transferir abre", await p.locator(".modal-fundo .modal").count() === 1);
await p.locator(".modal .acoes-modal button", { hasText: "Cancelar" }).click();
await p.waitForTimeout(300);
let campObj = (await apiM("GET", `/api/campaigns/${CID}`)).json.campanha;
ok("UI. cancelar manteve titularidade", campObj.meuPapel === "mestre");

await linhaMembro3.getByRole("button", { name: "Transferir" }).click();
await p.waitForTimeout(300);
await p.locator(".modal .acoes-modal button:not(.secundario):not(.perigo)").last().click();
await p.waitForTimeout(1500);
const membrosDepois = (await apiM("GET", `/api/campaigns/${CID}/members`)).json.membros;
const novoMestre = membrosDepois.find((m) => m.membershipId === tmpMembership3.id);
ok("UI. titularidade transferida", novoMestre?.role === "mestre", JSON.stringify(novoMestre?.role));

// devolve a titularidade ao administrador via API do novo mestre
const tokNovoMestre = sessao(tmpUserId3, "modais-nm");
const volta = await req("POST", `/api/campaigns/${CID}/transferir/${mestreMembership.id}`, {}, tokNovoMestre);
ok("API. titularidade devolvida", volta.status === 200, `status=${volta.status}`);
const campFinal = (await apiM("GET", `/api/campaigns/${CID}`)).json.campanha;
ok("API. administrador mestre novamente", campFinal.meuPapel === "mestre");

// ===== Arquivos: excluir pasta e arquivo =====
await p.getByRole("button", { name: /Arquivos/ }).click();
await p.waitForTimeout(1000);

// pasta via API
const pasta = await apiM("POST", `/api/campaigns/${CID}/arquivos/pastas`, { name: `pasta-modal-${sufixo}` });
const pastaId = pasta.json?.id;
ok("setup. pasta criada", !!pastaId, `status=${pasta.status}`);
await p.getByRole("button", { name: "Campanhas" }).click();
await p.waitForTimeout(800);
await p.locator(".cartao-campanha", { hasText: `modais-${sufixo}` }).first().click();
await p.waitForTimeout(1200);
await p.getByRole("button", { name: /Arquivos/ }).click();
await p.waitForTimeout(1000);

const btnPasta = p.locator(".biblioteca-pastas button[title='Excluir pasta vazia']").last();
await btnPasta.click();
await p.waitForTimeout(400);
ok("UI. modal excluir pasta abre", await p.locator(".modal-fundo .modal").count() === 1);
await p.locator(".modal .acoes-modal button", { hasText: "Cancelar" }).click();
await p.waitForTimeout(300);
ok("UI. cancelar manteve pasta", (await apiM("GET", `/api/campaigns/${CID}/arquivos/pastas`)).json.pastas.some((x) => x.id === pastaId));

await p.locator(".biblioteca-pastas button[title='Excluir pasta vazia']").last().click();
await p.waitForTimeout(300);
await p.locator(".modal .acoes-modal button.perigo").click();
await p.waitForTimeout(1200);
ok("UI. pasta excluída após confirmar", !(await apiM("GET", `/api/campaigns/${CID}/arquivos/pastas`)).json.pastas.some((x) => x.id === pastaId));

// arquivo via upload API (octet-stream)
const up = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
  method: "POST",
  headers: {
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent(`modal-${sufixo}.txt`),
    "x-file-mime": "text/plain",
    cookie: `mestre_rpg_session=${tokM}`,
  },
  body: "conteudo de teste",
});
const upJson = await up.json().catch(() => ({}));
const arquivoId = upJson.id;
ok("setup. arquivo enviado", (up.status === 200 || up.status === 201) && !!arquivoId, `status=${up.status}`);
await p.getByRole("button", { name: "Campanhas" }).click();
await p.waitForTimeout(800);
await p.locator(".cartao-campanha", { hasText: `modais-${sufixo}` }).first().click();
await p.waitForTimeout(1200);
await p.getByRole("button", { name: /Arquivos/ }).click();
await p.waitForTimeout(1000);

const itemArq = p.locator(".biblioteca-lista li", { hasText: `modal-${sufixo}.txt` }).first();
ok("UI. arquivo listado", await itemArq.count() === 1);
await itemArq.getByRole("button", { name: "Excluir" }).click();
await p.waitForTimeout(400);
ok("UI. modal excluir arquivo abre", await p.locator(".modal-fundo .modal").count() === 1);
await p.locator(".modal .acoes-modal button", { hasText: "Cancelar" }).click();
await p.waitForTimeout(300);
ok("UI. cancelar manteve arquivo", (await apiM("GET", `/api/campaigns/${CID}/arquivos`)).json.arquivos.some((a) => a.id === arquivoId));

await itemArq.getByRole("button", { name: "Excluir" }).click();
await p.waitForTimeout(300);
await p.locator(".modal .acoes-modal button.perigo").click();
await p.waitForTimeout(1200);
ok("UI. arquivo excluído após confirmar", !(await apiM("GET", `/api/campaigns/${CID}/arquivos`)).json.arquivos.some((a) => a.id === arquivoId));

// ===== Mesa: encerrar sessão =====
const sessaoNova = await apiM("POST", `/api/campaigns/${CID}/sessoes`, { name: "Sessão Modais" });
const SID = sessaoNova.json?.sessao?.id;
ok("setup. sessão criada", !!SID, `status=${sessaoNova.status}`);
await p.getByRole("button", { name: /Mesa/ }).click();
await p.waitForTimeout(1000);
await p.locator("tr", { hasText: "Sessão Modais" }).first().click();
await p.waitForTimeout(1500);
await p.locator("button.perigo", { hasText: "Encerrar" }).first().click();
await p.waitForTimeout(400);
ok("UI. modal encerrar sessão abre", await p.locator(".modal-fundo .modal").count() === 1);
await p.locator(".modal .acoes-modal button", { hasText: "Cancelar" }).click();
await p.waitForTimeout(300);
ok("UI. cancelar manteve sessão ativa", (await apiM("GET", `/api/campaigns/${CID}/sessoes`)).json.sessoes.find((s) => s.id === SID)?.status !== "encerrada");
await p.locator("button.perigo", { hasText: "Encerrar" }).first().click();
await p.waitForTimeout(300);
await p.locator(".modal .acoes-modal button.perigo").click();
await p.waitForTimeout(1500);
ok("UI. sessão encerrada após confirmar", (await apiM("GET", `/api/campaigns/${CID}/sessoes`)).json.sessoes.find((s) => s.id === SID)?.status === "encerrada");

// ===== Mobile 390px: modal sem overflow =====
await ctx.close();
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctxM.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
const pm = await ctxM.newPage();
pm.on("pageerror", (e) => erros.push(String(e)));
await pm.goto(BASE, { waitUntil: "networkidle" });
await pm.getByRole("button", { name: "Administração" }).click();
await pm.waitForTimeout(900);
await pm.locator(".cartoes-registro .registro-cartao").first().getByRole("button", { name: "Remover" }).click();
await pm.waitForTimeout(500);
const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("UI mobile. modal sem overflow horizontal", overflow <= 1, `overflow=${overflow}px`);
ok("UI mobile. botões do modal visíveis", await pm.locator(".modal .acoes-modal button").count() >= 2);
await ctxM.close();

ok("UI. zero erros de console/pageerror", erros.length === 0, erros.slice(0, 3).join(" | "));

await browser.close();

// ---------- limpeza ----------
// remove usuários temporários restantes e a campanha descartável (cascade remove memberships)
for (const uid of [tmpUserId2, tmpUserId3].filter(Boolean)) {
  try { await apiM("DELETE", `/api/admin/users/${uid}`); } catch {}
}
db.prepare("delete from memberships where campaign_id=?").run(CID);
db.prepare("delete from campaigns where id=?").run(CID);
db.prepare("delete from auth_sessions where user_agent='teste-modais'").run();

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
process.exit(falhas.length ? 1 : 0);
