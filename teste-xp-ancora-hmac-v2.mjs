// Issue #185 / I28B — integração XP × HMAC v2 (C3, Issue #186) com a
// âncora de truncamento do ledger. Quatro casos obrigatórios:
//
//  10. Âncora zero após truncamento simples — fixture REAL gerada por
//      aplicarXp (servidor/src/lib/progressao.ts) com 501 eventos cujo
//      primeiro retido começa do zero; saldo, 500 retidos e âncora
//      exata conferidos antes e depois de GET /progressao.
//  11. Truncamentos sucessivos — >1.000 eventos e dezenas de avanços
//      da janela; a âncora acumula sem resetar, duplicar ou perder o
//      saldo anterior (invariante saldo = âncora + Σ deltas retidos).
//  12. HMAC v2 válido com âncora zero — pacote XP+Sangue assinado v2
//      (`__sangue_sig`) preserva ancora:0 na importação/exportação e
//      as credenciais de transporte não persistem no banco.
//  13. Tampering da âncora — alterar ancora:0 após assinar reprova a
//      v2 e dispara rejeição CONJUNTA (XP fail-closed + Sangue fora),
//      sem fallback v1 residual e sem XP parcial persistido.
//
// Escopo: SOMENTE testes — nenhum arquivo de runtime é alterado. Os
// casos 12/13 exigem a árvore integrada #195×#257×#258 (HMAC v2 só
// existe na #195); quando o módulo v2 está ausente eles são reportados
// como SKIP explícito, nunca como passe. Execução de referência: worktree
// descartável da cadeia consolidada — NÃO é CI canônica nem prova de
// integração em main.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb, req, criarCenario, abrirDb,
} from "./teste-base.mjs";

const AQUI = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]+$/, "");
const ROOT = AQUI;
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const PROGRESSAO = join(ROOT, "servidor", "src", "lib", "progressao.ts");

let ok = 0, falhas = 0, skips = 0;
const check = (cond, msg) => {
  if (cond) { ok++; console.log("  ok", msg); }
  else { falhas++; console.error("  FALHOU:", msg); }
};
const skip = (msg) => { skips++; console.log("  SKIP:", msg); };
const sec = (n) => console.log("\n== " + n + " ==");

const AGORA = "2025-06-01T12:00:00.000Z";

