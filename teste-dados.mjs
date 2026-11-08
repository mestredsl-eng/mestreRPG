// Testes do sistema completo de dados: formas geométricas d4–d20,
// rolagem livre/dano com soma, preferências visuais por usuário
// (persistência, contraste, isolamento) e elegibilidade de campos
// nos desafios D10.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "teste-dados", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='jogador_teste'").get();
const tokM = sessao(admin.id, "dados-m");
const tokJ = sessao(jog.id, "dados-j");
async function req(m, path, body, token) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const apiM = (m, p, b) => req(m, p, b, tokM);
const apiJ = (m, p, b) => req(m, p, b, tokJ);

// ---------- preferências de dados (por usuário) ----------
{
  const me0 = await apiM("GET", "/api/auth/me");
  ok("me retorna preferences", me0.status === 200 && typeof me0.json?.usuario?.preferences === "object", `status=${me0.status}`);

  const put = await apiM("PATCH", "/api/auth/preferences", { dados: { corExterna: "#112233", corInterna: "#ffcc00" } });
  ok("PATCH preferences aceito", put.status === 200 && put.json?.preferences?.dados?.corExterna === "#112233", `status=${put.status}`);
  const me1 = await apiM("GET", "/api/auth/me");
  ok("preferência persiste após leitura", me1.json?.usuario?.preferences?.dados?.corInterna === "#ffcc00");

  const invalido = await apiM("PATCH", "/api/auth/preferences", { dados: { corExterna: "vermelho", corInterna: "#fff" } });
  ok("cor inválida rejeitada", invalido.status === 400, `status=${invalido.status}`);
  const extra = await apiM("PATCH", "/api/auth/preferences", { dados: { corExterna: "#112233", corInterna: "#ffcc00", hacker: true } });
  ok("campo extra rejeitado (strict)", extra.status === 400, `status=${extra.status}`);

  // isolamento: jogador não herda a cor do mestre
  const meJ = await apiJ("GET", "/api/auth/me");
  const dadosJ = meJ.json?.usuario?.preferences?.dados;
  ok("preferência é por usuário (jogador sem cor do mestre)", !dadosJ || dadosJ.corExterna !== "#112233", JSON.stringify(dadosJ));

  // restaura padrão no mestre para não sujar homologações visuais
  await apiM("PATCH", "/api/auth/preferences", { dados: { corExterna: "#2b3350", corInterna: "#e8ecf7" } });
}

// ---------- sessão + sockets ----------
const s = await apiM("POST", `/api/campaigns/${CID}/sessoes`, { name: "Sessão Dados" });
const SID = s.json?.sessao?.id;
ok("sessão criada", !!SID, `status=${s.status}`);

