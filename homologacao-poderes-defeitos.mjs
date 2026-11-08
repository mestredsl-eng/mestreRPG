// Homologação: Sistema de Poderes × Defeitos (15 cenários da spec).
// Cobre validação autoritativa no backend (PATCH/GET/pontos-previa),
// limites configuráveis via PUT /regras/config e UI (avisos, bolinhas
// de nível, descrição do nível, saldo com custos negativos).
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='admin'").get();
const token = "pd-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "hom-poderes", "127.0.0.1", Date.now() + 3600000, Date.now());

const H = { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` };
const api = async (m, path, body) => {
  const r = await fetch(BASE + path, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};

// ---------- personagem v2 ----------
const novo = await api("POST", `/api/campaigns/${CID}/characters`, { name: "PJ Poderes Defeitos" });
ok("criar personagem v2", novo.status === 201 || novo.status === 200, `status=${novo.status} ${JSON.stringify(novo.json?.erro ?? "")}`);
const charId = novo.json?.personagem?.id;
let ficha = (await api("GET", `/api/characters/${charId}`)).json?.ficha;
const estrutura = ficha?.estrutura;
const todosCampos = [];
for (const s of estrutura.secoes) for (const c of s.campos ?? []) todosCampos.push(c);
const poderId = todosCampos.find(c => c.regraKind === "poder")?.id;
const defeitoId = todosCampos.find(c => c.regraKind === "defeito")?.id;
ok("campo Poderes existe (regraKind=poder)", !!poderId, poderId);
ok("campo Defeitos é selecao_nivel", todosCampos.find(c => c.id === defeitoId)?.tipo === "selecao_nivel");
ok("seção Poderes presente", estrutura.secoes.some(s => s.titulo === "Poderes"));
ok("ficha.poderes config exposta", ficha?.poderes?.limitePoderes === 1 && ficha?.poderes?.exigirDefeito === true, JSON.stringify(ficha?.poderes));

const PATCH = (data, extra = {}) => api("PATCH", `/api/characters/${charId}`, { data, ...extra });
const poolsDe = (pontos) => Object.fromEntries((pontos?.pools ?? []).map(p => [p.id, p]));
const saldoDe = async (dados) => {
  const r = await api("POST", `/api/characters/${charId}/pontos-previa`, { dados });
  return r.json?.pontos;
};
const errosDe = (r) => (r.json?.detalhes?.erros ?? []).map(e => e.codigo);
// sorte não exige defeito específico nem está em grupo com os poderes livres
const P1 = "sorte", P2 = "poder_fogo", P3 = "poder_vigor", P4 = "poder_influencia";

// ---------- 1) Poder sem defeito -> rejeitado ----------
{
  const r = await PATCH({ [poderId]: [P1] });
  ok("1. PATCH poder sem defeito -> 400", r.status === 400, `status=${r.status}`);
  ok("1b. código poder_sem_defeito", errosDe(r).includes("poder_sem_defeito"), errosDe(r).join(","));
}

// ---------- 2) Defeito nv1 + poder -> aceito ----------
{
  const r = await PATCH({ [defeitoId]: [{ key: "cegueira", nivel: 1 }], [poderId]: [P1] });
  ok("2. defeito+poder -> 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? "")}`);
}

// ---------- 3/15) Dois poderes com limite 1 via API -> rejeitado ----------
{
  const r = await PATCH({ [defeitoId]: [{ key: "cegueira", nivel: 1 }], [poderId]: [P1, P2] });
  ok("3/15. dois poderes (limite 1) via API -> 400", r.status === 400, `status=${r.status}`);
  ok("3b. código limite_poderes", errosDe(r).includes("limite_poderes"), errosDe(r).join(","));
}

// ---------- 4) Trocar o poder ----------
{
  const r = await PATCH({ [defeitoId]: [{ key: "cegueira", nivel: 1 }], [poderId]: [P2] });
  ok("4. trocar poder -> 200", r.status === 200, `status=${r.status} ${errosDe(r).join(",")}`);
}