// ---------- driver real: aplicarXp do progressao.ts via tsx ----------
// Gera o ledger pelo MESMO código de produção (sem mock): recebe uma
// lista de deltas e devolve o __xp final + um snapshot a cada evento
// em que a janela de 500 truncou.
function ledgerPorDriver(eventos) {
  const dir = mkdtempSync(join(tmpdir(), "i28b-driver-"));
  const driver = join(dir, "driver.ts");
  const spec = join(dir, "spec.json");
  writeFileSync(driver, `
import { aplicarXp } from ${JSON.stringify(pathToFileURL(PROGRESSAO).href)};
import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
let dados = {};
const truncamentos = [];
for (const ev of spec.eventos) {
  const antes = (dados.__xp && dados.__xp.historico ? dados.__xp.historico.length : 0);
  const r = aplicarXp(dados, ev.d, {
    tipo: ev.tipo ?? "concessao", motivo: "i28b", autorId: null, autorNome: null,
  });
  dados = r.dados;
  const xp = dados.__xp;
  if (antes === 500 && xp.historico.length === 500) {
    truncamentos.push({
      saldo: xp.saldo, ancora: xp.ancora ?? null, histLen: xp.historico.length,
      primeiroSR: xp.historico[0].saldoResultante, primeiroQ: xp.historico[0].quantidade,
      ultimoSR: xp.historico[xp.historico.length - 1].saldoResultante,
    });
  }
}
console.log(JSON.stringify({ xp: dados.__xp ?? null, truncamentos }));
`);
  writeFileSync(spec, JSON.stringify({ eventos }));
  const r = spawnSync(process.execPath, [TSX, driver, spec], {
    cwd: ROOT, encoding: "utf8", timeout: 120000,
  });
  if (r.status !== 0) throw new Error(`driver falhou: ${r.stderr?.slice(0, 400)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

const dir = dirTeste("xp-ancora-hmac-v2");
const banco = `${dir}/teste.db`;
let proc = null, base = null;

try {
  await prepararBanco(banco);
  const porta = await portaLivre();
  base = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco, arquivos: `${dir}/arq`, backups: `${dir}/bks` });
  await esperarSaudavel(base, proc);

  // ruleset ativo com config.sangue → elegibilidade v2 da exportação.
  const c = await criarCenario(base, banco, {
    campanha: "I28B XP×HMAC v2",
    config: { sangue: { habilitado: true, campoCapacidadeId: "for" } },
  });
  const { campId, cookieMestre } = c;

  const tpl = comDb(banco, (db) =>
    db.prepare("select id from sheet_versions where template_id in (select id from sheet_templates where campaign_id=?)").get(campId).id);
  const membershipId = c.jogadores.jogador1.membershipId;
  const inserir = (nome, data) => {
    const id = randomUUID();
    const db = abrirDb(banco);
    db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, campId, membershipId, tpl, nome, JSON.stringify(data), "{}", "aprovada", 0, Date.now(), Date.now());
    db.close();
    return id;
  };
  const personagem = (nome) => comDb(banco, (db) => {
    const r = db.prepare("select data from characters where campaign_id=? and name=?").get(campId, nome);
    return r ? JSON.parse(r.data) : null;
  });

  // ---------- CASOS 10/11: truncamento real via aplicarXp ----------
  sec("10. Âncora zero após truncamento simples (501 eventos, driver real)");
  {
    // +0 (ajuste) zera a origem; +5 e +1×499 completam 501 aplicações.
    // O evento +0 é descartado pelo corte; o primeiro retido (+5, que
    // começou do zero) produz ancora = 5-5 = 0 — âncora ZERO real.
    const eventos = [{ d: 0, tipo: "ajuste" }, { d: 5 }, ...Array.from({ length: 499 }, () => ({ d: 1 }))];
    const { xp, truncamentos } = ledgerPorDriver(eventos);
    check(xp.historico.length === 500, `10. 500 eventos retidos (got ${xp.historico.length})`);
    check(xp.saldo === 504, `10. saldo=504 (got ${xp.saldo})`);
    check(xp.ancora === 0, `10. âncora exata 0 (got ${xp.ancora})`);
    check(xp.historico[0].saldoResultante === xp.historico[0].quantidade,
      `10. primeiro retido começou do zero (SR=${xp.historico[0].saldoResultante}, Q=${xp.historico[0].quantidade})`);
    check(truncamentos.length === 1 && truncamentos[0].ancora === 0,
      `10. exatamente 1 truncamento, âncora 0 (n=${truncamentos.length})`);

    const id10 = inserir("I28B Âncora Zero", { for: 5, __xp: xp });
    const g1 = await req(base, "GET", `/characters/${id10}/progressao`, { cookie: cookieMestre });
    const g2 = await req(base, "GET", `/characters/${id10}/progressao`, { cookie: cookieMestre });
    check(g1.status === 200 && g1.json?.xp?.ancora === 0 && g1.json?.xp?.saldo === 504
      && g1.json?.xp?.historico?.length === 500,
      `10. GET#1: ancora=0, saldo=504, 500 retidos (ancora=${g1.json?.xp?.ancora})`);
    check(JSON.stringify(g1.json?.xp) === JSON.stringify(g2.json?.xp),
      "10. GET#2 idêntico — leitura não muta o ledger");
  }

  sec("11. Truncamentos sucessivos (>1.000 eventos, janela avança)");
  {
    // 1.100 aplicações → 600 avanços de janela após o primeiro corte.
    const eventos = [{ d: 0, tipo: "ajuste" }, { d: 5 }, ...Array.from({ length: 1098 }, () => ({ d: 1 }))];
    const { xp, truncamentos } = ledgerPorDriver(eventos);
    check(truncamentos.length === 600, `11. 600 avanços de janela (got ${truncamentos.length})`);
    const somaRetida = xp.historico.reduce((s, e) => s + e.quantidade, 0);
    const ancoraFinal = xp.historico[0].saldoResultante - xp.historico[0].quantidade;
    check(xp.ancora === ancoraFinal,
      `11. âncora final = saldo anterior ao 1º retido (${xp.ancora} vs ${ancoraFinal})`);
    check(xp.saldo === xp.ancora + somaRetida,
      `11. invariante saldo = âncora + Σ retidos (${xp.saldo} vs ${xp.ancora}+${somaRetida})`);
    check(xp.historico[xp.historico.length - 1].saldoResultante === xp.saldo,
      "11. último saldoResultante = saldo");
    // Acumulação: cada avanço desloca a janela 1 evento — a âncora
    // cresce monotonicamente, nunca reseta/duplica/perde o anterior.
    const ancoras = truncamentos.map((t) => t.ancora);
    const monotona = ancoras.every((a, i) => i === 0 || a > ancoras[i - 1]);
    const formulaOk = truncamentos.every((t) => t.ancora === t.primeiroSR - t.primeiroQ
      && t.histLen === 500 && t.ultimoSR === t.saldo);
    check(monotona, `11. âncora monotônica crescente nos 600 avanços (${ancoras[0]}→${ancoras[ancoras.length - 1]})`);
    check(formulaOk, "11. fórmula âncora=saldoret−qtd e histLen=500 em TODOS os avanços");
    check(ancoras[0] === 0, `11. primeiro corte também produz âncora 0 (${ancoras[0]})`);

    const id11 = inserir("I28B Truncamentos", { for: 5, __xp: xp });
    const g1 = await req(base, "GET", `/characters/${id11}/progressao`, { cookie: cookieMestre });
    const g2 = await req(base, "GET", `/characters/${id11}/progressao`, { cookie: cookieMestre });
    check(g1.status === 200 && g1.json?.xp?.ancora === xp.ancora
      && g1.json?.xp?.historico?.length === 500 && g1.json?.xp?.saldo === xp.saldo,
      `11. GET preserva âncora=${xp.ancora}, saldo=${xp.saldo}, 500 retidos`);
    check(JSON.stringify(g1.json?.xp) === JSON.stringify(g2.json?.xp),
      "11. GET#2 idêntico — leitura não muta o ledger");
  }

  // ---------- CASOS 12/13: HMAC v2 × âncora (exige árvore #195) ----------
  const ledgerXpAncora = {
    saldo: 15,
    ancora: 0,
    historico: [
      { em: AGORA, tipo: "concessao", quantidade: 5, motivo: "i28b", autorId: null, autorNome: null, saldoResultante: 5 },
      { em: AGORA, tipo: "concessao", quantidade: 5, motivo: "i28b", autorId: null, autorNome: null, saldoResultante: 10 },
      { em: AGORA, tipo: "concessao", quantidade: 5, motivo: "i28b", autorId: null, autorNome: null, saldoResultante: 15 },
    ],
  };
  const ledgerSangue = {
    saldo: 3,
    usos: {},
    historico: [
      { em: AGORA, tipo: "inicial", quantidade: 3, motivo: null, autorId: null, autorNome: null, saldoResultante: 3 },
    ],
  };

  sec("12. HMAC v2 válido com âncora zero — importar/exportar preserva");
  let pacoteV2 = null;
  let idV2 = null;
  {
    idV2 = inserir("I28B V2 Âncora", { for: 5, __xp: ledgerXpAncora, __sangue: ledgerSangue });
    inserir("I28B Controle", { for: 5, __xp: { saldo: 7, historico: [
      { em: AGORA, tipo: "concessao", quantidade: 7, motivo: "i28b", autorId: null, autorNome: null, saldoResultante: 7 },
    ] } });

    const exp = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
    check(exp.status === 200, `12. exportar status ${exp.status}`);
    pacoteV2 = exp.json;
    const linha = (pacoteV2.estado.characters ?? []).find((r) => r.name === "I28B V2 Âncora");
    const xpPkg = linha?.data?.__xp;
    const temV2 = typeof linha?.data?.__sangue_sig === "string" && linha.data.__sangue_sig.startsWith("v2.");
    if (!temV2) {
      skip("árvore sem HMAC v2 (#195 ausente) — casos 12/13 não executáveis aqui");
    } else {
      check(xpPkg?.ancora === 0 && xpPkg?.sig === undefined && linha.data.__sangue !== undefined,
        `12. pacote v2: ancora=0, sem sig v1 residual, __sangue presente (sig=${linha.data.__sangue_sig.slice(0, 12)}…)`);

      const imp = await req(base, "POST", "/campaigns/importar", {
        cookie: cookieMestre,
        body: { pacote: pacoteV2, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
      });
      check(imp.status === 200, `12. importar status ${imp.status}: ${JSON.stringify(imp.json)?.slice(0, 160)}`);
      check((imp.json?.saneamento?.totais?.sanguesAutenticados ?? 0) >= 1,
        `12. saneamento autenticou o Sangue v2 (${imp.json?.saneamento?.totais?.sanguesAutenticados})`);

      const d = personagem("I28B V2 Âncora");
      check(d?.__xp?.ancora === 0 && d.__xp.saldo === 15 && d.__xp.historico.length === 3,
        `12. âncora 0 preservada após importar (ancora=${d?.__xp?.ancora}, saldo=${d?.__xp?.saldo})`);
      check(d?.__sangue?.saldo === 3, `12. __sangue preservado (saldo=${d?.__sangue?.saldo})`);
      check(d?.__sangue_sig === undefined && d?.__xp?.sig === undefined,
        "12. credenciais de transporte NÃO persistem (__sangue_sig/__xp.sig ausentes)");

      const exp2 = await req(base, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
      const linha2 = (exp2.json.estado.characters ?? []).find((r) => r.name === "I28B V2 Âncora");
      check(linha2?.data?.__xp?.ancora === 0
        && typeof linha2?.data?.__sangue_sig === "string" && linha2.data.__sangue_sig.startsWith("v2."),
        "12. re-export: âncora 0 segue explícita sob nova assinatura v2");
    }
  }

  sec("13. Tampering da âncora — rejeição conjunta fail-closed");
  {
    if (!pacoteV2) {
      skip("depende do caso 12 (pacote v2)");
    } else {
      const linhaTemV2 = (pacoteV2.estado.characters ?? []).find((r) => r.name === "I28B V2 Âncora");
      if (!linhaTemV2 || typeof linhaTemV2.data?.__sangue_sig !== "string"
          || !linhaTemV2.data.__sangue_sig.startsWith("v2.")) {
        skip("pacote sem v2 — idem caso 12");
      } else {
        // Altera ancora DEPOIS de assinar e ainda injeta um sig v1
        // residual FORJADO — prova que não há fallback v1.
        const adulterado = JSON.parse(JSON.stringify(pacoteV2));
        const alvo = (adulterado.estado.characters ?? []).find((r) => r.name === "I28B V2 Âncora");
        alvo.data.__xp.ancora = 7;
        alvo.data.__xp.sig = `v1.${"0".repeat(64)}`;
        const imp = await req(base, "POST", "/campaigns/importar", {
          cookie: cookieMestre,
          body: { pacote: adulterado, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
        });
        check(imp.status === 200, `13. importar adulterado status ${imp.status}`);
        check((imp.json?.saneamento?.totais?.ledgersXpInvalidos ?? 0) >= 1
          && (imp.json?.saneamento?.totais?.sanguesInvalidos ?? 0) >= 1,
          `13. rejeição conjunta contabilizada (xpInv=${imp.json?.saneamento?.totais?.ledgersXpInvalidos}, sgInv=${imp.json?.saneamento?.totais?.sanguesInvalidos})`);

        const d = personagem("I28B V2 Âncora");
        check(d?.__xp?.saldo === 0 && (d.__xp.historico?.length ?? -1) === 0 && d.__xp.ancora === undefined,
          `13. XP fail-closed — zero parcial, sem âncora forjada (saldo=${d?.__xp?.saldo})`);
        check(d?.__sangue === undefined, "13. Sangue rejeitado junto (sem prova v2)");
        check(d?.__xp?.sig === undefined && d?.__sangue_sig === undefined,
          "13. nenhuma credencial persiste no banco");
        check(d?.for === 5, "13. dados normais da ficha preservados");

        const ctrl = personagem("I28B Controle");
        check(ctrl?.__xp?.saldo === 7 && ctrl.__xp.historico.length === 1,
          `13. personagem íntegro do MESMO pacote não afetado (saldo=${ctrl?.__xp?.saldo})`);
      }
    }
  }
} finally {
  if (proc) encerrarServidor(proc);
  limparDir(dir);
}

console.log(`\n${ok} ok, ${skips} skip, ${falhas} falhas`);
if (falhas) process.exit(1);
