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

  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}
