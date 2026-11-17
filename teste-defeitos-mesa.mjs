#!/usr/bin/env node
// Painel de defeitos da Mesa (GET /api/campaigns/:cid/defeitos) — suíte HTTP.
// Cobre: agregação por personagem a partir da ficha real (campo.regra e
// regraKind/selecao_nivel), nível atual + descrição do nível, maior nível
// quando o mesmo defeito aparece em mais de um campo, exclusão de
// chave inexistente / nível inválido / outros tipos (poder, vantagem,
// habilidade), NPC sinalizado, arquivado fora da lista, atualização após
// PATCH e autorização (somente mestre).
import { req, dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel, encerrarServidor, limparDir, criarCenario, abrirDb, sessao } from "./teste-base.mjs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { hashSenha } from "./servidor/dist/lib/password.js";

const DIR = dirTeste("defeitos-mesa");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;

function t(desc, ok, details = "") {
  if (ok) { console.log(`  ok ${desc}`); pass++; }
  else { console.log(`  FALHOU ${desc} ${details}`); fail++; }
}
const sec = (n) => console.log("\n== " + n + " ==");

async function defeitos(cid, cookie) {
  const r = await req(BASE, "GET", `/campaigns/${cid}/defeitos`, { cookie });
  return { status: r.status, json: r.json };
}
async function elemento(cid, cookie, kind, key, name, definition) {
  return req(BASE, "POST", `/campaigns/${cid}/regras/elementos`, { cookie, body: { kind, key, name, definition } });
}

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Defeitos",
    jogadores: { jogador1: "jog_d1", jogador2: "jog_d2" },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie;
  const J2 = c.jogadores.jogador2.cookie;

  // ---------- Biblioteca da campanha (equivalente ao que o livro aplica) ----------
  sec("Biblioteca de regras");
  await elemento(CID, M, "defeito", "cegueira", "Cegueira", {
    niveis: [
      { descricao: "Cegueira nv1 — visão turva", custo: 1 },
      { descricao: "Cegueira nv2 — visão mínima", custo: 2 },
      { descricao: "Cegueira nv3 — cegueira total", custo: 3 },
    ],
    disponivel: true,
  });
  await elemento(CID, M, "defeito", "fobia_social", "Fobia social", {
    niveis: [
      { descricao: "Fobia nv1 — desconforto", custo: 1 },
      { descricao: "Fobia nv2 — evitação", custo: 2 },
    ],
    disponivel: true,
  });
  await elemento(CID, M, "defeito", "gagueira", "Gagueira", {
    niveis: [
      { descricao: "Gagueira nv1 — hesitação", custo: 1 },
      { descricao: "Gagueira nv2 — fala travada", custo: 2 },
    ],
    disponivel: true,
  });
  // surdez via campo.regra (modo A): sem niveis graduados -> descrição geral
  await elemento(CID, M, "defeito", "surdez", "Surdez", {
    descricao: "Não ouve sons do ambiente",
    custoPontos: -1,
    disponivel: true,
  });
  // tremor sem níveis: fallback para descrição geral
  await elemento(CID, M, "defeito", "tremor", "Tremor nas mãos", {
    descricao: "As mãos tremem em tarefas finas",
    disponivel: true,
  });
  // tipos que NÃO podem aparecer no painel
  await elemento(CID, M, "poder", "foco", "Foco mental", { custoPontos: 2, disponivel: true });
  await elemento(CID, M, "vantagem", "sorte", "Sorte", { custoPontos: 1, disponivel: true });
  await elemento(CID, M, "habilidade", "furtividade", "Furtividade", { custoPontos: 1, disponivel: true });
  t("elementos criados", true);

  // ---------- Modelo de ficha com vínculos reais ----------
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Defeitos" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Personagem", ordem: 0, campos: [
        { id: "fd-defeitos", label: "Defeitos", tipo: "selecao_nivel", regraKind: "defeito" },
        { id: "fd-surdez", label: "Surdez", tipo: "inteiro", regra: { kind: "defeito", key: "surdez" } },
        { id: "fd-tremor", label: "Tremor", tipo: "inteiro", regra: { kind: "defeito", key: "tremor" } },
        { id: "fd-cegueira", label: "Cegueira direta", tipo: "inteiro", regra: { kind: "defeito", key: "cegueira" } },
        { id: "fd-poderes", label: "Poderes", tipo: "selecao_multipla", regraKind: "poder" },
        { id: "fd-vantagens", label: "Vantagens", tipo: "selecao_multipla", regraKind: "vantagem" },
        { id: "fd-habs", label: "Habilidades", tipo: "selecao_nivel", regraKind: "habilidade" },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });

  const novoChar = async (cookie, name, data, extra = {}) => {
    const r = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie, body: { name, templateVersionId: vid, data, ...extra },
    });
    return r.json?.personagem?.id ?? r.json?.id;
  };

  // ---------- Personagens ----------
  sec("Personagens e fichas");
  // Alpha (jogador1): cegueira nv2 + fobia nv1 via selecao_nivel; surdez nv1 via campo.regra
  const ALPHA = await novoChar(J1, "Alpha", {
    "fd-defeitos": [{ key: "cegueira", nivel: 2 }, { key: "fobia_social", nivel: 1 }],
    "fd-surdez": 1,
  });
  // Beta (jogador2): cegueira nv3 (máximo) + gagueira nv2 + poder/vantagem/habilidade (não podem aparecer)
  const BETA = await novoChar(J2, "Beta", {
    "fd-defeitos": [{ key: "cegueira", nivel: 3 }, { key: "gagueira", nivel: 2 }],
    "fd-poderes": ["foco"],
    "fd-vantagens": ["sorte"],
    "fd-habs": [{ key: "furtividade", nivel: 2 }],
  });
  // Vazio (jogador1): sem defeitos
  const VAZIO = await novoChar(J1, "Vazio", {});
  // Dup (jogador2): mesmo defeito em DOIS campos -> maior nível, sem duplicata
  const DUP = await novoChar(J2, "Duplicado", {
    "fd-defeitos": [{ key: "cegueira", nivel: 1 }],
    "fd-cegueira": 3,
  });
  // Legado (jogador2): dados inváligos que a validação atual rejeitaria
  // (chave inexistente + nível acima do máximo graduado) — inserido
  // direto no banco para simular ficha antiga/corrompida.
  const LEGADO = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    const agora = Date.now();
    w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(LEGADO, CID, c.jogadores.jogador2.membershipId, vid, "Legado",
        JSON.stringify({
          "fd-defeitos": [{ key: "fantasma", nivel: 2 }, { key: "gagueira", nivel: 9 }],
          "fd-surdez": 1,
        }),
        "{}", "aprovada", 0, agora, agora);
    w.close();
  }
  // NPC do mestre com defeito
  const NPC = await novoChar(M, "Bruto NPC", { "fd-defeitos": [{ key: "surdez", nivel: 1 }] }, { isNpc: true });
  t("personagens criados", !!(ALPHA && BETA && VAZIO && DUP && LEGADO && NPC), `${ALPHA} ${BETA} ${VAZIO} ${DUP} ${LEGADO} ${NPC}`);

  // ---------- Consulta mestre ----------
  sec("GET /defeitos — mestre");
  const r0 = await defeitos(CID, M);
  t("mestre recebe 200", r0.status === 200, `status=${r0.status} ${JSON.stringify(r0.json).slice(0, 200)}`);
  const lista = r0.json?.personagens ?? [];
  const porId = Object.fromEntries(lista.map((p) => [p.id, p]));

  const alpha = porId[ALPHA];
  t("Alpha listado", !!alpha);
  t("Alpha jogador = Jogador jogador1", alpha?.jogador === "Jogador jogador1", alpha?.jogador);
  t("Alpha tem 3 defeitos", alpha?.defeitos?.length === 3, JSON.stringify(alpha?.defeitos));
  const cegoA = alpha?.defeitos?.find((d) => d.key === "cegueira");
  t("Alpha cegueira nv2", cegoA?.nivel === 2, JSON.stringify(cegoA));
  t("Alpha cegueira descrição do nv2", cegoA?.descricao === "Cegueira nv2 — visão mínima", cegoA?.descricao);
  const fobiaA = alpha?.defeitos?.find((d) => d.key === "fobia_social");
  t("Alpha fobia nv1 + descrição nv1", fobiaA?.nivel === 1 && fobiaA?.descricao === "Fobia nv1 — desconforto", JSON.stringify(fobiaA));
  const surdezA = alpha?.defeitos?.find((d) => d.key === "surdez");
  t("Alpha surdez via campo.regra nv1 + descrição geral", surdezA?.nivel === 1 && surdezA?.descricao === "Não ouve sons do ambiente", JSON.stringify(surdezA));

  const beta = porId[BETA];
  t("Beta listado", !!beta, `ids: ${lista.map((p) => p.nome).join(",")}`);
  t("Beta tem 2 defeitos (poder/vantagem/habilidade fora)", beta?.defeitos?.length === 2, JSON.stringify(beta?.defeitos));
  const cegoB = beta?.defeitos?.find((d) => d.key === "cegueira");
  t("Beta cegueira nv3 (máximo) + descrição nv3", cegoB?.nivel === 3 && cegoB?.descricao === "Cegueira nv3 — cegueira total", JSON.stringify(cegoB));
  const gagueiraB = beta?.defeitos?.find((d) => d.key === "gagueira");
  t("Beta gagueira nv2", gagueiraB?.nivel === 2 && gagueiraB?.descricao === "Gagueira nv2 — fala travada", JSON.stringify(gagueiraB));
  t("Beta sem poder/vantagem/habilidade", !beta?.defeitos?.some((d) => ["foco", "sorte", "furtividade"].includes(d.key)));

  const legado = porId[LEGADO];
  t("Legado: chave inexistente não aparece", legado && !legado.defeitos.some((d) => d.key === "fantasma"), JSON.stringify(legado?.defeitos));
  t("Legado: nível inválido (9 > máx 2) não aparece", legado && !legado.defeitos.some((d) => d.key === "gagueira"), JSON.stringify(legado?.defeitos));
  t("Legado: surdez válida permanece", legado?.defeitos?.some((d) => d.key === "surdez" && d.nivel === 1), JSON.stringify(legado?.defeitos));

  const vazio = porId[VAZIO];
  t("Vazio listado com defeitos vazio", !!vazio && Array.isArray(vazio.defeitos) && vazio.defeitos.length === 0, JSON.stringify(vazio));

  const dup = porId[DUP];
  t("Duplicado: mesmo defeito em 2 campos = 1 entrada", dup?.defeitos?.length === 1, JSON.stringify(dup?.defeitos));
  t("Duplicado: nível agregado = maior (3) + descrição nv3", dup?.defeitos?.[0]?.nivel === 3 && dup?.defeitos?.[0]?.descricao === "Cegueira nv3 — cegueira total", JSON.stringify(dup?.defeitos));

  const npc = porId[NPC];
  t("NPC listado com ehNpc=true", npc?.ehNpc === true, JSON.stringify(npc));
  t("NPC tem surdez nv1", npc?.defeitos?.some((d) => d.key === "surdez" && d.nivel === 1));
  t("Alpha ehNpc=false", alpha?.ehNpc === false);

  // arquivado: criar + arquivar (somente mestre) personagem com defeito -> fora da lista
  const ARQ1 = await novoChar(J1, "Arquivado", { "fd-defeitos": [{ key: "cegueira", nivel: 1 }] });
  const arq = await req(BASE, "POST", `/characters/${ARQ1}/arquivar`, { cookie: M });
  t("arquivamento pelo mestre aceito", arq.status === 200, `status=${arq.status}`);
  const r1 = await defeitos(CID, M);
  t("personagem arquivado fora do painel", !(r1.json?.personagens ?? []).some((p) => p.id === ARQ1));

  // ---------- Atualização após alteração da ficha ----------
  sec("Atualização após PATCH");
  // sobe cegueira 2 -> 3 e remove fobia
  const patch1 = await req(BASE, "PATCH", `/characters/${ALPHA}`, {
    cookie: J1,
    body: { data: { "fd-defeitos": [{ key: "cegueira", nivel: 3 }] } },
  });
  t("PATCH do jogador aceito", patch1.status === 200, `status=${patch1.status} ${JSON.stringify(patch1.json).slice(0, 160)}`);
  const r2 = await defeitos(CID, M);
  const alpha2 = (r2.json?.personagens ?? []).find((p) => p.id === ALPHA);
  const cego2 = alpha2?.defeitos?.find((d) => d.key === "cegueira");
  t("painel reflete nível 3 após PATCH", cego2?.nivel === 3 && cego2?.descricao === "Cegueira nv3 — cegueira total", JSON.stringify(cego2));
  t("fobia removida some do painel", !alpha2?.defeitos?.some((d) => d.key === "fobia_social"), JSON.stringify(alpha2?.defeitos));
  // remove tudo
  await req(BASE, "PATCH", `/characters/${ALPHA}`, { cookie: J1, body: { data: { "fd-defeitos": [], "fd-surdez": 0 } } });
  const r3 = await defeitos(CID, M);
  const alpha3 = (r3.json?.personagens ?? []).find((p) => p.id === ALPHA);
  t("Alpha sem defeitos após esvaziar ficha", alpha3 && alpha3.defeitos.length === 0, JSON.stringify(alpha3?.defeitos));

  // nível acima do máximo graduado não aparece (Legado já cobre o caso
  // persistido; aqui valida que uma escrita válida não o introduz)

  // ---------- Autorização ----------
  sec("Autorização");
  const rj = await defeitos(CID, J1);
  t("jogador recebe 403", rj.status === 403, `status=${rj.status}`);
  const rj2 = await defeitos(CID, J2);
  t("outro jogador recebe 403", rj2.status === 403, `status=${rj2.status}`);
  const rSem = await defeitos(CID, null);
  t("sem cookie recebe 401", rSem.status === 401, `status=${rSem.status}`);
  // usuário sem membership na campanha
  const db = abrirDb(BANCO);
  const uidFora = crypto.randomUUID();
  const agora = Date.now();
  db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
    .run(uidFora, "fora_campanha", "Fora", await hashSenha("senha-x"), agora, agora);
  db.close();
  const cookieFora = sessao(BANCO, uidFora);
  const rFora = await defeitos(CID, cookieFora);
  t("não-membro recebe 403", rFora.status === 403, `status=${rFora.status}`);
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
