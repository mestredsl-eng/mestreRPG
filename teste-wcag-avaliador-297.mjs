// Fixtures unitárias DOM do avaliador WCAG (#297 / #300).
// DOM sintético determinístico via setContent — prova a CLASSIFICAÇÃO
// normativa exigida pelo Dono (#7104140993): indicador→adjacente, ambíguo
// ⇒ REVIEW, IMG amostrado, inline estrito, foco com alpha composto.
import { chromium } from "playwright";
import { avaliarWcag, avaliarFocoIndicador } from "./wcag-avaliador-297.mjs";

let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

async function avaliar(html, foco = null) {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  if (foco) await page.evaluate((id) => document.getElementById(id)?.focus(), foco);
  return foco ? page.evaluate(avaliarFocoIndicador) : page.evaluate(avaliarWcag);
}
const temViol = (r, trecho) => [...r.textos.viol, ...r.naoTexto.viol].some((v) => v.includes(trecho));
const temRev = (r, trecho) => [...r.textos.rev, ...r.naoTexto.rev].some((v) => v.includes(trecho));

// Fundo escuro controlado para todos os fixtures de contraste
const FUNDO = "background:#14171a;color:#e8eaee;font-family:sans-serif";

sec("SC 1.4.11 — classificação do indicador");
{
  // 1. Botão com texto: borda fraca dispensada (texto identifica)
  let r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="b1" style="border:1px solid #2c3038;background:#1c2026;color:#e8eaee;padding:8px 14px">Ação</button></main>`);
  t("botão com texto: borda fraca não gera violação", !temViol(r, "b1") && !temRev(r, "b1"), JSON.stringify(r.naoTexto).slice(0, 200));

  // 2. Input COM label, borda+fundo fracos: ambíguo ⇒ REVIEW, não FAIL
  r = await avaliar(`<main style="${FUNDO};padding:20px"><label for="i1">Nome</label><input id="i1" style="border:1px solid #2c3038;background:#1c2026;padding:6px;width:200px"></main>`);
  t("input com label e fronteira fraca ⇒ REVIEW (sem veredito)", temRev(r, "i1") && !temViol(r, "i1"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 3. Input SEM contexto, borda+fundo fracos: FAIL determinístico
  r = await avaliar(`<main style="${FUNDO};padding:20px"><input id="i2" style="border:1px solid #2c3038;background:#1c2026;padding:6px;width:200px"></main>`);
  t("input sem contexto e fronteira fraca ⇒ FAIL", temViol(r, "i2"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 4. Input com preenchimento contrastante: PASS sem borda contrastante
  r = await avaliar(`<main style="${FUNDO};padding:20px"><input id="i3" style="border:1px solid #2c3038;background:#e8e8e8;color:#111;padding:6px;width:200px"></main>`);
  t("input com preenchimento contrastante ⇒ PASS (borda dispensável)", !temViol(r, "i3") && !temRev(r, "i3"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 5. Input com borda contrastante vs externo: PASS
  r = await avaliar(`<main style="${FUNDO};padding:20px"><input id="i4" style="border:2px solid #e8e8e8;background:#1c2026;padding:6px;width:200px"></main>`);
  t("input com fronteira contrastante vs externo ⇒ PASS", !temViol(r, "i4") && !temRev(r, "i4"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 6. Input desabilitado com texto/borda fracos: excluído do critério
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="d1" disabled style="color:#333;border:1px solid #333;background:#111;padding:8px">Inativo</button></main>`);
  t("componente inativo excluído (sem viol/rev)", !temViol(r, "d1") && !temRev(r, "d1"), JSON.stringify(r).slice(0, 240));
}

