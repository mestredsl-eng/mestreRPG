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
          { nome: "N4", penalidadeDados: 0, bloqueiaAcoes: false },
          { nome: "N5", penalidadeDados: 0, bloqueiaAcoes: false },
          { nome: "N6", penalidadeDados: 0, bloqueiaAcoes: false },
          { nome: "Quase", penalidadeDados: 0, bloqueiaAcoes: false },
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
        { id: "tal", label: "Talento", tipo: "inteiro", custoProgressivo: [1, 1, 1], semantico: "talento", regra: { kind: "talento", key: "talx" } },
        { id: "cap", label: "Capacidade de Sangue", tipo: "inteiro", custoProgressivo: [1], semantico: "livre", regra: { kind: "caracteristica", key: "cap_sangue" } },
      ],
    }],
    pontos: { habilitado: true, pontosIniciais: 10, pools: [], custos: {} },
  };
  dbw.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(estrutura), tpl.id);

  // elemento real da biblioteca vinculado ao campo "tal" — a prova de
  // financiamento (B2) exige kind:key existente nas regras da campanha
  const rsAtivo = dbw.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
  const configRegras = JSON.parse(rsAtivo.config || "{}");
  configRegras.sangue = { habilitado: true, campoCapacidadeId: "cap", capacidade: { modo: "valor" } };
  dbw.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(configRegras), rsAtivo.id);
  dbw.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
    .run(randomUUID(), rsAtivo.id, "talento", "talx", "Talento X", "{}", Date.now(), Date.now());
  dbw.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
    .run(randomUUID(), rsAtivo.id, "caracteristica", "cap_sangue", "Capacidade de Sangue", "{}", Date.now(), Date.now());

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
  // evento de compra legítimo: débito exato do custo REAL das regras
  // (custoProgressivo [1,1,1] → toda transição +1 custa 1 XP), transição
  // +1 nível, kind/key do elemento "talento:talx" vinculado ao campo "tal"
  const evCompra = (campoId, nivelAnterior, custoXp, saldo, extraCompra = {}) => ({
    em: AGORA, tipo: "compra", quantidade: -custoXp, motivo: `Compra ${campoId}`,
    autorId: null, autorNome: null, saldoResultante: saldo,
    compra: { kind: "talento", key: "talx", nome: "Talento X", campoId, nivelAnterior, nivelNovo: nivelAnterior + 1, custoXp, ...extraCompra },
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
  const membMestreId = c.membMestre;
  const inserirPersonagem = (nome, data, isNpc = 0) => {
    const id = randomUUID();
    dbw.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, campId, isNpc ? membMestreId : membershipId, tpl.id, nome, JSON.stringify(data), "{}", isNpc ? "aprovada" : "aprovada", isNpc, Date.now(), Date.now());
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
      saldo: 4,
      historico: [
        evXp(3, 3, { autorId: adminId, autorNome: "Nome Falso" }),
        evXp(1, 4, { autorId: "usuario-inexistente", autorNome: "Fantasma" }),
      ],
    },
  });
  // --- regressões B1: validação estrita de eventos XP ---
  ids.xpQtdZero = inserirPersonagem("ATQ xp qtd zero", {
    for: 5,
    __xp: { saldo: 5, historico: [evXp(5, 5), { ...evXp(1, 6), quantidade: 0, saldoResultante: 6 }] },
  });
  ids.xpSaldoNeg = inserirPersonagem("ATQ xp saldo negativo", {
    for: 5,
    __xp: { saldo: 0, historico: [evXp(5, -5)] },
  });
  ids.xpCompraSemObjeto = inserirPersonagem("ATQ xp compra s/ objeto", {
    for: 5,
    __xp: { saldo: 7, historico: [evXp(10, 10), { ...evXp(-3, 7), tipo: "compra" }] },
  });
  ids.xpCompraTransicao = inserirPersonagem("ATQ xp compra transição", {
    for: 5,
    __xp: {
      saldo: 7,
      historico: [
        evXp(10, 10),
        { ...evCompra("tal", 0, 3, 7), compra: { kind: "campo", key: "tal", nome: "Talento", campoId: "tal", nivelAnterior: 0, nivelNovo: 2, custoXp: 3 } },
      ],
    },
  });
  ids.xpHistoricoAusente = inserirPersonagem("ATQ xp histórico ausente", { for: 5, __xp: { saldo: 0 } });

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
  // B2: cada índice financiado exige evento de compra correspondente
  // na cadeia retida (campoId + nivelAnterior == índice).
  const ledgerComprasTal = {
    saldo: 7,
    historico: [
      evXp(10, 10),
      evCompra("tal", 0, 1, 9),
      evCompra("tal", 1, 1, 8),
      evCompra("tal", 2, 1, 7),
    ],
  };
  ids.finOk = inserirPersonagem("ATQ fin ok", {
    for: 5, tal: 3, __xp: { ...ledgerComprasTal, financiado: { tal: [0, 1] } },
  });
  ids.finInvalido = inserirPersonagem("ATQ fin inválido", {
    for: 5, tal: 3, __xp: { ...ledgerCustom([10]), financiado: { tal: "legado-x", fantasma: [0] } },
  });
  ids.finLegado = inserirPersonagem("ATQ fin legado", {
    for: 5, tal: 3, __xp: { ...ledgerComprasTal, financiado: { tal: 2 } }, // → índices [1,2], ambos comprovados
  });
  ids.finSemProva = inserirPersonagem("ATQ fin sem prova", {
    for: 5, tal: 3, __xp: { ...ledgerCustom([10]), financiado: { tal: [0, 1, 2] } }, // sem eventos de compra
  });
  ids.xpCompraValida = inserirPersonagem("ATQ xp compra válida", {
    for: 5, tal: 3, __xp: { ...ledgerComprasTal },
  });
  // Exceção estreita #186: a compra de Característica financia apenas
  // o campo configurado como capacidade de Sangue no mesmo ruleset.
  ids.xpCompraCapacidadeSangue = inserirPersonagem("ATQ XP capacidade de Sangue", {
    for: 5, tal: 3, cap: 1,
    __xp: {
      saldo: 9,
      historico: [
        evXp(10, 10),
        evCompra("cap", 0, 1, 9, {
          kind: "caracteristica",
          key: "cap_sangue",
          nome: "Capacidade de Sangue",
        }),
      ],
      financiado: { cap: [0] },
    },
  });

  // --- B1: âncora e cadeias longas ---
  // 501 eventos coerentes mas PRIMEIRO saldoResultante não nasce do zero
  // e sem `ancora` declarada → saldo inicial arbitrário → inválido
  ids.xpTruncForjado = inserirPersonagem("ATQ xp trunc forjado", {
    for: 5,
    __xp: {
      saldo: 501,
      historico: Array.from({ length: 501 }, (_, i) => evXp(1, 500 + i + 1)),
    },
  });
  // 600 eventos coerentes desde o zero, mas `ancora` declarada falsa → inválido
  ids.xpAncoraFalsa = inserirPersonagem("ATQ xp âncora falsa", {
    for: 5,
    __xp: { ...mkLedgerN(600), ancora: 999 },
  });
  // 501 eventos com ruptura no índice 300 → prefixo demonstrável (299) mantido
  ids.xpHist501Quebra = inserirPersonagem("ATQ xp hist 501 quebra", {
    for: 5,
    __xp: {
      saldo: 300,
      historico: Array.from({ length: 501 }, (_, i) => {
        const s = i < 300 ? i + 1 : i + 206; // quebra no evento 301
        return evXp(1, s);
      }),
    },
  });

  // --- B2: provas de financiamento com custo/campo/elemento reais ---
  // custo inventado: débito ≠ preço real (1 XP por transição) → sem prova
  ids.finCustoInv = inserirPersonagem("ATQ fin custo inventado", {
    for: 5, tal: 3,
    __xp: { saldo: 8, historico: [evXp(10, 10), evCompra("tal", 0, 2, 8)], financiado: { tal: [0] } },
  });
  // compra de OUTRO campo: campoId "for" não é vínculo do elemento talx
  ids.finOutroCampo = inserirPersonagem("ATQ fin outro campo", {
    for: 5, tal: 3,
    __xp: { saldo: 9, historico: [evXp(10, 10), evCompra("for", 0, 1, 9)], financiado: { tal: [0] } },
  });
  // kind/key inexistente na biblioteca da campanha
  ids.finKeyFantasma = inserirPersonagem("ATQ fin key fantasma", {
    for: 5, tal: 3,
    __xp: { saldo: 9, historico: [evXp(10, 10), evCompra("tal", 0, 1, 9, { key: "fantasma" })], financiado: { tal: [0] } },
  });
  // nível novo falsificado (pula um nível) → evento inválido → ledger cai
  ids.finNivelFalso = inserirPersonagem("ATQ fin nível falso", {
    for: 5, tal: 3,
    __xp: {
      saldo: 9,
      historico: [
        evXp(10, 10),
        { ...evCompra("tal", 0, 1, 9), compra: { kind: "talento", key: "talx", nome: "Talento X", campoId: "tal", nivelAnterior: 0, nivelNovo: 2, custoXp: 1 } },
      ],
      financiado: { tal: [0] },
    },
  });

  // --- casos vida/retrato/npc ---
  ids.hpAlto = inserirPersonagem("ATQ hp alto", { for: 5, __hp: { atual: 999, historico: [{ em: AGORA, tipo: "inicial", quantidade: 150, motivo: null, autorId: null, autorNome: null }] } });
  ids.hpOk = inserirPersonagem("ATQ hp ok", { for: 5, __hp: { atual: 80, historico: [] } });
  ids.vitFora = inserirPersonagem("ATQ vitalidade fora", { for: 5, __vitalidade: { nivel: 99, nivelManual: 50, historico: [{ em: AGORA, nivelAnterior: 0, nivelNovo: 99, motivo: null, autorId: null, autorNome: null }] } });
  ids.vitOk = inserirPersonagem("ATQ vitalidade ok", { for: 5, __vitalidade: { nivel: 1 } });
  // B3: alteradoPor forjado (userId inexistente) → limpo
  ids.vitAutor = inserirPersonagem("ATQ vitalidade autoria", {
    for: 5,
    __vitalidade: { nivel: 1, alteradoPor: "usuario-inexistente", alteradoEm: AGORA },
  });
  ids.vitAutorOk = inserirPersonagem("ATQ vitalidade autoria ok", {
    for: 5,
    __vitalidade: { nivel: 1, alteradoPor: adminId, alteradoEm: AGORA },
  });
  // B3: histórico de vitalidade com campos arbitrários/ inválidos —
  // whitelist deve reconstruir só o que é comprovável
  ids.vitHist = inserirPersonagem("ATQ vitalidade hist", {
    for: 5,
    __vitalidade: {
      nivel: 1, nivelManual: 1, campoExtra: "hack",
      historico: [
        { em: AGORA, nivelAnterior: 0, nivelNovo: 1, motivo: "ok", autorId: null, autorNome: null, origem: "manual", senha: "x" },
        { em: AGORA, nivelAnterior: 0, nivelNovo: 2, motivo: "forjado", autorId: null, autorNome: null, origem: "hack" },
        { em: AGORA, nivelAnterior: 1, nivelNovo: 1, motivo: "conv falsa", autorId: null, autorNome: null, origem: "conversao-ferimento" },
        { em: AGORA, nivelAnterior: 0, nivelNovo: 2, motivo: "limiar ruim", autorId: null, autorNome: null, origem: "manual", limiares: [{ ate: 150, nivel: 2 }] },
      ],
    },
  });
  // B3 + privacidade: NPC com vitalidade forjada fora da escala —
  // a leitura pública do jogador não pode exibir penalidade amplificada
  ids.npcVitForjado = inserirPersonagem("ATQ npc vitalidade forjada", {
    for: 5,
    __npcVisivel: { visivel: true },
    __vitalidade: {
      nivel: 99, nivelManual: 99,
      historico: [{ em: AGORA, nivelAnterior: 0, nivelNovo: 2, motivo: null, autorId: null, autorNome: null, origem: "conversao-ferimento", limiares: [{ ate: 100, nivel: 2 }] }],
    },
    __hp: { atual: 9999, historico: [{ em: AGORA, tipo: "inicial", quantidade: 9999, motivo: null, autorId: null, autorNome: null, extra: "x" }] },
  }, 1);
  // B3 + privacidade: NPC com `limiares` forjado DENTRO da escala de 7
  // níveis — o snapshot de limiares é autoridade do servidor e NUNCA
  // pode vir do pacote; sem ele a leitura pública cai no piso manual.
  ids.npcVitLimiares = inserirPersonagem("ATQ npc vitalidade limiares", {
    for: 5,
    __npcVisivel: { visivel: true },
    __vitalidade: {
      nivel: 2, nivelManual: 1,
      historico: [{ em: AGORA, nivelAnterior: 0, nivelNovo: 2, motivo: null, autorId: adminId, autorNome: "Falso", origem: "conversao-ferimento", limiares: [{ ate: 100, nivel: 6 }] }],
    },
  }, 1);
  // B4: histórico de HP com eventos inválidos — whitelist + contagem
  ids.hpHist = inserirPersonagem("ATQ hp histórico", {
    for: 5,
    __hp: {
      atual: 50,
      historico: [
        { em: AGORA, tipo: "inicial", quantidade: 150, motivo: "HP inicial", autorId: null, autorNome: null },
        { em: "data-ruim", tipo: "dano", quantidade: -10, motivo: null, autorId: null, autorNome: null },
        { em: AGORA, tipo: "explosao", quantidade: -50, motivo: null, autorId: null, autorNome: null },
        { em: AGORA, tipo: "dano", quantidade: "cem", motivo: null, autorId: null, autorNome: null },
        { em: AGORA, tipo: "recuperacao", quantidade: 20, motivo: "cura", autorId: "ninguem", autorNome: "Fantasma", extra: "x" },
      ],
    },
  });
  ids.retratoAlheio = inserirPersonagem("ATQ retrato alheio", { for: 5, __retrato: { tipo: "arquivo", arquivoId: "arquivo-de-outro-lugar" } });
  ids.retratoOk = inserirPersonagem("ATQ retrato ok", { for: 5, __retrato: { tipo: "arquivo", arquivoId: fileId } });
  // B4: retratos da galeria oficial — válido preservado, inválido removido
  ids.retratoGaleria = inserirPersonagem("ATQ retrato galeria", { for: 5, __retrato: { tipo: "galeria", id: "homem-01" } });
  ids.retratoGaleriaInv = inserirPersonagem("ATQ retrato galeria inválido", { for: 5, __retrato: { tipo: "galeria", id: "nao-existe" } });
  ids.retratoTipo = inserirPersonagem("ATQ retrato tipo", { for: 5, __retrato: { tipo: "url", url: "https://externo.invalid/x.png" } });
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
  check(saneNova?.totais?.ledgersXpInvalidos >= 6, `totais ledgers inválidos ${saneNova?.totais?.ledgersXpInvalidos}`);
  check(saneNova?.totais?.selosRemovidos >= 1, "selo removido contabilizado");
  check(saneNova?.totais?.bonusAjustados >= 3, `bônus ajustados ${saneNova?.totais?.bonusAjustados}`);
  check(saneNova?.totais?.hpCorrigidos >= 1 && (saneNova?.totais?.vitalidadeCorrigidas >= 1 || saneNova?.totais?.vitalidadeRemovidas >= 1), "hp/vitalidade saneados");
  check(saneNova?.totais?.retratoRemovido !== undefined || saneNova?.totais?.retratosRemovidos >= 1, "retrato removido contabilizado");
  check(saneNova?.totais?.npcVisivelRemovidos >= 1, "npcVisivel removido contabilizado");
  check(saneNova?.totais?.financiadoRejeitados >= 4, `financiado rejeitados ${saneNova?.totais?.financiadoRejeitados}`);
  check(saneNova?.totais?.hpHistoricoDescartados >= 3, `hp histórico descartados ${saneNova?.totais?.hpHistoricoDescartados}`);
  check(saneNova?.totais?.vitalidadeHistoricoDescartados >= 2, `vitalidade histórico descartados ${saneNova?.totais?.vitalidadeHistoricoDescartados}`);

  const personagemNa = (nome) => comDb(banco, (db) => {
    const r = db.prepare("select id,data from characters where campaign_id=? and name=?").get(cidNova, nome);
    return r ? { id: r.id, data: JSON.parse(r.data) } : null;
  });

  // --- asserts persistidos: __xp (modo nova = ids remapeados →
  // assinaturas inválidas → proveniência externa NÃO demonstrável →
  // fail-closed: TODO ledger XP zerado, mesmo os estruturalmente
  // perfeitos. É o comportamento correto: pacote de outra instalação
  // não pode provar autoria do ledger. A preservação de ledgers
  // legítimos é assertada no modo "substituir" (ids intactos). ---
  let p = personagemNa("ATQ xp válido");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "B1: ledger sem proveniência → zerado (fail-closed)");
  check(p?.data.for === 5, "campos normais preservados");
  p = personagemNa("ATQ histórico 501");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0 && p.data.__xp.ancora === undefined, "B1: 501 eventos sem assinatura → zerado");
  p = personagemNa("ATQ xp hist 501 quebra");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "B1: ruptura sem assinatura → zerado");
  p = personagemNa("ATQ saldo sem histórico");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "saldo sem histórico zerado");
  p = personagemNa("ATQ xp autoria");
  check(p?.data.__xp?.historico.length === 0, "B1: autoria forjada some com o ledger não demonstrável");

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

  // --- asserts persistidos: financiado (modo nova → sem proveniência,
  // TODO financiado é descartado junto com o ledger) ---
  p = personagemNa("ATQ fin ok");
  check(p?.data.__xp?.financiado === undefined && p.data.__xp.saldo === 0, "B2: financiado sem proveniência descartado");
  p = personagemNa("ATQ fin legado");
  check(p?.data.__xp?.financiado === undefined, "B2: legado sem proveniência descartado");
  p = personagemNa("ATQ fin custo inventado");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.financiado === undefined, "B2: custo inventado → ledger zerado sem prova");
  p = personagemNa("ATQ xp compra válida");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "B1: compra legítima sem assinatura → zerada");

  // --- asserts persistidos: vida/retrato/npc ---
  p = personagemNa("ATQ hp alto");
  check(p?.data.__hp?.atual === 150, "HP acima do máximo corrigido para o teto (for=5 → 150)");
  p = personagemNa("ATQ hp ok");
  check(p?.data.__hp?.atual === 80, "HP válido preservado");
  p = personagemNa("ATQ vitalidade fora");
  check(p?.data.__vitalidade === undefined, "B3: vitalidade fora da escala removida (fallback conservador)");
  p = personagemNa("ATQ vitalidade ok");
  check(p?.data.__vitalidade?.nivel === 1, "vitalidade válida preservada");
  p = personagemNa("ATQ vitalidade autoria");
  check(p?.data.__vitalidade?.alteradoPor === null, "B3: alteradoPor forjado limpo");
  p = personagemNa("ATQ vitalidade autoria ok");
  check(p?.data.__vitalidade?.alteradoPor === adminId, "B3: alteradoPor conhecido preservado");
  p = personagemNa("ATQ vitalidade hist");
  check(p?.data.__vitalidade?.nivel === 1 && p.data.__vitalidade.nivelManual === 1, "B3: nível válido preservado");
  check(p?.data.__vitalidade?.campoExtra === undefined, "B3: campo arbitrário removido");
  check(p?.data.__vitalidade?.historico?.length === 2, "B3: eventos inválidos de vitalidade descartados (manual ok + manual c/ limiares saneado)");
  check(p?.data.__vitalidade?.historico?.[1]?.limiares === undefined, "B3: limiares externos removidos do evento");
  check(p?.data.__vitalidade?.historico?.[0]?.senha === undefined && p?.data.__vitalidade?.historico?.[0]?.origem === "manual", "B3: whitelist remove campos arbitrários do evento");
  p = personagemNa("ATQ hp histórico");
  check(p?.data.__hp?.historico?.length === 2, "B4: eventos de HP inválidos descartados");
  check(p?.data.__hp?.historico?.[1]?.autorId === null && p?.data.__hp?.historico?.[1]?.autorNome === null && p?.data.__hp?.historico?.[1]?.extra === undefined, "B4: autoria forjada limpa e whitelist aplicada");
  p = personagemNa("ATQ retrato alheio");
  check(p?.data.__retrato === undefined, "retrato para arquivo inexistente removido");
  p = personagemNa("ATQ retrato ok");
  check(p?.data.__retrato?.arquivoId === p?.id ? false : typeof p?.data.__retrato?.arquivoId === "string", "retrato válido preservado (id remapeado)");
  p = personagemNa("ATQ retrato galeria");
  check(p?.data.__retrato?.tipo === "galeria" && p?.data.__retrato?.id === "homem-01", "B4: retrato da galeria oficial preservado");
  p = personagemNa("ATQ retrato galeria inválido");
  check(p?.data.__retrato === undefined, "B4: id de galeria inexistente removido");
  p = personagemNa("ATQ retrato tipo");
  check(p?.data.__retrato === undefined, "B4: tipo de retrato desconhecido removido");
  p = personagemNa("ATQ npc malformado");
  check(p?.data.__npcVisivel === undefined, "npcVisivel malformado removido");
  p = personagemNa("ATQ npc ok");
  check(p?.data.__npcVisivel?.visivel === true, "npcVisivel válido preservado");
  p = personagemNa("ATQ npc vitalidade forjada");
  check(p?.data.__vitalidade === undefined, "B3: vitalidade forjada de NPC removida no banco");
  check(p?.data.__hp?.atual === 150, "B3: HP forjado de NPC limitado ao máximo");
  check(p?.data.__npcVisivel?.visivel === true, "B3: npcVisivel válido preservado para leitura pública");
  // leitura pública do jogador: vitalidade forjada NÃO pode aparecer
  const leituraNpc = await req(base, "GET", `/characters/${p.id}`, { cookie: jogadores.jogador1.cookie });
  check(leituraNpc.status === 200, `GET NPC público ${leituraNpc.status}`);
  check(leituraNpc.json?.ficha?.vida?.vitalidade?.nivel === 0, `B3: vitalidade pública do NPC não amplificada (nivel=${leituraNpc.json?.ficha?.vida?.vitalidade?.nivel})`);
  // NPC com limiares forjados dentro da escala: o pacote não pode
  // definir o snapshot que a leitura pública usa como teto — sem
  // limiares o evento de conversão cai no fallback conservador (piso).
  const pLim = personagemNa("ATQ npc vitalidade limiares");
  check(pLim?.data.__vitalidade?.historico?.[0]?.limiares === undefined, "B3: limiares forjados removidos do evento de NPC");
  const leituraLim = await req(base, "GET", `/characters/${pLim.id}`, { cookie: jogadores.jogador1.cookie });
  check(leituraLim.status === 200, `GET NPC limiares ${leituraLim.status}`);
  check(leituraLim.json?.ficha?.vida?.vitalidade?.nivel === 1, `B3: leitura pública de NPC não amplificada por limiares forjados (nivel=${leituraLim.json?.ficha?.vida?.vitalidade?.nivel})`);

  // --- consequência econômica via calcularPontos (modo nova: SEM
  // proveniência → todo financiado descartado → custo integral) ---
  const calcNa = (nome, alvo = cidNova) => comDb(banco, (db) => {
    const row = db.prepare("select c.data, sv.structure from characters c join sheet_versions sv on sv.id=c.template_version_id where c.campaign_id=? and c.name=?").get(alvo, nome);
    return calcularPontos(JSON.parse(row.structure), JSON.parse(row.data));
  });
  check(calcNa("ATQ fin ok").pools[0]?.gastos === 3, "B1/B2: sem proveniência → financiado descartado → custo integral");
  check(calcNa("ATQ fin legado").pools[0]?.gastos === 3, "B1/B2: legado sem prova → custo integral");

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

  // --- caminho CONFIÁVEL (assinatura válida, ids intactos): a
  // validação estrutural continua valendo — forjas sem cadeia real
  // caem; ledgers legítimos e compras provadas são preservados ---
  p = personagemOrig("ATQ xp válido");
  check(p?.data.__xp?.saldo === 5 && p.data.__xp.historico.length === 3, "substituir: ledger legítimo assinado preservado");
  p = personagemOrig("ATQ saldo sem histórico");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "substituir: saldo sem histórico zerado");
  p = personagemOrig("ATQ saldo divergente");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "substituir: saldo divergente zerado");
  p = personagemOrig("ATQ cadeia quebra");
  check(p?.data.__xp?.saldo === 10 && p.data.__xp.historico.length === 1, "substituir: quebra → prefixo demonstrável");
  p = personagemOrig("ATQ divergência final");
  check(p?.data.__xp?.saldo === 0, "substituir: divergência final zerada");
  p = personagemOrig("ATQ histórico 499");
  check(p?.data.__xp?.historico.length === 499 && p.data.__xp.saldo === 499, "substituir: 499 preservados");
  p = personagemOrig("ATQ histórico 500");
  check(p?.data.__xp?.historico.length === 500 && p.data.__xp.saldo === 500, "substituir: 500 preservados");
  p = personagemOrig("ATQ histórico 501");
  check(p?.data.__xp?.historico.length === 500 && p.data.__xp.saldo === 501 && p.data.__xp.ancora === 1, "substituir: 501 → 500 + âncora=1");
  p = personagemOrig("ATQ xp trunc forjado");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "substituir: 501 sem âncora zero → rejeitado");
  p = personagemOrig("ATQ xp âncora falsa");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "substituir: âncora divergente rejeitada");
  p = personagemOrig("ATQ xp hist 501 quebra");
  check(p?.data.__xp?.historico.length === 300 && p.data.__xp.saldo === 300, "substituir: ruptura longa → prefixo 300");
  p = personagemOrig("ATQ eventos inválidos");
  check(p?.data.__xp?.historico.length === 3 && p.data.__xp.saldo === 5, "substituir: eventos inválidos descartados");
  p = personagemOrig("ATQ xp autoria");
  check(p?.data.__xp?.historico[0]?.autorNome === "Mestre Teste" && p?.data.__xp?.historico[1]?.autorId === null, "substituir: autoria resolvida/limpa");
  p = personagemOrig("ATQ xp qtd zero");
  check(p?.data.__xp?.saldo === 5 && p.data.__xp.historico.length === 1, "substituir: quantidade zero descartada");
  p = personagemOrig("ATQ xp histórico ausente");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "substituir: histórico ausente não vira vazio");
  p = personagemOrig("ATQ xp compra válida");
  check(p?.data.__xp?.saldo === 7 && p.data.__xp.historico.length === 4, "substituir: compra legítima preservada");
  p = personagemOrig("ATQ fin ok");
  check(JSON.stringify(p?.data.__xp?.financiado?.tal) === "[0,1]", "substituir: financiado comprovado preservado");
  p = personagemOrig("ATQ XP capacidade de Sangue");
  check(
    p?.data.__xp?.saldo === 9 &&
      JSON.stringify(p?.data.__xp?.financiado?.cap) === "[0]",
    "substituir: prova da Característica vinculada à capacidade de Sangue preservada",
  );
  p = personagemOrig("ATQ fin legado");
  check(JSON.stringify(p?.data.__xp?.financiado?.tal) === "[1,2]", "substituir: legado→índices comprovados");
  p = personagemOrig("ATQ fin sem prova");
  check(p?.data.__xp?.financiado === undefined, "substituir: sem prova de compra → rejeitado");
  p = personagemOrig("ATQ fin custo inventado");
  check(p?.data.__xp?.saldo === 8 && p.data.__xp.financiado === undefined, "substituir: custoXp divergente → sem prova");
  p = personagemOrig("ATQ fin outro campo");
  check(p?.data.__xp?.saldo === 9 && p.data.__xp.financiado === undefined, "substituir: compra de outro campo → sem prova");
  p = personagemOrig("ATQ fin key fantasma");
  check(p?.data.__xp?.saldo === 9 && p.data.__xp.financiado === undefined, "substituir: kind/key inexistente → sem prova");
  p = personagemOrig("ATQ fin nível falso");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.financiado === undefined, "substituir: transição falsificada → ledger cai");
  p = personagemOrig("ATQ selo forjado");
  check(p?.data.__pontos?.selo === null, "substituir: selo removido no banco");
  p = personagemOrig("ATQ histórico 501");
  check(p?.data.__xp?.historico.length === 500 && p.data.__xp.saldo === 501, "substituir: 501 → 500 no banco");
  p = personagemOrig("ATQ fin inválido");
  check(p?.data.__xp?.financiado === undefined, "substituir: financiado rejeitado no banco");

  // consequência econômica no caminho confiável
  check(calcNa("ATQ fin ok", campId).pools[0]?.gastos === 1, "substituir: financiado [0,1] → só 2→3 custa");
  check(calcNa("ATQ fin legado", campId).pools[0]?.gastos === 1, "substituir: legado [1,2] → só 0→1 custa");
  check(calcNa("ATQ fin capacidade de Sangue", campId).pools[0]?.gastos === 3, "substituir: capacidade financiada por XP não é cobrada novamente em pontos");
  check(calcNa("ATQ fin sem prova", campId).pools[0]?.gastos === 3, "substituir: sem prova → custo integral");
  check(calcNa("ATQ fin custo inventado", campId).pools[0]?.gastos === 3, "substituir: custo inventado → custo integral");

  // ---------- ataques à autenticidade (B1/B2) ----------
  // 1) pacote com TODOS os sigs removidos → proveniência zero → fail-closed
  const pacoteSemSig = JSON.parse(JSON.stringify(pacoteOriginal));
  for (const row of pacoteSemSig.estado.characters ?? []) {
    if (row.data?.__xp && typeof row.data.__xp === "object") delete row.data.__xp.sig;
  }
  const impSemSig = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteSemSig, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  check(impSemSig.status === 200, `importar sem assinatura ${impSemSig.status}`);
  p = personagemOrig("ATQ xp válido");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "ATAQUE: sig removido → ledger zerado");
  p = personagemOrig("ATQ fin ok");
  check(p?.data.__xp?.financiado === undefined, "ATAQUE: financiado sem sig descartado");

  // 2) adultera UM evento depois da exportação → só aquele ledger cai
  const pacoteEvento = JSON.parse(JSON.stringify(pacoteOriginal));
  const alvoEv = (pacoteEvento.estado.characters ?? []).find((r) => r.name === "ATQ xp válido");
  alvoEv.data.__xp.historico[0].saldoResultante = 999;
  const impEv = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteEvento, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  check(impEv.status === 200, `importar evento adulterado ${impEv.status}`);
  p = personagemOrig("ATQ xp válido");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "ATAQUE: evento adulterado → ledger zerado");
  p = personagemOrig("ATQ fin ok");
  check(JSON.stringify(p?.data.__xp?.financiado?.tal) === "[0,1]", "ATAQUE: ledger não tocado permanece assinado");

  // 3) adultera a ÂNCORA depois da exportação → assinatura quebra
  const pacoteAncora = JSON.parse(JSON.stringify(pacoteOriginal));
  const alvoAnc = (pacoteAncora.estado.characters ?? []).find((r) => r.name === "ATQ histórico 501");
  alvoAnc.data.__xp.ancora = 42;
  await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteAncora, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  p = personagemOrig("ATQ histórico 501");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "ATAQUE: âncora adulterada → ledger zerado");

  // 4) adultera regra E custo da compra simultaneamente → fp muda →
  // TODAS as assinaturas invalidam (o pacote não prova as próprias regras)
  const pacoteRegra = JSON.parse(JSON.stringify(pacoteOriginal));
  const defRegra = (pacoteRegra.estado.ruleDefinitions ?? [])[0];
  if (defRegra) defRegra.definition = { ...(defRegra.definition ?? {}), custoProgressivo: [0, 0, 0] };
  const compraRegra = (pacoteRegra.estado.characters ?? []).find((r) => r.name === "ATQ xp compra válida");
  if (compraRegra) for (const ev of compraRegra.data.__xp?.historico ?? []) {
    if (ev.compra) ev.compra.custoXp = 0;
    if (ev.tipo === "compra") ev.quantidade = 0;
  }
  await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteRegra, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  p = personagemOrig("ATQ xp válido");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "ATAQUE: regra adulterada → todas as assinaturas caem");
  p = personagemOrig("ATQ fin ok");
  check(p?.data.__xp?.financiado === undefined, "ATAQUE: financiado cai junto com a regra adulterada");

  // 5) instalação sem chave confiável: rotaciona a chave do servidor —
  // assinaturas antigas não verificam mais (outro "servidor")
  {
    const w = abrirDb(banco);
    w.prepare("delete from server_settings where key='exportacao.chave.xp'").run();
    w.close();
  }
  const impRot = await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteOriginal, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  check(impRot.status === 200, `importar com chave rotacionada ${impRot.status}`);
  p = personagemOrig("ATQ xp válido");
  check(p?.data.__xp?.saldo === 0 && p.data.__xp.historico.length === 0, "ATAQUE: chave diversa → proveniência não verificável → zerado");
  // restaura pacote íntegro para os testes seguintes (re-assinado com a nova chave)
  const exp3 = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
  await req(base, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: exp3.json, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  p = personagemOrig("ATQ xp válido");
  check(p?.data.__xp?.saldo === 0, "pós-rotação: estado zerado permanece até novo export legítimo");

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

  // ---------- replay entre personagens: assinatura A não autentica B ----------
  // Copia o objeto __xp COMPLETO (inclusive sig) de um personagem para outro.
  // A assinatura precisa falhar apenas no alvo B por causa do UUID vinculado.
  const pacoteReplay = JSON.parse(JSON.stringify(pacoteRound));
  const ledgerOrigemReplay = (pacoteReplay.estado.characters ?? []).find((r) => r.id === idSnap);
  const ledgerAlvoReplay = (pacoteReplay.estado.characters ?? []).find((r) => r.name === "ATQ xp compra válida");
  check(
    !!ledgerOrigemReplay?.data?.__xp?.sig && !!ledgerAlvoReplay?.data,
    "replay: pacote contém ledger assinado de A e personagem B",
  );
  if (ledgerOrigemReplay?.data?.__xp?.sig && ledgerAlvoReplay?.data) {
    check(ledgerOrigemReplay.id !== ledgerAlvoReplay.id, "replay: UUIDs de A e B são distintos");
    ledgerAlvoReplay.data.__xp = JSON.parse(JSON.stringify(ledgerOrigemReplay.data.__xp));
    const impReplay = await req(base, "POST", "/campaigns/importar", {
      cookie: cookieMestre,
      body: { pacote: pacoteReplay, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
    });
    check(impReplay.status === 200, `replay: substituir pacote adulterado ${impReplay.status}`);
    if (impReplay.status === 200) {
      const aDepoisReplay = personagemOrig("ATQ xp válido");
      const bDepoisReplay = personagemOrig("ATQ xp compra válida");
      check(aDepoisReplay?.data.__xp?.saldo === 777 && aDepoisReplay.data.__xp.historico.length === 1,
        "replay: ledger original de A continua válido");
      check(bDepoisReplay?.data.__xp?.saldo === 0 && bDepoisReplay.data.__xp.historico.length === 0,
        "replay: ledger assinado copiado de A para B é invalidado");
    }
  }

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
