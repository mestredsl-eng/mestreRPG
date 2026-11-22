// Testes HTTP — aprendizado de preferências visuais (Issue #132).
// Cobre o contrato de `visualAprendizado` em PATCH /api/auth/preferences:
// opt-in default desligado, schema fechado, histórico limitado a 8,
// coleta SOMENTE em apply de `visual` com opt-in ligado, merge parcial
// que não apaga chaves irmãs, limpeza explícita e isolamento por usuário.
// Banco temporário + migrations reais; sem navegador.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  req, criarCenario, comDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("aprendizado-visual");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

const V_A = {
  intensidade: "imersiva", corDestaque: "ambar", superficies: "elevado",
  textura: "intensa", animacoes: "completo", densidade: "ampla",
};
const V_B = {
  intensidade: "discreta", corDestaque: "violeta", superficies: "flat",
  textura: "nenhuma", animacoes: "reduzido", densidade: "compacta",
};
const V_C = {
  intensidade: "equilibrada", corDestaque: "vinho", superficies: "padrao",
  textura: "sutil", animacoes: "normal", densidade: "padrao",
};

const patch = (cookie, body) => req(BASE, "PATCH", "/auth/preferences", { cookie, body });
const getPrefs = async (cookie) => {
  const r = await req(BASE, "GET", "/auth/me", { cookie });
  return r.json?.usuario?.preferences ?? r.json?.preferences ?? null;
};
const aprDe = (prefs) => prefs?.visualAprendizado ?? null;

