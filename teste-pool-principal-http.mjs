// Regressão HTTP do bug da pool Principal: uma campanha configurada via
// PUT /regras/config com pools[{id:"principal",pontos:31}] rejeitava a ficha
// do jogador com "pontos insuficientes (saldo -31)" porque pontosEfetivos
// zerava o orçamento declarado. Aqui o fluxo real é exercido: mestre
// configura regras → template publicado → jogador cria personagem →
// PATCH da ficha → servidor valida e salva.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, encerrarServidor } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-pool-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const poolDe = async (cookie, charId, poolId = "principal") => {
  const f = await req(BASE, "GET", `/characters/${charId}`, { cookie });
  return f.json?.ficha?.pontos?.pools?.find((p) => p.id === poolId) ?? null;
};

try {
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Pool Principal", jogadores: { jogador1: "jog_pool" } });
  const CID = c.campId, M = c.cookieMestre, J = c.jogadores.jogador1.cookie;

  // ===== 1. Config real via API: Principal declarada com 31 + reserva =====
  sec("Configuração via PUT /regras/config");
  const cfg1 = await req(BASE, "PUT", `/campaigns/${CID}/regras/config`, {
    cookie: M,
    body: {
      pontos: {
        habilitado: true,
        pontosIniciais: 0,
        pools: [
          { id: "principal", nome: "Principal", pontos: 31 },
          { id: "vantagens", nome: "Vantagens", pontos: 5 },
        ],
        custos: {},
      },
      pontosExtras: 0,
      transferivelEntreReservas: false,
      transferencias: [],
    },
  });
  t("PUT /regras/config aceito", cfg1.status === 200, `status=${cfg1.status} ${JSON.stringify(cfg1.json).slice(0, 200)}`);

  // ===== 2. Template com campo de custo fixo 31 e campo em reserva =====
  sec("Template de ficha");
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Pool" } });
  const tid = mod.json?.modelo?.id, vid = mod.json?.modelo?.versionId;
  t("template criado", !!tid && !!vid, JSON.stringify(mod.json).slice(0, 200));
  // estrutura.pontos carrega a config legada (fallback) usada no cenário 5.
  const estrutura = {
    versao: 1,
    pontos: { habilitado: true, pontosIniciais: 0, pools: [{ id: "principal", nome: "Principal", pontos: 31 }], custos: {} },
    secoes: [{
      id: "s1", titulo: "Principal", ordem: 0,
      campos: [
        { id: "f-nivel", label: "Nível especial", tipo: "inteiro", padrao: 0, custoPontos: 31, obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
        { id: "f-van", label: "Vantagem extra", tipo: "inteiro", padrao: 0, custoPontos: 3, reservaPontos: "vantagens", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
      ],
    }],
  };
  const put = await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  t("estrutura salva", put.status === 200, `status=${put.status} ${JSON.stringify(put.json).slice(0, 200)}`);
  const pub = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
  t("template publicado", pub.status === 200, `status=${pub.status} ${JSON.stringify(pub.json).slice(0, 200)}`);

  const novoChar = async (nome) => {
    const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J, body: { name: nome, templateVersionId: vid } });
    const id = pj.json?.personagem?.id ?? pj.json?.id;
    t(`personagem ${nome} criado`, !!id, JSON.stringify(pj.json).slice(0, 200));
    return id;
  };

  // ===== 3. Bug original: gastar exatamente 31 deve salvar (saldo 0) =====
  sec("Gasto exato da pool Principal declarada");
  const charA = await novoChar("PJ Pool Exato");
  const patchA = await req(BASE, "PATCH", `/characters/${charA}`, { cookie: J, body: { data: { "f-nivel": 1 } } });
  t("PATCH gastando 31 pontos → 200 (bug retornava 400 saldo -31)", patchA.status === 200, `status=${patchA.status} ${JSON.stringify(patchA.json).slice(0, 300)}`);
  const poolA = await poolDe(J, charA);
  t("pool Principal: disponiveis 31, gastos 31, saldo 0",
    poolA?.disponiveis === 31 && poolA?.gastos === 31 && poolA?.saldo === 0,
    JSON.stringify(poolA));

  // ===== 4. Estouro real continua rejeitado =====
  sec("Estouro da pool continua bloqueado");
  const charB = await novoChar("PJ Pool Estouro");
  const patchB = await req(BASE, "PATCH", `/characters/${charB}`, { cookie: J, body: { data: { "f-nivel": 2 } } });
  t("PATCH gastando 62 > 31 → 400", patchB.status === 400, `status=${patchB.status}`);
  const msgB = JSON.stringify(patchB.json);
  t("erro menciona pontos insuficientes", /ponto/i.test(msgB), msgB.slice(0, 300));

  // ===== 5. Reservas independentes: Vantagens não invadem Principal =====
  sec("Reservas independentes sem transferência");
  const charC = await novoChar("PJ Pool Reservas");
  const patchC = await req(BASE, "PATCH", `/characters/${charC}`, { cookie: J, body: { data: { "f-nivel": 1, "f-van": 1 } } });
  t("PATCH nível 31 + vantagem 3 → 200", patchC.status === 200, `status=${patchC.status} ${JSON.stringify(patchC.json).slice(0, 300)}`);
  const poolC = await poolDe(J, charC);
  const vanC = await poolDe(J, charC, "vantagens");
  t("Principal saldo 0 após gastar 31", poolC?.saldo === 0, JSON.stringify(poolC));
  t("Vantagens: disponiveis 5, gastos 3, saldo 2 — sem uso indevido da Principal",
    vanC?.disponiveis === 5 && vanC?.gastos === 3 && vanC?.saldo === 2, JSON.stringify(vanC));

  // ===== 6. Aditivo real: declarada + iniciais + extras + bônus =====
  sec("Orçamento aditivo via fluxo real (config + endpoint /pontos)");
  const cfg2 = await req(BASE, "PUT", `/campaigns/${CID}/regras/config`, {
    cookie: M,
    body: {
      pontos: {
        habilitado: true,
        pontosIniciais: 2,
        pools: [
          { id: "principal", nome: "Principal", pontos: 31 },
          { id: "vantagens", nome: "Vantagens", pontos: 5 },
        ],
        custos: {},
      },
      pontosExtras: 3,
      transferivelEntreReservas: false,
      transferencias: [],
    },
  });
  t("PUT /regras/config com iniciais+extras", cfg2.status === 200, `status=${cfg2.status}`);
  const charD = await novoChar("PJ Pool Aditivo");
  const bonus = await req(BASE, "POST", `/characters/${charD}/pontos`, {
    cookie: M, body: { acao: "conceder", quantidade: 4, motivo: "Bônus individual de teste" },
  });
  t("mestre concede +4 de bônus", bonus.status === 200, `status=${bonus.status} ${JSON.stringify(bonus.json).slice(0, 200)}`);
  const patchD = await req(BASE, "PATCH", `/characters/${charD}`, { cookie: J, body: { data: { "f-nivel": 1 } } });
  t("PATCH gastando 31 → 200", patchD.status === 200, `status=${patchD.status} ${JSON.stringify(patchD.json).slice(0, 300)}`);
  const poolD = await poolDe(J, charD);
  // 31 declarados + 2 iniciais + 3 extras + 4 bônus = 40; gasto 31 → saldo 9
  t("disponiveis 40, gastos 31, saldo 9",
    poolD?.disponiveis === 40 && poolD?.gastos === 31 && poolD?.saldo === 9,
    JSON.stringify(poolD));

  // ===== 7. Fallback legado: regras desabilitadas → estrutura.pontos =====
  sec("Fallback da estrutura da ficha (regras de pontos desabilitadas)");
  const cfg3 = await req(BASE, "PUT", `/campaigns/${CID}/regras/config`, {
    cookie: M,
    body: { pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} }, pontosExtras: 0 },
  });
  t("PUT /regras/config desabilita pontos do ruleset", cfg3.status === 200, `status=${cfg3.status}`);
  const charE = await novoChar("PJ Pool Legado");
  const patchE = await req(BASE, "PATCH", `/characters/${charE}`, { cookie: J, body: { data: { "f-nivel": 1 } } });
  t("PATCH legado gastando 31 → 200", patchE.status === 200, `status=${patchE.status} ${JSON.stringify(patchE.json).slice(0, 300)}`);
  const poolE = await poolDe(J, charE);
  t("pool da estrutura: saldo 0", poolE?.saldo === 0, JSON.stringify(poolE));
} finally {
  await encerrarServidor(proc);
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
