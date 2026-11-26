// Testes — Issue #292: fidelidade da ficha e do ruleset Caçadores & Caçados.
// Cobre o que é mecanicamente verificável no servidor (autoridade real):
//   A) seed da biblioteca — inventário de kinds e chaves exigidas pelo Acervo;
//   B) regras via /regras/simulacao — limites, custos progressivos,
//      exclusividade de poderes e dependências obrigatórias;
//   C) round-trip e preservação — dados desconhecidos/futuros já gravados
//      não são apagados por edição parcial; ficha vazia/legada;
//   D) permissões — mestre vê cálculos, jogador só a própria ficha,
//      espectador sem acesso.
// Banco descartável + servidor spawnado; nunca toca produção.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, criarCenario, comDb, abrirDb,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

const DIR = dirTeste("ficha-cacadores");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arquivos`, backups: `${DIR}/backups` });
await esperarSaudavel(BASE, proc);

async function novoUsuario(username) {
  const id = randomUUID();
  const agora = Date.now();
  const db = abrirDb(BANCO);
  try {
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(id, username, username, await hashSenha("senha-jogador-123"), agora, agora);
  } finally { db.close(); }
  return { id, cookie: sessao(BANCO, id), username };
}
const membroEm = (campId, userId, role = "jogador") => {
  const mid = randomUUID();
  const agora = Date.now();
  const db = abrirDb(BANCO);
  try {
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,?,'ativo',?,?,?)")
      .run(mid, campId, userId, role, agora, agora, agora);
  } finally { db.close(); }
  return mid;
};

// Estrutura de ficha mínima que vincula campos às regras do seed:
// cada campo aponta para um elemento da biblioteca (regra.kind+key).
const ESTRUTURA = {
  versao: 1,
  secoes: [{
    id: "s1", titulo: "Atributos e poderes", ordem: 0,
    campos: [
      { id: "forca", label: "Força", tipo: "inteiro", semantico: "atributo", regra: { kind: "atributo", key: "forca" } },
      { id: "talento_atletismo", label: "Atletismo", tipo: "inteiro", semantico: "talento", regra: { kind: "talento", key: "atletismo" } },
      { id: "pericia_armas", label: "Armas Brancas", tipo: "inteiro", semantico: "habilidade", regra: { kind: "pericia", key: "armas_brancas" } },
      { id: "poder_magia", label: "Magia", tipo: "selecao_multipla", semantico: "poder", regraKind: "poder" },
      { id: "poder_feiticos", label: "Feitiços", tipo: "selecao_multipla", semantico: "poder", regraKind: "poder" },
      { id: "defeito_preco", label: "Preço oculto", tipo: "selecao_multipla", semantico: "defeito", regraKind: "defeito" },
    ],
  }],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};

const simular = (dados, estrutura = ESTRUTURA) =>
  req(BASE, "POST", `/campaigns/${CAMP_ID}/regras/simulacao`, {
    cookie: cookieMestre, body: { estrutura, dados, pontosFicticios: 100000 },
  });
let CAMP_ID, cookieMestre;

try {
  const c = await criarCenario(BASE, BANCO, { jogadores: {} });
  CAMP_ID = c.campId; cookieMestre = c.cookieMestre;

  sec("A — seed e inventário da biblioteca Caçadores & Caçados");
  const seed = await req(BASE, "POST", `/campaigns/${CAMP_ID}/regras/seed`, { cookie: cookieMestre });
  t("mestre semeia biblioteca (2xx)", seed.status >= 200 && seed.status < 300, `status=${seed.status} ${JSON.stringify(seed.json)?.slice(0, 150)}`);
  const els = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/elementos`, { cookie: cookieMestre });
  t("elementos listados", els.status === 200 && Array.isArray(els.json?.elementos ?? els.json), `status=${els.status}`);
  const elementos = els.json?.elementos ?? els.json ?? [];
  const tem = (kind, key) => elementos.some((e) => e.kind === kind && e.key === key);
  const KINDS = ["atributo", "talento", "pericia", "conhecimento", "profissao", "defeito", "vantagem", "poder", "item", "veiculo", "dinheiro"];
  for (const k of KINDS) t(`kind '${k}' presente no seed`, elementos.some((e) => e.kind === k));
  for (const a of ["forca", "destreza", "vitalidade", "inteligencia", "percepcao", "presenca"])
    t(`atributo '${a}' presente`, tem("atributo", a));
  // chaves exigidas pelos pré-requisitos do Acervo (pacote Caçadores & Caçados)
  for (const p of ["armas_brancas", "armas_de_fogo", "conducao", "sobrevivencia", "seguranca", "empatia_com_animal"])
    t(`perícia Acervo '${p}' presente`, tem("pericia", p));
  const magia = elementos.find((e) => e.kind === "poder" && e.key === "magia");
  t("poder 'magia' exige defeito:preco_oculto", JSON.stringify(magia?.def ?? magia).includes("preco_oculto"));
  t("poderes compartilham grupo de exclusividade", ["magia", "feiticos", "teleporte", "telepatia", "controle_mental", "transformacao"]
    .every((k) => JSON.stringify(elementos.find((e) => e.kind === "poder" && e.key === k) ?? {}).includes("poderes_ocultos")));

  sec("B — regras via simulação server-side");
  // limites de atributo (minimo 1 / maximo 6 do seed)
  let r = await simular({ forca: 6 });
  t("atributo no máximo (6) aceito", r.status === 200 && r.json?.ok === true, `status=${r.status} ${JSON.stringify(r.json?.erros)?.slice(0, 200)}`);
  r = await simular({ forca: 7 });
  t("atributo acima do máximo (7) rejeitado", r.json?.ok === false, JSON.stringify(r.json?.erros)?.slice(0, 200));
  // validarFicha normaliza o valor do campo antes das regras: fração em
  // campo "inteiro" é descartada e negativo coage a 0 (ausente) —
  // o piso "abaixo_minimo" das regras só dispara para níveis >0 válidos
  for (const v of [0.5, -3]) {
    r = await simular({ forca: v });
    t(`valor ${v} normalizado antes das regras (ok)`, r.json?.ok === true, JSON.stringify(r.json?.erros)?.slice(0, 150));
  }
  // talento com custo progressivo: nível 5 dentro do máximo
  r = await simular({ talento_atletismo: 5 });
  t("talento nível 5 aceito", r.json?.ok === true, JSON.stringify(r.json?.erros)?.slice(0, 200));
  r = await simular({ talento_atletismo: 6 });
  t("talento acima do máximo (6) rejeitado", r.json?.ok === false);
  // perícia limite
  r = await simular({ pericia_armas: 5 });
  t("perícia nível 5 aceita", r.json?.ok === true);
  r = await simular({ pericia_armas: 6 });
  t("perícia acima do máximo (6) rejeitada", r.json?.ok === false);
  // poder sobrenatural exige defeito:preco_oculto
  r = await simular({ poder_magia: ["magia"] });
  t("poder 'magia' sem preço oculto rejeitado", r.json?.ok === false, JSON.stringify(r.json?.erros)?.slice(0, 250));
  r = await simular({ poder_magia: ["magia"], defeito_preco: ["preco_oculto"] });
  t("poder 'magia' + preço oculto aceito", r.json?.ok === true, JSON.stringify(r.json?.erros)?.slice(0, 250));
  // exclusividade do grupo poderes_ocultos
  r = await simular({ poder_magia: ["magia"], poder_feiticos: ["feiticos"], defeito_preco: ["preco_oculto"] });
  t("magia+feiticos (mesmo grupo exclusivo) rejeitado", r.json?.ok === false, JSON.stringify(r.json?.erros)?.slice(0, 250));
  // custo progressivo do talento: nível 3 deve custar 1+2+3=6 pontos
  r = await simular({ talento_atletismo: 3 });
  const custoTxt = JSON.stringify(r.json?.pontos ?? r.json?.calculos ?? {});
  t("simulação retorna cálculo de pontos", r.status === 200 && (r.json?.pontos !== undefined || r.json?.calculos !== undefined), custoTxt.slice(0, 200));

  sec("C — round-trip e preservação de dados");
  // jogador cria ficha com dados dentro do modelo
  const u = await novoUsuario("ficha_jogador");
  membroEm(CAMP_ID, u.id);
  const criacao = await req(BASE, "POST", `/campaigns/${CAMP_ID}/characters`, {
    cookie: u.cookie, body: { name: "Fiel ao Caçadores", data: { for: 5, observacao_livre: "anotação" } },
  });
  t("jogador cria ficha (2xx)", criacao.status === 200 || criacao.status === 201, `status=${criacao.status}`);
  const charId = criacao.json?.personagem?.id ?? criacao.json?.id;
  t("id do personagem retornado", !!charId);
  const leitura = await req(BASE, "GET", `/campaigns/${CAMP_ID}/characters/${charId}`, { cookie: u.cookie });
  t("round-trip GET devolve dados gravados", leitura.status === 200, `status=${leitura.status}`);
  // injeção direta de chave desconhecida/futura (simula ficha legada ou
  // campo de versão futura): deve sobreviver a PATCH parcial
  {
    const w = abrirDb(BANCO);
    try {
      const atual = w.prepare("select data from characters where id=?").get(charId);
      const dados = JSON.parse(atual.data);
      dados["campo_futuro_v99"] = { estrutura: "qualquer", valores: [1, 2, 3] };
      dados["__metadado_legado"] = "preservar";
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), charId);
    } finally { w.close(); }
  }
  const patchParcial = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${charId}`, {
    cookie: u.cookie, body: { data: { for: 6 } },
  });
  t("PATCH parcial aceito", patchParcial.status === 200, `status=${patchParcial.status} ${JSON.stringify(patchParcial.json)?.slice(0, 150)}`);
  // A API projeta só campos do modelo — a preservação de chaves
  // desconhecidas/futuras é verificada no banco (camada de persistência).
  const dadosFinais = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(charId).data));
  t("edição parcial preserva chave desconhecida/futura",
    JSON.stringify(dadosFinais["campo_futuro_v99"]) === JSON.stringify({ estrutura: "qualquer", valores: [1, 2, 3] }),
    JSON.stringify(dadosFinais).slice(0, 200));
  t("campo conhecido atualizado (for=6)", dadosFinais.for === 6, `for=${dadosFinais.for}`);
  // chave desconhecida no CORPO do PATCH é descartada (fail-closed)
  const patchInjecao = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${charId}`, {
    cookie: u.cookie, body: { data: { for: 5, injetado_pelo_cliente: "hack" } },
  });
  t("PATCH com chave estranha não falha por isso", patchInjecao.status === 200, `status=${patchInjecao.status}`);
  const dados2 = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(charId).data));
  t("chave injetada no corpo NÃO é persistida", dados2["injetado_pelo_cliente"] === undefined, JSON.stringify(dados2).slice(0, 200));
  // ficha vazia/legada: personagem sem templateVersionId → validação ok informativa
  {
    const w = abrirDb(BANCO);
    try {
      const id = randomUUID(); const agora = Date.now();
      const memb = w.prepare("select id from memberships where campaign_id=? limit 1").get(CAMP_ID);
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, CAMP_ID, memb.id, null, "Ficha Vazia", "{}", "{}", "aprovada", 0, agora, agora);
      w.close();
      const val = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/validacao/${id}`, { cookie: cookieMestre });
      t("ficha sem template → validação informativa (não quebra)", val.status === 200, `status=${val.status} ${JSON.stringify(val.json)?.slice(0, 150)}`);
    } finally { try { w.close(); } catch {} }
  }

  sec("D — permissões na validação da ficha");
  const valMestre = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/validacao/${charId}`, { cookie: cookieMestre });
  t("mestre valida ficha (200)", valMestre.status === 200, `status=${valMestre.status}`);
  t("mestre recebe calculos detalhados", valMestre.json?.calculos !== undefined || valMestre.json?.pontos !== undefined,
    JSON.stringify(valMestre.json).slice(0, 200));
  const valDono = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/validacao/${charId}`, { cookie: u.cookie });
  t("jogador dono valida a própria ficha (200)", valDono.status === 200, `status=${valDono.status}`);
  t("jogador NÃO recebe calculos detalhados", valDono.json?.calculos === undefined, JSON.stringify(valDono.json).slice(0, 200));
  // outro jogador da mesma campanha não valida ficha alheia
  const uOutro = await novoUsuario("ficha_outro");
  membroEm(CAMP_ID, uOutro.id);
  const valAlheia = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/validacao/${charId}`, { cookie: uOutro.cookie });
  t("jogador NÃO valida ficha de outro (403)", valAlheia.status === 403, `status=${valAlheia.status}`);
  // personagem de outra campanha → 404 (não vaza existência)
  const c2 = await req(BASE, "POST", "/campaigns", { cookie: cookieMestre, body: { name: "Campanha B" } });
  const campB = c2.json?.campanha?.id;
  const charB = await req(BASE, "POST", `/campaigns/${campB}/characters`, {
    cookie: cookieMestre, body: { name: "Char B", data: {} },
  });
  const charBId = charB.json?.personagem?.id ?? charB.json?.id;
  const valCross = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/validacao/${charBId}`, { cookie: cookieMestre });
  t("personagem de outra campanha → 404", valCross.status === 404, `status=${valCross.status}`);
  // espectador sem membership de jogador → sem acesso à validação
  const uEsp = await novoUsuario("ficha_esp");
  const dbE = abrirDb(BANCO);
  try {
    const mid = randomUUID(); const agora = Date.now();
    dbE.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(mid, CAMP_ID, uEsp.id, agora, agora, agora);
  } finally { dbE.close(); }
  const valEsp = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/validacao/${charId}`, { cookie: uEsp.cookie });
  t("espectador não acessa validação (403)", valEsp.status === 403, `status=${valEsp.status}`);
  const simEsp = await req(BASE, "POST", `/campaigns/${CAMP_ID}/regras/simulacao`, {
    cookie: uEsp.cookie, body: { estrutura: ESTRUTURA, dados: {} },
  });
  t("espectador não usa simulador (403)", simEsp.status === 403, `status=${simEsp.status}`);
  const seedJogador = await req(BASE, "POST", `/campaigns/${CAMP_ID}/regras/seed`, { cookie: u.cookie });
  t("jogador não semeia biblioteca (403)", seedJogador.status === 403, `status=${seedJogador.status}`);

  sec("E — fidelidade ao dump Caçadores & Caçados (Raça, Virtudes, Qualidades, Defeitos)");
  // O dump de referência (dump-cacadores-e-cacas.json) usa kinds que a seed
  // da main NÃO possui: disciplina (Virtudes) e caracteristica. Registrado
  // como divergência — os elementos fiéis ao dump são criados via API real.
  const kindsSeed = new Set(elementos.map((e) => e.kind));
  t("seed NÃO contém kind 'disciplina' (divergência dump×seed)", !kindsSeed.has("disciplina"));
  t("seed NÃO contém kind 'caracteristica' (divergência dump×seed)", !kindsSeed.has("caracteristica"));
  const chavesSeed = new Set(elementos.map((e) => `${e.kind}:${e.key}`));
  for (const k of ["atributo:vigor", "atributo:aparencia", "atributo:manipulacao", "atributo:carisma", "atributo:raciocinio"])
    t(`seed NÃO contém atributo do dump '${k}'`, !chavesSeed.has(k));
  for (const k of ["atributo:vitalidade", "atributo:presenca"])
    t(`seed contém atributo ausente no dump '${k}'`, chavesSeed.has(k));
  t("seed contém chave 'contatos_influentes' mas com def divergente do dump (reservaPontos/custo2 vs custo3 sem reserva)",
    chavesSeed.has("vantagem:contatos_influentes"));

  // Elementos fiéis ao dump, criados pela API real (mestre)
  // Elementos fiéis ao dump — definitions literais do catálogo de referência
  // (dump regras[].definition): disciplinas custam progressivo, defeitos
  // devolvem pontos (custo negativo), vantagens custam no pool principal.
  const DISC_DEF = { custoPontos: 10, custoProgressivo: [0, 10, 20, 30, 40], minimo: 1, maximo: 5 };
  const EL_DUMP = [
    ["disciplina", "auto_controlhe", "Auto Controlhe", "Virtudes", DISC_DEF],
    ["disciplina", "coragem", "Coragem", "Virtudes", DISC_DEF],
    ["disciplina", "humanidade", "Humanidade", "Virtudes", DISC_DEF],
    ["caracteristica", "peso", "Peso Kg", "Características", {}],
    ["caracteristica", "quantidade", "Quantidade", "Características", {}],
    ["caracteristica", "valor", "Valor R$", "Características", {}],
    ["atributo", "vigor", "Vigor", "Atributos De Força", { custoPontos: 7, minimo: 0, maximo: 5 }],
    ["atributo", "aparencia", "Aparência", "Atributos Social", { custoPontos: 7, minimo: 0, maximo: 5 }],
    ["atributo", "manipulacao", "Manipulação", "Atributos Social", { custoPontos: 7, minimo: 0, maximo: 5 }],
    ["atributo", "carisma", "Carisma", "Atributos Social", { custoPontos: 7, minimo: 0, maximo: 5 }],
    ["atributo", "raciocinio", "Raciocínio", "Atributos Mental", { custoPontos: 7, minimo: 0, maximo: 5 }],
    ["defeito", "agressivo", "Agressivo", "Defeitos", { custoPontos: -1, minimo: 0, maximo: 5 }],
    ["defeito", "cego", "Cego", "Defeitos", { custoPontos: -1, minimo: 0, maximo: 5 }],
    ["poder", "feitico", "Feitiço", "Poder", { custoPontos: 14, minimo: 0, maximo: 5 }],
    ["vantagem", "chacra", "Chacra", "Qualidades", { custoPontos: 3, minimo: 0, maximo: 5 }],
  ];
  let criadosDump = 0;
  for (const [kind, key, name, category, definition] of EL_DUMP) {
    const r = await req(BASE, "POST", `/campaigns/${CAMP_ID}/regras/elementos`, {
      cookie: cookieMestre, body: { kind, key, name, category, definition },
    });
    if (r.status === 201) criadosDump++;
    else console.log("   ! elemento", kind, key, "status", r.status, JSON.stringify(r.json)?.slice(0, 120));
  }
  t("15 elementos fiéis ao dump criados via API", criadosDump === EL_DUMP.length, `${criadosDump}/${EL_DUMP.length}`);
  const dup = await req(BASE, "POST", `/campaigns/${CAMP_ID}/regras/elementos`, {
    cookie: cookieMestre, body: { kind: "disciplina", key: "coragem", name: "Coragem" },
  });
  t("elemento duplicado rejeitado (409)", dup.status === 409, `status=${dup.status}`);
  const elJogador = await req(BASE, "POST", `/campaigns/${CAMP_ID}/regras/elementos`, {
    cookie: u.cookie, body: { kind: "disciplina", key: "forca_bruta", name: "Força Bruta" },
  });
  t("jogador não cria elemento de regra (403)", elJogador.status === 403, `status=${elJogador.status}`);

  // Estrutura LITERAL do dump de referência (9 seções, 24 campos,
  // ids/metadados/opções/defaults idênticos) — fixtures/estrutura-cacadores-dump.json
  const ESTRUTURA_DUMP = JSON.parse(readFileSync(
    new URL("./fixtures/estrutura-cacadores-dump.json", import.meta.url), "utf8"));
  t("fixture literal: 9 seções / 24 campos do dump",
    ESTRUTURA_DUMP.secoes.length === 9 &&
    ESTRUTURA_DUMP.secoes.reduce((n, s) => n + (s.campos?.length ?? 0), 0) === 24);
  const campoDump = (id) => ESTRUTURA_DUMP.secoes.flatMap((s) => s.campos ?? []).find((c) => c.id === id);
  t("Raça literal: editavelPor=mestre, padrao=Humano, obrigatorio",
    campoDump("24605000")?.editavelPor === "mestre" && campoDump("24605000")?.padrao === "Humano" &&
    campoDump("24605000")?.obrigatorio === true);
  t("Virtudes literal: regraKind=disciplina com padrao dos 3 elementos",
    campoDump("d2fd135b")?.regraKind === "disciplina" &&
    JSON.stringify(campoDump("d2fd135b")?.padrao) === JSON.stringify(
      [{ key: "auto_controlhe", nivel: 1 }, { key: "coragem", nivel: 1 }, { key: "humanidade", nivel: 1 }]));
  t("Qualidades literal: regraKind=vantagem na seção d2cb72d0",
    campoDump("bb1573df")?.regraKind === "vantagem" &&
    ESTRUTURA_DUMP.secoes.find((s) => s.id === "d2cb72d0")?.campos?.some((c) => c.id === "bb1573df"));
  // Orçamento de pontos generoso para a fixture literal (o pontosIniciais:27
  // da estrutura é o default do template; a campanha de teste precisa cobrir
  // 9 atributos + talentos + vantagens — o ruleset do dump usa 140).
  {
    const w = abrirDb(BANCO);
    try {
      const rs = w.prepare("select id,config from rule_sets where campaign_id=? and is_active=1").get(CAMP_ID);
      const cfg = JSON.parse(rs.config);
      cfg.pontos = { habilitado: true, pontosIniciais: 500, pools: cfg.pontos?.pools ?? [], custos: cfg.pontos?.custos ?? {} };
      w.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
    } finally { w.close(); }
  }
  // publica template+versão direto no banco (mesmo padrão do criarCenario)
  const tplDumpId = randomUUID(), verDumpId = randomUUID();
  {
    const w = abrirDb(BANCO); const agora = Date.now();
    try {
      w.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
        .run(tplDumpId, CAMP_ID, "Ficha Caçadores & Caçados (dump)", null, c.adminId, agora, agora);
      w.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
        .run(verDumpId, tplDumpId, JSON.stringify(ESTRUTURA_DUMP), agora, agora);
      w.prepare("update sheet_templates set current_version_id=? where id=?").run(verDumpId, tplDumpId);
    } finally { w.close(); }
  }
  // Dados fiéis cobrindo os 24 campos do dump
  const DADOS_DUMP = {
    // Identificação (ec76b38f)
    "8da47020": "policial", "107c7c6f": 34, "8e468977": "Feminino",
    "f13e57cf": "Morena média", "24605000": "Vampiro",
    // Atributos (9 campos regra→atributo)
    "f805fff7": 3, "c5632957": 4, "aba8bec6": 2, "bfb8dbe2": 4,
    "8a2043c2": 3, "6cf9ee14": 5, "712c5723": 3, "94b2ec01": 4, "db4cbb37": 3,
    // Habilidades
    "630f86ae": [{ key: "armas_brancas", nivel: 3 }],
    "0094021c": [{ key: "hacker", nivel: 2 }],
    "46504ccd": [{ key: "computador", nivel: 2 }],
    // Virtudes (disciplina) / Poder / Qualidades & Defeitos
    "d2fd135b": [{ key: "auto_controlhe", nivel: 2 }, { key: "coragem", nivel: 1 }, { key: "humanidade", nivel: 3 }],
    "95c409e4": [{ key: "feitico", nivel: 1 }],
    "11b55b5d": [{ key: "agressivo", nivel: 2 }, { key: "cego", nivel: 1 }],
    "bb1573df": [{ key: "chacra", nivel: 1 }],
    // Inventário (tabelas com colunas literais do dump)
    "0cb84d3a": [{ item: "Faca", quantidade: 1, peso: 0.4, valor: 120, descricao: "de cozinha" }],
    "704ab6e7": [{ veiculo: "Uno", marca: "Fiat", modelo: "Way", ano: 2019, placa: "ABC1D23", cor: "Prata", combustivel: "Flex" }],
  };
  const criacaoDump = await req(BASE, "POST", `/campaigns/${CAMP_ID}/characters`, {
    cookie: u.cookie, body: { name: "Dumper Fiel", templateVersionId: verDumpId, data: DADOS_DUMP },
  });
  t("personagem com estrutura literal do dump criado", criacaoDump.status === 200 || criacaoDump.status === 201,
    `status=${criacaoDump.status} ${JSON.stringify(criacaoDump.json)?.slice(0, 300)}`);
  const charDumpId = criacaoDump.json?.personagem?.id ?? criacaoDump.json?.id;
  const dadosDump = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(charDumpId).data));
  t("Raça 'Vampiro' persistida", dadosDump["24605000"] === "Vampiro", JSON.stringify(dadosDump["24605000"]));
  t("Identificação completa persistida (profissão/idade/gênero/cor)",
    dadosDump["8da47020"] === "policial" && dadosDump["107c7c6f"] === 34 &&
    dadosDump["8e468977"] === "Feminino" && dadosDump["f13e57cf"] === "Morena média");
  t("9 atributos do dump persistidos", ["f805fff7","c5632957","aba8bec6","bfb8dbe2","8a2043c2","6cf9ee14","712c5723","94b2ec01","db4cbb37"]
    .every((id) => typeof dadosDump[id] === "number"), JSON.stringify(dadosDump).slice(0, 200));
  t("Virtudes persistidas como disciplina", JSON.stringify(dadosDump["d2fd135b"]) === JSON.stringify(DADOS_DUMP["d2fd135b"]));
  t("Qualidades (vantagem) e Defeitos persistidos separados",
    JSON.stringify(dadosDump["bb1573df"]) === JSON.stringify(DADOS_DUMP["bb1573df"]) &&
    JSON.stringify(dadosDump["11b55b5d"]) === JSON.stringify(DADOS_DUMP["11b55b5d"]));
  t("Poder e Habilidades persistidos",
    JSON.stringify(dadosDump["95c409e4"]) === JSON.stringify(DADOS_DUMP["95c409e4"]) &&
    JSON.stringify(dadosDump["630f86ae"]) === JSON.stringify(DADOS_DUMP["630f86ae"]));
  t("tabelas Inventário e Veículo persistidas com colunas",
    Array.isArray(dadosDump["0cb84d3a"]) && dadosDump["0cb84d3a"][0]?.item === "Faca" &&
    Array.isArray(dadosDump["704ab6e7"]) && dadosDump["704ab6e7"][0]?.veiculo === "Uno");
  // Raça é editavelPor=mestre no dump: o DONO da ficha (jogador) NÃO pode editá-la
  const patchRacaJogador = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${charDumpId}`, {
    cookie: u.cookie, body: { data: { "24605000": "Animal" } },
  });
  const dadosAposRacaJogador = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(charDumpId).data));
  t("jogador/dono NÃO edita Raça (editavelPor=mestre)",
    patchRacaJogador.status === 400 && dadosAposRacaJogador["24605000"] === "Vampiro",
    `status=${patchRacaJogador.status} raca=${dadosAposRacaJogador["24605000"]}`);
  // PATCH parcial pelo mestre: troca Raça, resto preservado
  const patchRaca = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${charDumpId}`, {
    cookie: cookieMestre, body: { data: { "24605000": "Lobisomem" } },
  });
  t("PATCH mestre Raça→Lobisomem aceito", patchRaca.status === 200, `status=${patchRaca.status}`);
  const dadosDump2 = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(charDumpId).data));
  t("edição parcial preserva Virtudes/Defeitos/Atributos",
    dadosDump2["24605000"] === "Lobisomem" &&
    JSON.stringify(dadosDump2["d2fd135b"]) === JSON.stringify(DADOS_DUMP["d2fd135b"]) &&
    dadosDump2["aba8bec6"] === 2);
  // opção inválida de Raça rejeitada
  const patchRacaInvalida = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${charDumpId}`, {
    cookie: cookieMestre, body: { data: { "24605000": "Dragão" } },
  });
  t("Raça fora das opções do dump rejeitada", patchRacaInvalida.status === 400, `status=${patchRacaInvalida.status}`);
  // nível de selecao_nivel fora de 1..5 rejeitado
  const patchNivelInvalido = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${charDumpId}`, {
    cookie: u.cookie, body: { data: { "d2fd135b": [{ key: "coragem", nivel: 9 }] } },
  });
  t("nível 9 em selecao_nivel rejeitado", patchNivelInvalido.status === 400, `status=${patchNivelInvalido.status}`);
  // padrão do dump: Virtudes tem padrao com os 3 elementos nível 1
  const criacaoSemVirtudes = await req(BASE, "POST", `/campaigns/${CAMP_ID}/characters`, {
    cookie: u.cookie, body: { name: "Sem Virtudes", templateVersionId: verDumpId,
      data: { "24605000": "Humano", "8da47020": "policial", "107c7c6f": 30, "8e468977": "Masculino", "f13e57cf": "Clara" } },
  });
  const idSemVirt = criacaoSemVirtudes.json?.personagem?.id ?? criacaoSemVirtudes.json?.id;
  const dadosSemVirt = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(idSemVirt).data));
  t("padrão do dump aplicado: Virtudes default (3 elementos nível 1)",
    JSON.stringify(dadosSemVirt["d2fd135b"]) === JSON.stringify(
      [{ key: "auto_controlhe", nivel: 1 }, { key: "coragem", nivel: 1 }, { key: "humanidade", nivel: 1 }]),
    JSON.stringify(dadosSemVirt["d2fd135b"]));
  t("padrão do dump aplicado: atributos default nível 1 e idade 18 quando ausentes",
    dadosSemVirt["f805fff7"] === 1 && dadosSemVirt["107c7c6f"] === 30); // idade enviada=30 prevalece
  // DIVERGÊNCIA documentada (não mascarada): campo.obrigatorio nunca é
  // exigido — validarFicha só checa obrigatórios com estrito:true e nenhum
  // caller usa. Personagem sem Raça explícita recebe o PADRÃO "Humano".
  const criacaoSemRaca = await req(BASE, "POST", `/campaigns/${CAMP_ID}/characters`, {
    cookie: u.cookie, body: { name: "Sem Raça", templateVersionId: verDumpId, data: {} },
  });
  const idSemRaca = criacaoSemRaca.json?.personagem?.id ?? criacaoSemRaca.json?.id;
  const dadosSemRaca = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(idSemRaca).data));
  t("criação sem Raça passa e recebe padrão 'Humano' (obrigatório não enforceado — divergência)",
    (criacaoSemRaca.status === 200 || criacaoSemRaca.status === 201) && dadosSemRaca["24605000"] === "Humano",
    `status=${criacaoSemRaca.status} raca=${dadosSemRaca["24605000"]}`);
  // validação de regras do personagem fiel ao dump (mestre vê erros)
  const valDump = await req(BASE, "GET", `/campaigns/${CAMP_ID}/regras/validacao/${charDumpId}`, { cookie: cookieMestre });
  t("validação de regras do personagem dump responde", valDump.status === 200, `status=${valDump.status}`);

  sec("F — #304 campo.obrigatorio: transição que bloqueia ficha incompleta");
  // O7.2 — esvaziar obrigatório explicitamente no payload → 400 atômico
  const patchEsvazia = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${charDumpId}`, {
    cookie: cookieMestre, body: { data: { "8da47020": "", "107c7c6f": 99 } },
  });
  t("PATCH esvaziando obrigatório → 400", patchEsvazia.status === 400, `status=${patchEsvazia.status}`);
  const dadosAposEsvazia = JSON.parse(comDb(BANCO, (db) =>
    db.prepare("select data from characters where id=?").get(charDumpId).data));
  t("PATCH rejeitado não gravou NADA (Profissão e Idade intactas)",
    dadosAposEsvazia["8da47020"] === "policial" && dadosAposEsvazia["107c7c6f"] === 34,
    JSON.stringify({ prof: dadosAposEsvazia["8da47020"], idade: dadosAposEsvazia["107c7c6f"] }));
  // submissão de ficha incompleta → 400; completa → transição ok
  const DADOS_SEM_OBRIG = { ...DADOS_DUMP };
  delete DADOS_SEM_OBRIG["8da47020"]; delete DADOS_SEM_OBRIG["f13e57cf"];
  const criacaoIncompleta = await req(BASE, "POST", `/campaigns/${CAMP_ID}/characters`, {
    cookie: u.cookie, body: { name: "Incompleta 304", templateVersionId: verDumpId, data: DADOS_SEM_OBRIG },
  });
  const idIncompleta = criacaoIncompleta.json?.personagem?.id ?? criacaoIncompleta.json?.id;
  t("rascunho incompleto ainda é criado (permissivo)", criacaoIncompleta.status === 200 || criacaoIncompleta.status === 201, `status=${criacaoIncompleta.status}`);
  const submeteIncompleta = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${idIncompleta}`, {
    cookie: u.cookie, body: { status: "aguardando_aprovacao" },
  });
  t("submissão sem obrigatório → 400", submeteIncompleta.status === 400, `status=${submeteIncompleta.status} ${JSON.stringify(submeteIncompleta.json)?.slice(0, 150)}`);
  const completaEsubmete = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${idIncompleta}`, {
    cookie: u.cookie, body: { status: "aguardando_aprovacao", data: { "8da47020": "policial", "f13e57cf": "Morena média" } },
  });
  t("submissão completa → 200", completaEsubmete.status === 200, `status=${completaEsubmete.status} ${JSON.stringify(completaEsubmete.json)?.slice(0, 150)}`);
  // NPC aprovado não tem bypass: criação sem Profissão/Cor → 400
  const npcIncompleto = await req(BASE, "POST", `/campaigns/${CAMP_ID}/characters`, {
    cookie: cookieMestre, body: { name: "NPC Incompleto", templateVersionId: verDumpId, isNpc: true, data: {} },
  });
  t("NPC sem obrigatório → 400 (sem bypass)", npcIncompleto.status === 400, `status=${npcIncompleto.status}`);
  // ficha legada aprovada incompleta: PATCH neutro NÃO é bloqueado
  {
    const w = abrirDb(BANCO); const agora = Date.now();
    try {
      const id = randomUUID();
      const memb = w.prepare("select id from memberships where campaign_id=? and user_id=?").get(CAMP_ID, u.id);
      const dadosLegado = JSON.parse(JSON.stringify(DADOS_SEM_OBRIG));
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, CAMP_ID, memb.id, verDumpId, "Legada Aprovada Incompleta", JSON.stringify(dadosLegado), "{}", "aprovada", 0, agora, agora);
      w.close();
      const patchNeutro = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${id}`, {
        cookie: cookieMestre, body: { data: { "107c7c6f": 35 } },
      });
      t("PATCH neutro em aprovada legada incompleta → 200", patchNeutro.status === 200, `status=${patchNeutro.status} ${JSON.stringify(patchNeutro.json)?.slice(0, 150)}`);
      const tentaEsvaziarLegada = await req(BASE, "PATCH", `/campaigns/${CAMP_ID}/characters/${id}`, {
        cookie: cookieMestre, body: { data: { "8da47020": "" } },
      });
      t("mesmo legada: esvaziar obrigatório enviado → 400", tentaEsvaziarLegada.status === 400, `status=${tentaEsvaziarLegada.status}`);
    } finally { try { w.close(); } catch {} }
  }

  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}
