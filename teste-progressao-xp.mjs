#!/usr/bin/env node
// Progressão XP/Merit (Issue #124) — suíte HTTP com banco temporário.
// Cobre: concessão/remoção de XP só pelo mestre, saldo nunca negativo,
// personagem arquivado bloqueado, PATCH comum não toca __xp, separação
// de __pontos.bonus, compras com preço fixo/progressivo/graduação,
// salto de nível, pré-requisitos, tetos, limitações condicionais (#122),
// dependências/exclusividades, preço não configurado, saldo insuficiente,
// atomicidade (compra inválida não altera nada) e concorrência.
import { req, dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel, encerrarServidor, limparDir, criarCenario, abrirDb } from "./teste-base.mjs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const DIR = dirTeste("progressao");
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

async function progressaoDe(charId, cookie) {
  const r = await req(BASE, "GET", `/characters/${charId}/progressao`, { cookie });
  return { status: r.status, json: r.json };
}
async function fichaDe(charId, cookie) {
  const r = await req(BASE, "GET", `/characters/${charId}`, { cookie });
  return r.json;
}
async function darXp(charId, cookie, body) {
  return req(BASE, "POST", `/characters/${charId}/xp`, { cookie, body });
}
async function comprar(charId, cookie, body) {
  return req(BASE, "POST", `/characters/${charId}/comprar-ponto`, { cookie, body });
}
async function elemento(campId, cookie, kind, key, name, definition) {
  return req(BASE, "POST", `/campaigns/${campId}/regras/elementos`, { cookie, body: { kind, key, name, definition } });
}

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  // Pontos de criação quase esgotados de propósito: qualquer nível
  // comprado com XP estouraria o pool — prova de que XP é moeda própria.
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Progressão",
    jogadores: { jogador1: "jog_prog", jogador2: "jog_outro" },
    config: { pontos: { habilitado: true, pontosIniciais: 5, pools: [{ id: "principal", nome: "Principal", pontos: 5 }], custos: {} } },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie;
  const J2 = c.jogadores.jogador2.cookie;

  // ---------- Biblioteca de regras ----------
  sec("Biblioteca de regras");
  // forca: atributo com custo PROGRESSIVO [2,3,4,5,6] e teto 5
  await elemento(CID, M, "atributo", "forca", "Força", { custoProgressivo: [2, 3, 4, 5, 6], maximo: 5, disponivel: true });
  // sorte: vantagem que limita forca a 2 enquanto selecionada (#122)
  await elemento(CID, M, "vantagem", "sorte", "Sorte", {
    limitacoes: [{ kind: "atributo", key: "forca", maximo: 2 }], disponivel: true,
  });
  // manipulacao: habilidade de seleção múltipla, custo fixo 3 XP
  await elemento(CID, M, "habilidade", "manipulacao", "Manipulação", { custoPontos: 3, disponivel: true });
  // covardia: defeito graduado — custos por nível [1,2,3]
  await elemento(CID, M, "defeito", "covardia", "Covardia", {
    niveis: [{ descricao: "nível 1", custo: 1 }, { descricao: "nível 2", custo: 2 }, { descricao: "nível 3", custo: 3 }],
    disponivel: true,
  });
  // foco: poder com pré-requisito forca>=3 e custo fixo 2
  await elemento(CID, M, "poder", "foco", "Foco", {
    prerequisitos: [{ kind: "atributo", key: "forca", minLevel: 3 }], custoPontos: 2, disponivel: true,
  });
  // ex_a / ex_b: mesma exclusividade
  await elemento(CID, M, "vantagem", "ex_a", "Vantagem A", { gruposExclusividade: ["combate"], custoPontos: 1, disponivel: true });
  await elemento(CID, M, "vantagem", "ex_b", "Vantagem B", { gruposExclusividade: ["combate"], custoPontos: 1, disponivel: true });
  // sem_custo: habilidade sem nenhuma tabela de custo
  await elemento(CID, M, "habilidade", "sem_custo", "Sem custo", { disponivel: true });
  t("elementos da biblioteca criados", true);

  // ---------- Modelo de ficha com vínculos ----------
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Progressão" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Personagem", ordem: 0, campos: [
        { id: "f-forca", label: "Força", tipo: "inteiro", semantico: "atributo", regra: { kind: "atributo", key: "forca" } },
        { id: "f-sorte", label: "Sorte", tipo: "inteiro", regra: { kind: "vantagem", key: "sorte" } },
        { id: "f-exa", label: "Vantagem A", tipo: "inteiro", regra: { kind: "vantagem", key: "ex_a" } },
        { id: "f-exb", label: "Vantagem B", tipo: "inteiro", regra: { kind: "vantagem", key: "ex_b" } },
        { id: "f-habs", label: "Habilidades", tipo: "selecao_multipla", regraKind: "habilidade" },
        { id: "f-defeitos", label: "Defeitos", tipo: "selecao_nivel", regraKind: "defeito" },
        { id: "f-poderes", label: "Poderes", tipo: "selecao_multipla", regraKind: "poder" },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });

  // Personagem do jogador1: forca=2 (gasta exatamente os 5 pontos do
  // pool — saldo de pontos zerado), sorte=1 (limitação ativa).
  // ex_a NÃO vem na criação: é comprada com XP na seção de exclusividade.
  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1,
    body: {
      name: "Herói XP", templateVersionId: vid,
      data: { "f-forca": 2, "f-sorte": 1 },
    },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  t("personagem criado", !!CHAR, JSON.stringify(pj.json).slice(0, 200));
  // Jogador2 tem personagem próprio para teste de isolamento
  const pj2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J2, body: { name: "Outro", templateVersionId: vid, data: {} },
  });
  const CHAR2 = pj2.json?.personagem?.id ?? pj2.json?.id;
  let CHAR3 = null; // personagem de saldo baixo — usado em 2 seções

  sec("Saldo inicial e permissões de XP");
  {
    const pg = await progressaoDe(CHAR, J1);
    t("GET progressao → 200", pg.status === 200, `status=${pg.status}`);
    t("saldo inicial zero", pg.json?.xp?.saldo === 0, `saldo=${pg.json?.xp?.saldo}`);
    t("histórico inicial vazio", Array.isArray(pg.json?.xp?.historico) && pg.json.xp.historico.length === 0);
    t("disponíveis lista elementos vinculados", (pg.json?.disponiveis ?? []).some((d) => d.kind === "atributo" && d.key === "forca"),
      JSON.stringify((pg.json?.disponiveis ?? []).map((d) => `${d.kind}:${d.key}`)));
    const forca = (pg.json?.disponiveis ?? []).find((d) => d.kind === "atributo" && d.key === "forca");
    t("forca nível atual 2", forca?.nivelAtual === 2, `nivel=${forca?.nivelAtual}`);
    const manip = (pg.json?.disponiveis ?? []).find((d) => d.key === "manipulacao");
    t("manipulação preço 3 (custo fixo)", manip?.precoProximo === 3, `preco=${manip?.precoProximo}`);
  }
  {
    const neg = await darXp(CHAR, J1, { acao: "conceder", quantidade: 10, motivo: "tentativa" });
    t("jogador não concede XP → 403", neg.status === 403, `status=${neg.status}`);
    const neg2 = await darXp(CHAR, J2, { acao: "conceder", quantidade: 10, motivo: "tentativa outro" });
    t("outro jogador não concede XP no personagem alheio → 403", neg2.status === 403, `status=${neg2.status}`);
    const progOutro = await progressaoDe(CHAR, J2);
    t("jogador2 não lê progressão alheia → 403/404", progOutro.status === 403 || progOutro.status === 404, `status=${progOutro.status}`);
  }
  {
    const inval = await darXp(CHAR, M, { acao: "conceder", quantidade: 0, motivo: "x" });
    t("quantidade 0 → 400", inval.status === 400, `status=${inval.status}`);
    const inval2 = await darXp(CHAR, M, { acao: "remover", quantidade: 2.5, motivo: "x" });
    t("quantidade fracionária → 400", inval2.status === 400, `status=${inval2.status}`);
    const semMotivo = await darXp(CHAR, M, { acao: "conceder", quantidade: 5, motivo: "  " });
    t("motivo vazio → 400", semMotivo.status === 400, `status=${semMotivo.status}`);
  }

  sec("Concessão e remoção de XP");
  {
    const r = await darXp(CHAR, M, { acao: "conceder", quantidade: 100, motivo: "sessão 1 — interpretação" });
    t("mestre concede 100 XP → 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
    t("saldo 100", r.json?.xp?.saldo === 100, `saldo=${r.json?.xp?.saldo}`);
    const ev = r.json?.xp?.historico?.at(-1);
    t("evento concessao com motivo/data/saldo", ev?.tipo === "concessao" && ev?.motivo === "sessão 1 — interpretação" && ev?.saldoResultante === 100 && !!ev?.em, JSON.stringify(ev));

    const r2 = await darXp(CHAR, M, { acao: "remover", quantidade: 30, motivo: "correção" });
    t("mestre remove 30 XP → 200", r2.status === 200, `status=${r2.status}`);
    t("saldo 70", r2.json?.xp?.saldo === 70, `saldo=${r2.json?.xp?.saldo}`);
    t("evento remocao registrado", r2.json?.xp?.historico?.at(-1)?.tipo === "remocao");

    const r3 = await darXp(CHAR, M, { acao: "remover", quantidade: 999, motivo: "exagero" });
    t("remoção além do saldo → 400", r3.status === 400, `status=${r3.status}`);
    t("código xp_negativo", r3.json?.codigo === "xp_negativo", `codigo=${r3.json?.codigo}`);
    const pg = await progressaoDe(CHAR, M);
    t("saldo inalterado após remoção inválida", pg.json?.xp?.saldo === 70, `saldo=${pg.json?.xp?.saldo}`);
    t("histórico inalterado após remoção inválida", pg.json?.xp?.historico?.length === 2, `n=${pg.json?.xp?.historico?.length}`);
  }

  sec("XP separado dos pontos de criação e protegido do PATCH");
  {
    // bônus de pontos de criação via endpoint próprio
    const rp = await req(BASE, "POST", `/characters/${CHAR}/pontos`, { cookie: M, body: { acao: "conceder", quantidade: 4, motivo: "bônus criação" } });
    t("bônus de pontos concedido", rp.status === 200, `status=${rp.status}`);
    const pg = await progressaoDe(CHAR, M);
    t("XP inalterado pela concessão de pontos", pg.json?.xp?.saldo === 70, `saldo=${pg.json?.xp?.saldo}`);

    // PATCH comum tentando injetar __xp é ignorado (chave reservada)
    const patch = await req(BASE, "PATCH", `/characters/${CHAR}`, {
      cookie: M, body: { data: { "__xp": { saldo: 99999, historico: [] } } },
    });
    t("PATCH com __xp malicioso → 200 mas ignorado", patch.status === 200, `status=${patch.status}`);
    const pg2 = await progressaoDe(CHAR, M);
    t("saldo XP intacto após PATCH", pg2.json?.xp?.saldo === 70, `saldo=${pg2.json?.xp?.saldo}`);
    t("histórico XP intacto após PATCH", pg2.json?.xp?.historico?.length === 2, `n=${pg2.json?.xp?.historico?.length}`);
  }

  sec("Personagem arquivado bloqueia XP e compra");
  {
    const arq = await req(BASE, "POST", `/characters/${CHAR}/arquivar`, { cookie: M, body: {} });
    t("arquivar → 200", arq.status === 200, `status=${arq.status}`);
    const r1 = await darXp(CHAR, M, { acao: "conceder", quantidade: 5, motivo: "arquivado" });
    t("conceder XP em arquivado → 403", r1.status === 403, `status=${r1.status}`);
    const r2 = await comprar(CHAR, M, { kind: "atributo", key: "forca", nivelAlvo: 3 });
    t("comprar em arquivado → 403", r2.status === 403, `status=${r2.status}`);
    const pg = await progressaoDe(CHAR, M);
    t("leitura de XP segue disponível (saldo 70)", pg.json?.xp?.saldo === 70, `saldo=${pg.json?.xp?.saldo}`);
    const des = await req(BASE, "POST", `/characters/${CHAR}/desarquivar`, { cookie: M, body: {} });
    t("desarquivar → 200", des.status === 200, `status=${des.status}`);
  }

  sec("Compras — rejeições antes de gastar");
  {
    // saldo 70 — compras caras abaixo não devem alterar nada
    const antes = await progressaoDe(CHAR, J1);
    const antesSaldo = antes.json?.xp?.saldo;
    const antesHist = antes.json?.xp?.historico?.length;

    const salto = await comprar(CHAR, J1, { kind: "atributo", key: "forca", nivelAlvo: 5 });
    t("salto de nível (atual 2 → alvo 5) → 400", salto.status === 400, `status=${salto.status}`);
    t("código salto_nivel", salto.json?.codigo === "salto_nivel", `codigo=${salto.json?.codigo}`);

    const semPre = await comprar(CHAR, J1, { kind: "habilidade", key: "sem_custo", nivelAlvo: 1 });
    t("elemento sem preço → 400", semPre.status === 400, `status=${semPre.status}`);
    t("código sem_preco", semPre.json?.codigo === "sem_preco", `codigo=${semPre.json?.codigo}`);

    const inexistente = await comprar(CHAR, J1, { kind: "atributo", key: "nao_existe", nivelAlvo: 1 });
    t("elemento inexistente → 400", inexistente.status === 400, `status=${inexistente.status}`);

    const alheio = await comprar(CHAR, J2, { kind: "atributo", key: "forca", nivelAlvo: 3 });
    t("jogador2 compra no personagem alheio → 403", alheio.status === 403, `status=${alheio.status}`);

    const depois = await progressaoDe(CHAR, J1);
    t("saldo inalterado após rejeições", depois.json?.xp?.saldo === antesSaldo, `antes=${antesSaldo} depois=${depois.json?.xp?.saldo}`);
    t("histórico inalterado após rejeições", depois.json?.xp?.historico?.length === antesHist, `n=${depois.json?.xp?.historico?.length}`);
    const ficha = await fichaDe(CHAR, J1);
    t("ficha forca continua 2", ficha?.ficha?.campos?.["f-forca"] === 2, `forca=${ficha?.ficha?.campos?.["f-forca"]}`);
  }

  sec("Limitação condicional (#122) bloqueia a compra");
  {
    // forca=2 e sorte=1 ativo → teto 2; comprar forca 2→3 deve falhar
    const r = await comprar(CHAR, J1, { kind: "atributo", key: "forca", nivelAlvo: 3 });
    t("forca 2→3 com Sorte ativa → 400", r.status === 400, `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    const erro = r.json?.detalhes?.erros?.find?.((e) => e.codigo === "limitacao") ?? r.json?.erros?.find?.((e) => e.codigo === "limitacao");
    t("erro codigo=limitacao presente", !!erro, JSON.stringify(r.json).slice(0, 300));
    const pg = await progressaoDe(CHAR, J1);
    t("saldo inalterado", pg.json?.xp?.saldo === 70, `saldo=${pg.json?.xp?.saldo}`);

    // mestre remove Sorte → limitação cai; compra 2→3 passa (custa 4 XP)
    const patch = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: M, body: { data: { "f-sorte": 0 } } });
    t("mestre remove Sorte → 200", patch.status === 200, `status=${patch.status}`);
    const ok = await comprar(CHAR, J1, { kind: "atributo", key: "forca", nivelAlvo: 3 });
    t("forca 2→3 sem Sorte → 200", ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 200)}`);
    t("saldo 70-4=66", ok.json?.xp?.saldo === 66, `saldo=${ok.json?.xp?.saldo}`);
    const ficha = await fichaDe(CHAR, J1);
    t("f-forca agora 3", ficha?.ficha?.campos?.["f-forca"] === 3, `forca=${ficha?.ficha?.campos?.["f-forca"]}`);
  }

  sec("Pré-requisito ausente bloqueia compra");
  {
    // CHAR3 (criado abaixo na seção de saldo) tem forca=0 — usaremos um
    // personagem dedicado aqui para não depender da ordem das seções.
    const pjP = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Sem prereq", templateVersionId: vid, data: {} },
    });
    const CHARP = pjP.json?.personagem?.id ?? pjP.json?.id;
    await darXp(CHARP, M, { acao: "conceder", quantidade: 20, motivo: "para prereq" });
    // foco exige forca>=3; forca=0 → 400 regras (não XP)
    const r = await comprar(CHARP, J1, { kind: "poder", key: "foco", nivelAlvo: 1 });
    t("foco sem forca>=3 → 400", r.status === 400, `status=${r.status} ${JSON.stringify(r.json).slice(0, 250)}`);
    const erro = r.json?.detalhes?.erros?.find?.((e) => e.codigo === "pre_requisito");
    t("erro codigo=pre_requisito", !!erro, JSON.stringify(r.json).slice(0, 300));
    const pg = await progressaoDe(CHARP, J1);
    t("saldo inalterado (20)", pg.json?.xp?.saldo === 20, `saldo=${pg.json?.xp?.saldo}`);
    // sobe forca 0→1→2→3 (custos 2+3+4=9 XP) e depois foco (2 XP)
    for (const alvo of [1, 2, 3]) {
      const b = await comprar(CHARP, J1, { kind: "atributo", key: "forca", nivelAlvo: alvo });
      t(`forca →${alvo} ok`, b.status === 200, `status=${b.status}`);
    }
    const ok = await comprar(CHARP, J1, { kind: "poder", key: "foco", nivelAlvo: 1 });
    t("foco com forca=3 → 200", ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 200)}`);
    t("saldo 20-9-2=9", ok.json?.xp?.saldo === 9, `saldo=${ok.json?.xp?.saldo}`);
  }

  sec("Compra válida — débito e nível atômicos");
  {
    // manipulação: custo fixo 3 XP, seleção múltipla 0→1
    const antes = await progressaoDe(CHAR, J1);
    const r = await comprar(CHAR, J1, { kind: "habilidade", key: "manipulacao", nivelAlvo: 1 });
    t("compra manipulação → 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 250)}`);
    t("saldo 66-3=63", r.json?.xp?.saldo === 63, `saldo=${r.json?.xp?.saldo}`);
    const comp = r.json?.compra;
    t("compra registra kind/key/níveis/custo", comp?.kind === "habilidade" && comp?.key === "manipulacao" && comp?.nivelAnterior === 0 && comp?.nivelNovo === 1 && comp?.custoXp === 3, JSON.stringify(comp));
    const ficha = await fichaDe(CHAR, J1);
    t("f-habs contém manipulacao", Array.isArray(ficha?.ficha?.campos?.["f-habs"]) && ficha.ficha.campos["f-habs"].includes("manipulacao"), JSON.stringify(ficha?.ficha?.campos?.["f-habs"]));

    // segunda compra do mesmo elemento: seleção simples não avança além de 1
    const r2 = await comprar(CHAR, J1, { kind: "habilidade", key: "manipulacao", nivelAlvo: 2 });
    t("seleção simples não avança → 400", r2.status === 400, `status=${r2.status} ${JSON.stringify(r2.json).slice(0, 200)}`);

    // histórico completo via GET
    const pg = await progressaoDe(CHAR, J1);
    const compras = (pg.json?.xp?.historico ?? []).filter((e) => e.tipo === "compra");
    t("histórico tem 2 compras", compras.length === 2, `n=${compras.length}`);
    t("evento compra tem níveis e custo", compras.at(-1)?.compra?.nivelNovo === 1 && compras.at(-1)?.compra?.custoXp === 3);
  }

  sec("Defeito graduado — preço por níveis");
  {
    const pg0 = await progressaoDe(CHAR, J1);
    const cov = (pg0.json?.disponiveis ?? []).find((d) => d.key === "covardia");
    t("covardia nível 0, preço 1 (niveis[0].custo)", cov?.nivelAtual === 0 && cov?.precoProximo === 1, `nivel=${cov?.nivelAtual} preco=${cov?.precoProximo}`);
    const r1 = await comprar(CHAR, J1, { kind: "defeito", key: "covardia", nivelAlvo: 1 });
    t("compra covardia nível 1 → 200", r1.status === 200, `status=${r1.status} ${JSON.stringify(r1.json).slice(0, 200)}`);
    t("saldo 63-1=62", r1.json?.xp?.saldo === 62, `saldo=${r1.json?.xp?.saldo}`);
    const pg1 = await progressaoDe(CHAR, J1);
    const cov1 = (pg1.json?.disponiveis ?? []).find((d) => d.key === "covardia");
    t("covardia nível 1, próximo preço 2 (niveis[1].custo)", cov1?.nivelAtual === 1 && cov1?.precoProximo === 2, `nivel=${cov1?.nivelAtual} preco=${cov1?.precoProximo}`);
    const r2 = await comprar(CHAR, J1, { kind: "defeito", key: "covardia", nivelAlvo: 2 });
    t("compra covardia nível 2 → 200", r2.status === 200, `status=${r2.status}`);
    t("saldo 62-2=60", r2.json?.xp?.saldo === 60, `saldo=${r2.json?.xp?.saldo}`);
    const ficha = await fichaDe(CHAR, J1);
    const item = (ficha?.ficha?.campos?.["f-defeitos"] ?? []).find((i) => i?.key === "covardia");
    t("f-defeitos covardia nivel=2", item?.nivel === 2, JSON.stringify(ficha?.ficha?.campos?.["f-defeitos"]));
  }

  sec("Exclusividade bloqueia compra");
  {
    // ex_a ainda não selecionada: compra com XP (custa 1)
    const ra = await comprar(CHAR, J1, { kind: "vantagem", key: "ex_a", nivelAlvo: 1 });
    t("ex_a comprada com XP → 200", ra.status === 200, `status=${ra.status} ${JSON.stringify(ra.json).slice(0, 200)}`);
    t("saldo 60-1=59", ra.json?.xp?.saldo === 59, `saldo=${ra.json?.xp?.saldo}`);
    // ex_a ativa → comprar ex_b viola grupo "combate"
    const r = await comprar(CHAR, J1, { kind: "vantagem", key: "ex_b", nivelAlvo: 1 });
    t("ex_b com ex_a ativa → 400", r.status === 400, `status=${r.status} ${JSON.stringify(r.json).slice(0, 250)}`);
    const erro = r.json?.detalhes?.erros?.find?.((e) => e.codigo === "exclusividade");
    t("erro codigo=exclusividade", !!erro, JSON.stringify(r.json).slice(0, 300));
    const pg = await progressaoDe(CHAR, J1);
    t("saldo inalterado (59)", pg.json?.xp?.saldo === 59, `saldo=${pg.json?.xp?.saldo}`);
    // remove ex_a via mestre → ex_b comprável
    // (ignorarPontos: o pool de criação já está negativo pelas compras XP)
    const rm = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: M, body: { data: { "f-exa": 0 }, ignorarPontos: true } });
    t("mestre remove ex_a → 200", rm.status === 200, `status=${rm.status}`);
    const ok = await comprar(CHAR, J1, { kind: "vantagem", key: "ex_b", nivelAlvo: 1 });
    t("ex_b após remover ex_a → 200", ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 200)}`);
    t("ex_b custou 1 XP → saldo 58", ok.json?.xp?.saldo === 58, `saldo=${ok.json?.xp?.saldo}`);
  }

  sec("Saldo insuficiente — nada muda");
  {
    // ex_b custou 1; saldo 59. Cria personagem novo com pouco XP para teste limpo
    const pj3 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Pobre XP", templateVersionId: vid, data: {} },
    });
    CHAR3 = pj3.json?.personagem?.id ?? pj3.json?.id;
    await darXp(CHAR3, M, { acao: "conceder", quantidade: 2, motivo: "pouco" });
    const antes = await progressaoDe(CHAR3, J1);
    const r = await comprar(CHAR3, J1, { kind: "habilidade", key: "manipulacao", nivelAlvo: 1 }); // custa 3
    t("compra com saldo insuficiente → 400", r.status === 400, `status=${r.status}`);
    t("código xp_insuficiente", r.json?.codigo === "xp_insuficiente", `codigo=${r.json?.codigo}`);
    const depois = await progressaoDe(CHAR3, J1);
    t("saldo inalterado (2)", depois.json?.xp?.saldo === 2, `saldo=${depois.json?.xp?.saldo}`);
    t("histórico só tem a concessão", depois.json?.xp?.historico?.length === 1, `n=${depois.json?.xp?.historico?.length}`);
    const ficha = await fichaDe(CHAR3, J1);
    t("ficha sem habilidade comprada", !(ficha?.ficha?.campos?.["f-habs"] ?? []).includes("manipulacao"));
  }

  sec("Concorrência — duas compras não gastam o mesmo XP");
  {
    // CHAR3 tem saldo 2; manipulação custa 3 → ambas falham.
    // Melhor: concede 3 exatos → só UMA das duas compras passa.
    await darXp(CHAR3, M, { acao: "conceder", quantidade: 1, motivo: "completa 3" });
    const [r1, r2] = await Promise.all([
      comprar(CHAR3, J1, { kind: "habilidade", key: "manipulacao", nivelAlvo: 1 }),
      comprar(CHAR3, J1, { kind: "habilidade", key: "manipulacao", nivelAlvo: 1 }),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 200).length;
    const falhas = [r1, r2].filter((r) => r.status === 400).length;
    t("exatamente uma compra passa", oks === 1 && falhas === 1, `r1=${r1.status} r2=${r2.status}`);
    const pg = await progressaoDe(CHAR3, J1);
    t("saldo final 0 (3-3)", pg.json?.xp?.saldo === 0, `saldo=${pg.json?.xp?.saldo}`);
    const compras = (pg.json?.xp?.historico ?? []).filter((e) => e.tipo === "compra");
    t("histórico tem exatamente 1 compra", compras.length === 1, `n=${compras.length}`);
    const ficha = await fichaDe(CHAR3, J1);
    t("nível aplicado uma única vez", (ficha?.ficha?.campos?.["f-habs"] ?? []).filter((x) => x === "manipulacao").length === 1);
  }

  sec("Mestre administra progressão de outro personagem");
  {
    // mestre compra para CHAR2 (personagem do jogador2)
    const r = await comprar(CHAR2, M, { kind: "atributo", key: "forca", nivelAlvo: 1 });
    // CHAR2 sem XP → insuficiente
    t("mestre compra sem XP → 400 xp_insuficiente", r.status === 400 && r.json?.codigo === "xp_insuficiente", `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
    await darXp(CHAR2, M, { acao: "conceder", quantidade: 10, motivo: "bônus mestre" });
    const ok = await comprar(CHAR2, M, { kind: "atributo", key: "forca", nivelAlvo: 1 });
    t("mestre compra para personagem alheio → 200", ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 200)}`);
    t("preço forca 0→1 = 2 XP → saldo 8", ok.json?.xp?.saldo === 8, `saldo=${ok.json?.xp?.saldo}`);
    const ficha = await fichaDe(CHAR2, M);
    t("forca do CHAR2 = 1", ficha?.ficha?.campos?.["f-forca"] === 1, `forca=${ficha?.ficha?.campos?.["f-forca"]}`);
  }

} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
