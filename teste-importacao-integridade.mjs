// Issue #162 — integridade do ledger XP e metadados reservados na
// importação/restauração. Cobre modos "nova" e "substituir", valida o
// conteúdo PERSISTIDO no banco (não só a resposta HTTP) e confirma que
// snapshots internos (origem "interna") preservam tudo integralmente.
import { randomUUID } from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb, req, criarCenario, abrirDb,
} from "./teste-base.mjs";
import { calcularPontos, campoSchema } from "./servidor/dist/lib/ficha.js";

let ok = 0, falhas = 0;
const check = (cond, msg) => { if (cond) { ok++; } else { falhas++; console.error("FALHA:", msg); } };

const dir = dirTeste("imp-integ");
const banco = `${dir}/teste.db`;
const arquivos = `${dir}/arquivos`;
const backups = `${dir}/backups`;
let proc = null, base = null;

try {
  await prepararBanco(banco);
  const porta = await portaLivre();
  base = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco, arquivos, backups });
  await esperarSaudavel(base, proc);

  // ---------- cenário: config HP/vitalidade + ficha com campo "tal" ----------
  const c = await criarCenario(base, banco, {
    config: {
      hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" },
      vitalidade: {
        edicaoPor: "mestre",
        niveis: [
          { nome: "Ok", penalidadeDados: 0, bloqueiaAcoes: false },
          { nome: "Ferido", penalidadeDados: 1, bloqueiaAcoes: false },
          { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
        ],
      },
    },
  });
  const { campId, cookieMestre, adminId, jogadores } = c;

  // estrutura customizada: campo "tal" inteiro com custo progressivo +
  // sistema de pontos habilitado (para a consequência econômica)
  const dbw = abrirDb(banco);
  const tpl = dbw.prepare("select id from sheet_versions where template_id in (select id from sheet_templates where campaign_id=?)").get(campId);
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Atributos", ordem: 0,
      campos: [
        { id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" },
        { id: "tal", label: "Talento", tipo: "inteiro", custoProgressivo: [1, 1, 1], semantico: "talento" },
      ],
    }],
    pontos: { habilitado: true, pontosIniciais: 10, pools: [], custos: {} },
  };
  dbw.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(estrutura), tpl.id);

  // arquivo da campanha (alvo legítimo de __retrato)
  const fileId = randomUUID();
  dbw.prepare("insert into files (id,campaign_id,folder_path,file_name,mime_type,size_bytes,uploaded_by,visibility,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(fileId, campId, "/", "retrato.png", "image/png", 10, adminId, "mestre", Date.now(), Date.now());

  // ---------- helpers de dados forjados ----------
  const AGORA = "2025-06-01T12:00:00.000Z";
  const evXp = (qtd, saldo, extra = {}) => ({
    em: AGORA, tipo: "concessao", quantidade: qtd, motivo: "teste",
    autorId: null, autorNome: null, saldoResultante: saldo, ...extra,
  });
  // cadeia válida: n eventos de +1 → saldo final = n (âncora zero)
  const ledgerN = (n) => ({
    saldo: n,
    historico: Array.from({ length: n }, (_, i) => evXp(1, i + 1)),
  });
  // cadeia válida com eventos arbitrários (quantidades/saldos coerentes)
  const ledgerCustom = (deltas) => {
    let s = 0;
    const historico = deltas.map((q) => { s += q; return evXp(q, s); });
    return { saldo: s, historico };
  };

  const membershipId = jogadores.jogador1.membershipId;
  const inserirPersonagem = (nome, data) => {
    const id = randomUUID();
    dbw.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, campId, membershipId, tpl.id, nome, JSON.stringify(data), "{}", "aprovada", 0, Date.now(), Date.now());
    return id;
  };

  const ids = {};
  // --- casos __xp ---
  ids.saldoVazio = inserirPersonagem("ATQ saldo sem histórico", { for: 5, __xp: { saldo: 500, historico: [] } });
  ids.saldoForjado = inserirPersonagem("ATQ saldo divergente", { for: 5, __xp: { saldo: 999, historico: [evXp(10, 10)] } });
  ids.cadeiaQuebra = inserirPersonagem("ATQ cadeia quebra", {
    for: 5,
    __xp: {
      saldo: 10,
      historico: [
        evXp(10, 10),
        evXp(5, 999),          // quebra: esperado 15
        evXp(5, 1004),         // pós-quebra (descartado)
      ],
    },
  });
  ids.divergencia = inserirPersonagem("ATQ divergência final", {
    for: 5,
    __xp: { saldo: 20, historico: ledgerCustom([10, 5]).historico }, // cadeia soma 15, ledger diz 20
  });

  const mkLedgerN = (n) => ({ saldo: n, historico: Array.from({ length: n }, (_, i) => evXp(1, i + 1)) });
  const dbw2 = abrirDb(banco);
  ids.hist499 = inserirPersonagem("ATQ histórico 499", { for: 5, __xp: mkLedgerN(499) });
  ids.hist500 = inserirPersonagem("ATQ histórico 500", { for: 5, __xp: mkLedgerN(500) });
  ids.hist501 = inserirPersonagem("ATQ histórico 501", { for: 5, __xp: mkLedgerN(501) });
  ids.eventosInvalidos = inserirPersonagem("ATQ eventos inválidos", {
    for: 5,
    __xp: {
      saldo: 5,
      historico: [
        evXp(2, 2),
        { em: "data-ruim", tipo: "concessao", quantidade: 1, saldoResultante: 3 },
        { em: AGORA, tipo: "hack", quantidade: 1, saldoResultante: 4 },
        evXp(1, 3),
        evXp(2, 5),
      ],
    },
  });
  ids.xpValido = inserirPersonagem("ATQ xp válido", { for: 5, __xp: ledgerCustom([4, -1, 2]) }); // saldo 5
  ids.xpValidoAutor = inserirPersonagem("ATQ xp autoria", {
    for: 5,
    __xp: {
      saldo: 3,
      historico: [
        evXp(3, 3, { autorId: adminId, autorNome: "Nome Falso" }),
        evXp(0, 3, { autorId: "usuario-inexistente", autorNome: "Fantasma" }),
      ],
    },
  });

  // --- casos __pontos ---
  ids.seloForjado = inserirPersonagem("ATQ selo forjado", {
    for: 5,
    __pontos: { bonus: 5, historico: [{ em: AGORA, quantidade: 2, motivo: "bônus", autorId: null, autorNome: null }], selo: { por: "qualquer", em: AGORA } },
  });
  ids.bonusTexto = inserirPersonagem("ATQ bônus texto", { for: 5, __pontos: { bonus: "muito", historico: [] } });
  ids.bonusFracionario = inserirPersonagem("ATQ bônus fracionário", { for: 5, __pontos: { bonus: 3.9, historico: [] } });
  ids.bonusAcima = inserirPersonagem("ATQ bônus acima", { for: 5, __pontos: { bonus: 99999, historico: [] } });
  ids.pontosAutor = inserirPersonagem("ATQ pontos autoria", {
    for: 5,
    __pontos: {
      bonus: 1,
      historico: [
        { em: AGORA, quantidade: 1, motivo: "ok", autorId: adminId, autorNome: "Falso" },
        { em: "ruim", quantidade: 1, motivo: "data ruim", autorId: null, autorNome: null },
        { em: AGORA, quantidade: 1, motivo: "fantasma", autorId: "ninguem", autorNome: "X" },
      ],
    },
  });
  ids.pontosHist201 = inserirPersonagem("ATQ pontos hist 201", {
    for: 5,
    __pontos: { bonus: 0, historico: Array.from({ length: 201 }, (_, i) => ({ em: AGORA, quantidade: 1, motivo: `e${i}`, autorId: null, autorNome: null })) },
  });

  // --- casos financiado (campo "tal" = 3, custoProgressivo [1,1,1]) ---
  ids.finOk = inserirPersonagem("ATQ fin ok", {
    for: 5, tal: 3, __xp: { ...ledgerCustom([10]), financiado: { tal: [0, 1] } },
  });
  ids.finInvalido = inserirPersonagem("ATQ fin inválido", {
    for: 5, tal: 3, __xp: { ...ledgerCustom([10]), financiado: { tal: "legado-x", fantasma: [0] } },
  });
  ids.finLegado = inserirPersonagem("ATQ fin legado", {
    for: 5, tal: 3, __xp: { ...ledgerCustom([10]), financiado: { tal: 2 } }, // → índices [1,2]
  });

  // --- casos vida/retrato/npc ---
  ids.hpAlto = inserirPersonagem("ATQ hp alto", { for: 5, __hp: { atual: 999, historico: [{ em: AGORA, tipo: "inicial", quantidade: 150, motivo: null, autorId: null, autorNome: null }] } });
  ids.hpOk = inserirPersonagem("ATQ hp ok", { for: 5, __hp: { atual: 80, historico: [] } });
  ids.vitFora = inserirPersonagem("ATQ vitalidade fora", { for: 5, __vitalidade: { nivel: 99, nivelManual: 50, historico: [{ em: AGORA, nivelAnterior: 0, nivelNovo: 99, motivo: null, autorId: null, autorNome: null }] } });
  ids.vitOk = inserirPersonagem("ATQ vitalidade ok", { for: 5, __vitalidade: { nivel: 1 } });
  ids.retratoAlheio = inserirPersonagem("ATQ retrato alheio", { for: 5, __retrato: { tipo: "arquivo", arquivoId: "arquivo-de-outro-lugar" } });
  ids.retratoOk = inserirPersonagem("ATQ retrato ok", { for: 5, __retrato: { tipo: "arquivo", arquivoId: fileId } });
  ids.npcMalformado = inserirPersonagem("ATQ npc malformado", { for: 5, isNpcFlag: true, __npcVisivel: { visivel: "sim" } });
  ids.npcOk = inserirPersonagem("ATQ npc ok", { for: 5, __npcVisivel: { visivel: true } });
  dbw2.close();

  // ---------- exporta o pacote "original" ----------
  const exp = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
  check(exp.status === 200, `exportar status ${exp.status}`);
  const pacoteOriginal = exp.json;

  // ---------- remapeador de ids para modo "nova" ----------
  const remapear = (pacote) => {
    const clone = JSON.parse(JSON.stringify(pacote));
    const novoCid = `imp${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const idMap = new Map(); // oldId -> newId (global: ids são UUIDs únicos)
    const colecoes = [
      "memberships", "invitations", "sheetTemplates", "sheetVersions", "characters",
      "characterFields", "ruleSets", "ruleDefinitions", "itemTemplates",
      "inventoryEntries", "equipmentEntries", "vehicles", "financialAccounts",
      "moneyTransactions", "sessions", "turns", "chatMessages", "rolls",
      "tests", "notes", "files", "folders", "noteAttachments",
    ];
    for (const col of colecoes) {
      for (const row of clone.estado[col] ?? []) {
        if (typeof row.id === "string" && !idMap.has(row.id)) idMap.set(row.id, randomUUID());
      }
    }
    const trocar = (v) => (typeof v === "string" && idMap.has(v) ? idMap.get(v) : v);
    for (const col of colecoes) {
      for (const row of clone.estado[col] ?? []) {
        if (typeof row.id === "string") row.id = idMap.get(row.id);
        for (const [k, v] of Object.entries(row)) {
          if (k === "id" || k === "data" || k === "overrides" || k === "config" || k === "structure" || k === "permissions" || k === "settings" || k === "recipients" || k === "definition") continue;
          if (typeof v === "string") row[k] = trocar(v);
        }
        row.campaignId = novoCid;
        if (col === "characters" && row.data && typeof row.data === "object") {
          const d = row.data;
          if (d.__retrato && typeof d.__retrato.arquivoId === "string") d.__retrato.arquivoId = trocar(d.__retrato.arquivoId);
        }
      }
    }
    clone.campanhaId = novoCid;
    // chaves dos binários acompanham os novos ids de files
    const novosArquivos = {};
    for (const [oldId, arq] of Object.entries(clone.arquivos ?? {})) {
      novosArquivos[idMap.get(oldId) ?? oldId] = arq;
    }
    clone.arquivos = novosArquivos;
    return clone;
  };

  // ---------- importação modo "nova" ----------
  const pacoteNova = remapear(pacoteOriginal);
  const impNova = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre, body: { pacote: pacoteNova, modo: "nova" },
  });
  check(impNova.status === 201, `importar nova status ${impNova.status}: ${JSON.stringify(impNova.json)?.slice(0, 300)}`);
  const cidNova = impNova.json?.campaignId;
  const saneNova = impNova.json?.saneamento;
  check(!!saneNova && saneNova.origem === "externa", "saneamento origem externa presente");
  check(saneNova?.totais?.ledgersXpInvalidos >= 3, `totais ledgers inválidos ${saneNova?.totais?.ledgersXpInvalidos}`);
  check(saneNova?.totais?.selosRemovidos >= 1, "selo removido contabilizado");
  check(saneNova?.totais?.bonusAjustados >= 3, `bônus ajustados ${saneNova?.totais?.bonusAjustados}`);
  check(saneNova?.totais?.hpCorrigidos >= 1 && saneNova?.totais?.vitalidadeCorrigidas >= 1, "hp/vitalidade corrigidos");
  check(saneNova?.totais?.retratoRemovido !== undefined || saneNova?.totais?.retratosRemovidos >= 1, "retrato removido contabilizado");
  check(saneNova?.totais?.npcVisivelRemovidos >= 1, "npcVisivel removido contabilizado");
  check(saneNova?.totais?.financiadoRejeitados >= 2, `financiado rejeitados ${saneNova?.totais?.financiadoRejeitados}`);

  const personagemNa = (nome) => comDb(banco, (db) => {
    const r = db.prepare("select id,data from characters where campaign_id=? and name=?").get(cidNova, nome);
    return r ? { id: r.id, data: JSON.parse(r.data) } : null;
  });

  // --- asserts persistidos: __xp ---
  let p = personagemNa("ATQ saldo sem histórico");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "saldo sem histórico invalidado");
  p = personagemNa("ATQ saldo divergente");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "saldo divergente invalidado");
  p = personagemNa("ATQ cadeia quebra");
  check(p?.data.__xp?.saldo === 10 && p.data.__xp.historico.length === 1, "quebra: prefixo demonstrável mantido");
  p = personagemNa("ATQ divergência final");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "divergência final invalidada");
  p = personagemNa("ATQ histórico 499");
  check(p?.data.__xp?.historico.length === 499 && p.data.__xp.saldo === 499, "499 eventos preservados");
  p = personagemNa("ATQ histórico 500");
  check(p?.data.__xp?.historico.length === 500 && p.data.__xp.saldo === 500, "500 eventos preservados");
  p = personagemNa("ATQ histórico 501");
  check(p?.data.__xp?.historico.length === 500 && p.data.__xp.saldo === 501, "501 → últimos 500 validados, saldo do último evento");
  p = personagemNa("ATQ eventos inválidos");
  check(p?.data.__xp?.historico.length === 3 && p.data.__xp.saldo === 5, "eventos inválidos descartados, cadeia válida mantida");
  p = personagemNa("ATQ xp válido");
  check(p?.data.__xp?.saldo === 5 && p.data.__xp.historico.length === 3, "ledger legítimo preservado");
  check(p?.data.for === 5, "campos normais preservados");
  p = personagemNa("ATQ xp autoria");
  check(p?.data.__xp?.historico[0]?.autorNome === "Mestre Teste", "autorNome resolvido pelo banco");
  check(p?.data.__xp?.historico[1]?.autorId === null && p?.data.__xp?.historico[1]?.autorNome === null, "autor desconhecido limpo");

  // --- asserts persistidos: __pontos ---
  p = personagemNa("ATQ selo forjado");
  check(p?.data.__pontos?.selo === null && p.data.__pontos.bonus === 5, "selo removido, bônus legítimo mantido");
  p = personagemNa("ATQ bônus texto");
  check(p?.data.__pontos?.bonus === 0, "bônus inválido → 0");
  p = personagemNa("ATQ bônus fracionário");
  check(p?.data.__pontos?.bonus === 3, "bônus truncado");
  p = personagemNa("ATQ bônus acima");
  check(p?.data.__pontos?.bonus === 10000, "bônus limitado a 10000");
  p = personagemNa("ATQ pontos autoria");
  check(p?.data.__pontos?.historico.length === 2, "evento de data inválida descartado");
  check(p?.data.__pontos?.historico[0]?.autorNome === "Mestre Teste", "pontos: autorNome resolvido");
  check(p?.data.__pontos?.historico[1]?.autorId === null && p?.data.__pontos?.historico[1]?.autorNome === null, "pontos: autoria forjada limpa");
  p = personagemNa("ATQ pontos hist 201");
  check(p?.data.__pontos?.historico.length === 200, "histórico de pontos limitado a 200");

  // --- asserts persistidos: financiado ---
  p = personagemNa("ATQ fin ok");
  check(JSON.stringify(p?.data.__xp?.financiado?.tal) === "[0,1]", "financiado válido preservado");
  p = personagemNa("ATQ fin inválido");
  check(p?.data.__xp?.financiado === undefined, "financiado inválido rejeitado por inteiro");
  p = personagemNa("ATQ fin legado");
  check(JSON.stringify(p?.data.__xp?.financiado?.tal) === "[1,2]", "legado numérico convertido em índices");

  // --- asserts persistidos: vida/retrato/npc ---
  p = personagemNa("ATQ hp alto");
  check(p?.data.__hp?.atual === 150, "HP acima do máximo corrigido para o teto (for=5 → 150)");
  p = personagemNa("ATQ hp ok");
  check(p?.data.__hp?.atual === 80, "HP válido preservado");
  p = personagemNa("ATQ vitalidade fora");
  check(p?.data.__vitalidade?.nivel === 2 && p.data.__vitalidade.nivelManual === 2, "vitalidade fora da escala corrigida");
  p = personagemNa("ATQ vitalidade ok");
  check(p?.data.__vitalidade?.nivel === 1, "vitalidade válida preservada");
  p = personagemNa("ATQ retrato alheio");
  check(p?.data.__retrato === undefined, "retrato para arquivo inexistente removido");
  p = personagemNa("ATQ retrato ok");
  check(p?.data.__retrato?.arquivoId === p?.id ? false : typeof p?.data.__retrato?.arquivoId === "string", "retrato válido preservado (id remapeado)");
  p = personagemNa("ATQ npc malformado");
  check(p?.data.__npcVisivel === undefined, "npcVisivel malformado removido");
  p = personagemNa("ATQ npc ok");
  check(p?.data.__npcVisivel?.visivel === true, "npcVisivel válido preservado");

  // --- consequência econômica via calcularPontos (banco persistido) ---
  const calcNa = (nome) => comDb(banco, (db) => {
    const row = db.prepare("select c.data, sv.structure from characters c join sheet_versions sv on sv.id=c.template_version_id where c.campaign_id=? and c.name=?").get(cidNova, nome);
    return calcularPontos(JSON.parse(row.structure), JSON.parse(row.data));
  });
  const ptsOk = calcNa("ATQ fin ok");
  const ptsInv = calcNa("ATQ fin inválido");
  const ptsLeg = calcNa("ATQ fin legado");
  check(ptsOk.pools[0]?.gastos === 1, `financiado [0,1] → só transição 2→3 custa (gastos=${ptsOk.pools[0]?.gastos})`);
  check(ptsInv.pools[0]?.gastos === 3, `financiado rejeitado → custo integral (gastos=${ptsInv.pools[0]?.gastos})`);
  check(ptsLeg.pools[0]?.gastos === 1, `legado→[1,2] → transição 0→1 custa (gastos=${ptsLeg.pools[0]?.gastos})`);

  // ---------- importação modo "substituir" (mesmos ids, campanha original) ----------
  const impSub = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteOriginal, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  check(impSub.status === 200, `importar substituir status ${impSub.status}: ${JSON.stringify(impSub.json)?.slice(0, 300)}`);
  check(impSub.json?.saneamento?.origem === "externa", "substituir: saneamento externa");
  check(impSub.json?.saneamento?.totais?.selosRemovidos >= 1, "substituir: selo removido");

  const personagemOrig = (nome) => comDb(banco, (db) => {
    const r = db.prepare("select id,data from characters where campaign_id=? and name=?").get(campId, nome);
    return r ? { id: r.id, data: JSON.parse(r.data) } : null;
  });
  p = personagemOrig("ATQ saldo sem histórico");
  check(p?.data.__xp?.saldo === 0, "substituir: saldo forjado zerado no banco");
  p = personagemOrig("ATQ selo forjado");
  check(p?.data.__pontos?.selo === null, "substituir: selo removido no banco");
  p = personagemOrig("ATQ histórico 501");
  check(p?.data.__xp?.historico.length === 500 && p.data.__xp.saldo === 501, "substituir: 501 → 500 no banco");
  p = personagemOrig("ATQ fin inválido");
  check(p?.data.__xp?.financiado === undefined, "substituir: financiado rejeitado no banco");

  // ---------- snapshot interno: preservação integral ----------
  // semeia metadados "confiáveis" direto no banco (como o servidor faria),
  // tira snapshot, adultera, restaura → deve voltar EXATAMENTE.
  const xpSnapshot = {
    saldo: 777,
    historico: [evXp(777, 777, { autorId: adminId, autorNome: "Mestre Teste" })],
    financiado: { tal: [0, 1, 2] },
  };
  const pontosSnapshot = {
    bonus: -50,
    historico: [{ em: AGORA, quantidade: -50, motivo: "ajuste", autorId: null, autorNome: null }],
    selo: { por: adminId, em: AGORA, hash: "selo-legitimo" },
  };
  const idSnap = ids.xpValido;
  {
    const w = abrirDb(banco);
    w.prepare("update characters set data=? where id=?")
      .run(JSON.stringify({ for: 5, tal: 3, __xp: xpSnapshot, __pontos: pontosSnapshot }), idSnap);
    w.close();
  }
  const snap = await req(base, "POST", `/campaigns/${campId}/snapshots`, { cookie: cookieMestre, body: { description: "teste #162" } });
  check(snap.status === 201, `criar snapshot ${snap.status}`);
  const snapId = snap.json?.id;
  // adultera o banco após o snapshot
  {
    const w = abrirDb(banco);
    w.prepare("update characters set data=? where id=?").run(JSON.stringify({ for: 5 }), idSnap);
    w.close();
  }
  const rest = await req(base, "POST", `/campaigns/${campId}/snapshots/${snapId}/restaurar`, {
    cookie: cookieMestre, body: { confirmacao: "RESTAURAR" },
  });
  check(rest.status === 200, `restaurar snapshot ${rest.status}: ${JSON.stringify(rest.json)?.slice(0, 200)}`);
  const aposRestore = comDb(banco, (db) => JSON.parse(db.prepare("select data from characters where id=?").get(idSnap).data));
  check(aposRestore.__xp?.saldo === 777 && aposRestore.__xp.historico.length === 1, "snapshot interno: saldo+histórico preservados");
  check(JSON.stringify(aposRestore.__xp.financiado) === JSON.stringify({ tal: [0, 1, 2] }), "snapshot interno: financiado preservado");
  check(aposRestore.__pontos?.selo?.hash === "selo-legitimo" && aposRestore.__pontos.bonus === -50, "snapshot interno: selo e bônus preservados INTEGRALMENTE");

  // ---------- roundtrip: exportar → importar documenta remoção do selo ----------
  // o estado atual da campanha original JÁ contém selo legítimo? Não —
  // o snapshot restaurou o estado com selo. Exporta e reimporta (substituir)
  // → selo sai (remoção intencional), XP/pontos válidos permanecem.
  const exp2 = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
  const pacoteRound = exp2.json;
  const impRound = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteRound, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  check(impRound.status === 200, `roundtrip substituir ${impRound.status}`);
  check(impRound.json?.saneamento?.totais?.selosRemovidos >= 1, "roundtrip: selo removido intencionalmente");
  const aposRound = comDb(banco, (db) => JSON.parse(db.prepare("select data from characters where id=?").get(idSnap).data));
  check(aposRound.__xp?.saldo === 777 && aposRound.__xp.historico.length === 1, "roundtrip: ledger válido preservado");
  check(aposRound.__pontos?.selo === null && aposRound.__pontos.bonus === -50, "roundtrip: selo fora, bônus mantido");

  // ---------- campoSchema: id reservado ----------
  check(!campoSchema.safeParse({ id: "__xp", label: "x", tipo: "inteiro" }).success, "campoSchema rejeita id '__xp'");
  check(!campoSchema.safeParse({ id: "__for", label: "x", tipo: "inteiro" }).success, "campoSchema rejeita id '__for'");
  check(campoSchema.safeParse({ id: "for", label: "x", tipo: "inteiro" }).success, "campoSchema aceita id normal");

  // ---------- auditoria registra saneamento ----------
  const auditoria = comDb(banco, (db) =>
    db.prepare("select detail from audit_logs where action='campanha.importada' order by created_at desc limit 1").get());
  check(!!auditoria && JSON.stringify(auditoria.detail ?? "").includes("saneamento"), "audit() campanha.importada inclui saneamento");

  console.log(`\n${ok} ok, ${falhas} falhas`);
  if (falhas) process.exitCode = 1;
} catch (e) {
  console.error("ERRO FATAL:", e);
  process.exitCode = 1;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(dir);
}
