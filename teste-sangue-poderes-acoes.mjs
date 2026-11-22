// Issue #186 — config.sangue.poderes (custos) e recuperacaoSangue.acoes
// (Descansar/Alimentar-se), contrato aprovado #7055515759.
// Cobre: defaults preservados, custo zero/positivo/inválido, chave de
// Poder inexistente ou de outro kind, ações completas/incompletas/
// inválidas, naturezas mapeadas às ações canônicas, campanha vazia e
// readback de rejeições. Banco 100% descartável.
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("sangue-poderes-acoes");
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

// Insere elementos rule_definitions no rule_set ativo da campanha.
function semearElementos(campId, elementos) {
  const db = abrirDb(BANCO);
  try {
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    if (!rs) throw new Error("rule_set ativo não encontrado");
    const agora = Date.now();
    for (const el of elementos) {
      db.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), rs.id, el.kind, el.key, el.name ?? el.key, null, null, "{}", agora, agora);
    }
    return rs.id;
  } finally { db.close(); }
}

const SANGUE_BASE = {
  habilitado: true,
  campoCapacidadeId: "for",
  capacidade: { modo: "valor" },
};

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bkp") });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Sangue Poderes" });
  // fixture base expõe campo inteiro "for" — capacidade "valor" válida
  semearElementos(c.campId, [
    { kind: "poder", key: "necromancia", name: "Necromancia" },
    { kind: "poder", key: "pirotecnia", name: "Pirotecnia" },
    { kind: "vantagem", key: "foco", name: "Foco" }, // kind errado de propósito
  ]);

  sec("1. Config antiga/ausente — defaults preservados");
  {
    const cfg = await getCfg(c.campId, c.cookieMestre);
    t("sangue default desabilitado", cfg?.sangue?.habilitado === false);
    t("sem poderes por padrão", cfg?.sangue?.poderes === undefined, JSON.stringify(cfg?.sangue?.poderes));
    t("sem acoes por padrão", cfg?.sangue?.recuperacaoSangue?.acoes === undefined);
  }

  sec("2. Poderes — chave deve ser kind=poder do rule_set");
  {
    const r = await putCfg(c.campId, c.cookieMestre, {
      sangue: { ...SANGUE_BASE, poderes: { necromancia: { custo: 2 }, pirotecnia: { custo: 0 } } },
    });
    t("poderes válidos aceitos (custo 2 e 0)", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    const cfg = await getCfg(c.campId, c.cookieMestre);
    t("custos persistidos", cfg?.sangue?.poderes?.necromancia?.custo === 2 && cfg?.sangue?.poderes?.pirotecnia?.custo === 0);

    for (const [nome, poderes] of [
      ["chave inexistente", { fogo_arcano: { custo: 1 } }],
      ["kind não-poder (vantagem)", { foco: { custo: 1 } }],
      ["mistura válida+inválida", { necromancia: { custo: 1 }, foco: { custo: 1 } }],
    ]) {
      const rr = await putCfg(c.campId, c.cookieMestre, { sangue: { ...SANGUE_BASE, poderes } });
      t(`400: ${nome}`, rr.status === 400, `status=${rr.status} ${JSON.stringify(rr.json).slice(0, 140)}`);
    }
    const cfg2 = await getCfg(c.campId, c.cookieMestre);
    t("rejeições não alteraram poderes persistidos",
      cfg2?.sangue?.poderes?.necromancia?.custo === 2 && !("fogo_arcano" in (cfg2?.sangue?.poderes ?? {})),
      JSON.stringify(cfg2?.sangue?.poderes));
  }

  sec("3. Poderes — custo zero/positivo/negativo/NaN/Infinity");
  {
    for (const [nome, custo, esperado] of [
      ["zero", 0, 200],
      ["positivo", 3, 200],
      ["negativo", -1, 400],
      ["NaN", NaN, 400],
      ["Infinity", Infinity, 400],
      ["ausente", undefined, 400], // objeto sem custo
    ]) {
      const rr = await putCfg(c.campId, c.cookieMestre, {
        sangue: { ...SANGUE_BASE, poderes: { pirotecnia: custo === undefined ? {} : { custo } } },
      });
      t(`custo ${nome} → ${esperado}`, rr.status === esperado, `status=${rr.status} ${JSON.stringify(rr.json).slice(0, 120)}`);
    }
  }

  sec("4. Ações — Descansar/Alimentar-se completas e incompletas");
  {
    const completa = await putCfg(c.campId, c.cookieMestre, {
      sangue: {
        ...SANGUE_BASE,
        recuperacaoSangue: {
          habilitado: true,
          acoes: {
            descansar: { habilitada: true, quantidade: 2 },
            alimentar: { habilitada: true, quantidade: 1 },
          },
        },
      },
    });
    t("ambas as ações completas → 200", completa.status === 200, `status=${completa.status} ${JSON.stringify(completa.json).slice(0, 160)}`);
    const cfg = await getCfg(c.campId, c.cookieMestre);
    t("quantidades persistidas", cfg?.sangue?.recuperacaoSangue?.acoes?.descansar?.quantidade === 2
      && cfg?.sangue?.recuperacaoSangue?.acoes?.alimentar?.quantidade === 1);

    for (const [nome, acao, esperado] of [
      ["habilitada sem quantidade", { habilitada: true }, 400],
      ["quantidade zero", { habilitada: true, quantidade: 0 }, 400],
      ["quantidade negativa", { habilitada: true, quantidade: -2 }, 400],
      ["quantidade NaN", { habilitada: true, quantidade: NaN }, 400],
      ["quantidade Infinity", { habilitada: true, quantidade: Infinity }, 400],
      ["sem habilitada", { quantidade: 3 }, 400],
      ["habilitada false sem quantidade", { habilitada: false }, 200],
      ["habilitada false com quantidade (inerte)", { habilitada: false, quantidade: 5 }, 200],
    ]) {
      const rr = await putCfg(c.campId, c.cookieMestre, {
        sangue: { ...SANGUE_BASE, recuperacaoSangue: { habilitado: true, acoes: { descansar: acao } } },
      });
      t(`${nome} → ${esperado}`, rr.status === esperado, `status=${rr.status} ${JSON.stringify(rr.json).slice(0, 140)}`);
    }
    // ação ausente permanece desabilitada — config válida
    const soHabilitado = await putCfg(c.campId, c.cookieMestre, {
      sangue: { ...SANGUE_BASE, recuperacaoSangue: { habilitado: true } },
    });
    t("só flag habilitado (sem acoes) → 200, ações desabilitadas", soHabilitado.status === 200);
  }

  sec("5. Naturezas — mapeamento explícito às ações canônicas");
  {
    const ok = await putCfg(c.campId, c.cookieMestre, {
      sangue: {
        ...SANGUE_BASE,
        campoNaturezaId: undefined,
        naturezas: {
          Humano: { metaHumanoComPoder: true, recuperacao: "descansar" },
          Vampiro: { recuperacao: "alimentar" },
          Lobisomem: { metaHumanoComPoder: false }, // sem ação mapeada
        },
      },
    });
    // fixture base não tem campo de natureza — vínculo não declarado,
    // então naturezas livres são aceitas sem validação de campo
    t("naturezas mapeadas às ações → 200", ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 160)}`);
    const invalida = await putCfg(c.campId, c.cookieMestre, {
      sangue: { ...SANGUE_BASE, naturezas: { X: { recuperacao: "dormir" } } },
    });
    t("recuperacao fora do catálogo → 400", invalida.status === 400, `status=${invalida.status}`);
  }

  sec("6. Campanha vazia — config válida aceita, inválida rejeitada");
  {
    const camp = await req(BASE, "POST", "/campaigns", { cookie: c.cookieMestre, body: { name: "Vazia " + crypto.randomUUID().slice(0, 6) } });
    const vazia = camp.json?.campanha?.id;
    t("campanha vazia criada", !!vazia);
    // sem rule_definitions de poder → qualquer custo é rejeitado
    const r1 = await putCfg(vazia, c.cookieMestre, { sangue: { ...SANGUE_BASE, poderes: { x: { custo: 1 } } } });
    t("poder inexistente em campanha vazia → 400", r1.status === 400, `status=${r1.status}`);
    const r2 = await putCfg(vazia, c.cookieMestre, {
      sangue: {
        ...SANGUE_BASE,
        recuperacaoSangue: { habilitado: true, acoes: { descansar: { habilitada: true } } },
      },
    });
    t("ação incompleta em campanha vazia → 400", r2.status === 400, `status=${r2.status}`);
    const r3 = await putCfg(vazia, c.cookieMestre, {
      sangue: { ...SANGUE_BASE, recuperacaoSangue: { habilitado: true, acoes: { descansar: { habilitada: true, quantidade: 3 } } } },
    });
    t("config válida em campanha vazia → 200", r3.status === 200, `status=${r3.status} ${JSON.stringify(r3.json).slice(0, 140)}`);
  }

  sec("7. PUT parcial preserva poderes/acoes não enviados");
  {
    const antes = await getCfg(c.campId, c.cookieMestre);
    const r = await putCfg(c.campId, c.cookieMestre, { mesa: { acaoForaDeTurno: false } });
    t("PUT mesa parcial → 200", r.status === 200, `status=${r.status}`);
    const depois = await getCfg(c.campId, c.cookieMestre);
    t("poderes preservados", JSON.stringify(depois?.sangue?.poderes) === JSON.stringify(antes?.sangue?.poderes));
    t("acoes preservadas", JSON.stringify(depois?.sangue?.recuperacaoSangue?.acoes) === JSON.stringify(antes?.sangue?.recuperacaoSangue?.acoes));
  }
} catch (e) {
  fail++;
  console.log("FALHOU exceção não tratada:", e?.stack ?? e);
} finally {
  let teardownFalhou = false;
  try { if (proc) await encerrarServidor(proc); } catch (e) { teardownFalhou = true; console.error("[teardown] servidor:", e?.message ?? e); }
  try { if (!limparDir(DIR)) teardownFalhou = true; } catch (e) { teardownFalhou = true; console.error("[teardown] limpeza:", e?.message ?? e); }
  if (teardownFalhou) fail++;
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
