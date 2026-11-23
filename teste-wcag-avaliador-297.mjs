// Fixtures unitárias DOM do avaliador WCAG (#297 / #300).
// DOM sintético determinístico via setContent — prova a CLASSIFICAÇÃO
// normativa exigida pelo Dono (#7104140993): indicador→adjacente, ambíguo
// ⇒ REVIEW, IMG amostrado, inline estrito, foco com alpha composto.
import { chromium } from "playwright";
import { avaliarWcag, avaliarFocoIndicador } from "./wcag-avaliador-297.mjs";
import { auditarNomes } from "./nomes-acessiveis-297.mjs";

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

  // 6b. aria-label NÃO é cue visual: input só com aria-label e fronteira
  // fraca ⇒ FAIL (nome acessível ≠ identificação visual)
  r = await avaliar(`<main style="${FUNDO};padding:20px"><input id="i5" aria-label="Nome" style="border:1px solid #2c3038;background:#1c2026;padding:6px;width:200px"></main>`);
  t("aria-label sozinho não é contexto visual ⇒ FAIL", temViol(r, "i5"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 6c. Placeholder vazio (campo vazio → visível) com ::placeholder ≥4.5 ⇒ REVIEW válido
  r = await avaliar(`<main style="${FUNDO};padding:20px"><style>#i6::placeholder{color:#aab4c0}</style><input id="i6" placeholder="Digite o nome" style="border:1px solid #2c3038;background:#1c2026;padding:6px;width:200px;color:#e8eaee"></main>`);
  t("placeholder visível com contraste ≥4.5 ⇒ REVIEW (contexto válido)", temRev(r, "i6") && (r.naoTexto.rev.join(" ").includes("pode identificar") || r.naoTexto.rev.join(" ").includes("valido")), JSON.stringify(r.naoTexto.rev).slice(0, 240));

  // 6d. Mesmo input COM valor → placeholder some → sem contexto ⇒ FAIL
  r = await avaliar(`<main style="${FUNDO};padding:20px"><style>#i7::placeholder{color:#aab4c0}</style><input id="i7" placeholder="Digite o nome" value="preenchido" style="border:1px solid #2c3038;background:#1c2026;padding:6px;width:200px;color:#e8eaee"></main>`);
  t("placeholder preenchido não conta ⇒ FAIL", temViol(r, "i7"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 6e. Label display:none ⇒ contexto inválido ⇒ REVIEW (não FAIL, não PASS)
  r = await avaliar(`<main style="${FUNDO};padding:20px"><label for="i8" style="display:none">Nome oculto</label><input id="i8" style="border:1px solid #2c3038;background:#1c2026;padding:6px;width:200px"></main>`);
  t("label oculto ⇒ REVIEW (contexto não comprovado)", temRev(r, "i8") && !temViol(r, "i8"), JSON.stringify(r.naoTexto).slice(0, 240));

  // 6f. Label com contraste insuficiente (<4.5) ⇒ contexto inválido ⇒ REVIEW
  r = await avaliar(`<main style="${FUNDO};padding:20px"><label for="i9" style="color:#3a4149">Nome apagado</label><input id="i9" style="border:1px solid #2c3038;background:#1c2026;padding:6px;width:200px"></main>`);
  t("label com contraste <4.5 ⇒ REVIEW (contexto inválido)", temRev(r, "i9") && !temViol(r, "i9"), JSON.stringify(r.naoTexto).slice(0, 240));
}

sec("SC 1.4.11 — select: cue ambíguo (diagnóstico #7106946553)");
{
  let r;
  // 6g. Select com opção selecionada legível + chrome nativo do UA
  // (appearance:auto, seta não mensurável): cue identifica o VALOR,
  // não o propósito ⇒ REVIEW ambíguo — nunca FAIL nem PASS por conveniência
  r = await avaliar(`<main style="${FUNDO};padding:20px"><select id="s1" aria-label="Ação de pontos" style="border:1px solid #2c3038;background:#1c2026;color:#e8eaee;padding:4px;width:140px"><option>Conceder</option><option>Remover</option></select></main>`);
  t("select c/ opção legível + affordance nativa ⇒ REVIEW ambíguo", temRev(r, "s1") && !temViol(r, "s1") && r.naoTexto.rev.join(" ").includes("select"), JSON.stringify(r.naoTexto).slice(0, 300));

  // 6h. Select appearance:none + opção sem texto legível ⇒ nenhum cue
  // identificável ⇒ FAIL determinístico (não mascarado como REVIEW)
  r = await avaliar(`<main style="${FUNDO};padding:20px"><select id="s2" style="appearance:none;-webkit-appearance:none;border:1px solid #2c3038;background:#1c2026;color:#23262b;padding:4px;width:140px"><option></option></select></main>`);
  t("select sem affordance/legibilidade ⇒ FAIL determinístico", temViol(r, "s2") && !temRev(r, "s2"), JSON.stringify(r.naoTexto).slice(0, 300));
}

sec("SC 1.4.11 — input number: stepper nativo (#7110981908)");
{
  let r;
  // n1. Input number appearance:auto COM valor: stepper nativo do UA
  // renderizado (pseudo-elemento medido) ⇒ REVIEW — nunca FAIL/PASS
  r = await avaliar(`<main style="${FUNDO};padding:20px"><input id="n1" type="number" value="1" aria-label="Quantidade" style="border:1px solid #2c3038;background:#1c2026;color:#e8eaee;padding:6px;width:80px"></main>`);
  t("input number c/ stepper + valor ⇒ REVIEW", temRev(r, "n1") && !temViol(r, "n1") && r.naoTexto.rev.join(" ").includes("stepper"), JSON.stringify(r.naoTexto).slice(0, 300));

  // n2. MESMO input VAZIO: o valor some, mas o stepper persiste ⇒ REVIEW
  // (a classificação não depende do estado do valor)
  r = await avaliar(`<main style="${FUNDO};padding:20px"><input id="n2" type="number" aria-label="Quantidade" style="border:1px solid #2c3038;background:#1c2026;color:#e8eaee;padding:6px;width:80px"></main>`);
  t("input number vazio c/ stepper ⇒ REVIEW", temRev(r, "n2") && !temViol(r, "n2") && r.naoTexto.rev.join(" ").includes("stepper"), JSON.stringify(r.naoTexto).slice(0, 300));

  // n3. appearance:none ⇒ stepper suprimido ⇒ sem affordance ⇒ FAIL
  r = await avaliar(`<main style="${FUNDO};padding:20px"><input id="n3" type="number" value="1" aria-label="Quantidade" style="appearance:none;-webkit-appearance:none;border:1px solid #2c3038;background:#1c2026;color:#e8eaee;padding:6px;width:80px"></main>`);
  t("input number appearance:none ⇒ FAIL determinístico", temViol(r, "n3") && !temRev(r, "n3"), JSON.stringify(r.naoTexto).slice(0, 300));

  // n4. Composição de toolbar equivalente ao PainelPontosMestre
  // (select + input number + botão Aplicar): stepper ⇒ REVIEW
  r = await avaliar(`<main style="${FUNDO};padding:20px"><div style="display:flex;gap:6px;align-items:center"><select id="sx1" aria-label="Ação" style="border:1px solid #2c3038;background:#1c2026;color:#e8eaee;padding:4px"><option>Conceder</option></select><input id="n4" type="number" value="1" aria-label="Quantidade" style="border:1px solid #2c3038;background:#1c2026;color:#e8eaee;padding:6px;width:70px"><button id="ap1" style="padding:6px 12px;color:#e8eaee;background:#2a2f38;border:1px solid #3a4150">Aplicar</button></div></main>`);
  t("input number em toolbar contextual ⇒ REVIEW (stepper)", temRev(r, "n4") && !temViol(r, "n4"), JSON.stringify(r.naoTexto).slice(0, 300));
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

  // 11b. IMG heterogênea: maioria clara + pequeno símbolo escuro essencial
  // ⇒ média global poderia passar, mas região essencial não comprovada ⇒ REVIEW
  const IMG_HETERO = "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='white'/><rect x='3' y='3' width='4' height='4' fill='black'/></svg>");
  r = await avaliar(`<main style="${FUNDO};padding:20px"><button id="ib4" style="border:1px solid #2c3038;background:#1c2026;padding:4px"><img src="${IMG_HETERO}" width="20" height="20" alt=""></button></main>`);
  t("img heterogênea (símbolo essencial escuro) ⇒ REVIEW, não PASS por média", temRev(r, "ib4"), JSON.stringify(r.naoTexto).slice(0, 260));
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

  // 14b. Links display:inline FORA de frase (sem p/li/td) ⇒ não exceptuados
  r = await avaliar(`<main style="${FUNDO};padding:20px"><div><a id="iso1" href="#" style="display:inline;font-size:12px;color:#8ab4ff">x</a><a id="iso2" href="#" style="display:inline;font-size:12px;color:#8ab4ff">y</a></div></main>`);
  t("links inline isolados sem frase ⇒ NÃO exceptuados (viol)", r.alvos.viol.length > 0, JSON.stringify(r.alvos).slice(0, 240));
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

sec("Nomes acessíveis — type-aware HTML-AAM (#7107456243)");
{
  const nomes = async (html) => {
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    return page.evaluate(auditarNomes);
  };
  let n;
  // select com texto de opções mas sem label/ARIA/title ⇒ SEM nome
  // (option text é valor corrente, não nome acessível)
  n = await nomes(`<main><select id="sel1"><option>Conta…</option><option>Entrada</option><option>Dinheiro em espécie</option></select></main>`);
  t("select só com opções ⇒ sem nome", n.some((x) => x.includes("sel1")), JSON.stringify(n));

  // select com aria-label ⇒ nome
  n = await nomes(`<main><select id="sel2" aria-label="Conta de origem"><option>Conta…</option></select></main>`);
  t("select com aria-label ⇒ nome", !n.some((x) => x.includes("sel2")), JSON.stringify(n));

  // select com <label for> ⇒ nome
  n = await nomes(`<main><label for="sel3">Tipo de conta</label><select id="sel3"><option>especie</option></select></main>`);
  t("select com label associado ⇒ nome", !n.some((x) => x.includes("sel3")), JSON.stringify(n));

  // input number preenchido sem nenhuma fonte ⇒ SEM nome
  // (value é conteúdo do campo, não nome)
  n = await nomes(`<main><input id="num1" type="number" value="1"></main>`);
  t("input number com valor ⇒ sem nome", n.some((x) => x.includes("num1")), JSON.stringify(n));

  // botão com texto interno ⇒ nome (texto interno é fonte válida)
  n = await nomes(`<main><button id="bt9">Registrar</button></main>`);
  t("button com texto ⇒ nome", !n.some((x) => x.includes("bt9")), JSON.stringify(n));

  // input texto com placeholder ⇒ fallback HTML-AAM ⇒ nome
  n = await nomes(`<main><input id="tx1" placeholder="Descrição"></main>`);
  t("input com placeholder ⇒ nome (fallback)", !n.some((x) => x.includes("tx1")), JSON.stringify(n));

  // input type=submit com value ⇒ o value É o rótulo ⇒ nome
  n = await nomes(`<main><input id="sb1" type="submit" value="Enviar"></main>`);
  t("input submit com value ⇒ nome", !n.some((x) => x.includes("sb1")), JSON.stringify(n));

  // link com texto ⇒ nome
  n = await nomes(`<main><a id="lk1" href="#">Detalhes</a></main>`);
  t("link com texto ⇒ nome", !n.some((x) => x.includes("lk1")), JSON.stringify(n));
}

await browser.close();
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