sec("SC 1.4.11 — IMG e SVG como identificadores");
{
  let r;
  const GIF_BRANCO = "data:image/svg+xml;utf8,"+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='white'/></svg>");
  const GIF_PRETO = "data:image/svg+xml;utf8,"+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='black'/></svg>");
  // 7. IMG clara como único identificador de botão-só-imagem ⇒ isenta
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="ib1" style="border:1px solid #2c3038;background:#1c2026;padding:4px"><img src="${GIF_BRANCO}" width="20" height="20" alt=""></button></main>`);
  t("img clara mensurável isenta fronteira do botão-só-imagem", !temViol(r, "ib1") && !temRev(r, "ib1"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 8. IMG escura (mesma luminância do fundo) NÃO isenta ⇒ vai p/ fronteira
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="ib2" style="border:1px solid #2c3038;background:#1c2026;padding:4px"><img src="${GIF_PRETO}" width="20" height="20" alt=""></button></main>`);
  t("img escura não isenta — fronteira ambígua vira REVIEW/FAIL honesto", temRev(r, "ib2") || temViol(r, "ib2"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 9. IMG não carregável ⇒ REVIEW (nunca PASS por existência)
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="ib3" style="border:1px solid #2c3038;background:#1c2026;padding:4px"><img src="data:image/gif;base64,@@@invalid" width="20" height="20" alt=""></button></main>`);
  t("img não mensurável ⇒ REVIEW, não PASS silencioso", temRev(r, "ib3"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 10. SVG informativo (botão só-ícone) com fill fraco ⇒ violação gráfica
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="sv1" style="width:32px;height:32px;padding:4px;color:#e8eaee;background:#1c2026"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M2 2h16v16H2z" fill="#333333"/></svg></button></main>`);
  t("svg informativo fill fraco ⇒ violação SC 1.4.11", temViol(r, "sv1") || temViol(r, "grafico"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 11. SVG decorativo (aria-hidden) ignorado
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="sv2" style="padding:8px 14px;color:#e8eaee;background:#1c2026">Ação<svg width="16" height="16" aria-hidden="true"><path d="M2 2h16v16H2z" fill="#333333"/></svg></button></main>`);
  t("svg aria-hidden decorativo não gera violação", !temViol(r, "sv2"), JSON.stringify(r.naoTexto).slice(0, 240));
}

sec("SC 2.5.8 — exceção inline estrita");
{
  let r;
  // 12. Link inline em frase (display:inline, <24px) ⇒ exceção
  r = await avaliar(`<main style="${FUNDO};padding:20px"><p style="font-size:14px;line-height:20px">Texto com <a id="li1" href="#" style="display:inline;color:#8ab4ff">link</a> no meio da frase.</p></main>`);
  t("link inline em frase ⇒ exceção (sem viol de alvo)", !temViol(r, "li1") && r.alvos.okEsp >= 1, JSON.stringify(r.alvos).slice(0, 200));

  // 13. Link autônomo display:block dentro de <li>, pequeno e colado ⇒ viol
  r = await avaliar(`<main style="${FUNDO};padding:20px"><ul><li><a id="la1" href="#" style="display:block;width:10px;height:10px"></a><a id="la2" href="#" style="display:block;width:10px;height:10px"></a></li></ul></main>`);
  t("links display:block em li NÃO exceptuados — viol sem espaçamento", temViol(r, "a ") || r.alvos.viol.length > 0, JSON.stringify(r.alvos).slice(0, 240));

  // 14. Botão pequeno dentro de <li> ⇒ não exceptuado
  r = await avaliar(`<main style="${FUNDO};padding:20px"><ul><li><button id="bt1" style="width:10px;height:10px;padding:0"></button><button id="bt2" style="width:10px;height:10px;padding:0"></button></li></ul></main>`);
  t("botões pequenos em li NÃO exceptuados — viol sem espaçamento", r.alvos.viol.length > 0, JSON.stringify(r.alvos).slice(0, 240));
}

sec("Indicador de foco — alpha e geometrias");
{
  let r;
  // 15. Outline com alpha composto sobre o adjacente ⇒ PASS medido
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="f1" style="padding:8px 14px;color:#e8eaee">Alvo</button><style>#f1:focus{outline:2px solid rgba(255,255,255,0.5)}</style></main>`, "f1");
  t("foco outline alpha ⇒ medido com composição (sem viol/rev)", r.viol.length === 0 && r.rev.length === 0, JSON.stringify(r).slice(0, 240));

  // 16. Múltiplas sombras ⇒ REVIEW (adjacentes distintos não classificados)
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="f2" style="padding:8px 14px;color:#e8eaee;outline:none">Alvo</button><style>#f2:focus{box-shadow:0 0 0 2px #ffffff,0 0 0 5px #000000}</style></main>`, "f2");
  t("foco com múltiplas sombras ⇒ REVIEW", r.rev.length > 0 && r.viol.length === 0, JSON.stringify(r).slice(0, 240));

  // 17. Sem outline/sombra ⇒ REVIEW (possível borda/fundo — inspeção)
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="f3" style="padding:8px 14px;color:#e8eaee;outline:none;box-shadow:none">Alvo</button></main>`, "f3");
  t("foco sem indicador mensurável ⇒ REVIEW", r.rev.length > 0 && r.viol.length === 0, JSON.stringify(r).slice(0, 240));
}

await browser.close();
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
