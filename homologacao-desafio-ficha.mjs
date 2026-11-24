// Homologação — Issue #93: desafio D10 pela ficha como fluxo principal da Mesa.
// Cobre: campos elegíveis agrupados por seção, pool de dados positivos derivado
// do valor PERSISTIDO da ficha (servidor autoritativo), penalidade de dados
// negativos, adulteração do cliente ignorada, recebimento/rolagem pelo jogador,
// visibilidade pública/privada e formulário manual preservado como secundário.
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

// Toda aquisição fica dentro do try: uma falha de setup também limpa.
let DIR, BANCO, ARQ, BKS, BASE;
let proc, ids, sid, browser, fechamentoServidor = null;
const sockets = [];

// O listener de `close` é registrado no spawn (antes de qualquer kill):
// `exit` prova só o fim do processo; `close` prova stdio encerrado —
// teardown real. O timeout só começa quando o finally aguarda.
function observarFechamento(p) {
  return new Promise((resolve) => p.once("close", resolve));
}
async function aguardarFechamento(obs, timeoutMs = 10000) {
  let timer;
  try {
    await Promise.race([
      obs,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout aguardando close do processo do servidor")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Cleanup compartilhado entre o fluxo principal e a prova de falha:
// sockets → browser → shutdown + close real → remoção do diretório.
// Retorna a lista de erros de limpeza; nunca lança — quem chama decide
// como contabilizar, para não mascarar a exceção original.
async function limparRecursos({ sockets: sk = [], proc: p = null, fechamento = null, browser: br = null, pagina = null, contexto = null, dir = null } = {}) {
  const erros = [];
  for (const s of sk) {
    try {
      if (s && s.connected) {
        // Evento disconnect REAL com timeout — listener preso antes do
        // close (emissão pode ser síncrona); timer e listener sempre
        // limpos em finally; timeout vira erro de limpeza explícito.
        const resultado = await new Promise((resolve) => {
          let done = false;
          const onDisc = () => fin("disconnect");
          const t = setTimeout(() => fin("timeout"), 5000);
          function fin(v) {
            if (done) return;
            done = true;
            clearTimeout(t);
            s.off("disconnect", onDisc);
            resolve(v);
          }
          s.once("disconnect", onDisc);
          s.close();
        });
        if (resultado === "timeout") erros.push("socket: disconnect não emitido em 5s");
      } else if (s) {
        s.close();
      }
    } catch (e) { erros.push("socket: " + String(e?.message ?? e)); }
  }
  if (pagina) {
    try { await pagina.close(); } catch (e) { erros.push("pagina: " + String(e?.message ?? e)); }
  }
  if (contexto) {
    try { await contexto.close(); } catch (e) { erros.push("contexto: " + String(e?.message ?? e)); }
  }
  if (br) {
    try { await br.close(); } catch (e) { erros.push("browser: " + String(e?.message ?? e)); }
  }
  try {
    if (p) {
      await encerrarServidor(p);
      if (fechamento) await aguardarFechamento(fechamento);
    }
  } catch (e) {
    erros.push("servidor: " + String(e?.message ?? e));
  }
  try {
    if (dir) { if (!limparDir(dir)) erros.push("dir: limpeza falhou: " + dir); }
  } catch (e) {
    erros.push("dir: " + String(e?.message ?? e));
  }
  return erros;
}

// Prova determinística do caminho de exceção (ordem do Dono): adquire
// dir+banco+porta+servidor+dois sockets e injeta erro. O MESMO
// limparRecursos do finally deve fechar tudo; a falha original permanece
// visível; a execução limpa posterior é o próprio fluxo principal abaixo.
async function provaFalhaParcial() {
  sec("Teardown — falha injetada após aquisição parcial");
  const sk = [];
  const descFlags = [];
  let d2, proc2 = null, fech2 = null, close2Ok = false;
  let browser2 = null, ctx2 = null, pg2 = null;
  let erroOriginal = null, erros2 = [];
  try {
    d2 = dirTeste("desafio-ficha-falha");
    const banco2 = `${d2}/teste.db`;
    await prepararBanco(banco2);
    const porta2 = await portaLivre();
    const base2 = `http://localhost:${porta2}`;
    proc2 = subirServidor(porta2, { banco: banco2, arquivos: `${d2}/arq`, backups: `${d2}/bks` });
    proc2.stderr.on("data", () => {});
    proc2.stdout.resume();
    fech2 = observarFechamento(proc2);
    fech2.then(() => { close2Ok = true; });
    await esperarSaudavel(base2, proc2);
    const c2 = await criarCenario(base2, banco2, { jogadores: {} });
    const token = decodeURIComponent(c2.cookieMestre.split("=")[1]);
    for (let i = 0; i < 2; i++) {
      const s = ioClient(base2, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
        reconnection: false,
      });
      sk.push(s);
      const f = { ok: false };
      s.once("disconnect", () => { f.ok = true; });
      descFlags.push(f);
    }
    await pronto(sk[0]);
    await pronto(sk[1]);
    // Browser real com contexto/página explícitos também na aquisição parcial
    browser2 = await chromium.launch();
    ctx2 = await browser2.newContext();
    pg2 = await ctx2.newPage();
    await pg2.goto(base2);
    await pg2.waitForLoadState("domcontentloaded").catch(() => {});
    throw new Error("FALHA_INJETADA_pos_aquisicao_parcial");
  } catch (e) {
    erroOriginal = e;
  } finally {
    erros2 = await limparRecursos({ sockets: sk, proc: proc2, fechamento: fech2, pagina: pg2, contexto: ctx2, browser: browser2, dir: d2 });
  }
  t("falha injetada propaga sem ser mascarada pelo cleanup", String(erroOriginal?.message ?? "").includes("FALHA_INJETADA"), String(erroOriginal?.message ?? erroOriginal).slice(0, 90));
  t("cleanup da prova sem erros", erros2.length === 0, erros2.join(" | "));
  t("dois sockets emitiram disconnect real (evento, não flag)", descFlags.length === 2 && descFlags.every((f) => f.ok));
  t("página da prova fechada", !!pg2 && pg2.isClosed() === true);
  t("contexto da prova sem páginas abertas", !!ctx2 && ctx2.pages().length === 0, `pages=${ctx2 ? ctx2.pages().length : "n/a"}`);
  t("browser real da prova desconectado", !!browser2 && browser2.isConnected() === false);
  t("processo da prova chegou a close (stdio encerrado)", close2Ok === true);
  t("diretório da prova removido", !!d2 && !existsSync(d2), d2 || "sem dir");
}

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
// Todo socket é registrado na coleção externa ao try: o finally fecha
// todos, inclusive os criados antes de uma falha parcial.
function conectarRegistrado(cookie) {
  const s = conectar(cookie);
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const esperar = (s, ev, timeout = 8000, pred) => new Promise((resolve, reject) => {
  const h = (d) => { if (pred && !pred(d)) return; clearTimeout(t); s.off(ev, h); resolve(d); };
  const t = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout ${ev}`)); }, timeout);
  s.on(ev, h);
});

await provaFalhaParcial();

try {
  DIR = dirTeste("desafio-ficha");
  BANCO = `${DIR}/teste.db`;
  ARQ = `${DIR}/arq`; BKS = `${DIR}/bks`;
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  BASE = `http://localhost:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  proc.stdout.resume();
  fechamentoServidor = observarFechamento(proc);
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

  // Terceiro personagem reproduz a ficha real do Fernandinho (retrato do
  // formato publicado em produção): seções com nomes do template real,
  // atributos como `inteiro` + semantico sem `usadoEmTestes` (legado —
  // fallback semântico deve elegê-los), conhecimentos/perícias como
  // `selecao_nivel` (não elegíveis por tipo), moeda/item em tabela,
  // campo numérico explicitamente desabilitado e campo "livre" sem flag.
  const ESTRUTURA_FERNANDINHO = {
    versao: 1,
    secoes: [
      { id: "s-forca", titulo: "Atributos De Força", ordem: 0, campos: [
        { id: "forca", label: "Força", tipo: "inteiro", semantico: "atributo" },
        { id: "destreza", label: "Destreza", tipo: "inteiro", semantico: "atributo" },
        { id: "vigor", label: "Vigor", tipo: "inteiro", semantico: "atributo" },
      ]},
      { id: "s-mental", titulo: "Atributos Mental", ordem: 1, campos: [
        { id: "percepcao", label: "Percepção", tipo: "inteiro", semantico: "atributo" },
        { id: "raciocinio", label: "Raciocínio", tipo: "inteiro", semantico: "atributo" },
        { id: "inteligencia", label: "Inteligência", tipo: "inteiro", semantico: "atributo" },
      ]},
      { id: "s-hab", titulo: "Habilidades", ordem: 2, campos: [
        { id: "pericias", label: "Pericias", tipo: "selecao_nivel", semantico: "especializacao", regraKind: "pericia" },
        { id: "conhecimentos", label: "Conhecimento", tipo: "selecao_nivel", semantico: "conhecimento", regraKind: "conhecimento" },
        { id: "talentos", label: "Talentos", tipo: "selecao_nivel", semantico: "talento", opcoes: ["Liderança", "Furtividade", " Espionagem", "Negociação "] },
        { id: "computador_fern", label: "Computador", tipo: "inteiro", semantico: "conhecimento" },
        { id: "doencas", label: "Doenças", tipo: "inteiro", semantico: "habilidade", usadoEmTestes: false },
      ]},
      { id: "s-virt", titulo: "Virtudes", ordem: 3, campos: [
        { id: "pontos_sangue", label: "Pontos de Sangue", tipo: "inteiro", semantico: "livre" },
      ]},
      { id: "s-inv", titulo: "Inventario", ordem: 4, campos: [
        { id: "dinheiro", label: "Dinheiro", tipo: "tabela", semantico: "moeda" },
        { id: "inventario", label: "Inventario", tipo: "tabela", semantico: "item" },
      ]},
    ],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  const tpl3Id = crypto.randomUUID(), ver3Id = crypto.randomUUID(), pj3Id = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
        .run(tpl3Id, ids.camp, "Ficha Mundo Tenebroso", null, ids.admin, agora, agora);
      w.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
        .run(ver3Id, tpl3Id, JSON.stringify(ESTRUTURA_FERNANDINHO), agora, agora);
      w.prepare("update sheet_templates set current_version_id=? where id=?").run(ver3Id, tpl3Id);
      // biblioteca da campanha: nomes reais dos elementos selecao_nivel
      let rs = w.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(ids.camp);
      if (!rs) {
        const rsId = crypto.randomUUID();
        w.prepare("insert into rule_sets (id,campaign_id,name,version,is_active,config,created_at,updated_at) values (?,?,?,?,1,?,?,?)")
          .run(rsId, ids.camp, "Regras da campanha", 1, "{}", agora, agora);
        rs = { id: rsId };
      }
      const defs = [
        ["conhecimento", "academicos", "Acadêmicos"],
        ["conhecimento", "computador", "Computador"],
        ["conhecimento", "medicina", "Medicina"],
        ["conhecimento", "quimica", "Química"],
        ["pericia", "esportes", "Esportes"],
      ];
      for (const [kind, key, name] of defs) {
        w.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
          .run(crypto.randomUUID(), rs.id, kind, key, name, null, null, "{}", agora, agora);
      }
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(pj3Id, ids.camp, ids.j1.membershipId, ver3Id, "Fernandinho",
          JSON.stringify({
            forca: 3, destreza: 1, vigor: 3,
            percepcao: 2, raciocinio: 2, inteligencia: 3,
            pericias: [{ key: "esportes", nivel: 2 }],
            conhecimentos: [
              { key: "academicos", nivel: 3 },
              { key: "computador", nivel: 5 },
              { key: "medicina", nivel: 3 },
              { key: "quimica", nivel: 2 },
            ],
            talentos: [
              { key: "Liderança", nivel: 4 },
              { key: " Espionagem", nivel: 3 },
              { key: "Negociação ", nivel: 2 },
            ],
            computador_fern: 5, doencas: 4, pontos_sangue: 1,
            dinheiro: [], inventario: [],
          }), "{}", "aprovada", 0, agora, agora);
    } finally { w.close(); }
  }
  ids.pj3 = pj3Id;

  // Quarto personagem: do JOGADOR 2, mesma ficha com campos elegíveis —
  // prova que o desafio chega ao dono certo e que não-donos não rolam.
  const pj4Id = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(pj4Id, ids.camp, ids.j2.membershipId, verId, "PJ Dois",
          JSON.stringify({ for: 4, computador: 3, medicina: 2, atletismo: 5, ouro: 10, carisma: 1, apelido: "y" }),
          "{}", "aprovada", 0, agora, agora);
    } finally { w.close(); }
  }
  ids.pj4 = pj4Id;

  // mínimo de sucesso D10 conhecido
  await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cm, body: { dados: { d10SucessoMinimo: 6 } } });

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cm, body: { name: "Mesa Ficha" } });
  sid = sess.json?.sessao?.id;
  t("sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 120));

  const sockM = conectarRegistrado(ids.cm), sockJ1 = conectarRegistrado(ids.j1.cookie), sockJ2 = conectarRegistrado(ids.j2.cookie);
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

  sec("fixture Fernandinho — formato real publicado");
  // atributos legados sem `usadoEmTestes` caem no fallback semântico
  const rFor = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "forca",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evFor = evJ1.teste.find((x) => x.id === rFor?.id);
  t("Fernandinho: Força (atributo sem flag) elegível, 3 positivos",
    rFor?.ok === true && evFor?.pool?.positivos === 3, JSON.stringify(rFor) + " " + JSON.stringify(evFor?.pool));
  const rCompF = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "computador_fern",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evCompF = evJ1.teste.find((x) => x.id === rCompF?.id);
  t("Fernandinho: Conhecimento Computador=5 -> 5 positivos D10",
    rCompF?.ok === true && evCompF?.pool?.positivos === 5 && evCompF?.pool?.dadosLados === 10, JSON.stringify(evCompF?.pool));
  const rSel = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "conhecimentos",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("Fernandinho: selecao_nivel sem elementoKey rejeitado",
    rSel?.ok === false, JSON.stringify(rSel));
  // desafio por ELEMENTO: cada item da lista vira um teste próprio com o
  // nível individual como dados positivos — nome real vem da biblioteca
  const rElComp = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "conhecimentos", elementoKey: "computador",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evElComp = evJ1.teste.find((x) => x.id === rElComp?.id);
  t("Fernandinho: elemento Conhecimento/Computador nível 5 -> 5 positivos",
    rElComp?.ok === true && evElComp?.pool?.positivos === 5 && evElComp?.pool?.dadosLados === 10,
    JSON.stringify(rElComp) + " " + JSON.stringify(evElComp?.pool));
  t("evento do jogador rotula o elemento real (não a lista)",
    evElComp?.rotulo === "Computador" && evElComp?.skillRef?.elementoKey === "computador"
      && evElComp?.skillRef?.campoRotulo === "Conhecimento", JSON.stringify(evElComp?.skillRef));
  const rowEl = rElComp?.id ? comDb(BANCO, (db) => db.prepare("select skill_ref,modifiers from tests where id=?").get(rElComp.id)) : null;
  const skillEl = JSON.parse(rowEl?.skill_ref ?? "null");
  const modsEl = JSON.parse(rowEl?.modifiers ?? "{}");
  t("banco: skill_ref do elemento + valorCampo=5",
    skillEl?.campoId === "conhecimentos" && skillEl?.elementoKey === "computador"
      && skillEl?.rotulo === "Computador" && modsEl?.valorCampo === 5, JSON.stringify(skillEl));
  await new Promise((r) => setTimeout(r, 400));
  const rElMed = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "conhecimentos", elementoKey: "medicina", malus: 2,
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evElMed = evJ1.teste.find((x) => x.id === rElMed?.id);
  t("Fernandinho: Medicina nível 3 − malus 2 -> 1 efetivo",
    rElMed?.ok === true && evElMed?.pool?.positivos === 3 && evElMed?.pool?.negativos === 2 && evElMed?.dados?.count === 1,
    JSON.stringify(evElMed?.pool));
  const rElInexistente = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "conhecimentos", elementoKey: "elemento_falso",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("Fernandinho: elementoKey inexistente rejeitado", rElInexistente?.ok === false, JSON.stringify(rElInexistente));
  await new Promise((r) => setTimeout(r, 350));
  const rElPericia = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "pericias", elementoKey: "esportes",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("Fernandinho: perícia (especializacao sem flag) rejeitada — exige opt-in",
    rElPericia?.ok === false, JSON.stringify(rElPericia));
  const rElTalento = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "talentos", elementoKey: "Liderança",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evElTal = evJ1.teste.find((x) => x.id === rElTalento?.id);
  t("Fernandinho: Talento 'Liderança' nível 4 elegível via fallback",
    rElTalento?.ok === true && evElTal?.pool?.positivos === 4, JSON.stringify(evElTal?.pool));

  // Chaves com espaços fazem parte da identidade do elemento: a comparação
  // é EXATA contra o valor persistido — trim no servidor quebraria isso.
  await new Promise((r) => setTimeout(r, 400));
  const rEsp = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "talentos", elementoKey: " Espionagem",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evEsp = evJ1.teste.find((x) => x.id === rEsp?.id);
  t("elemento com espaço inicial: chave exata aceita, nível 3 -> 3 positivos",
    rEsp?.ok === true && evEsp?.pool?.positivos === 3, JSON.stringify(rEsp) + " " + JSON.stringify(evEsp?.pool));
  const rowEsp = rEsp?.id ? comDb(BANCO, (db) => db.prepare("select skill_ref from tests where id=?").get(rEsp.id)) : null;
  const skillEsp = JSON.parse(rowEsp?.skill_ref ?? "null");
  t("skill_ref persiste a chave original com espaço",
    skillEsp?.elementoKey === " Espionagem" && skillEsp?.campoId === "talentos", JSON.stringify(skillEsp));
  const rEspAparada = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "talentos", elementoKey: "Espionagem",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("elementoKey aparada (sem o espaço persistido) rejeitada",
    rEspAparada?.ok === false, JSON.stringify(rEspAparada));
  await new Promise((r) => setTimeout(r, 400));
  const rNeg = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "talentos", elementoKey: "Negociação ",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evNeg = evJ1.teste.find((x) => x.id === rNeg?.id);
  t("elemento com espaço final: chave exata aceita, nível 2 -> 2 positivos",
    rNeg?.ok === true && evNeg?.pool?.positivos === 2, JSON.stringify(rNeg) + " " + JSON.stringify(evNeg?.pool));
  const rNegAparada = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "talentos", elementoKey: "Negociação",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("elementoKey sem o espaço final rejeitada",
    rNegAparada?.ok === false, JSON.stringify(rNegAparada));
  await new Promise((r) => setTimeout(r, 400));
  const rDoencas = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "doencas",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("Fernandinho: usadoEmTestes:false explícito bloqueia campo numérico",
    rDoencas?.ok === false, JSON.stringify(rDoencas));
  const rPS = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "pontos_sangue",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("Fernandinho: contador 'livre' sem flag não entra no fallback",
    rPS?.ok === false, JSON.stringify(rPS));
  const rDin = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj3Id, campoId: "dinheiro",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  t("Fernandinho: moeda/item em tabela rejeitados",
    rDin?.ok === false, JSON.stringify(rDin));
  // a fixture adiciona emits ao mesmo socket — respeita a janela do rate limit
  await new Promise((r) => setTimeout(r, 600));

  sec("desafio para personagem do jogador 2 — dono certo, permissões");
  const rPj4 = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: sid, characterId: pj4Id, campoId: "computador",
    dadosLados: 10, requestId: "df-" + crypto.randomUUID().slice(0, 8),
  });
  const evPj4 = evJ2.teste.find((x) => x.id === rPj4?.id);
  t("jogador2 recebe o desafio do próprio personagem (Computador=3)",
    rPj4?.ok === true && !!evPj4 && evPj4.pool?.positivos === 3, JSON.stringify(evPj4?.pool));
  // jogador1 (não-dono, não-mestre) não pode rolar o teste do pj4
  const rRollErrado = await emitirCb(sockJ1, "mesa:teste:rolar", { testId: rPj4?.id, requestId: "df-rr-" + crypto.randomUUID().slice(0, 8) });
  t("não-dono não rola teste de personagem alheio", rRollErrado?.ok === false, JSON.stringify(rRollErrado));
  // dono rola normalmente
  const rRollPj4 = await emitirCb(sockJ2, "mesa:teste:rolar", { testId: rPj4?.id, requestId: "df-rr-" + crypto.randomUUID().slice(0, 8) });
  t("dono (jogador2) rola o próprio desafio", rRollPj4?.ok === true && rRollPj4?.d10?.lancados === 3, JSON.stringify(rRollPj4?.d10));
  // persistência: o desafio por elemento continua pendente no histórico HTTP
  const histPendente = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/testes`, { cookie: ids.j1.cookie });
  const pendEl = (histPendente.json?.testes ?? []).find((x) => x.id === rElComp?.id);
  t("histórico HTTP mantém desafio por elemento pendente",
    !!pendEl && pendEl.status === "pendente", JSON.stringify(pendEl?.status));
  await new Promise((r) => setTimeout(r, 400));

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
  await new Promise((r) => setTimeout(r, 400));
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
  await new Promise((r) => setTimeout(r, 400));

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
  // Issue #147: o skillRef pode carregar metadados DERIVADOS da estrutura
  // validada (tipo/semantico/categoria/secao) — chaves fora desse
  // conjunto ou valores forjados continuam proibidos.
  const CHAVES_SKILLREF_OK = new Set(["campoId", "rotulo", "tipo", "semantico", "categoria", "secao"]);
  t("nenhuma propriedade forjada persistida",
    skillSk && Object.keys(skillSk).every((k) => CHAVES_SKILLREF_OK.has(k))
      && !Object.values(skillSk).some((v) => typeof v === "string" && v.includes("FORJADO")),
    JSON.stringify(skillSk));
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
  const chatSkill = comDb(BANCO, (db) => db.prepare(
    "select content from chat_messages where session_id=? and kind='teste' order by created_at desc limit 1",
  ).get(sid));
  t("chat do desafio usa rótulo validado da ficha",
    typeof chatSkill?.content === "string" && chatSkill.content.includes("Medicina")
      && !chatSkill.content.includes("FORJADO"), JSON.stringify(chatSkill?.content));
  await new Promise((r) => setTimeout(r, 500));

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
  await new Promise((r) => setTimeout(r, 400));
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
  await new Promise((r) => setTimeout(r, 600));
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
  browser = await chromium.launch();
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
  // o card do jogador deve ser o desafio submetido pela UI (3 efetivos
  // após malus) — não os testes de socket pendentes com o mesmo rótulo
  const cardJ = pJ.locator(".teste-card", { hasText: "Computador" }).filter({ hasText: "3 efetivos" }).last();
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

  // aceite da missão: mestre seleciona Fernandinho, escolhe Conhecimento
  // Computador (5), solicita e o jogador recebe exatamente 5 D10 positivos
  if (!(await form.isVisible().catch(() => false))) {
    await tituloFicha.locator("button", { hasText: "+ Desafio" }).click();
    await pM.waitForTimeout(300);
  }
  const idxFern = opsPers.findIndex((o) => o.includes("Fernandinho"));
  t("UI. Fernandinho presente na lista de personagens", idxFern >= 0, opsPers.join("|"));
  await selPers.selectOption({ index: idxFern });
  await pM.waitForTimeout(1200);
  const opcoesF = await selCampo.locator("option").allTextContents();
  t("UI. Fernandinho: Computador (5) elegível", opcoesF.some((o) => /Computador\s*\(5\)/.test(o)), opcoesF.join("|"));
  t("UI. Fernandinho: Força (3) elegível", opcoesF.some((o) => /Força\s*\(3\)/.test(o)), opcoesF.join("|"));
  t("UI. Fernandinho: moeda/item/contador ausentes",
    !opcoesF.some((o) => /Dinheiro|Inventario|Pontos de Sangue|Doenças/.test(o)), opcoesF.join("|"));
  // selecao_nivel elegível expande cada ELEMENTO com seu nível — nome real
  // da biblioteca, sem somar nem usar a quantidade de itens
  t("UI. Fernandinho: elementos de Conhecimento listados individualmente",
    opcoesF.some((o) => /Conhecimento — Computador\s*\(5\)/.test(o))
      && opcoesF.some((o) => /Conhecimento — Medicina\s*\(3\)/.test(o))
      && opcoesF.some((o) => /Conhecimento — Química\s*\(2\)/.test(o)), opcoesF.join("|"));
  t("UI. Fernandinho: elemento de Talentos listado",
    opcoesF.some((o) => /Talentos — Liderança\s*\(4\)/.test(o)), opcoesF.join("|"));
  t("UI. Fernandinho: elementos com espaços nas chaves listados",
    opcoesF.some((o) => /Talentos —\s+Espionagem\s*\(3\)/.test(o))
      && opcoesF.some((o) => /Talentos —\s+Negociação\s*\(2\)/.test(o)), opcoesF.join("|"));
  t("UI. Fernandinho: perícia sem opt-in ausente",
    !opcoesF.some((o) => /Esportes/.test(o)), opcoesF.join("|"));
  const idxCompF = opcoesF.findIndex((o) => /Conhecimento — Computador/.test(o));
  t("UI. Fernandinho: opção de elemento encontrada", idxCompF >= 0, opcoesF.join("|"));
  await selCampo.selectOption({ index: idxCompF });
  await pM.waitForTimeout(300);
  const metaF = await form.locator(".meta, .desafio-pool").allTextContents();
  t("UI. pool do elemento: 5 positivos", metaF.some((m) => /5\s*positivo/.test(m)), metaF.join(" | "));
  await form.locator('button[type="submit"]').click();
  await pM.waitForTimeout(900);
  const evFern = evJ1.teste.filter((x) => x.skillRef?.elementoKey === "computador" && x.skillRef?.campoId === "conhecimentos").pop();
  t("UI. jogador recebe desafio do elemento com 5 positivos",
    !!evFern && evFern.pool?.positivos === 5 && evFern.pool?.dadosLados === 10, JSON.stringify(evFern?.pool));
  const cardFern = pJ.locator(".teste-card", { hasText: "Computador" }).filter({ hasText: "5d10 positivos" }).last();
  await cardFern.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const txtFern = await cardFern.textContent().catch(() => "");
  t("UI. card do jogador identifica o elemento Computador com 5 positivos",
    /Computador/.test(txtFern ?? "") && /5d10 positivos/.test(txtFern ?? ""), txtFern?.slice(0, 160));
  // reload completo: o desafio pendente NÃO pode sumir — vem do histórico
  await abrirMesa(pJ);
  const cardFernReload = pJ.locator(".teste-card", { hasText: "Computador" }).filter({ hasText: "5d10 positivos" }).last();
  await cardFernReload.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const txtFernR = await cardFernReload.textContent().catch(() => "");
  t("UI. após reload o desafio pendente continua na Mesa do jogador",
    /Computador/.test(txtFernR ?? "") && /Rolar/.test(txtFernR ?? ""), txtFernR?.slice(0, 160));

  // o desafio criado com skillRef forjado aparece com o label REAL da ficha
  const cardSk = pJ.locator(".teste-card", { hasText: "Medicina" }).last();
  await cardSk.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const txtSk = await cardSk.textContent().catch(() => "");
  t("UI. jogador vê label real do campo (skillRef forjado neutralizado)",
    /Medicina/.test(txtSk ?? "") && !/FORJADO/.test(txtSk ?? ""), txtSk?.slice(0, 160));

  t("UI. console sem erros (mestre)", errosM.length === 0, errosM.slice(0, 2).join(" | "));
  t("UI. console sem erros (jogador)", errosJ.length === 0, errosJ.slice(0, 2).join(" | "));
} catch (e) {
  fail++;
  console.log("FALHOU exceção:", e);
} finally {
  // Ordem: sockets → browser → shutdown/close do servidor → remoção do DIR.
  // Erro de cleanup falha a suíte sem mascarar a exceção original (o catch
  // acima já a registrou antes deste bloco).
  const errosLimpeza = await limparRecursos({ sockets, proc, fechamento: fechamentoServidor, browser, dir: DIR });
  for (const msg of errosLimpeza) {
    fail++;
    console.log("FALHOU teardown:", msg);
  }
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