try {
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  await esperarSaudavel(BASE, proc);

  sec("Cenário — admin + dois jogadores");
  const C = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "apr_j1", jogador2: "apr_j2" } });
  const { cookieMestre, jogadores } = C;
  const j1 = jogadores.jogador1, j2 = jogadores.jogador2;

  sec("Padrão — aprendizado desativado e ausente");
  {
    const prefs = await getPrefs(j1.cookie);
    t("conta nova não tem visualAprendizado", aprDe(prefs) === null, JSON.stringify(aprDe(prefs)));
  }
  {
    // apply de visual SEM opt-in: nada é coletado
    const r = await patch(j1.cookie, { visual: V_A });
    t("PATCH visual sem opt-in → 200", r.status === 200, `status=${r.status}`);
    const prefs = await getPrefs(j1.cookie);
    t("sem opt-in, histórico NÃO cresce", !aprDe(prefs)?.historico?.length, JSON.stringify(aprDe(prefs)));
  }

  sec("Schema fechado — rejeições 400");
  for (const [nome, corpo] of [
    ["optIn não-booleano", { visualAprendizado: { optIn: "sim" } }],
    ["chave extra", { visualAprendizado: { optIn: true, foo: 1 } }],
    ["historico > 8", { visualAprendizado: { optIn: true, historico: Array(9).fill(V_A) } }],
    ["entrada inválida no histórico", { visualAprendizado: { optIn: true, historico: [{ intensidade: "x" }] } }],
    ["historico não-array", { visualAprendizado: { optIn: true, historico: "tudo" } }],
  ]) {
    const r = await patch(j1.cookie, corpo);
    t(`${nome} → 400`, r.status === 400, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
  {
    const prefs = await getPrefs(j1.cookie);
    t("rejeições não persistiram nada", aprDe(prefs) === null, JSON.stringify(aprDe(prefs)));
  }

  sec("Opt-in — liga e preserva visual salvo");
  {
    const r = await patch(j1.cookie, { visualAprendizado: { optIn: true } });
    t("opt-in → 200", r.status === 200, `status=${r.status}`);
    const prefs = await getPrefs(j1.cookie);
    t("optIn persistido", aprDe(prefs)?.optIn === true, JSON.stringify(aprDe(prefs)));
    t("visual anterior preservado", JSON.stringify(prefs?.visual) === JSON.stringify(V_A), JSON.stringify(prefs?.visual));
  }

  sec("Coleta — somente apply de visual com opt-in");
  {
    // apply V_B → histórico [V_B]
    await patch(j1.cookie, { visual: V_B });
    let prefs = await getPrefs(j1.cookie);
    t("apply V_B → histórico [V_B]", JSON.stringify(aprDe(prefs)?.historico) === JSON.stringify([V_B]), JSON.stringify(aprDe(prefs)?.historico));

    // PATCH só de visualAprendizado (toggle parcial) NÃO coleta
    await patch(j1.cookie, { visualAprendizado: { optIn: true } });
    prefs = await getPrefs(j1.cookie);
    t("PATCH sem visual não coleta", aprDe(prefs)?.historico?.length === 1, JSON.stringify(aprDe(prefs)?.historico));

    // desligar opt-in → apply não coleta
    await patch(j1.cookie, { visualAprendizado: { optIn: false } });
    await patch(j1.cookie, { visual: V_C });
    prefs = await getPrefs(j1.cookie);
    t("opt-in off → apply não coleta", aprDe(prefs)?.historico?.length === 1, JSON.stringify(aprDe(prefs)?.historico));
    t("opt-in off preservou histórico antigo", JSON.stringify(aprDe(prefs)?.historico) === JSON.stringify([V_B]), JSON.stringify(aprDe(prefs)?.historico));

    // religar → apply V_A → histórico [V_B, V_A]
    await patch(j1.cookie, { visualAprendizado: { optIn: true } });
    await patch(j1.cookie, { visual: V_A });
    prefs = await getPrefs(j1.cookie);
    t("opt-in on de novo → coleta V_A", JSON.stringify(aprDe(prefs)?.historico) === JSON.stringify([V_B, V_A]), JSON.stringify(aprDe(prefs)?.historico));
  }

  sec("Limite — histórico corta em 8 (últimas)");
  {
    const seq = [V_C, V_B, V_A, V_C, V_B, V_A, V_C, V_B, V_A, V_C]; // 10 applies
    for (const v of seq) await patch(j1.cookie, { visual: v });
    const prefs = await getPrefs(j1.cookie);
    const h = aprDe(prefs)?.historico ?? [];
    // histórico prévio tinha [V_B, V_A]; após 10 applies = últimos 8 do total 12
    t("histórico limitado a 8", h.length === 8, `len=${h.length}`);
    t("última entrada = último apply", JSON.stringify(h[h.length - 1]) === JSON.stringify(V_C), JSON.stringify(h[h.length - 1]));
    t("primeira entrada descartada corretamente", JSON.stringify(h[0]) === JSON.stringify(V_A), JSON.stringify(h[0]));
  }

  sec("Limpeza — historico explícito é autoritativo");
  {
    const r = await patch(j1.cookie, { visualAprendizado: { optIn: true, historico: [] } });
    t("apagar → 200", r.status === 200, `status=${r.status}`);
    const prefs = await getPrefs(j1.cookie);
    t("histórico zerado, optIn mantido", aprDe(prefs)?.historico?.length === 0 && aprDe(prefs)?.optIn === true, JSON.stringify(aprDe(prefs)));

    // apply após limpeza recomeça do zero
    await patch(j1.cookie, { visual: V_A });
    const prefs2 = await getPrefs(j1.cookie);
    t("apply pós-limpeza → [V_A]", JSON.stringify(aprDe(prefs2)?.historico) === JSON.stringify([V_A]), JSON.stringify(aprDe(prefs2)?.historico));
  }

  sec("Isolamento — contas não compartilham histórico");
  {
    await patch(j2.cookie, { visualAprendizado: { optIn: true } });
    await patch(j2.cookie, { visual: V_B });
    await patch(j2.cookie, { visual: V_B });
    const p1 = await getPrefs(j1.cookie);
    const p2 = await getPrefs(j2.cookie);
    t("j1 histórico intacto ([V_A])", JSON.stringify(aprDe(p1)?.historico) === JSON.stringify([V_A]), JSON.stringify(aprDe(p1)?.historico));
    t("j2 tem próprio histórico", aprDe(p2)?.historico?.length === 2, JSON.stringify(aprDe(p2)?.historico));
    t("j2 visual = V_B", JSON.stringify(p2?.visual) === JSON.stringify(V_B), JSON.stringify(p2?.visual));
  }

  sec("Merge — chaves irmãs preservadas");
  {
    await patch(j1.cookie, { dados: { corExterna: "#112233", corInterna: "#445566" }, temaMesa: "vinho" });
    await patch(j1.cookie, { visualAprendizado: { optIn: false } });
    const prefs = await getPrefs(j1.cookie);
    t("dados preservado", prefs?.dados?.corExterna === "#112233", JSON.stringify(prefs?.dados));
    t("temaMesa preservado", prefs?.temaMesa === "vinho", JSON.stringify(prefs?.temaMesa));
    t("visual preservado", JSON.stringify(prefs?.visual) === JSON.stringify(V_A), JSON.stringify(prefs?.visual));
    t("visualAprendizado.optIn=false", aprDe(prefs)?.optIn === false, JSON.stringify(aprDe(prefs)));
    t("histórico preservado após toggle", aprDe(prefs)?.historico?.length === 1, JSON.stringify(aprDe(prefs)?.historico));
  }
} catch (e) {
  fail++;
  console.log("FALHOU exceção não tratada:", e?.stack ?? e);
} finally {
  let teardownFalhou = false;
  try {
    if (proc) await encerrarServidor(proc);
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] servidor:", e?.message ?? e);
  }
  try {
    if (!limparDir(DIR)) teardownFalhou = true;
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] limpeza:", e?.message ?? e);
  }
  if (teardownFalhou) fail++;
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
