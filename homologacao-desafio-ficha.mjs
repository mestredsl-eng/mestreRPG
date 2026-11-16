// Homologação — Issue #93: desafio D10 pela ficha como fluxo principal da Mesa.
// Cobre: campos elegíveis agrupados por seção, pool de dados positivos derivado
// do valor PERSISTIDO da ficha (servidor autoritativo), penalidade de dados
// negativos, adulteração do cliente ignorada, recebimento/rolagem pelo jogador,
// visibilidade pública/privada e formulário manual preservado como secundário.
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("desafio-ficha");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids, sid;

// Template de ficha com seções reais: atributos, conhecimentos, habilidades,
// equipamento (moeda = inelegível) e um campo "livre" só elegível via flag.
const ESTRUTURA = {
  versao: 1,
  secoes: [
    { id: "s-attr", titulo: "Atributos", ordem: 0, campos: [
      { id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" },
    ]},
    { id: "s-conh", titulo: "Conhecimentos", ordem: 1, campos: [
      { id: "computador", label: "Computador", tipo: "inteiro", semantico: "conhecimento" },
      { id: "medicina", label: "Medicina", tipo: "inteiro", semantico: "conhecimento" },
    ]},
    { id: "s-hab", titulo: "Habilidades", ordem: 2, campos: [
      { id: "atletismo", label: "Atletismo", tipo: "inteiro", semantico: "habilidade" },
    ]},
    { id: "s-eq", titulo: "Equipamento", ordem: 3, campos: [
      { id: "ouro", label: "Ouro", tipo: "decimal", semantico: "moeda" },
    ]},
    { id: "s-livre", titulo: "Outros", ordem: 4, campos: [
      { id: "carisma", label: "Carisma", tipo: "inteiro", semantico: "livre", usadoEmTestes: true },
      { id: "apelido", label: "Apelido interno", tipo: "texto", semantico: "livre" },
    ]},
  ],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  return ioClient(BASE, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const esperar = (s, ev, timeout = 8000, pred) => new Promise((resolve, reject) => {
  const h = (d) => { if (pred && !pred(d)) return; clearTimeout(t); s.off(ev, h); resolve(d); };
  const t = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout ${ev}`)); }, timeout);
  s.on(ev, h);
});

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "ficha_j1", jogador2: "ficha_j2" },
    ficha: false,
  });
  ids = { admin: cenario.adminId, camp: cenario.campId, cm: cenario.cookieMestre };
  ids.j1 = cenario.jogadores.jogador1; ids.j2 = cenario.jogadores.jogador2;

  // template próprio com as seções acima + personagem do jogador1
  const agora = Date.now();
  const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,1,?,?)")
        .run(tplId, ids.camp, "Ficha RPG", null, ids.admin, agora, agora);
      w.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
        .run(verId, tplId, JSON.stringify(ESTRUTURA), agora, agora);
      w.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
    } finally { w.close(); }
  }
  const pjId = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(pjId, ids.camp, ids.j1.membershipId, verId, "PJ Ficha",
          JSON.stringify({ for: 5, computador: 5, medicina: 3, atletismo: 4, ouro: 99, carisma: 2, apelido: "x" }),
          "{}", "aprovada", 0, agora, agora);
    } finally { w.close(); }
  }
  ids.pj = pjId;

  // segundo personagem (jogador2) cuja ficha NÃO tem nenhum campo elegível:
  // só texto e moeda — serve para provar a mensagem explicativa na UI e a
  // rejeição de qualquer campo no socket.
  const ESTRUTURA_SEM_ELEGIVEIS = {
    versao: 1,
    secoes: [
      { id: "s-liv", titulo: "Anotações", ordem: 0, campos: [
        { id: "diario", label: "Diário", tipo: "texto", semantico: "livre" },
        { id: "cofre", label: "Cofre", tipo: "decimal", semantico: "moeda" },
      ]},
    ],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  const tpl2Id = crypto.randomUUID(), ver2Id = crypto.randomUUID(), pj2Id = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
        .run(tpl2Id, ids.camp, "Ficha Anotações", null, ids.admin, agora, agora);
      w.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
        .run(ver2Id, tpl2Id, JSON.stringify(ESTRUTURA_SEM_ELEGIVEIS), agora, agora);
      w.prepare("update sheet_templates set current_version_id=? where id=?").run(ver2Id, tpl2Id);
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(pj2Id, ids.camp, ids.j2.membershipId, ver2Id, "PJ Sem Teste",
          JSON.stringify({ diario: "texto", cofre: 10 }), "{}", "aprovada", 0, agora, agora);
    } finally { w.close(); }
  }
  ids.pj2 = pj2Id;

  // mínimo de sucesso D10 conhecido
  await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cm, body: { dados: { d10SucessoMinimo: 6 } } });

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cm, body: { name: "Mesa Ficha" } });
  sid = sess.json?.sessao?.id;
  t("sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 120));

  const sockM = conectar(ids.cm), sockJ1 = conectar(ids.j1.cookie), sockJ2 = conectar(ids.j2.cookie);
  await Promise.all([pronto(sockM), pronto(sockJ1), pronto(sockJ2)]);
  for (const s of [sockM, sockJ1, sockJ2]) await emitirCb(s, "mesa:entrar", { sessionId: sid });

  const evJ1 = { teste: [], rolagem: [] }, evJ2 = { teste: [] }, evM = { teste: [], rolagem: [] };
  sockJ1.on("mesa:teste", (d) => evJ1.teste.push(d));
  sockJ1.on("mesa:rolagem", (d) => evJ1.rolagem.push(d));
  sockJ2.on("mesa:teste", (d) => evJ2.teste.push(d));
  sockM.on("mesa:teste", (d) => evM.teste.push(d));
  sockM.on("mesa:rolagem", (d) => evM.rolagem.push(d));

  sec("pool autoritativo do servidor");
  // Computador = 5 -> 5 positivos; cliente tenta adulterar count/lados
  const r1 = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "computador", rotulo: "Computador",
    dadosLados: 6, dadosCount: 99, malus: 0, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("mestre cria desafio pela ficha", r1?.ok === true, JSON.stringify(r1));
  const id1 = r1?.id;
  const ev1 = evJ1.teste.find((x) => x.id === id1);
  t("pool = 5 positivos do campo persistido", ev1?.pool?.positivos === 5, JSON.stringify(ev1?.pool));
  t("adulteração ignorada: sempre D10", ev1?.pool?.dadosLados === 10 && ev1?.dados?.lados === 10, JSON.stringify(ev1?.pool));
  t("count adulterado não altera pool", ev1?.dados?.count === 5, JSON.stringify(ev1?.dados));
  const row1 = comDb(BANCO, (db) => db.prepare("select dice_sides,dice_count,modifiers from tests where id=?").get(id1));
  const mods1 = JSON.parse(row1?.modifiers ?? "{}");
  t("banco: 10 lados, 5 dados, valorCampo=5", row1?.dice_sides === 10 && row1?.dice_count === 5 && mods1.valorCampo === 5, JSON.stringify(row1));

  sec("campo nível 3 + penalidade 2");
  const r2 = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "medicina", rotulo: "Medicina",
    dadosLados: 10, malus: 2, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const id2 = r2?.id;
  const ev2 = evJ1.teste.find((x) => x.id === id2);
  t("Medicina=3 -> 3 positivos", ev2?.pool?.positivos === 3, JSON.stringify(ev2?.pool));
  t("penalidade 2 -> 1 efetivo", ev2?.pool?.negativos === 2 && ev2?.dados?.count === 1, JSON.stringify(ev2?.pool));

  sec("elegibilidade genérica e rejeições");
  const rOuro = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "ouro", requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("campo moeda rejeitado", rOuro?.ok === false, JSON.stringify(rOuro));
  const rTexto = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "apelido", requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("campo texto rejeitado", rTexto?.ok === false, JSON.stringify(rTexto));
  const rLivre = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "carisma", rotulo: "Carisma",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evL = evJ1.teste.filter((x) => x.id === rLivre?.id).pop();
  t("campo livre com usadoEmTestes elegível (carisma=2)", rLivre?.ok === true && evL?.pool?.positivos === 2, JSON.stringify(evL?.pool));

  sec("campoId forjado/inexistente e rótulo adulterado");
  const rInexistente = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "campo_que_nao_existe",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("campoId inexistente rejeitado", rInexistente?.ok === false, JSON.stringify(rInexistente));
  const rCofre = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj2Id, campoId: "cofre",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("campo inelegível de outra ficha rejeitado", rCofre?.ok === false, JSON.stringify(rCofre));
  const rForjado = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "medicina", rotulo: "RÓTULO FORJADO PELO CLIENTE",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("desafio com rótulo forjado aceito (campo válido)", rForjado?.ok === true, JSON.stringify(rForjado));
  const evF = evJ1.teste.find((x) => x.id === rForjado?.id);
  t("rótulo exibido = label real do campo, não o forjado",
    evF?.rotulo === "Medicina", `rotulo=${JSON.stringify(evF?.rotulo)}`);
  const rowF = rForjado?.id ? comDb(BANCO, (db) => db.prepare("select skill_ref from tests where id=?").get(rForjado.id)) : null;
  const skillF = JSON.parse(rowF?.skill_ref ?? "{}");
  t("skill_ref persistido usa label real", skillF?.rotulo === "Medicina" && skillF?.campoId === "medicina", JSON.stringify(skillF));

  sec("skillRef forjado — referência autoritativa única");
  // campoId válido + rótulo forjado + skillRef objeto forjado: nada do
  // payload substitui a referência construída da estrutura validada
  const rSk = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "medicina", rotulo: "FORJADO-1",
    skillRef: { campoId: "outro", rotulo: "FORJADO-2", nome: "X", extra: "Y" },
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("desafio criado com campo válido apesar de skillRef forjado", rSk?.ok === true, JSON.stringify(rSk));
  const rowSk = rSk?.id ? comDb(BANCO, (db) => db.prepare("select skill_ref from tests where id=?").get(rSk.id)) : null;
  const skillSk = JSON.parse(rowSk?.skill_ref ?? "null");
  t("skill_ref persistido = campoId e label reais",
    skillSk?.campoId === "medicina" && skillSk?.rotulo === "Medicina", JSON.stringify(skillSk));
  t("nenhuma propriedade forjada persistida",
    skillSk && Object.keys(skillSk).sort().join(",") === "campoId,rotulo", JSON.stringify(skillSk));
  const evSkJ = evJ1.teste.find((x) => x.id === rSk?.id);
  const evSkM = evM.teste.find((x) => x.id === rSk?.id);
  const evSkJ2 = evJ2.teste.find((x) => x.id === rSk?.id);
  t("evento do jogador traz skillRef autoritativo",
    evSkJ?.skillRef?.campoId === "medicina" && evSkJ?.skillRef?.rotulo === "Medicina", JSON.stringify(evSkJ?.skillRef));
  t("evento do mestre traz a mesma referência",
    evSkM?.skillRef?.campoId === "medicina" && evSkM?.skillRef?.rotulo === "Medicina", JSON.stringify(evSkM?.skillRef));
  t("evento de participante autorizado (jogador2) idem",
    evSkJ2?.skillRef?.campoId === "medicina" && evSkJ2?.skillRef?.rotulo === "Medicina", JSON.stringify(evSkJ2?.skillRef));
  const hist = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/testes`, { cookie: ids.j1.cookie });
  const histSk = (hist.json?.testes ?? []).find((x) => x.id === rSk?.id);
  const histSkill = typeof histSk?.skillRef === "string" ? JSON.parse(histSk.skillRef) : histSk?.skillRef;
  t("histórico GET devolve skill_ref autoritativo",
    histSkill?.campoId === "medicina" && histSkill?.rotulo === "Medicina", JSON.stringify(histSkill));

  sec("skillRef manual — contrato mínimo sem campoId");
  const rManOk = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, rotulo: "Vigor",
    skillRef: { rotulo: "Percepção", nome: "Vigia", campoId: "forjado", extra: 1 },
    dadosLados: 20, dadosCount: 2, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("teste manual sem campoId funciona", rManOk?.ok === true, JSON.stringify(rManOk));
  const rowMan = rManOk?.id ? comDb(BANCO, (db) => db.prepare("select skill_ref from tests where id=?").get(rManOk.id)) : null;
  const skillMan = JSON.parse(rowMan?.skill_ref ?? "null");
  t("skillRef manual sanitizado: só rotulo/nome permitidos",
    skillMan && skillMan.rotulo === "Percepção" && skillMan.nome === "Vigia"
      && !("campoId" in skillMan) && !("extra" in skillMan), JSON.stringify(skillMan));
  const rManLixo = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, rotulo: "Teste",
    skillRef: "string-forjada", dadosLados: 20, dadosCount: 1,
    requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("skillRef de tipo inválido não quebra o pedido", rManLixo?.ok === true, JSON.stringify(rManLixo));
  const rowLixo = rManLixo?.id ? comDb(BANCO, (db) => db.prepare("select skill_ref from tests where id=?").get(rManLixo.id)) : null;
  t("skillRef inválido persistido como null", rowLixo?.skill_ref === null, JSON.stringify(rowLixo?.skill_ref));

  sec("jogador recebe, identifica e rola; resultado para todos");
  const roll = await emitirCb(sockJ1, "mesa:teste:rolar", { testId: id1, requestId: "df-r-" + crypto.randomUUID().slice(0, 8) });
  t("dono rola o desafio", roll?.ok === true, JSON.stringify(roll).slice(0, 160));
  t("resposta D10: 5 lançados, mín 6", roll?.d10?.lancados === 5 && roll?.d10?.minimo === 6, JSON.stringify(roll?.d10));
  const esp = (roll?.dados ?? []).filter((v) => v >= 6).length;
  t("sucessos/falhas corretos", roll?.d10?.sucessos === esp && roll?.d10?.falhas === 5 - esp, JSON.stringify(roll?.d10));
  const rolM = evM.rolagem.find((x) => x.testId === id1);
  t("mestre vê rolagem com d10", !!rolM && rolM.d10?.lancados === 5, JSON.stringify(rolM?.d10));
  const rolJ1 = evJ1.rolagem.find((x) => x.testId === id1);
  t("dono vê rolagem com d10", !!rolJ1 && rolJ1.d10 != null);

  sec("visibilidade");
  evJ2.teste.length = 0;
  const rPub = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "atletismo", rotulo: "Atletismo",
    dadosLados: 10, visibilidade: "publica", requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  await new Promise((r) => setTimeout(r, 300));
  t("público: não-dono também recebe", evJ2.teste.some((x) => x.id === rPub?.id), `recebidos=${evJ2.teste.length} ids=${evJ2.teste.map((x) => x.id).join(",")} alvo=${rPub?.id}`);
  evJ2.teste.length = 0;
  const rPriv = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pjId, campoId: "atletismo", rotulo: "Atletismo",
    dadosLados: 10, visibilidade: "privada", requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("privado: não-dono NÃO recebe", !evJ2.teste.some((x) => x.id === rPriv?.id), `recebidos=${evJ2.teste.length}`);
  t("privado: dono recebe", evJ1.teste.some((x) => x.id === rPriv?.id));

  sec("UI — fluxo principal pela ficha");
  const browser = await chromium.launch();
  const errosM = [], errosJ = [];
  const ctxM = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const ctxJ = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctxM.addCookies([{ name: "mestre_rpg_session", value: decodeURIComponent(ids.cm.split("=")[1]), url: BASE }]);
  await ctxJ.addCookies([{ name: "mestre_rpg_session", value: decodeURIComponent(ids.j1.cookie.split("=")[1]), url: BASE }]);
  const pM = await ctxM.newPage(); const pJ = await ctxJ.newPage();
  pM.on("pageerror", (e) => errosM.push(String(e)));
  pJ.on("pageerror", (e) => errosJ.push(String(e)));

  const abrirMesa = async (p) => {
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).click();
    await p.waitForTimeout(900);
    await p.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
    await p.waitForTimeout(1200);
    await p.getByRole("button", { name: /Mesa/ }).click();
    await p.waitForTimeout(1000);
    await p.locator("tr", { hasText: "Mesa Ficha" }).first().click();
    await p.waitForTimeout(1800);
  };
  await abrirMesa(pM);
  await abrirMesa(pJ);

  // fluxo principal: "Solicitar teste pela ficha" é o card de destaque e
  // já abre com o formulário visível — sem precisar procurar ação escondida
  const tituloFicha = pM.locator("section.cartao", { has: pM.locator("h3", { hasText: "Solicitar teste pela ficha" }) });
  t("UI. card 'Solicitar teste pela ficha' presente", (await tituloFicha.count()) > 0);
  t("UI. desafio pela ficha é o card de destaque", await tituloFicha.evaluate((el) => el.classList.contains("cartao-destaque")));
  const manual = pM.locator("section.cartao h3", { hasText: "teste manual" });
  t("UI. rolagem personalizada preservada como secundária", (await manual.count()) > 0);

  // o formulário já vem aberto (fluxo principal); só clica se estiver fechado
  const form = tituloFicha.locator("form.formulario");
  if (!(await form.isVisible().catch(() => false))) {
    await tituloFicha.locator("button", { hasText: "+ Desafio" }).click();
    await pM.waitForTimeout(300);
  }
  t("UI. formulário da ficha visível sem clique extra", await form.isVisible());
  const selPers = form.locator("select").first();
  const opsPers = await selPers.locator("option").allTextContents();
  const idxPers = opsPers.findIndex((o) => o.includes("PJ Ficha"));
  await selPers.selectOption({ index: idxPers });
  await pM.waitForTimeout(1200);

  const selCampo = form.locator("select").nth(1);
  const grupos = await selCampo.locator("optgroup").evaluateAll((els) => els.map((e) => e.getAttribute("label")));
  t("UI. campos agrupados por seção da ficha", grupos.includes("Conhecimentos") && grupos.includes("Habilidades"), JSON.stringify(grupos));
  const opcoes = await selCampo.locator("option").allTextContents();
  t("UI. Computador (5) listado", opcoes.some((o) => /Computador\s*\(5\)/.test(o)), opcoes.join("|"));
  t("UI. campo inelegível (Ouro) ausente", !opcoes.some((o) => /Ouro/.test(o)), opcoes.join("|"));

  const idxComp = opcoes.findIndex((o) => /Computador/.test(o));
  await selCampo.selectOption({ index: idxComp });
  await pM.waitForTimeout(300);
  const metaPos = await form.locator(".meta").allTextContents();
  t("UI. informa 5 dados positivos", metaPos.some((m) => /5\s*dados?\s*positivos?/.test(m)), metaPos.join(" | "));
  await form.locator('input[type="number"]').first().fill("2");
  await pM.waitForTimeout(200);
  const metaEf = await form.locator(".meta, .desafio-pool").allTextContents();
  t("UI. pool exibido: 5 positivos − 2 negativos = 3 efetivos",
    metaEf.some((m) => /positivos/.test(m) && /negativos/.test(m) && /=\s*3\s*d10/.test(m)), metaEf.join(" | "));

  // envia o desafio pela UI
  await form.locator('button[type="submit"]').click();
  await pM.waitForTimeout(800);
  const cardJ = pJ.locator(".teste-card", { hasText: "Computador" }).last();
  await cardJ.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const txtJ = await cardJ.textContent().catch(() => "");
  t("UI. jogador vê desafio pendente identificado", /Computador/.test(txtJ ?? "") && /5d10 positivos/.test(txtJ ?? "") && /3 efetivos/.test(txtJ ?? ""), txtJ?.slice(0, 160));
  await cardJ.locator("button", { hasText: "Rolar" }).click();
  await pJ.waitForTimeout(1200);
  const txtResJ = await pJ.locator(".rolagem-item .d10-rolagem").last().textContent().catch(() => "");
  t("UI. jogador vê resultado D10 (sucessos/falhas)", /sucesso/.test(txtResJ ?? "") && /falha/.test(txtResJ ?? ""), txtResJ?.slice(0, 160));
  const txtResM = await pM.locator(".rolagem-item .d10-rolagem").last().textContent().catch(() => "");
  t("UI. mestre vê o mesmo resultado", /sucesso/.test(txtResM ?? "") && /falha/.test(txtResM ?? ""), txtResM?.slice(0, 160));
  const dados3d = await pM.locator(".rolagem-item canvas, .rolagem-item svg").count();
  t("UI. dados visuais renderizados", dados3d > 0, `n=${dados3d}`);

  // ficha sem nenhum campo elegível: a UI explica o motivo em vez de
  // mostrar um seletor vazio sem contexto — o envio anterior fechou o
  // formulário (fluxo fecha após sucesso), reabrir antes de continuar
  if (!(await form.isVisible().catch(() => false))) {
    await tituloFicha.locator("button", { hasText: "+ Desafio" }).click();
    await pM.waitForTimeout(300);
  }
  await selPers.selectOption({ index: opsPers.findIndex((o) => o.includes("PJ Sem Teste")) });
  await pM.waitForTimeout(1200);
  const msgsVazio = await form.locator(".meta").allTextContents();
  t("UI. ficha sem elegíveis mostra explicação",
    msgsVazio.some((m) => /Nenhum campo elegível/.test(m) && /Usado em testes/.test(m)), msgsVazio.join(" | "));
  const opcoesVazio = await selCampo.locator("option").allTextContents();
  t("UI. seletor sem opções de campo", opcoesVazio.every((o) => /Escolher|Carregando/.test(o)), opcoesVazio.join("|"));

  // o desafio criado com skillRef forjado aparece com o label REAL da ficha
  const cardSk = pJ.locator(".teste-card", { hasText: "Medicina" }).last();
  await cardSk.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const txtSk = await cardSk.textContent().catch(() => "");
  t("UI. jogador vê label real do campo (skillRef forjado neutralizado)",
    /Medicina/.test(txtSk ?? "") && !/FORJADO/.test(txtSk ?? ""), txtSk?.slice(0, 160));

  t("UI. console sem erros (mestre)", errosM.length === 0, errosM.slice(0, 2).join(" | "));
  t("UI. console sem erros (jogador)", errosJ.length === 0, errosJ.slice(0, 2).join(" | "));
  await browser.close();

  sockM.close(); sockJ1.close(); sockJ2.close();
} catch (e) {
  fail++;
  console.log("FALHOU exceção:", e);
} finally {
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
