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
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";

const DIR = dirTeste("progressao");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
// Barreira determinística do contrato 409 (NODE_ENV=test no servidor):
// <dir>/armado faz o endpoint sinalizar <dir>/iniciado e aguardar
// <dir>/liberar entre a pré-carga das regras e a transação da compra.
const BARREIRA = join(DIR, "barreira-regras");
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
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS, env: { MESTRE_PROGRESSAO_BARRIER: BARREIRA } });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  // Pontos de criação quase esgotados de propósito: qualquer nível
  // comprado com XP estouraria o pool — prova de que XP é moeda própria.
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Progressão",
    jogadores: { jogador1: "jog_prog", jogador2: "jog_outro" },
    // pools vazio de propósito: desde que a pool Principal declarada
    // passou a SOMAR ao orçamento (PR #151), manter {principal,5} aqui
    // dobraria o saldo e quebraria as premissas de pool quase zerado.
    config: { pontos: { habilitado: true, pontosIniciais: 5, pools: [], custos: {} } },
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
    // (ignorarPontos: o pool de criação já está negativo pelas compras XP;
    //  baseUpdatedAt: f-exa é nível financiado por XP → contrato BUG_0002)
    const fxA = await fichaDe(CHAR, M);
    const rm = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: M, body: { data: { "f-exa": 0 }, ignorarPontos: true, baseUpdatedAt: fxA?.personagem?.updatedAt } });
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

  sec("Concorrência — regras alteradas na janela da compra → HTTP 409");
  {
    mkdirSync(BARREIRA, { recursive: true });
    const pj4 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Conflito", templateVersionId: vid, data: {} },
    });
    const CHAR4 = pj4.json?.personagem?.id ?? pj4.json?.id;
    await darXp(CHAR4, M, { acao: "conceder", quantidade: 30, motivo: "fundo de prova" });

    const esperarArquivo = async (caminho, timeoutMs = 10000) => {
      const limite = Date.now() + timeoutMs;
      while (Date.now() < limite) {
        if (existsSync(caminho)) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };
    // Compra com mutação de regras DENTRO da janela pré-carga→tx:
    // arma a barreira, dispara a compra, espera o "iniciado" do servidor,
    // grava a nova definição direto no banco (mesmo efeito de um escritor
    // fora do lease HTTP — restauração/importação) e libera.
    const COMPRA_409 = { erro: "As regras da campanha foram alteradas durante a compra. Atualize os dados e tente novamente.", codigo: "regras_alteradas", detalhes: { recurso: "regras_campanha", atualizarAntesDeTentar: true, compraEfetivada: false } };
    const gravarDefCovardia = (def) => {
      const w = abrirDb(BANCO);
      try {
        w.prepare("update rule_definitions set definition = ?, updated_at = ? where rule_set_id = (select id from rule_sets where campaign_id = ? and is_active = 1) and kind = 'defeito' and key = 'covardia'").run(JSON.stringify(def), Date.now(), CID);
      } finally { w.close(); }
    };
    const defBase = { niveis: [{ descricao: "n1", custo: 1 }, { descricao: "n2", custo: 2 }, { descricao: "n3", custo: 3 }], disponivel: true };
    const compraComMutacao = async (body, mutar) => {
      writeFileSync(join(BARREIRA, "armado"), "1");
      const p = comprar(CHAR4, J1, body);
      const iniciou = await esperarArquivo(join(BARREIRA, "iniciado"));
      if (!iniciou) { writeFileSync(join(BARREIRA, "liberar"), "1"); return { status: -1, json: null }; }
      mutar();
      writeFileSync(join(BARREIRA, "liberar"), "1");
      for (const f of ["armado", "iniciado", "liberar"]) rmSync(join(BARREIRA, f), { force: true });
      return p;
    };
    const conferirConflito = async (rotulo, antes) => {
      const pg = await progressaoDe(CHAR4, J1);
      t(`${rotulo}: saldo inalterado`, pg.json?.xp?.saldo === antes.saldo, `antes=${antes.saldo} depois=${pg.json?.xp?.saldo}`);
      t(`${rotulo}: histórico inalterado`, pg.json?.xp?.historico?.length === antes.hist, `antes=${antes.hist} depois=${pg.json?.xp?.historico?.length}`);
      const ficha = await fichaDe(CHAR4, J1);
      const itens = ficha?.ficha?.campos?.["f-defeitos"] ?? [];
      t(`${rotulo}: ficha inalterada`, JSON.stringify(itens) === JSON.stringify(antes.defeitos), JSON.stringify(itens));
      const w = abrirDb(BANCO);
      try {
        const n = w.prepare("select count(*) n from audit_logs where action = 'personagem.comprar_ponto' and json_extract(detail, '$.characterId') = ?").get(CHAR4)?.n ?? 0;
        t(`${rotulo}: sem auditoria de compra efetivada`, n === antes.auditorias, `auditorias=${n} esperadas=${antes.auditorias}`);
      } finally { w.close(); }
    };
    const auditoriasCompra = () => {
      const w = abrirDb(BANCO);
      try {
        return w.prepare("select count(*) n from audit_logs where action = 'personagem.comprar_ponto' and json_extract(detail, '$.characterId') = ?").get(CHAR4)?.n ?? 0;
      } finally { w.close(); }
    };
    const estadoAtual = async () => {
      const pg = await progressaoDe(CHAR4, J1);
      const ficha = await fichaDe(CHAR4, J1);
      return { saldo: pg.json?.xp?.saldo, hist: pg.json?.xp?.historico?.length, defeitos: ficha?.ficha?.campos?.["f-defeitos"] ?? [], auditorias: auditoriasCompra() };
    };
    const confere409 = (r, rotulo) => {
      t(`${rotulo}: HTTP 409`, r.status === 409, `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
      t(`${rotulo}: código regras_alteradas`, r.json?.codigo === "regras_alteradas", `codigo=${r.json?.codigo}`);
      t(`${rotulo}: corpo do contrato`, r.json?.erro === COMPRA_409.erro
        && r.json?.detalhes?.recurso === "regras_campanha"
        && r.json?.detalhes?.atualizarAntesDeTentar === true
        && r.json?.detalhes?.compraEfetivada === false,
        JSON.stringify(r.json));
    };

    // Rodada A — CUSTO alterado na janela: niveis[0].custo 1 → 5
    let antes = await estadoAtual();
    let r = await compraComMutacao({ kind: "defeito", key: "covardia", nivelAlvo: 1 }, () =>
      gravarDefCovardia({ ...defBase, niveis: [{ ...defBase.niveis[0], custo: 5 }, defBase.niveis[1], defBase.niveis[2]] }));
    confere409(r, "custo");
    await conferirConflito("custo", antes);
    // Nova tentativa usa a configuração VIGENTE: preço 5 (não 1)
    r = await comprar(CHAR4, J1, { kind: "defeito", key: "covardia", nivelAlvo: 1 });
    t("após conflito: compra usa preço vigente (5 XP)", r.status === 200 && r.json?.xp?.saldo === antes.saldo - 5, `status=${r.status} saldo=${r.json?.xp?.saldo}`);

    // Rodada B — PRÉ-REQUISITO alterado na janela
    antes = await estadoAtual();
    r = await compraComMutacao({ kind: "defeito", key: "covardia", nivelAlvo: 2 }, () =>
      gravarDefCovardia({ ...defBase, niveis: [{ ...defBase.niveis[0], custo: 5 }, defBase.niveis[1], defBase.niveis[2]], prerequisitos: [{ kind: "atributo", key: "forca", minLevel: 9 }] }));
    confere409(r, "pré-requisito");
    await conferirConflito("pré-requisito", antes);
    // Restaura a definição vigente (sem pré-requisito, custo[0]=5) e tenta de novo
    gravarDefCovardia({ ...defBase, niveis: [{ ...defBase.niveis[0], custo: 5 }, defBase.niveis[1], defBase.niveis[2]] });
    r = await comprar(CHAR4, J1, { kind: "defeito", key: "covardia", nivelAlvo: 2 });
    t("após pré-requisito: compra nível 2 → 200 @2 XP", r.status === 200 && r.json?.xp?.saldo === antes.saldo - 2, `status=${r.status} saldo=${r.json?.xp?.saldo}`);

    // Rodada C — LIMITAÇÃO CONDICIONAL alterada na janela (#122)
    antes = await estadoAtual();
    r = await compraComMutacao({ kind: "defeito", key: "covardia", nivelAlvo: 3 }, () =>
      gravarDefCovardia({ ...defBase, niveis: [{ ...defBase.niveis[0], custo: 5 }, defBase.niveis[1], defBase.niveis[2]], limitacoes: [{ kind: "atributo", key: "forca", maximo: 0 }] }));
    confere409(r, "limitação");
    await conferirConflito("limitação", antes);
    gravarDefCovardia({ ...defBase, niveis: [{ ...defBase.niveis[0], custo: 5 }, defBase.niveis[1], defBase.niveis[2]] });
    r = await comprar(CHAR4, J1, { kind: "defeito", key: "covardia", nivelAlvo: 3 });
    t("após limitação: compra nível 3 → 200 @3 XP", r.status === 200 && r.json?.xp?.saldo === antes.saldo - 3, `status=${r.status} saldo=${r.json?.xp?.saldo}`);

    // Estabilidade: compra normal com regras estáveis segue funcionando
    // (CHAR3: saldo 0 → concede 10 e compra forca 0→1 @2 XP da tabela)
    await darXp(CHAR3, M, { acao: "conceder", quantidade: 10, motivo: "estabilidade" });
    r = await comprar(CHAR3, J1, { kind: "atributo", key: "forca", nivelAlvo: 1 });
    t("regras estáveis: compra normal → 200 @2 XP", r.status === 200 && r.json?.xp?.saldo === 8, `status=${r.status} saldo=${r.json?.xp?.saldo}`);
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

  // ---------- Defeito A: compra respeita editabilidade do campo ----------
  let vidA; // template de autorização — reutilizado na prova de janela
  sec("Defeito A — compra exige campo editável (dentro da transação)");
  {
    // Elementos dedicados (vantagem, custo fixo 1 XP)
    await elemento(CID, M, "vantagem", "vis_editj", "Talento Jogador", { custoPontos: 1, disponivel: true });
    await elemento(CID, M, "vantagem", "vis_editm", "Segredo do Mestre", { custoPontos: 1, disponivel: true });
    await elemento(CID, M, "vantagem", "vis_ambos", "Talento Comum", { custoPontos: 1, disponivel: true });
    // Template dedicado: campos inteiros com vínculo direto + editavelPor
    const modA = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Autorização" } });
    const tidA = modA.json.modelo.id;
    vidA = modA.json.modelo.versionId;
    const estruturaA = {
      versao: 1,
      secoes: [{
        id: "s1", titulo: "Campos", ordem: 0, campos: [
          { id: "ca-editj", label: "Talento J", tipo: "inteiro", editavelPor: "jogador", visibilidade: "todos", custoPontos: 1, regra: { kind: "vantagem", key: "vis_editj" } },
          { id: "ca-editm", label: "Talento M", tipo: "inteiro", editavelPor: "mestre", visibilidade: "todos", custoPontos: 1, regra: { kind: "vantagem", key: "vis_editm" } },
          { id: "ca-ambos", label: "Talento A", tipo: "inteiro", editavelPor: "ambos", visibilidade: "todos", custoPontos: 1, regra: { kind: "vantagem", key: "vis_ambos" } },
        ],
      }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tidA}/versions/${vidA}`, { cookie: M, body: { estrutura: estruturaA } });
    await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tidA}/publish`, { cookie: M, body: { versionId: vidA } });
    const pjA = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Autorização", templateVersionId: vidA, data: {} },
    });
    const CHARA = pjA.json?.personagem?.id ?? pjA.json?.id;
    await darXp(CHARA, M, { acao: "conceder", quantidade: 50, motivo: "fundo A" });

    const compraOk = await comprar(CHARA, J1, { kind: "vantagem", key: "vis_editj", nivelAlvo: 1 });
    t("A1. campo editavelPor=jogador → compra permitida", compraOk.status === 200, `status=${compraOk.status} ${JSON.stringify(compraOk.json).slice(0, 200)}`);
    const saldoAposJ = compraOk.json?.xp?.saldo;

    const compraM = await comprar(CHARA, J1, { kind: "vantagem", key: "vis_editm", nivelAlvo: 1 });
    t("A2. campo editavelPor=mestre → jogador 403", compraM.status === 403, `status=${compraM.status} ${JSON.stringify(compraM.json).slice(0, 200)}`);
    t("A2b. código campo_nao_editavel", compraM.json?.codigo === "campo_nao_editavel", `codigo=${compraM.json?.codigo}`);
    const pgA = await progressaoDe(CHARA, J1);
    t("A3. sem débito após bloqueio", pgA.json?.xp?.saldo === saldoAposJ, `saldo=${pgA.json?.xp?.saldo}`);

    const compraAmbos = await comprar(CHARA, J1, { kind: "vantagem", key: "vis_ambos", nivelAlvo: 1 });
    t("A4. editavelPor=ambos → compra permitida", compraAmbos.status === 200, `status=${compraAmbos.status}`);

    // Overrides respeitados: template=mestre + override=jogador libera;
    // template=jogador + override=mestre bloqueia.
    const ov1 = await req(BASE, "PATCH", `/characters/${CHARA}`, { cookie: M, body: { overrides: { "ca-editm": { editavelPor: "jogador" } } } });
    t("A5. override mestre→jogador aplicado", ov1.status === 200, `status=${ov1.status}`);
    const compraOv = await comprar(CHARA, J1, { kind: "vantagem", key: "vis_editm", nivelAlvo: 1 });
    t("A6. override editavelPor=jogador → compra permitida", compraOv.status === 200, `status=${compraOv.status} ${JSON.stringify(compraOv.json).slice(0, 150)}`);
    const ov2 = await req(BASE, "PATCH", `/characters/${CHARA}`, { cookie: M, body: { overrides: { "ca-editj": { editavelPor: "mestre" } } } });
    t("A7. override jogador→mestre aplicado", ov2.status === 200, `status=${ov2.status}`);
    // vis_editj já está nível 1; próximo nível é 2 — mas o campo é inteiro
    // (modo nivel) e o elemento vantagem sem maximo → alvo 2 válido.
    const compraOv2 = await comprar(CHARA, J1, { kind: "vantagem", key: "vis_editj", nivelAlvo: 2 });
    t("A8. override editavelPor=mestre → jogador bloqueado", compraOv2.status === 403 && compraOv2.json?.codigo === "campo_nao_editavel", `status=${compraOv2.status}`);

    // Ficha aprovada/bloqueada: regra canônica campoEditavelPor barra
    // o não-mestre por status, mesmo com campo editável.
    const ap = await req(BASE, "PATCH", `/characters/${CHARA}`, { cookie: M, body: { status: "aprovada" } });
    t("A9. mestre aprova ficha → 200", ap.status === 200, `status=${ap.status} ${JSON.stringify(ap.json).slice(0, 150)}`);
    // desfaz override que bloquearia (ca-editj está mestre) — usa vis_ambos
    const compraAprov = await comprar(CHARA, J1, { kind: "vantagem", key: "vis_ambos", nivelAlvo: 2 });
    t("A10. ficha aprovada → jogador não compra", compraAprov.status === 403, `status=${compraAprov.status} ${JSON.stringify(compraAprov.json).slice(0, 200)}`);
    const compraAprovM = await comprar(CHARA, M, { kind: "vantagem", key: "vis_ambos", nivelAlvo: 2 });
    t("A11. ficha aprovada → mestre compra normalmente", compraAprovM.status === 200, `status=${compraAprovM.status} ${JSON.stringify(compraAprovM.json).slice(0, 150)}`);
    const back = await req(BASE, "PATCH", `/characters/${CHARA}`, { cookie: M, body: { status: "rascunho" } });
    t("A12. mestre devolve a rascunho", back.status === 200, `status=${back.status}`);
  }

  sec("Defeito A — overrides/status na janela pré-carga→transação não geram bypass");
  {
    mkdirSync(BARREIRA, { recursive: true });
    const pjB = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Janela", templateVersionId: vidA, data: {} },
    });
    const CHARB = pjB.json?.personagem?.id ?? pjB.json?.id;
    await darXp(CHARB, M, { acao: "conceder", quantidade: 30, motivo: "fundo B" });
    const esperarArquivo = async (caminho, timeoutMs = 10000) => {
      const limite = Date.now() + timeoutMs;
      while (Date.now() < limite) {
        if (existsSync(caminho)) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };
    // Janela: compra do jogador armada; dentro dela o override do campo
    // vira editavelPor=mestre DIRETO NO BANCO (efeito de restauração/
    // importação — fora do PATCH). A tx deve reler overrides frescos.
    writeFileSync(join(BARREIRA, "armado"), "1");
    const compraJanela = comprar(CHARB, J1, { kind: "vantagem", key: "vis_ambos", nivelAlvo: 1 });
    const iniciou = await esperarArquivo(join(BARREIRA, "iniciado"));
    if (iniciou) {
      const w = abrirDb(BANCO);
      try {
        w.prepare("update characters set overrides = ? where id = ?")
          .run(JSON.stringify({ "ca-ambos": { editavelPor: "mestre" } }), CHARB);
      } finally { w.close(); }
    }
    writeFileSync(join(BARREIRA, "liberar"), "1");
    for (const f of ["armado", "iniciado", "liberar"]) rmSync(join(BARREIRA, f), { force: true });
    const r = await compraJanela;
    t("B1. override mutado na janela → compra bloqueada", r.status === 403 && r.json?.codigo === "campo_nao_editavel", `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    const pgB = await progressaoDe(CHARB, J1);
    t("B2. saldo intacto após bypass tentado", pgB.json?.xp?.saldo === 30, `saldo=${pgB.json?.xp?.saldo}`);
    // E o mestre segue podendo comprar no mesmo campo (política preservada)
    const compraM2 = await comprar(CHARB, M, { kind: "vantagem", key: "vis_ambos", nivelAlvo: 1 });
    t("B3. mestre compra no campo restrito → 200", compraM2.status === 200, `status=${compraM2.status}`);
  }

  // ---------- Defeito B: GET não revela campos ocultos ----------
  sec("Defeito B — GET progressao filtra por visibilidade do campo");
  {
    await elemento(CID, M, "vantagem", "vis_pub", "Recurso Público", { custoPontos: 1, disponivel: true });
    await elemento(CID, M, "vantagem", "vis_sec", "Segredo de Mestre XP", { custoPontos: 1, disponivel: true });
    const modB = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Visibilidade" } });
    const tidB = modB.json.modelo.id, vidB = modB.json.modelo.versionId;
    const estruturaB = {
      versao: 1,
      secoes: [{
        id: "s1", titulo: "Campos", ordem: 0, campos: [
          { id: "cv-pub", label: "Recurso P", tipo: "inteiro", visibilidade: "todos", custoPontos: 1, regra: { kind: "vantagem", key: "vis_pub" } },
          { id: "cv-sec", label: "Segredo", tipo: "inteiro", visibilidade: "mestre", custoPontos: 1, regra: { kind: "vantagem", key: "vis_sec" } },
        ],
      }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tidB}/versions/${vidB}`, { cookie: M, body: { estrutura: estruturaB } });
    await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tidB}/publish`, { cookie: M, body: { versionId: vidB } });
    const pjC = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Visibilidade", templateVersionId: vidB, data: {} },
    });
    const CHARC = pjC.json?.personagem?.id ?? pjC.json?.id;
    await darXp(CHARC, M, { acao: "conceder", quantidade: 20, motivo: "fundo C" });
    // Mestre compra o elemento do campo oculto → gera evento de compra
    const compraSec = await comprar(CHARC, M, { kind: "vantagem", key: "vis_sec", nivelAlvo: 1 });
    t("B4. mestre compra elemento de campo oculto → 200", compraSec.status === 200, `status=${compraSec.status}`);

    // Mestre: visão completa
    const pgM = await progressaoDe(CHARC, M);
    const dispM = pgM.json?.disponiveis ?? [];
    t("B5. mestre vê vis_pub e vis_sec", dispM.some((d) => d.key === "vis_pub") && dispM.some((d) => d.key === "vis_sec"));
    const compraMHist = (pgM.json?.xp?.historico ?? []).find((e) => e.tipo === "compra");
    t("B6. mestre vê detalhes da compra (campoId cv-sec)", compraMHist?.compra?.campoId === "cv-sec" && compraMHist?.compra?.key === "vis_sec", JSON.stringify(compraMHist?.compra));

    // Jogador: campo visível aparece; oculto some por completo
    const pgJ = await progressaoDe(CHARC, J1);
    const dispJ = pgJ.json?.disponiveis ?? [];
    t("B7. jogador vê vis_pub", dispJ.some((d) => d.key === "vis_pub"));
    t("B8. jogador NÃO vê vis_sec", !dispJ.some((d) => d.key === "vis_sec"), JSON.stringify(dispJ.map((d) => d.key)));
    const corpoJ = JSON.stringify(pgJ.json);
    t("B9. resposta do jogador não vaza key/nome/campoId ocultos", !corpoJ.includes("vis_sec") && !corpoJ.includes("Segredo de Mestre XP") && !corpoJ.includes("cv-sec"), corpoJ.slice(0, 300));
    // Histórico mascarado: evento permanece, detalhes somem
    const histJ = (pgJ.json?.xp?.historico ?? []).filter((e) => e.tipo === "compra");
    t("B10. histórico do jogador mantém o evento de XP", histJ.length === 1, `n=${histJ.length}`);
    t("B11. compra mascarada (sem objeto compra)", histJ[0] && histJ[0].compra === undefined, JSON.stringify(histJ[0]));
    t("B12. motivo sanitizado", histJ[0]?.motivo === "Compra de nível", `motivo=${histJ[0]?.motivo}`);
    t("B13. histórico não vaza nome/key/campoId", !corpoJ.includes("vis_sec") && !corpoJ.includes("Segredo de Mestre XP") && !corpoJ.includes("cv-sec"));

    // Override de visibilidade respeitado nos dois sentidos
    const ovVis = await req(BASE, "PATCH", `/characters/${CHARC}`, { cookie: M, body: { overrides: { "cv-sec": { visibilidade: "todos" } } } });
    t("B14. override visibilidade mestre→todos aplicado", ovVis.status === 200, `status=${ovVis.status}`);
    const pgJ2 = await progressaoDe(CHARC, J1);
    t("B15. override torna vis_sec visível ao jogador", (pgJ2.json?.disponiveis ?? []).some((d) => d.key === "vis_sec"));
    const histJ2 = (pgJ2.json?.xp?.historico ?? []).find((e) => e.tipo === "compra");
    t("B16. histórico revela compra após override", histJ2?.compra?.campoId === "cv-sec", JSON.stringify(histJ2?.compra));
    const ovVis2 = await req(BASE, "PATCH", `/characters/${CHARC}`, { cookie: M, body: { overrides: { "cv-sec": { visibilidade: "mestre" } } } });
    t("B17. override de volta p/ mestre", ovVis2.status === 200, `status=${ovVis2.status}`);
    const pgJ3 = await progressaoDe(CHARC, J1);
    t("B18. vis_sec volta a ficar oculto", !(pgJ3.json?.disponiveis ?? []).some((d) => d.key === "vis_sec"));
  }

  // ---------- BUG_0001/0002: origem XP persistente + PATCH ----------
  let vidX; // template "Ficha Origem XP" — reutilizado nas seções Y/Z
  sec("BUG_0001/0002 — nível financiado por XP e PATCH com snapshot");
  {
    // Elementos e template dedicados: pool de pontos PEQUENO de
    // propósito — nível comprado com XP não pode estourar a criação.
    await elemento(CID, M, "atributo", "xp_nivel", "Nível XP", { disponivel: true });
    await elemento(CID, M, "atributo", "xp_max", "Teto XP", { disponivel: true });
    await elemento(CID, M, "habilidade", "xp_meio", "Custo Meio", { custoPontos: 0.5, disponivel: true });
    await elemento(CID, M, "habilidade", "xp_dois", "Custo Dois e Meio", { custoPontos: 2.5, disponivel: true });
    await elemento(CID, M, "disciplina", "xp_const", "Fórmula Constante", { formulas: { custo: "5" }, disponivel: true });
    await elemento(CID, M, "defeito", "xp_grad", "Graduado XP", {
      niveis: [{ descricao: "g1", custo: 1 }, { descricao: "g2", custo: 1 }], disponivel: true,
    });
    const modX = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Origem XP" } });
    const tidX = modX.json.modelo.id;
    vidX = modX.json.modelo.versionId;
    const estruturaX = {
      versao: 1,
      secoes: [{
        id: "s1", titulo: "Campos", ordem: 0, campos: [
          // custoPontos 2: pool da campanha é 5 — criação em 2 já gasta
          // 4; se o nível XP fosse cobrado de novo (3 níveis = 6) estoura.
          { id: "cx-nivel", label: "Nível", tipo: "inteiro", editavelPor: "ambos", visibilidade: "todos", custoPontos: 2, regra: { kind: "atributo", key: "xp_nivel" } },
          { id: "cx-nota", label: "Nota", tipo: "texto", editavelPor: "ambos", visibilidade: "todos" },
          { id: "cx-max", label: "Teto", tipo: "inteiro", editavelPor: "ambos", visibilidade: "todos", custoPontos: 1, maximo: 2, regra: { kind: "atributo", key: "xp_max" } },
          { id: "cx-habs", label: "Habs XP", tipo: "selecao_multipla", editavelPor: "ambos", visibilidade: "todos", regraKind: "habilidade" },
          { id: "cx-sele", label: "Sele XP", tipo: "selecao_nivel", editavelPor: "ambos", visibilidade: "todos", regraKind: "disciplina" },
          { id: "cx-grad", label: "Grad XP", tipo: "selecao_nivel", editavelPor: "ambos", visibilidade: "todos", regraKind: "defeito" },
        ],
      }],
      pontos: { habilitado: true, pontosIniciais: 2, pools: [], custos: {} },
    };
    await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tidX}/versions/${vidX}`, { cookie: M, body: { estrutura: estruturaX } });
    await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tidX}/publish`, { cookie: M, body: { versionId: vidX } });
    const pjX = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Origem XP", templateVersionId: vidX, data: { "cx-nivel": 2 } },
    });
    const CHX = pjX.json?.personagem?.id ?? pjX.json?.id;
    t("X0. personagem origem criado", !!CHX, JSON.stringify(pjX.json).slice(0, 150));
    await darXp(CHX, M, { acao: "conceder", quantidade: 60, motivo: "fundo X" });

    // BUG_0001: compra XP sobe cx-nivel 2→3; o nível pago NÃO pode
    // ser cobrado de novo no orçamento de pontos de criação.
    const compX = await comprar(CHX, J1, { kind: "atributo", key: "xp_nivel", nivelAlvo: 3 });
    t("X1. compra xp_nivel 2→3 → 200", compX.status === 200, `status=${compX.status} ${JSON.stringify(compX.json).slice(0, 200)}`);
    // PATCH sem dados (só status) revalida pontos: sem a correção o
    // nível XP seria cobrado (3 > pool 2) → 400.
    const patchStatus = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: M, body: { status: "rascunho" } });
    t("X2. PATCH status após compra XP → 200 (pontos não cobram nível XP)", patchStatus.status === 200, `status=${patchStatus.status} ${JSON.stringify(patchStatus.json).slice(0, 200)}`);

    // Redução reconcilia: 3→2 consome o nível financiado por XP.
    const fx1 = await fichaDe(CHX, M);
    const u1 = fx1?.personagem?.updatedAt;
    const red = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: M, body: { data: { "cx-nivel": 2 }, baseUpdatedAt: u1 } });
    t("X3. redução 3→2 com base atual → 200", red.status === 200, `status=${red.status} ${JSON.stringify(red.json).slice(0, 200)}`);
    // Subir de volta por PATCH agora é financiamento de CRIAÇÃO:
    // 3 níveis > pool 2 → rejeitado (XP não virou ponto livre).
    const fx2 = await fichaDe(CHX, M);
    const sobe = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: M, body: { data: { "cx-nivel": 3 }, baseUpdatedAt: fx2?.personagem?.updatedAt } });
    t("X4. subir por PATCH estoura pool → 400 (sem ponto artificial)", sobe.status === 400, `status=${sobe.status}`);

    // BUG_0002: snapshot antigo não reverte nível pago.
    // Jogador carrega ficha (nível 2), mestre compra →3, jogador salva
    // o valor antigo → 409 e o nível permanece.
    const snap = await fichaDe(CHX, J1);
    const uSnap = snap?.personagem?.updatedAt;
    const compX2 = await comprar(CHX, M, { kind: "atributo", key: "xp_nivel", nivelAlvo: 3 });
    t("X5. mestre compra xp_nivel 2→3 → 200", compX2.status === 200, `status=${compX2.status}`);
    const patchVelho = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: J1, body: { data: { "cx-nivel": 2 }, baseUpdatedAt: uSnap } });
    t("X6. PATCH com base desatualizada → 409", patchVelho.status === 409, `status=${patchVelho.status} ${JSON.stringify(patchVelho.json).slice(0, 200)}`);
    const patchSemToken = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: J1, body: { data: { "cx-nivel": 2 } } });
    t("X7. PATCH sem token em campo financiado → 409", patchSemToken.status === 409, `status=${patchSemToken.status}`);
    const pgX = await progressaoDe(CHX, J1);
    const nivX = (pgX.json?.disponiveis ?? []).find((d) => d.key === "xp_nivel");
    t("X8. nível pago preservado após tentativas de reversão", nivX?.nivelAtual === 3, `nivel=${nivX?.nivelAtual}`);
    // Base atual + valor coerente → permitido e reconcilia financiado.
    const fx3 = await fichaDe(CHX, J1);
    const patchBom = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: J1, body: { data: { "cx-nivel": 2 }, baseUpdatedAt: fx3?.personagem?.updatedAt } });
    t("X9. PATCH com base atual reduz nível → 200", patchBom.status === 200, `status=${patchBom.status} ${JSON.stringify(patchBom.json).slice(0, 200)}`);
    const pgX2 = await progressaoDe(CHX, J1);
    const nivX2 = (pgX2.json?.disponiveis ?? []).find((d) => d.key === "xp_nivel");
    t("X10. nível reconciliado para 2", nivX2?.nivelAtual === 2, `nivel=${nivX2?.nivelAtual}`);
    // PATCH narrativo (não toca campo financiado) não exige token e
    // preserva o estado — compra seguida de edição comum.
    const patchNarr = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: J1, body: { data: { "cx-nota": "capítulo 1" } } });
    t("X11. PATCH narrativo → 200 sem token", patchNarr.status === 200, `status=${patchNarr.status}`);
    const pgX3 = await progressaoDe(CHX, J1);
    const nivX3 = (pgX3.json?.disponiveis ?? []).find((d) => d.key === "xp_nivel");
    t("X12. nível XP preservado após PATCH narrativo", nivX3?.nivelAtual === 2, `nivel=${nivX3?.nivelAtual}`);
    // Salvar e aprovar preserva compra.
    const aprov = await req(BASE, "PATCH", `/characters/${CHX}`, { cookie: M, body: { status: "aprovada" } });
    t("X13. aprovação após compra XP → 200", aprov.status === 200, `status=${aprov.status} ${JSON.stringify(aprov.json).slice(0, 150)}`);
    const pgX4 = await progressaoDe(CHX, M);
    const nivX4 = (pgX4.json?.disponiveis ?? []).find((d) => d.key === "xp_nivel");
    t("X14. nível XP preservado após aprovação", nivX4?.nivelAtual === 2, `nivel=${nivX4?.nivelAtual}`);
  }

  // ---------- BUG_0003: tetos estruturais na compra ----------
  sec("BUG_0003 — compra nunca excede máximo do campo/seleção");
  {
    const pjY = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J2, body: { name: "Herói Tetos", templateVersionId: vidX, data: {} },
    });
    const CHY = pjY.json?.personagem?.id ?? pjY.json?.id;
    await darXp(CHY, M, { acao: "conceder", quantidade: 60, motivo: "fundo Y" });
    // campo.maximo = 2 → alvo 3 rejeitado
    const c1 = await comprar(CHY, J2, { kind: "atributo", key: "xp_max", nivelAlvo: 1 });
    const c2 = await comprar(CHY, J2, { kind: "atributo", key: "xp_max", nivelAlvo: 2 });
    const c3 = await comprar(CHY, J2, { kind: "atributo", key: "xp_max", nivelAlvo: 3 });
    t("Y1. compras até o máximo → 200", c1.status === 200 && c2.status === 200, `c1=${c1.status} c2=${c2.status}`);
    t("Y2. acima de campo.maximo → 400", c3.status === 400 && c3.json?.codigo === "maximo_campo", `status=${c3.status} codigo=${c3.json?.codigo} ${JSON.stringify(c3.json).slice(0, 200)}`);
    // Seleção graduada: xp_grad tem 2 níveis → alvo 3 rejeitado
    const g1 = await comprar(CHY, J2, { kind: "defeito", key: "xp_grad", nivelAlvo: 1 });
    const g2 = await comprar(CHY, J2, { kind: "defeito", key: "xp_grad", nivelAlvo: 2 });
    const g3 = await comprar(CHY, J2, { kind: "defeito", key: "xp_grad", nivelAlvo: 3 });
    t("Y3. seleção graduada até o limite → 200", g1.status === 200 && g2.status === 200, `g1=${g1.status} g2=${g2.status} ${JSON.stringify(g2.json).slice(0, 150)}`);
    t("Y4. acima do limite de seleção → 400", g3.status === 400 && g3.json?.codigo === "maximo_selecao", `status=${g3.status} codigo=${g3.json?.codigo}`);
    // covardia (3 níveis) no template principal: alvo além de 3 rejeitado
    await darXp(CHAR, M, { acao: "conceder", quantidade: 50, motivo: "fundo tetos" });
    const cvOk = await comprar(CHAR, J1, { kind: "defeito", key: "covardia", nivelAlvo: 3 });
    t("Y5a. covardia nível 3 → 200", cvOk.status === 200, `status=${cvOk.status} ${JSON.stringify(cvOk.json).slice(0, 150)}`);
    const cv = await comprar(CHAR, J1, { kind: "defeito", key: "covardia", nivelAlvo: 4 });
    t("Y5. covardia acima de 3 níveis → 400", cv.status === 400 && cv.json?.codigo === "maximo_selecao", `status=${cv.status} codigo=${cv.json?.codigo}`);
  }

  // ---------- BUG_0004/0005: frações e fórmula constante ----------
  sec("BUG_0004/0005 — custos fracionários e primeira aquisição");
  {
    const pjZ = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Frações", templateVersionId: vidX, data: {} },
    });
    const CHZ = pjZ.json?.personagem?.id ?? pjZ.json?.id;
    await darXp(CHZ, M, { acao: "conceder", quantidade: 20, motivo: "fundo Z" });
    // 0.5 e 2.5 debitados EXATAMENTE — sem truncamento
    const f1 = await comprar(CHZ, J1, { kind: "habilidade", key: "xp_meio", nivelAlvo: 1 });
    t("Z1. custo 0.5 → 200", f1.status === 200, `status=${f1.status} ${JSON.stringify(f1.json).slice(0, 200)}`);
    t("Z2. saldo 20−0.5=19.5 exato", f1.json?.xp?.saldo === 19.5, `saldo=${f1.json?.xp?.saldo}`);
    const pgZ1 = await progressaoDe(CHZ, J1);
    const ev1 = (pgZ1.json?.xp?.historico ?? []).find((e) => e.tipo === "compra" && e.compra?.key === "xp_meio");
    t("Z3. histórico registra −0.5", ev1?.quantidade === -0.5, `qtd=${ev1?.quantidade}`);
    const f2 = await comprar(CHZ, J1, { kind: "habilidade", key: "xp_dois", nivelAlvo: 1 });
    t("Z4. custo 2.5 → 200", f2.status === 200, `status=${f2.status}`);
    // P2: seleção binária adquirida (nível 1) NÃO pode sumir do GET —
    // não existe "próximo nível" para escolherVinculo(nivelAtual+1).
    const pgBin = await progressaoDe(CHZ, J1);
    const binEl = (pgBin.json?.disponiveis ?? []).find((d) => d.key === "xp_meio");
    t("P2. seleção binária nv.1 permanece no GET", binEl?.nivelAtual === 1, `el=${JSON.stringify(binEl)}`);
    t("Z5. saldo 19.5−2.5=17 exato", f2.json?.xp?.saldo === 17, `saldo=${f2.json?.xp?.saldo}`);
    const pgZ2 = await progressaoDe(CHZ, J1);
    const ev2 = (pgZ2.json?.xp?.historico ?? []).find((e) => e.tipo === "compra" && e.compra?.key === "xp_dois");
    t("Z6. histórico registra −2.5", ev2?.quantidade === -2.5, `qtd=${ev2?.quantidade}`);

    // BUG_0005: fórmula constante "5" — 1ª aquisição custa 5 (não 0).
    const k1 = await comprar(CHZ, J1, { kind: "disciplina", key: "xp_const", nivelAlvo: 1 });
    t("Z7. 1ª aquisição c/ fórmula constante → 200", k1.status === 200, `status=${k1.status} ${JSON.stringify(k1.json).slice(0, 250)}`);
    t("Z8. preço da 1ª aquisição = 5 XP", k1.json?.xp?.saldo === 12, `saldo=${k1.json?.xp?.saldo}`);
    // 2ª aquisição: fórmula é TOTAL da seleção → delta 0 → sem preço
    // configurado para o incremento (consistente, nunca negativo/grátis).
    const k2 = await comprar(CHZ, J1, { kind: "disciplina", key: "xp_const", nivelAlvo: 2 });
    t("Z9. 2ª aquisição sem preço incremental → 400 consistente", k2.status === 400, `status=${k2.status} ${JSON.stringify(k2.json).slice(0, 200)}`);
    const pgZ3 = await progressaoDe(CHZ, J1);
    const selZ = (pgZ3.json?.disponiveis ?? []).find((d) => d.key === "xp_const");
    t("Z10. nível da fórmula permanece 1", selZ?.nivelAtual === 1, `nivel=${selZ?.nivelAtual}`);
  }

  // ---------- P3/P4: financiamento por posição exata + montarFicha ----------
  sec("P3/P4 — índices de transição financiados e custo consistente");
  {
    await elemento(CID, M, "atributo", "xp_prog", "Progressivo XP", { disponivel: true });
    await elemento(CID, M, "atributo", "xp_fixo", "Fixo XP", { disponivel: true });
    const modW = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Posições" } });
    const tidW = modW.json.modelo.id, vidW = modW.json.modelo.versionId;
    const estruturaW = {
      versao: 1,
      secoes: [{
        id: "s1", titulo: "Campos", ordem: 0, campos: [
          // custos[i] = custo da transição i→i+1: [1,2,5,10]
          { id: "cx-prog", label: "Progressivo", tipo: "inteiro", editavelPor: "ambos", visibilidade: "todos", custoProgressivo: [1, 2, 5, 10], regra: { kind: "atributo", key: "xp_prog" } },
          { id: "cx-fixo", label: "Fixo", tipo: "inteiro", editavelPor: "ambos", visibilidade: "todos", custoPontos: 1, regra: { kind: "atributo", key: "xp_fixo" } },
        ],
      }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tidW}/versions/${vidW}`, { cookie: M, body: { estrutura: estruturaW } });
    await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tidW}/publish`, { cookie: M, body: { versionId: vidW } });
    const pjW = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Posições", templateVersionId: vidW, data: { "cx-prog": 2, "cx-fixo": 1 } },
    });
    const CHW = pjW.json?.personagem?.id ?? pjW.json?.id;
    t("W0. personagem posições criado", !!CHW, JSON.stringify(pjW.json).slice(0, 150));
    await darXp(CHW, M, { acao: "conceder", quantidade: 30, motivo: "fundo W" });

    // XP financia a transição 2→3 de cx-prog (custa tabela[2]=5 XP)
    // e a transição 1→2 de cx-fixo (custa 1 XP).
    const wp1 = await comprar(CHW, J1, { kind: "atributo", key: "xp_prog", nivelAlvo: 3 });
    t("W1. compra xp_prog 2→3 → 200", wp1.status === 200, `status=${wp1.status} ${JSON.stringify(wp1.json).slice(0, 200)}`);
    const wf1 = await comprar(CHW, J1, { kind: "atributo", key: "xp_fixo", nivelAlvo: 2 });
    t("W2. compra xp_fixo 1→2 → 200", wf1.status === 200, `status=${wf1.status}`);

    // P3: pontos sobem cx-prog para 4 por PATCH — o custo correto é
    // transições 0,1,3 = 1+2+10 = 13 (a transição 2→3 é XP).
    const prevM = await req(BASE, "POST", `/characters/${CHW}/pontos-previa`, { cookie: M, body: { dados: { "cx-prog": 4 } } });
    const detProg = prevM.json?.pontos?.detalhes?.find?.((d) => d.campoId === "cx-prog");
    t("W3. prévia cx-prog=4 cobra 13 (1+2+10, pula transição XP)", detProg?.custo === 13, `detalhes=${JSON.stringify(prevM.json?.pontos?.detalhes)}`);
    // custo fixo: cx-fixo=3 → transições 0 e 2 = 2 pontos (1→2 é XP)
    const prevF = await req(BASE, "POST", `/characters/${CHW}/pontos-previa`, { cookie: M, body: { dados: { "cx-fixo": 3 } } });
    const detFixo = prevF.json?.pontos?.detalhes?.find?.((d) => d.campoId === "cx-fixo");
    t("W4. prévia cx-fixo=3 cobra 2 (transição 1→2 é XP)", detFixo?.custo === 2, `detalhes=${JSON.stringify(prevF.json?.pontos?.detalhes)}`);

    // PATCH real sobe os dois (ignorarPontos: pool 5 < custo total).
    const fxW = await fichaDe(CHW, M);
    const upW = await req(BASE, "PATCH", `/characters/${CHW}`, {
      cookie: M, body: { data: { "cx-prog": 4, "cx-fixo": 3 }, baseUpdatedAt: fxW?.personagem?.updatedAt, ignorarPontos: true },
    });
    t("W5. PATCH sobe níveis por pontos → 200", upW.status === 200, `status=${upW.status} ${JSON.stringify(upW.json).slice(0, 200)}`);
    // GET da ficha reflete o mesmo cálculo no servidor.
    const fichaW = await fichaDe(CHW, M);
    const detW = fichaW?.ficha?.pontos?.detalhes ?? [];
    const dProg = detW.find((d) => d.campoId === "cx-prog");
    const dFixo = detW.find((d) => d.campoId === "cx-fixo");
    t("W6. GET ficha: cx-prog custo 13", dProg?.custo === 13, `detalhes=${JSON.stringify(detW)}`);
    t("W7. GET ficha: cx-fixo custo 2", dFixo?.custo === 2, `detalhes=${JSON.stringify(detW)}`);
    // P4: resposta da ficha nunca expõe __xp.
    t("W8. GET ficha não vaza __xp", !JSON.stringify(fichaW).includes('"__xp"'), "");

    // Redução 4→3: a transição 3→4 sai (era de criação); a transição
    // 2→3 segue financiada por XP — marcador permanece.
    const fxW2 = await fichaDe(CHW, M);
    const redW = await req(BASE, "PATCH", `/characters/${CHW}`, {
      cookie: M, body: { data: { "cx-prog": 3 }, baseUpdatedAt: fxW2?.personagem?.updatedAt },
    });
    t("W9. redução 4→3 → 200 (custo 3+2=5 = pool)", redW.status === 200, `status=${redW.status} ${JSON.stringify(redW.json).slice(0, 200)}`);
    const prevR = await req(BASE, "POST", `/characters/${CHW}/pontos-previa`, { cookie: M, body: { dados: { "cx-prog": 3 } } });
    const detR = prevR.json?.pontos?.detalhes?.find?.((d) => d.campoId === "cx-prog");
    t("W10. cx-prog=3 segue custando 3 (nível 3 continua XP)", detR?.custo === 3, `detalhes=${JSON.stringify(prevR.json?.pontos?.detalhes)}`);

    // P4: jogador vê o MESMO cálculo (metadado de financiamento dos
    // campos visíveis chega ao cálculo sem expor __xp).
    const fichaJ = await fichaDe(CHW, J1);
    const detJ = fichaJ?.ficha?.pontos?.detalhes ?? [];
    const dJProg = detJ.find((d) => d.campoId === "cx-prog");
    t("W11. GET ficha jogador: mesmo custo 3", dJProg?.custo === 3, `detalhes=${JSON.stringify(detJ)}`);
    t("W12. GET ficha jogador não vaza __xp", !JSON.stringify(fichaJ).includes('"__xp"'), "");
    // Prévia do jogador equivalente ao PATCH.
    const prevJ = await req(BASE, "POST", `/characters/${CHW}/pontos-previa`, { cookie: J1, body: { dados: { "cx-prog": 4, "cx-fixo": 3 } } });
    const detPJ = prevJ.json?.pontos?.detalhes ?? [];
    const pjProg = detPJ.find((d) => d.campoId === "cx-prog");
    const pjFixo = detPJ.find((d) => d.campoId === "cx-fixo");
    t("W13. prévia jogador cx-prog=4 → 13", pjProg?.custo === 13, `detalhes=${JSON.stringify(detPJ)}`);
    t("W14. prévia jogador cx-fixo=3 → 2", pjFixo?.custo === 2, `detalhes=${JSON.stringify(detPJ)}`);
  }


  // ---------- MC3 P1: custo fixo proporcional em decimal/moeda ----------
  sec("MC3-P1 — custo fixo proporcional (decimal/moeda) e financiamento fracionário");
  {
    await elemento(CID, M, "atributo", "dec_nivel", "Nível Decimal", { disponivel: true });
    const modV = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Decimais" } });
    const tidV = modV.json.modelo.id, vidV = modV.json.modelo.versionId;
    const estruturaV = {
      versao: 1,
      secoes: [{
        id: "s1", titulo: "Campos", ordem: 0, campos: [
          // custo fixo 2 por unidade acima da base — valor 1.5 deve
          // custar 3 (proporcional), não 4 (contagem inteira).
          { id: "cd-dec", label: "Decimal", tipo: "decimal", editavelPor: "ambos", visibilidade: "todos", custoPontos: 2, regra: { kind: "atributo", key: "dec_nivel" } },
          { id: "cd-moeda", label: "Moeda", tipo: "moeda", editavelPor: "ambos", visibilidade: "todos", custoPontos: 3 },
          // custo negativo: concessão proporcional de pontos.
          { id: "cd-neg", label: "Defeito", tipo: "decimal", editavelPor: "ambos", visibilidade: "todos", custoPontos: -1 },
          // base não-zero (padrao 0.25): 1.75-0.25=1.5 × 2 = 3.
          { id: "cd-base", label: "Com Base", tipo: "decimal", padrao: 0.25, editavelPor: "ambos", visibilidade: "todos", custoPontos: 2 },
        ],
      }],
      pontos: { habilitado: true, pontosIniciais: 100, pools: [], custos: {} },
    };
    await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tidV}/versions/${vidV}`, { cookie: M, body: { estrutura: estruturaV } });
    await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tidV}/publish`, { cookie: M, body: { versionId: vidV } });
    const pjV = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Decimais", templateVersionId: vidV, data: {} },
    });
    const CHV = pjV.json?.personagem?.id ?? pjV.json?.id;
    t("V0. personagem decimal criado", !!CHV, JSON.stringify(pjV.json).slice(0, 150));
    const custoDe = (prev, campoId) => (prev.json?.pontos?.detalhes ?? []).find((d) => d.campoId === campoId)?.custo;

    // Sem financiamento: cobrança integral proporcional.
    const v1 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-dec": 1.5 } } });
    t("V1. decimal 1.5 × custo 2 → 3 pontos", custoDe(v1, "cd-dec") === 3, `custo=${custoDe(v1, "cd-dec")}`);
    const v2 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-moeda": 2.5 } } });
    t("V2. moeda 2.5 × custo 3 → 7.5 pontos", custoDe(v2, "cd-moeda") === 7.5, `custo=${custoDe(v2, "cd-moeda")}`);
    const v3 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-neg": 1 } } });
    t("V3. custo negativo -1 → concede 1 ponto", custoDe(v3, "cd-neg") === -1, `custo=${custoDe(v3, "cd-neg")}`);
    const v4 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-base": 1.75 } } });
    t("V4. base 0.25: (1.75-0.25)×2 → 3 pontos", custoDe(v4, "cd-base") === 3, `custo=${custoDe(v4, "cd-base")}`);
    const v5 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-base": 0.25 } } });
    t("V5. valor == base → sem cobrança", custoDe(v5, "cd-base") === undefined, `custo=${custoDe(v5, "cd-base")}`);
    const v6 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-neg": 2.5 } } });
    t("V6. negativo proporcional: 2.5 × -1 → -2.5", custoDe(v6, "cd-neg") === -2.5, `custo=${custoDe(v6, "cd-neg")}`);

    // XP financia as transições 0→1 e 1→2 de cd-dec (2 XP cada).
    await darXp(CHV, M, { acao: "conceder", quantidade: 10, motivo: "fundo V" });
    const vd1 = await comprar(CHV, J1, { kind: "atributo", key: "dec_nivel", nivelAlvo: 1 });
    t("V7. compra dec_nivel 0→1 → 200", vd1.status === 200, `status=${vd1.status} ${JSON.stringify(vd1.json).slice(0, 200)}`);
    const vd2 = await comprar(CHV, J1, { kind: "atributo", key: "dec_nivel", nivelAlvo: 2 });
    t("V8. compra dec_nivel 1→2 → 200", vd2.status === 200, `status=${vd2.status}`);

    // Intervalo [0,1.5) está INTEIRAMENTE coberto pelos financiamentos
    // [0,1) e [1,1.5) → custo zero (fração financiada, não nível inteiro).
    const v7 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-dec": 1.5 } } });
    t("V9. 1.5 totalmente financiado → custo 0", custoDe(v7, "cd-dec") === undefined, `detalhes=${JSON.stringify(v7.json?.pontos?.detalhes)}`);
    // [0,2.5): financiado cobre 2.0 → restam 0.5 × 2 = 1 ponto.
    const v8 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-dec": 2.5 } } });
    t("V10. 2.5 com 2 financiados → cobra 0.5×2=1", custoDe(v8, "cd-dec") === 1, `custo=${custoDe(v8, "cd-dec")}`);
    // [0,3.5): financiado cobre 2.0 → restam 1.5 × 2 = 3 pontos.
    const v9 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-dec": 3.5 } } });
    t("V11. 3.5 com 2 financiados → cobra 1.5×2=3", custoDe(v9, "cd-dec") === 3, `custo=${custoDe(v9, "cd-dec")}`);
    // PATCH real grava 2.5 por pontos (custo 1 ≤ pool) e o
    // financiamento das transições 0→1 e 1→2 permanece intacto.
    const fxV = await fichaDe(CHV, M);
    const upV = await req(BASE, "PATCH", `/characters/${CHV}`, {
      cookie: M, body: { data: { "cd-dec": 2.5 }, baseUpdatedAt: fxV?.personagem?.updatedAt },
    });
    t("V12. PATCH decimal 2.5 → 200", upV.status === 200, `status=${upV.status} ${JSON.stringify(upV.json).slice(0, 200)}`);
    const v10 = await req(BASE, "POST", `/characters/${CHV}/pontos-previa`, { cookie: M, body: { dados: { "cd-dec": 2.5 } } });
    t("V13. após PATCH, custo de 2.5 segue 1 (financiamento preservado)", custoDe(v10, "cd-dec") === 1, `custo=${custoDe(v10, "cd-dec")}`);
  }

  // ---------- MC3 P2: elemento com vínculo visível E oculto ----------
  sec("MC3-P2 — vínculo oculto não vaza preço nem recebe compra");
  {
    // Mesmo kind:key em DOIS campos: seleção múltipla pública (binária)
    // e campo numérico oculto com editavelPor=ambos (preço sentinela 7).
    await elemento(CID, M, "caracteristica", "dup_item", "Relíquia Duplicada", {
      // 3 níveis: nv.1 custa 3 XP na seleção pública; o campo
      // numérico oculto tem custoPontos próprio (7) — sentinela.
      niveis: [{ descricao: "nv1", custo: 3 }, { descricao: "nv2", custo: 7 }, { descricao: "nv3", custo: 7 }], disponivel: true,
    });
    const modU = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Duplicada" } });
    const tidU = modU.json.modelo.id, vidU = modU.json.modelo.versionId;
    const estruturaU = {
      versao: 1,
      secoes: [{
        id: "s1", titulo: "Campos", ordem: 0, campos: [
          { id: "cu-pub", label: "Relíquias", tipo: "selecao_multipla", editavelPor: "ambos", visibilidade: "todos", regraKind: "caracteristica" },
          { id: "cu-sec", label: "Cofre Secreto", tipo: "inteiro", editavelPor: "ambos", visibilidade: "mestre", custoPontos: 7, regra: { kind: "caracteristica", key: "dup_item" } },
        ],
      }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tidU}/versions/${vidU}`, { cookie: M, body: { estrutura: estruturaU } });
    await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tidU}/publish`, { cookie: M, body: { versionId: vidU } });
    const pjU = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Herói Duplicado", templateVersionId: vidU, data: {} },
    });
    const CHU = pjU.json?.personagem?.id ?? pjU.json?.id;
    t("U0. personagem duplicado criado", !!CHU, JSON.stringify(pjU.json).slice(0, 150));
    await darXp(CHU, M, { acao: "conceder", quantidade: 50, motivo: "fundo U" });

    // A) Jogador compra nível 1 pelo vínculo PÚBLICO (3 XP da biblioteca).
    const u1 = await comprar(CHU, J1, { kind: "caracteristica", key: "dup_item", nivelAlvo: 1 });
    t("U1. compra nv.1 pelo vínculo público → 200", u1.status === 200, `status=${u1.status} ${JSON.stringify(u1.json).slice(0, 250)}`);
    t("U2. débito de 3 XP (preço da seleção, não do campo oculto)", u1.json?.xp?.saldo === 47, `saldo=${u1.json?.xp?.saldo}`);
    t("U3. escrita no campo público cu-pub", u1.json?.compra?.campoId === "cu-pub", `campoId=${u1.json?.compra?.campoId}`);

    // B) GET do jogador: seleção adquirida visível, SEM preço do oculto.
    const pgU1 = await progressaoDe(CHU, J1);
    const elU = (pgU1.json?.disponiveis ?? []).find((d) => d.key === "dup_item");
    t("U4. elemento permanece no GET com nivelAtual 1", elU?.nivelAtual === 1, `el=${JSON.stringify(elU)}`);
    t("U5. precoProximo null (binário não expressa nv.2)", elU?.precoProximo === null, `preco=${elU?.precoProximo}`);
    t("U6. compravel false", elU?.compravel === false, `compravel=${elU?.compravel}`);
    const corpoU = JSON.stringify(pgU1.json);
    t("U7. resposta não vaza campoId/label/custo do oculto", !corpoU.includes("cu-sec") && !corpoU.includes("Cofre Secreto") && !corpoU.includes('"precoProximo":7'), corpoU.slice(0, 300));

    // C) POST direto do jogador no nível 2 → fail-closed, sem efeitos.
    const histAntes = (pgU1.json?.xp?.historico ?? []).length;
    const u2 = await comprar(CHU, J1, { kind: "caracteristica", key: "dup_item", nivelAlvo: 2 });
    t("U8. POST jogador nv.2 → rejeitado", u2.status === 400, `status=${u2.status} ${JSON.stringify(u2.json).slice(0, 250)}`);
    const corpoU2 = JSON.stringify(u2.json);
    t("U9. erro não vaza campoId/preço do oculto", !corpoU2.includes("cu-sec") && !corpoU2.includes("Cofre Secreto"), corpoU2.slice(0, 200));
    const pgU2 = await progressaoDe(CHU, J1);
    t("U10. saldo XP inalterado (47)", pgU2.json?.xp?.saldo === 47, `saldo=${pgU2.json?.xp?.saldo}`);
    t("U11. histórico inalterado", (pgU2.json?.xp?.historico ?? []).length === histAntes, `n=${(pgU2.json?.xp?.historico ?? []).length}`);
    const pgUM = await progressaoDe(CHU, M);
    const elUM = (pgUM.json?.disponiveis ?? []).find((d) => d.key === "dup_item");
    t("U12. campo oculto continua 0 (nível do elemento = 1)", elUM?.nivelAtual === 1, `nivel=${elUM?.nivelAtual}`);

    // D) Mestre compra o nível 2 pelo campo oculto (7 XP sentinela).
    const u3 = await comprar(CHU, M, { kind: "caracteristica", key: "dup_item", nivelAlvo: 2 });
    t("U13. mestre compra nv.2 → 200", u3.status === 200, `status=${u3.status} ${JSON.stringify(u3.json).slice(0, 250)}`);
    t("U14. débito de 7 XP no campo oculto", u3.json?.xp?.saldo === 40 && u3.json?.compra?.campoId === "cu-sec", `saldo=${u3.json?.xp?.saldo} campoId=${u3.json?.compra?.campoId}`);
    // Histórico do jogador mascara a compra do mestre no campo oculto.
    const pgU3 = await progressaoDe(CHU, J1);
    const comprasU = (pgU3.json?.xp?.historico ?? []).filter((e) => e.tipo === "compra");
    const compraOculta = comprasU.find((e) => e.compra === undefined);
    t("U15. histórico do jogador mascara compra no oculto", !!compraOculta && compraOculta.motivo === "Compra de nível", JSON.stringify(comprasU));
    t("U16. histórico não vaza cu-sec/Cofre da compra oculta", !JSON.stringify(comprasU).includes("cu-sec") && !JSON.stringify(comprasU).includes("Cofre"), "");
    // Jogador continua vendo o elemento no nível 1 (o 2 está oculto).
    const elU3 = (pgU3.json?.disponiveis ?? []).find((d) => d.key === "dup_item");
    t("U17. jogador segue vendo nivelAtual 1 após compra oculta", elU3?.nivelAtual === 1 && elU3?.precoProximo === null, `el=${JSON.stringify(elU3)}`);

    // E) Override torna o campo visível → política efetiva muda.
    const ovU = await req(BASE, "PATCH", `/characters/${CHU}`, { cookie: M, body: { overrides: { "cu-sec": { visibilidade: "todos" } }, ignorarPontos: true } });
    t("U18. override visibilidade→todos", ovU.status === 200, `status=${ovU.status} ${JSON.stringify(ovU.json).slice(0,300)}`);
    const pgU4 = await progressaoDe(CHU, J1);
    const elU4 = (pgU4.json?.disponiveis ?? []).find((d) => d.key === "dup_item");
    t("U19. com override, jogador vê nivelAtual 2 e preço 7", elU4?.nivelAtual === 2 && elU4?.precoProximo === 7 && elU4?.compravel === true, `el=${JSON.stringify(elU4)}`);
    const u4 = await comprar(CHU, J1, { kind: "caracteristica", key: "dup_item", nivelAlvo: 3 });
    t("U20. jogador compra nv.3 pelo campo agora visível → 200", u4.status === 200, `status=${u4.status} ${JSON.stringify(u4.json).slice(0, 200)}`);
    t("U21. débito de 7 XP (saldo 33)", u4.json?.xp?.saldo === 33 && u4.json?.compra?.campoId === "cu-sec", `saldo=${u4.json?.xp?.saldo}`);

    // Volta a ocultar → proteção restaurada.
    const ovU2 = await req(BASE, "PATCH", `/characters/${CHU}`, { cookie: M, body: { overrides: { "cu-sec": { visibilidade: "mestre" } }, ignorarPontos: true } });
    t("U22. override de volta p/ mestre", ovU2.status === 200, `status=${ovU2.status} ${JSON.stringify(ovU2.json).slice(0,300)}`);
    const pgU5 = await progressaoDe(CHU, J1);
    const elU5 = (pgU5.json?.disponiveis ?? []).find((d) => d.key === "dup_item");
    t("U23. oculto de novo: nivelAtual 1, sem preço", elU5?.nivelAtual === 1 && elU5?.precoProximo === null && elU5?.compravel === false, `el=${JSON.stringify(elU5)}`);
    const u5 = await comprar(CHU, J1, { kind: "caracteristica", key: "dup_item", nivelAlvo: 2 });
    t("U24. POST nv.2 rejeitado de novo", u5.status === 400, `status=${u5.status}`);
    const pgUM2 = await progressaoDe(CHU, M);
    const elUM2 = (pgUM2.json?.disponiveis ?? []).find((d) => d.key === "dup_item");
    t("U25. mestre vê nivelAtual 3", elUM2?.nivelAtual === 3, `nivel=${elUM2?.nivelAtual}`);
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