const sockJ = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokJ}` }, transports: ["polling", "websocket"] });
await new Promise((r) => sockJ.on("connect", r));
const emitirCb = (sock, ev, payload) => new Promise((res) => sock.emit(ev, payload, res));
await emitirCb(sockJ, "mesa:entrar", { sessionId: SID });

// ---------- rolagem livre: d4–d20, contagens e soma ----------
for (const lados of [4, 6, 8, 10, 20]) {
  const roll = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: lados, count: 4 }], motivo: `livre d${lados}`,
    requestId: "dados-" + crypto.randomUUID().slice(0, 8),
  });
  const res = roll?.grupos?.[0]?.resultados ?? [];
  const soma = res.reduce((a, b) => a + b, 0);
  ok(`d${lados}: 4 resultados no intervalo`, roll?.ok === true && res.length === 4 && res.every((v) => v >= 1 && v <= lados), res.join(","));
  ok(`d${lados}: total = soma dos resultados`, roll?.total === soma, `total=${roll?.total} soma=${soma}`);
  ok(`d${lados}: sem meta D10`, roll?.d10 == null);
}

// ---------- modo dano ----------
{
  const eventos = [];
  sockJ.on("mesa:rolagem", (r) => eventos.push(r));
  const roll = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 8, count: 3 }], modo: "dano", motivo: "espada longa",
    requestId: "dano-" + crypto.randomUUID().slice(0, 8),
  });
  ok("dano: rolagem ok", roll?.ok === true, JSON.stringify(roll).slice(0, 160));
  ok("dano: modo retornado", roll?.modo === "dano", `modo=${roll?.modo}`);
  ok("dano: 3d8 resultados", roll?.grupos?.[0]?.resultados?.length === 3);
  await new Promise((r) => setTimeout(r, 300));
  const ev = eventos.find((e) => e.id === roll?.id);
  ok("dano: evento mesa:rolagem traz modo", ev?.modo === "dano", JSON.stringify(ev?.modo));

  const msgs = await apiM("GET", `/api/campaigns/${CID}/sessoes/${SID}/mensagens?limite=50`);
  const msgDano = (msgs.json?.mensagens ?? []).find((m) => m.kind === "rolagem" && /espada longa/.test(m.content ?? ""));
  ok("dano: registrado no chat", !!msgDano, msgDano?.content?.slice(0, 120));

  // dano sem motivo ganha rótulo padrão "Dano" no evento
  const roll2 = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 6, count: 2 }], modo: "dano",
    requestId: "dano-" + crypto.randomUUID().slice(0, 8),
  });
  ok("dano sem motivo: motivo padrão 'Dano'", roll2?.ok === true);
  await new Promise((r) => setTimeout(r, 300));
  const ev2 = eventos.find((e) => e.id === roll2?.id);
  ok("dano sem motivo: payload motivo=Dano", ev2?.motivo === "Dano", String(ev2?.motivo));

  // modo:dano não liga contagem D10
  ok("dano: d10 permanece nulo", roll?.d10 == null && roll2?.d10 == null);
}

// ---------- elegibilidade de campo nos desafios ----------
{
  const chars = await apiM("GET", `/api/campaigns/${CID}/characters`);
  ok("personagens disponíveis p/ teste de campo", (chars.json?.personagens ?? []).length > 0, `n=${chars.json?.personagens?.length}`);
  const sockM = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokM}` }, transports: ["polling", "websocket"] });
  await new Promise((r) => sockM.on("connect", r));
  await emitirCb(sockM, "mesa:entrar", { sessionId: SID });
  const emitirM = (ev, payload) => new Promise((res) => sockM.emit(ev, payload, res));

  let char = null, campoOk = null;
  for (const cand of chars.json?.personagens ?? []) {
    const det = await apiM("GET", `/api/characters/${cand.id}`);
    const valores = det.json?.ficha?.campos ?? {};
    for (const sec of det.json?.ficha?.estrutura?.secoes ?? []) {
      for (const c of sec.campos ?? []) {
        if ((c.tipo === "inteiro" || c.tipo === "decimal") && c.semantico !== "moeda" && c.semantico !== "item"
          && typeof valores[c.id] === "number" && valores[c.id] > 0) { char = cand; campoOk = c; break; }
      }
      if (campoOk) break;
    }
    if (campoOk) break;
  }
  if (char && campoOk) {
    const invalido = await emitirM("mesa:teste:pedir", {
      sessionId: SID, characterId: char.id, campoId: "campo-inexistente-xyz",
      dadosLados: 10, malus: 0, visibilidade: "publica",
      requestId: "inv-" + crypto.randomUUID().slice(0, 8),
    });
    ok("campoId inexistente rejeitado no servidor", invalido?.ok === false, JSON.stringify(invalido));

    const bom = await emitirM("mesa:teste:pedir", {
      sessionId: SID, characterId: char.id, campoId: campoOk.id, rotulo: campoOk.label,
      dadosLados: 10, malus: 0, visibilidade: "publica",
      requestId: "ok-" + crypto.randomUUID().slice(0, 8),
    });
    ok("campo testável aceito", bom?.ok === true, `${campoOk.label} -> ${JSON.stringify(bom).slice(0, 120)}`);
  } else {
    ok("campo testável encontrado na ficha", false, "nenhum campo numérico elegível");
  }
  sockM.close();
}