// ---------- custos: -1 e -2 concedem; positivo desconta ----------
{
  const prev = await saldoDe({ [defeitoId]: [{ key: "cegueira", nivel: 1 }], [poderId]: [P1] });
  const pools = poolsDe(prev);
  ok("9. custo -1 -> pool defeitos saldo +1", pools["defeitos"]?.saldo === 1, `saldo=${pools["defeitos"]?.saldo}`);
  ok("11. custo positivo desconta (sorte=2)", pools["principal"]?.gastos === 2 && pools["principal"]?.saldo === 28,
    `gastos=${pools["principal"]?.gastos} saldo=${pools["principal"]?.saldo}`);

  // -2: preco_oculto nv1 (sem reserva própria -> pool principal)
  const prev2 = await saldoDe({ [defeitoId]: [{ key: "preco_oculto", nivel: 1 }] });
  const p2 = poolsDe(prev2)["principal"];
  ok("10. custo -2 -> saldo +2", p2?.saldo === 32, `saldo=${p2?.saldo}`);

  const prev5 = await saldoDe({ [defeitoId]: [{ key: "cegueira", nivel: 5 }], [poderId]: [P1] });
  const d5 = poolsDe(prev5)["defeitos"];
  ok("nv5 acumula custos (-6)", d5?.saldo === 6, `saldo=${d5?.saldo}`);
}

// ---------- 7/8) níveis: nv1 não é nv5; descrição por nível ----------
{
  const v = await api("GET", `/api/campaigns/${CID}/regras/vinculaveis`);
  const ceg = v.json?.elementos?.defeito?.find(e => e.key === "cegueira");
  ok("vinculaveis expõe niveis", Array.isArray(ceg?.niveis) && ceg.niveis.length === 5, `n=${ceg?.niveis?.length}`);
  ok("nv1 desc != nv5 desc", ceg?.niveis?.[0]?.descricao !== ceg?.niveis?.[4]?.descricao);
  ok("nv1 custo -1, nv5 custo -2", ceg?.niveis?.[0]?.custo === -1 && ceg?.niveis?.[4]?.custo === -2);
  const p1 = poolsDe(await saldoDe({ [defeitoId]: [{ key: "cegueira", nivel: 1 }] }))["defeitos"];
  const p5 = poolsDe(await saldoDe({ [defeitoId]: [{ key: "cegueira", nivel: 5 }] }))["defeitos"];
  ok("7. nv1 != nv5 no cálculo", p1?.saldo === 1 && p5?.saldo === 6, `nv1=${p1?.saldo} nv5=${p5?.saldo}`);
}

// ---------- 5/6) limite configurável ----------
{
  await api("PUT", `/api/campaigns/${CID}/regras/config`, { poderes: { limitePoderes: 3 } });
  let r = await PATCH({ [poderId]: [P1, P2] }); // sem defeito -> erro de defeito, não de limite
  ok("5a. limite=3: 2 poderes não gera limite_poderes", !errosDe(r).includes("limite_poderes"), errosDe(r).join(","));
  r = await PATCH({ [defeitoId]: [{ key: "cegueira", nivel: 1 }], [poderId]: [P1, P2, P3] });
  ok("5b. limite=3: 3 poderes aceitos", r.status === 200, `status=${r.status} ${errosDe(r).join(",")}`);

  await api("PUT", `/api/campaigns/${CID}/regras/config`, { poderes: { limitePoderes: null } });
  r = await PATCH({ [defeitoId]: [{ key: "cegueira", nivel: 1 }], [poderId]: [P1, P2, P3, P4] });
  ok("6. limite=null: 4 poderes aceitos", r.status === 200, `status=${r.status} ${errosDe(r).join(",")}`);

  await api("PUT", `/api/campaigns/${CID}/regras/config`, { poderes: { limitePoderes: 1 } });
}

// ---------- 12/13) prévia == definitivo; salvar/recarregar ----------
{
  const dados = { [defeitoId]: [{ key: "cegueira", nivel: 2 }], [poderId]: [P1] };
  const prev = poolsDe(await saldoDe(dados));
  const r = await PATCH(dados);
  ok("13. salvar 200", r.status === 200, `status=${r.status} ${errosDe(r).join(",")}`);
  const g = (await api("GET", `/api/characters/${charId}`)).json?.ficha?.pontos;
  const gp = poolsDe(g);
  ok("12. prévia == saldo definitivo", prev["defeitos"]?.saldo === gp["defeitos"]?.saldo && prev["principal"]?.saldo === gp["principal"]?.saldo,
    `prev defeitos=${prev["defeitos"]?.saldo} get=${gp["defeitos"]?.saldo}`);
  const recarregado = (await api("GET", `/api/characters/${charId}`)).json?.ficha?.campos?.[defeitoId];
  ok("13b. valor persiste após reload", Array.isArray(recarregado) && recarregado[0]?.key === "cegueira" && recarregado[0]?.nivel === 2, JSON.stringify(recarregado));
}

