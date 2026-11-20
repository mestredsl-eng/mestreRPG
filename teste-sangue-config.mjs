// Issue #186 C1 — config.sangue no PUT /api/campaigns/:id/regras/config.
// Cobre: default desabilitado, schema estrutural, validação de vínculos
// contra TODAS as estruturas de ficha ativas da campanha (400 sem
// persistir), PUT parcial preservando campos, e naturezas de rótulos
// livres. Banco 100% descartável; fixtures sintéticas.
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("sangue-config");
const BANCO = join(DIR, "banco.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

const putCfg = (campId, cookie, body) =>
  req(BASE, "PUT", `/campaigns/${campId}/regras/config`, { cookie, body });
const getCfg = async (campId, cookie) => {
  const r = await req(BASE, "GET", `/campaigns/${campId}/regras`, { cookie });
  return r.json?.config;
};

// Estrutura sintética com campos compatíveis/incompatíveis de propósito.
function estruturaCustom() {
  return {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Sangue", ordem: 0,
      campos: [
        { id: "cap", label: "Capacidade", tipo: "inteiro", semantico: "livre", padrao: 0 },
        { id: "nat", label: "Natureza", tipo: "selecao_unica", semantico: "livre", padrao: "", opcoes: ["Alfa", "Beta"] },
        { id: "qual", label: "Qualidade", tipo: "selecao_nivel", semantico: "vantagem", padrao: [] },
        { id: "txt", label: "Texto", tipo: "texto", semantico: "livre", padrao: "" },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
}

// criarCenario só semeia o admin uma vez por banco — campanhas extras
// são criadas via API e recebem ficha/personagem por INSERT direto.
async function novaCenarioExtra(c, { comFicha = true, estrutura = null, rotulo = "extra" } = {}) {
  const camp = await req(BASE, "POST", "/campaigns", {
    cookie: c.cookieMestre, body: { name: `Extra ${rotulo} ${crypto.randomUUID().slice(0, 6)}` },
  });
  const campId = camp.json?.campanha?.id;
  if (!campId) throw new Error("criar campanha extra falhou: " + JSON.stringify(camp.json));
  const db = abrirDb(BANCO);
  try {
    const agora = Date.now();
    const mid = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(mid, campId, c.jogadores.jogador1.id, agora, agora, agora);
    let templateVersionId = null;
    if (comFicha) {
      const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
      db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
        .run(tplId, campId, "Ficha " + rotulo, null, c.adminId, agora, agora);
      db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
        .run(verId, tplId, JSON.stringify(estrutura ?? estruturaCustom()), agora, agora);
      db.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
      templateVersionId = verId;
      const pid = crypto.randomUUID();
      db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(pid, campId, mid, verId, "Herói " + rotulo,
          JSON.stringify({ cap: 7, nat: "Alfa", for: 5, qual: [{ key: "x", nivel: 2 }], txt: "livre" }),
          "{}", "aprovada", 0, agora, agora);
    }
    return { campId, cookieMestre: c.cookieMestre, templateVersionId };
  } finally { db.close(); }
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bkp") });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Sangue Config" });

  sec("1-2. Default desabilitado — configs antigas intactas");
  {
    const cfg = await getCfg(c.campId, c.cookieMestre);
    t("config sem sangue → bloco desabilitado", cfg?.sangue?.habilitado === false, JSON.stringify(cfg?.sangue));
    // PUT parcial de outro bloco não liga Sangue
    const r = await putCfg(c.campId, c.cookieMestre, { financeiro: { moedaPrincipal: "USD" } });
    t("PUT financeiro parcial aceito", r.status === 200, `status=${r.status}`);
    const cfg2 = await getCfg(c.campId, c.cookieMestre);
    t("sangue continua desabilitado após PUT alheio", cfg2?.sangue?.habilitado === false);
    t("financeiro persistiu USD", cfg2?.financeiro?.moedaPrincipal === "USD");
    // habilitado:false explícito não liga
    const r2 = await putCfg(c.campId, c.cookieMestre, { sangue: { habilitado: false } });
    t("sangue.habilitado=false aceito", r2.status === 200, `status=${r2.status}`);
  }

  sec("3. Config estrutural válida — sem valores de regra inventados");
  {
    // habilitado:true sem campoCapacidadeId → 400 (a config ainda não tem vínculo)
    const r0 = await putCfg(c.campId, c.cookieMestre, { sangue: { habilitado: true } });
    t("400: habilitado sem campoCapacidadeId", r0.status === 400, `status=${r0.status} ${JSON.stringify(r0.json).slice(0, 140)}`);

    const r = await putCfg(c.campId, c.cookieMestre, {
      sangue: {
        habilitado: true,
        campoCapacidadeId: "for", // campo inteiro da fixture base
        campoNaturezaId: undefined,
        capacidade: { modo: "valor" },
        naturezas: { Alfa: { metaHumanoComPoder: true, recuperacao: "descansar" } },
        recuperacaoSangue: { habilitado: true },
      },
    });
    // fixture base só tem campo "for" (inteiro): capacidade ok, natureza ausente ok
    t("sangue válido na estrutura base aceito", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    const cfg = await getCfg(c.campId, c.cookieMestre);
    t("naturezas persistiu rótulo livre Alfa", cfg?.sangue?.naturezas?.Alfa?.metaHumanoComPoder === true);
    t("recuperacaoSangue persistiu", cfg?.sangue?.recuperacaoSangue?.habilitado === true);
  }

  sec("4-6. Vínculos inválidos → HTTP 400 sem persistir");
  {
    const casos = [
      ["campo capacidade inexistente", { sangue: { habilitado: true, campoCapacidadeId: "nao_existe" } }],
      ["modo incompatível (somaNiveis em inteiro)", { sangue: { habilitado: true, campoCapacidadeId: "for", capacidade: { modo: "somaNiveis" } } }],
      ["modo mapa sem mapa", { sangue: { habilitado: true, campoCapacidadeId: "for", capacidade: { modo: "mapa" } } }],
      ["natureza inexistente", { sangue: { habilitado: true, campoCapacidadeId: "for", campoNaturezaId: "fantasma" } }],
      ["natureza tipo incompatível (inteiro)", { sangue: { habilitado: true, campoCapacidadeId: "for", campoNaturezaId: "for" } }],
      ["bonusQualidade campo inexistente", { sangue: { habilitado: true, campoCapacidadeId: "for", capacidade: { bonusQualidade: { campoId: "x", coeficiente: 1 } } } }],
    ];
    for (const [nome, body] of casos) {
      const r = await putCfg(c.campId, c.cookieMestre, body);
      t(`400: ${nome}`, r.status === 400, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    }
    // nada foi persistido — config ainda é a do cenário 3
    const cfg = await getCfg(c.campId, c.cookieMestre);
    t("rejeições não gravaram alteração", cfg?.sangue?.campoCapacidadeId === "for");
  }

  sec("7. Naturezas: rótulos livres, sem nomes hardcoded");
  {
    const r = await putCfg(c.campId, c.cookieMestre, {
      sangue: {
        habilitado: true,
        campoCapacidadeId: "for",
        naturezas: {
          "Espécie-X-Qualquer": { metaHumanoComPoder: false },
          Outro: { recuperacao: "rotulo-opaco-da-campanha" },
        },
      },
    });
    t("naturezas com rótulos arbitrários aceitas", r.status === 200, `status=${r.status}`);
    const cfg = await getCfg(c.campId, c.cookieMestre);
    t("rótulo não mapeado não ganha semântica", cfg?.sangue?.naturezas?.["Sem-Mapeamento"] === undefined);
  }

  sec("8. PUT parcial preserva campos não enviados");
  {
    const antes = await getCfg(c.campId, c.cookieMestre);
    const r = await putCfg(c.campId, c.cookieMestre, { mesa: { acaoForaDeTurno: false } });
    t("PUT mesa parcial aceito", r.status === 200);
    const depois = await getCfg(c.campId, c.cookieMestre);
    t("sangue preservado no merge parcial", JSON.stringify(depois?.sangue) === JSON.stringify(antes?.sangue));
    t("mesa persistiu", depois?.mesa?.acaoForaDeTurno === false);
  }

  sec("9. Múltiplas estruturas ativas — valida CADA uma");
  {
    // campanha com DOIS personagens em estruturas diferentes:
    // custom (cap/nat/qual/txt) + base-like (só "for")
    const c2 = await novaCenarioExtra(c, { rotulo: "multi" });
    // segundo personagem com estrutura mínima (só campo "for" inteiro)
    {
      const db = abrirDb(BANCO); const agora = Date.now();
      try {
        const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
        db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
          .run(tplId, c2.campId, "Ficha minima", null, c.adminId, agora, agora);
        db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
          .run(verId, tplId, JSON.stringify({
            versao: 1,
            secoes: [{ id: "s1", titulo: "A", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" }] }],
            pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
          }), agora, agora);
        db.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
        const mid2 = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(c2.campId, c.jogadores.jogador2?.id ?? c.jogadores.jogador1.id)?.id
          ?? db.prepare("select id from memberships where campaign_id=? limit 1").get(c2.campId).id;
        const pid = crypto.randomUUID();
        db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
          .run(pid, c2.campId, mid2, verId, "Herói Mínimo", JSON.stringify({ for: 3 }), "{}", "aprovada", 0, agora, agora);
      } finally { db.close(); }
    }
    // config que só a estrutura custom atende (nat não existe na mínima)
    const ok = await putCfg(c2.campId, c2.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "for", campoNaturezaId: undefined, capacidade: { modo: "valor" } },
    });
    // "for" existe nas DUAS estruturas (custom tem for? não — custom não tem "for")
    // custom tem cap/nat/qual/txt; mínima tem for → "for" falta na custom → 400
    t("vínculo ausente em QUALQUER estrutura ativa → 400", ok.status === 400, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 200)}`);
    // config que falha só na mínima: campoNaturezaId "nat" (não existe na mínima)
    const rNat = await putCfg(c2.campId, c2.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "cap", campoNaturezaId: "nat" },
    });
    t("natureza válida na custom mas ausente na mínima → 400", rNat.status === 400, `status=${rNat.status} ${JSON.stringify(rNat.json).slice(0, 200)}`);
    const cfg2 = await getCfg(c2.campId, c2.cookieMestre);
    t("config rejeitada não persistiu", cfg2?.sangue?.habilitado !== true || cfg2?.sangue?.campoNaturezaId == null);
  }

  sec("10. Campanha sem nenhuma ficha vinculada — config válida aceita, inválida rejeitada");
  {
    const c3 = await novaCenarioExtra(c, { comFicha: false, rotulo: "sem-ficha" });
    // configs inválidas PRIMEIRO: o PUT é parcial e preserva campos —
    // depois que campoCapacidadeId persistir, {habilitado:true} sozinho
    // já seria válido pelo merge
    const rInv = await putCfg(c3.campId, c3.cookieMestre, { sangue: { habilitado: true } });
    t("habilitado sem campoCapacidadeId → 400", rInv.status === 400, `status=${rInv.status}`);
    const rBq = await putCfg(c3.campId, c3.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "x", capacidade: { bonusQualidade: { campoId: "q" } } },
    });
    t("bonusQualidade parcial sem estrutura → 400", rBq.status === 400, `status=${rBq.status}`);
    // readback: os 400 não persistiram nada — config segue default
    const cfgApos400 = await getCfg(c3.campId, c3.cookieMestre);
    t("readback: 400s não alteraram a config", cfgApos400?.sangue?.habilitado === false && cfgApos400?.sangue?.campoCapacidadeId == null);
    // sem estruturas elegíveis não há vínculo a comparar: config
    // sintaticamente válida é aceita e persistida
    const r = await putCfg(c3.campId, c3.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "qualquer", capacidade: { modo: "valor" } },
    });
    t("sangue válido sem estrutura elegível → 200", r.status === 200, `status=${r.status}`);
    const cfg = await getCfg(c3.campId, c3.cookieMestre);
    t("config persistida sem estrutura", cfg?.sangue?.habilitado === true && cfg?.sangue?.campoCapacidadeId === "qualquer");
    const r2 = await putCfg(c3.campId, c3.cookieMestre, { sangue: { habilitado: false } });
    t("sangue desabilitado sem ficha → 200", r2.status === 200, `status=${r2.status}`);
  }

  sec("11. Escopo — versão publicada, campanha do template, status do personagem");
  {
    // estrutura propositalmente INCOMPATÍVEL: não tem o campo "cap"
    const estruturaIncompativel = () => ({
      versao: 1,
      secoes: [{ id: "s1", titulo: "X", ordem: 0, campos: [{ id: "zzz", label: "Z", tipo: "inteiro", semantico: "livre" }] }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    });
    // adiciona personagem com versão customizada à campanha
    // templateCampId: undefined→campanha; null→modelo global; outro id→cross-campaign
    // estrutura: null→incompatível (só "zzz"); passe estruturaCustom() p/ compatível
    const addPersonagem = (campId, { status = "aprovada", publicado = true, templateCampId = undefined, isNpc = 0, estrutura = null } = {}) => {
      const db = abrirDb(BANCO); const agora = Date.now();
      try {
        const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
        const tplCamp = templateCampId === undefined ? campId : templateCampId;
        db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
          .run(tplId, tplCamp, "Ficha escopo", null, c.adminId, agora, agora);
        db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
          .run(verId, tplId, JSON.stringify(estrutura ?? estruturaIncompativel()), publicado ? agora : null, agora);
        db.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
        const mid = db.prepare("select id from memberships where campaign_id=? limit 1").get(campId).id;
        const pid = crypto.randomUUID();
        db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
          .run(pid, campId, mid, verId, "Herói Escopo", "{}", "{}", status, isNpc, agora, agora);
        return verId;
      } finally { db.close(); }
    };
    const cfgValida = { sangue: { habilitado: true, campoCapacidadeId: "cap", capacidade: { modo: "valor" } } };

    // A) versão NÃO publicada não restringe a config
    const cA = await novaCenarioExtra(c, { rotulo: "naopub" });
    addPersonagem(cA.campId, { publicado: false });
    const rA = await putCfg(cA.campId, cA.cookieMestre, cfgValida);
    t("versão unpublished ignorada → config válida 200", rA.status === 200, `status=${rA.status} ${JSON.stringify(rA.json).slice(0, 160)}`);

    // B) versão de template de OUTRA campanha não restringe
    const cB = await novaCenarioExtra(c, { rotulo: "crosscamp" });
    addPersonagem(cB.campId, { templateCampId: c.campId }); // template da campanha principal
    const rB = await putCfg(cB.campId, cB.cookieMestre, cfgValida);
    t("versão de outra campanha ignorada → 200", rB.status === 200, `status=${rB.status} ${JSON.stringify(rB.json).slice(0, 160)}`);

    // B2) template GLOBAL publicado PARTICIPA da validação (a rota de
    // personagens aceita templateVersionId global — vínculo é real)
    const cG = await novaCenarioExtra(c, { comFicha: false, rotulo: "global-ok" });
    addPersonagem(cG.campId, { templateCampId: null, estrutura: estruturaCustom() });
    const rG = await putCfg(cG.campId, cG.cookieMestre, cfgValida);
    t("global publicada compatível → 200", rG.status === 200, `status=${rG.status} ${JSON.stringify(rG.json).slice(0, 160)}`);
    const cG2 = await novaCenarioExtra(c, { comFicha: false, rotulo: "global-bad" });
    addPersonagem(cG2.campId, { templateCampId: null }); // estrutura incompatível
    const rG2 = await putCfg(cG2.campId, cG2.cookieMestre, cfgValida);
    t("global publicada incompatível → 400", rG2.status === 400, `status=${rG2.status} ${JSON.stringify(rG2.json).slice(0, 160)}`);

    // C) personagem arquivado não restringe
    const cC = await novaCenarioExtra(c, { rotulo: "arquivado" });
    addPersonagem(cC.campId, { status: "arquivado" });
    const rC = await putCfg(cC.campId, cC.cookieMestre, cfgValida);
    t("personagem arquivado ignorado → 200", rC.status === 200, `status=${rC.status} ${JSON.stringify(rC.json).slice(0, 160)}`);

    // C2) NPC incompatível não restringe (D11 pendente); jogador elegível segue validado
    const cN = await novaCenarioExtra(c, { rotulo: "npc" });
    addPersonagem(cN.campId, { isNpc: 1 });
    const rN = await putCfg(cN.campId, cN.cookieMestre, cfgValida);
    t("NPC incompatível ignorado → 200", rN.status === 200, `status=${rN.status} ${JSON.stringify(rN.json).slice(0, 160)}`);
    // e o jogador elegível da mesma campanha continua sendo validado:
    // config com campo inexistente na estrutura custom → 400
    const rN2 = await putCfg(cN.campId, cN.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "inexistente", capacidade: { modo: "valor" } },
    });
    t("jogador elegível continua validado → 400", rN2.status === 400, `status=${rN2.status}`);

    // D2) campanhas SEM jogador elegível: só arquivados, só NPCs, vazia
    const cSoArq = await novaCenarioExtra(c, { comFicha: false, rotulo: "so-arquivados" });
    addPersonagem(cSoArq.campId, { status: "arquivado" });
    const rSoArqInv = await putCfg(cSoArq.campId, cSoArq.cookieMestre, { sangue: { habilitado: true } });
    t("só arquivados + config inválida → 400", rSoArqInv.status === 400, `status=${rSoArqInv.status}`);
    const cfgSoArqApos400 = await getCfg(cSoArq.campId, cSoArq.cookieMestre);
    t("readback só-arquivados: 400 não persistiu", cfgSoArqApos400?.sangue?.habilitado === false);
    const rSoArq = await putCfg(cSoArq.campId, cSoArq.cookieMestre, cfgValida);
    t("só arquivados → config válida 200", rSoArq.status === 200, `status=${rSoArq.status}`);
    const cfgSoArq = await getCfg(cSoArq.campId, cSoArq.cookieMestre);
    t("readback só-arquivados: 200 persistiu", cfgSoArq?.sangue?.habilitado === true && cfgSoArq?.sangue?.campoCapacidadeId === "cap");
    const cSoNpc = await novaCenarioExtra(c, { comFicha: false, rotulo: "so-npcs" });
    addPersonagem(cSoNpc.campId, { isNpc: 1 });
    const rSoNpcInv = await putCfg(cSoNpc.campId, cSoNpc.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "cap", capacidade: { bonusQualidade: { modo: "mapa" } } },
    });
    t("só NPCs + bonusQualidade parcial → 400", rSoNpcInv.status === 400, `status=${rSoNpcInv.status}`);
    const cfgSoNpcApos400 = await getCfg(cSoNpc.campId, cSoNpc.cookieMestre);
    t("readback só-NPCs: 400 não persistiu", cfgSoNpcApos400?.sangue?.habilitado === false);
    const rSoNpc = await putCfg(cSoNpc.campId, cSoNpc.cookieMestre, cfgValida);
    t("só NPCs → config válida 200", rSoNpc.status === 200, `status=${rSoNpc.status}`);
    const cfgSoNpc = await getCfg(cSoNpc.campId, cSoNpc.cookieMestre);
    t("readback só-NPCs: 200 persistiu", cfgSoNpc?.sangue?.habilitado === true && cfgSoNpc?.sangue?.campoCapacidadeId === "cap");
    const cVazia = await novaCenarioExtra(c, { comFicha: false, rotulo: "vazia" });
    const rVaziaInv = await putCfg(cVazia.campId, cVazia.cookieMestre, { sangue: { habilitado: true } });
    t("campanha vazia + config inválida → 400", rVaziaInv.status === 400, `status=${rVaziaInv.status}`);
    const cfgVaziaApos400 = await getCfg(cVazia.campId, cVazia.cookieMestre);
    t("readback vazia: 400 não persistiu", cfgVaziaApos400?.sangue?.habilitado === false);
    const rVazia = await putCfg(cVazia.campId, cVazia.cookieMestre, cfgValida);
    t("campanha vazia → config válida 200", rVazia.status === 200, `status=${rVazia.status}`);
    const cfgVazia = await getCfg(cVazia.campId, cVazia.cookieMestre);
    t("readback vazia: 200 persistiu", cfgVazia?.sangue?.habilitado === true && cfgVazia?.sangue?.campoCapacidadeId === "cap");

    // D) bônus de qualidade parcial → 400 (par campoId+coeficiente exigido)
    const parciais = [
      ["só campoId", { campoId: "qual" }],
      ["só coeficiente", { coeficiente: 1 }],
      ["só modo", { modo: "mapa" }],
      ["só mapa", { mapa: { Alfa: 2 } }],
      ["coeficiente NaN", { campoId: "qual", coeficiente: "NaN" }],
      ["coeficiente Infinity", { campoId: "qual", coeficiente: 1e999 }],
      ["coeficiente negativo", { campoId: "qual", coeficiente: -1 }],
    ];
    const cfgAntes = await getCfg(cA.campId, cA.cookieMestre);
    for (const [nome, bq] of parciais) {
      const r = await putCfg(cA.campId, cA.cookieMestre, {
        sangue: { habilitado: true, campoCapacidadeId: "cap", capacidade: { modo: "valor", bonusQualidade: bq } },
      });
      t(`400: bonusQualidade ${nome}`, r.status === 400, `status=${r.status}`);
    }
    // nenhum 400 persistiu alteração
    const cfgDepois = await getCfg(cA.campId, cA.cookieMestre);
    t("400s de bonusQualidade não alteraram a config", JSON.stringify(cfgDepois?.sangue) === JSON.stringify(cfgAntes?.sangue));
    // objeto vazio não tem chave definida → bloco inativo → aceito
    const rVazio = await putCfg(cA.campId, cA.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "cap", capacidade: { modo: "valor", bonusQualidade: {} } },
    });
    t("bonusQualidade {} inativo → 200", rVazio.status === 200, `status=${rVazio.status}`);
    // bônus completo válido → aceito (qual é selecao_nivel na estrutura custom)
    const rFull = await putCfg(cA.campId, cA.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "cap", capacidade: { modo: "valor", bonusQualidade: { campoId: "qual", coeficiente: 1, modo: "somaNiveis" } } },
    });
    t("bonusQualidade completo válido → 200", rFull.status === 200, `status=${rFull.status} ${JSON.stringify(rFull.json).slice(0, 160)}`);
    // coeficiente 0 é no-op válido (C2 aceita >= 0)
    const rZero = await putCfg(cA.campId, cA.cookieMestre, {
      sangue: { habilitado: true, campoCapacidadeId: "cap", capacidade: { modo: "valor", bonusQualidade: { campoId: "qual", coeficiente: 0, modo: "somaNiveis" } } },
    });
    t("bonusQualidade coeficiente 0 → 200 (alinhado à C2)", rZero.status === 200, `status=${rZero.status} ${JSON.stringify(rZero.json).slice(0, 160)}`);
  }
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e?.stack ?? e).slice(0, 600));
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