// ---------- UI ----------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(String(e)));
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(900);
  await p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p.waitForTimeout(1200);
  await p.getByRole("button", { name: /Mesa/ }).click();
  await p.waitForTimeout(1000);
  await p.locator("tr", { hasText: "Sessão Dados" }).first().click();
  await p.waitForTimeout(1500);

  ok("UI. abas do painel de dados", await p.locator(".abas-dados button").count() === 2);
  ok("UI. aba Testes D10 ativa por padrão", await p.locator("text=Lançador D10").count() > 0);

  // troca para rolagem e dano
  await p.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  await p.waitForTimeout(300);
  ok("UI. formulário rolagem/dano", await p.locator(".rolagem-form select").count() >= 2);
  const selDado = p.locator(".rolagem-controles select").first();
  await selDado.selectOption("4");
  const qtdInput = p.locator(".rolagem-controles input[type=number]");
  await qtdInput.fill("3");
  const selModo = p.locator(".rolagem-controles select").nth(1);
  await selModo.selectOption("dano");
  await p.locator(".rolagem-form button[type=submit]").click();
  await p.waitForTimeout(2500);
  ok("UI. 3 dados d4 animados", await p.locator(".rolagem-resultado .dado-shape.d4").count() === 3);
  const chipDano = await p.locator(".rolagem-resultado .d10-chip-total").textContent().catch(() => "");
  ok("UI. chip 'Dano total' com soma", !!chipDano && /Dano total: \d+/.test(chipDano), chipDano);
  ok("UI. chip modo Dano", await p.locator(".rolagem-resultado .d10-chip-neg", { hasText: "Dano" }).count() > 0);

  // cinco formas geométricas distintas no seletor de aparência
  const nFormas = await p.locator(".cores-dados-preview .dado-shape").count();
  ok("UI. preview com 5 tipos de dado", nFormas === 5, `n=${nFormas}`);
  const classes = await p.locator(".cores-dados-preview .dado-shape").evaluateAll((els) => els.map((e) => e.className));
  ok("UI. classes d4/d6/d8/d10/d20 presentes", ["d4", "d6", "d8", "d10", "d20"].every((d) => classes.some((c) => c.includes(d))), classes.join("|"));

  // personalização: muda cor externa e verifica aplicação no SVG
  // (native setter: o React rastreia o value do input e ignora atribuição direta)
  const setCor = (locator, hex) => locator.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, hex);
  const corInput = p.locator('.cores-dados-controles input[type="color"]').first();
  await setCor(corInput, "#aa3300");
  await p.waitForTimeout(400);
  const fill = await p.locator(".mesa-view .dado-poligono").first().evaluate((el) => getComputedStyle(el).fill);
  ok("UI. cor externa aplicada aos dados", fill === "rgb(170, 51, 0)", fill);
  const texto = await p.locator(".mesa-view .dado-numero").first().evaluate((el) => getComputedStyle(el).fill);
  ok("UI. cor dos números aplicada", texto === "rgb(232, 236, 247)", texto);

  // contraste baixo gera aviso
  const corInt = p.locator('.cores-dados-controles input[type="color"]').nth(1);
  await setCor(corInt, "#aa3300");
  await p.waitForTimeout(400);
  ok("UI. aviso de contraste baixo", await p.locator(".cores-contraste-aviso").count() > 0);

  // restaura padrão
  await p.locator(".cores-dados-controles button", { hasText: "Restaurar padrão" }).click();
  await p.waitForTimeout(400);
  const fillPadrao = await p.locator(".mesa-view .dado-poligono").first().evaluate((el) => getComputedStyle(el).fill);
  ok("UI. restaurar padrão volta cor original", fillPadrao === "rgb(43, 51, 80)", fillPadrao);

  // persistência: define cor, recarrega, confere
  await setCor(corInput, "#004488");
  await p.waitForTimeout(500);
  await p.reload({ waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(800);
  await p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p.waitForTimeout(1000);
  await p.getByRole("button", { name: /Mesa/ }).click();
  await p.waitForTimeout(800);
  await p.locator("tr", { hasText: "Sessão Dados" }).first().click();
  await p.waitForTimeout(1800);
  const fillPers = await p.locator(".mesa-view .dado-poligono").first().evaluate((el) => getComputedStyle(el).fill);
  ok("UI. preferência persiste após reload", fillPers === "rgb(0, 68, 136)", fillPers);
  // limpa para o padrão
  await p.locator(".cores-dados-controles button", { hasText: "Restaurar padrão" }).click();
  await p.waitForTimeout(300);

  // isolamento visual: jogador vê cores padrão mesmo com mestre customizado antes
  await setCor(corInput, "#9900cc");
  await p.waitForTimeout(400);
  const ctxJ = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctxJ.addCookies([{ name: "mestre_rpg_session", value: tokJ, url: BASE }]);
  const pj = await ctxJ.newPage();
  await pj.goto(BASE, { waitUntil: "networkidle" });
  await pj.getByRole("button", { name: "Campanhas" }).click();
  await pj.waitForTimeout(800);
  await pj.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await pj.waitForTimeout(1000);
  await pj.getByRole("button", { name: /Mesa/ }).click();
  await pj.waitForTimeout(800);
  await pj.locator("tr", { hasText: "Sessão Dados" }).first().click();
  await pj.waitForTimeout(1800);
  const fillJ = await pj.locator(".mesa-view .dado-poligono").first().evaluate((el) => getComputedStyle(el).fill).catch(() => "n/a");
  ok("UI. jogador não herda cor do mestre", fillJ === "rgb(43, 51, 80)", fillJ);
  await ctxJ.close();
  await p.locator(".cores-dados-controles button", { hasText: "Restaurar padrão" }).click();

  // mobile
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p3 = await ctx3.newPage();
  await p3.goto(BASE, { waitUntil: "networkidle" });
  await p3.getByRole("button", { name: "Campanhas" }).click();
  await p3.waitForTimeout(700);
  await p3.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p3.waitForTimeout(1000);
  await p3.getByRole("button", { name: /Mesa/ }).click();
  await p3.waitForTimeout(800);
  await p3.locator("tr", { hasText: "Sessão Dados" }).first().click();
  await p3.waitForTimeout(1500);
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px: sem overflow", overflow <= 1, `overflow=${overflow}px`);
  ok("UI. sem erros de console", erros.length === 0, erros.slice(0, 2).join(" | "));
  await ctx3.close();
  await browser.close();
}

sockJ.close();
await db.close();
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