// ---------- formato selecao_nivel ----------
{
  const r = await PATCH({ [defeitoId]: [{ key: "cegueira", nivel: 9 }] });
  ok("formato: nivel>5 rejeitado", r.status === 400, `status=${r.status}`);
  const r2 = await PATCH({ [defeitoId]: [{ key: "cegueira", nivel: 1 }, { key: "cegueira", nivel: 2 }] });
  ok("formato: key duplicada rejeitada", r2.status === 400, `status=${r2.status}`);
}

// ---------- 14/15) bypass via API já coberto (1,3); endpoints GET ----------
{
  const val = await api("GET", `/api/campaigns/${CID}/regras/validacao/${charId}`);
  ok("GET validacao reflete estado salvo", val.status === 200, `status=${val.status}`);
}

// ---------- UI ----------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", e => erros.push(String(e)));
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(700);
  await p.locator(".cartao-campanha", { hasText: "Caçadores" }).first().click();
  await p.waitForTimeout(1000);
  await p.getByRole("button", { name: /Personagens/ }).click();
  await p.waitForTimeout(800);
  await p.locator("tr", { hasText: "PJ Poderes Defeitos" }).first().click();
  await p.waitForTimeout(1500);

  ok("UI. seção Poderes renderizada", await p.locator(".ficha-secao", { hasText: "Poderes" }).count() >= 1);

  await p.getByRole("button", { name: "Editar ficha" }).click();
  await p.waitForTimeout(1200);
  await p.locator(".selecao-nivel").first().waitFor({ timeout: 8000 }).catch(() => {});

  // Cegueira nv2 salva: 5 bolinhas, 2 cheias, descrição visível
  const itemCeg = p.locator(".nivel-item", { hasText: "Cegueira" }).first();
  const bolCeg = await itemCeg.locator(".bolinha").count();
  const cheiasCeg = await itemCeg.locator(".bolinha.cheia").count();
  ok("UI. Cegueira: 5 bolinhas", bolCeg === 5, `bolinhas=${bolCeg}`);
  ok("UI. Cegueira nv2: 2 cheias", cheiasCeg === 2, `cheias=${cheiasCeg}`);
  const desc = await itemCeg.locator(".nivel-desc").textContent().catch(() => null);
  ok("UI. descrição do nível visível", !!desc && desc.includes("prejudicada"), desc?.slice(0, 70));

  // desmarcar o defeito -> aviso "falta defeito" (clica na bolinha selecionada = nv2)
  await itemCeg.locator('.bolinha[aria-pressed="true"]').click();
  await p.waitForTimeout(500);
  const avisoFalta = await p.locator(".ficha-aviso", { hasText: /ao menos 1 defeito/i }).count();
  ok("UI. aviso falta defeito ao remover último defeito", avisoFalta > 0, `avisos=${avisoFalta}`);

  // marcar 2º poder -> aviso de limite
  const secaoPoderes = p.locator(".ficha-secao", { hasText: "Poderes" }).first();
  const opcoesPoder = secaoPoderes.locator("label.checkbox-inline", { hasText: "Poder Fogo" });
  if (await opcoesPoder.count()) {
    await opcoesPoder.click();
    await p.waitForTimeout(500);
    const avisoLimite = await p.locator(".ficha-aviso", { hasText: /Limite de poderes/ }).count();
    ok("UI. aviso limite de poderes ao 2º poder", avisoLimite > 0, `avisos=${avisoLimite}`);
  } else {
    ok("UI. aviso limite de poderes ao 2º poder", false, "opção 'Poder Fogo' não encontrada");
  }

  ok("UI. sem erros de console", erros.length === 0, erros.slice(0, 2).join(" | "));
  await ctx.close();
  await browser.close();
}

await db.close();
const falhas = resultados.filter(r => !r.ok).length;
console.log(`\n${resultados.length - falhas} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
