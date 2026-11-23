// Auditor de nomes acessíveis type-aware (HTML-AAM) — autocontido para
// page.evaluate (o Playwright serializa só o fonte da função).
// Ordem #7107456243: o fallback `textContent || value` anterior era
// incorreto — textContent de <select> são textos de <option> (valor
// corrente, não nome) e value de input/textarea é o conteúdo do campo.
// Fontes válidas por tipo:
//   aria-label > aria-labelledby > <label>/label[for] > title >
//   placeholder (inputs/textarea — fallback HTML-AAM) >
//   texto interno (button/a/summary/[role=button|link|tab|...] e
//   input[type=button|submit|reset|image], cujo value É o rótulo).
function auditarNomes(alvo) {
  // `alvo`: seletor CSS (string), Element (escopo de formulário) ou
  // ausente/null ⇒ documento inteiro.
  const raiz = typeof alvo === "string"
    ? (alvo ? document.querySelector(alvo) : document)
    : (alvo && typeof alvo.querySelectorAll === "function" ? alvo : document);
  if (!raiz || typeof raiz.querySelectorAll !== "function") return ["<raiz ausente>"];
  const els = [...raiz.querySelectorAll(
    "button, a[href], input, select, textarea, summary, " +
    "[role='button'], [role='link'], [role='tab'], [role='menuitem'], " +
    "[role='checkbox'], [role='radio'], [role='switch']"
  )];
  const rotulosDe = (el) => {
    const ls = [];
    if (el.labels) ls.push(...el.labels);
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) ls.push(l);
      } catch { }
    }
    const anc = el.closest("label");
    if (anc) ls.push(anc);
    return [...new Set(ls)];
  };
  const tipoInput = (el) => (el.getAttribute("type") || "text").toLowerCase();
  const ehCampo = (el) => /^(input|select|textarea)$/.test(el.tagName.toLowerCase());
  // input type=button/submit/reset/image: o value é o rótulo renderizado
  const botaoInput = (el) => el.tagName.toLowerCase() === "input" &&
    ["button", "submit", "reset", "image"].includes(tipoInput(el));
  return els.filter((el) => {
    const labelledby = el.getAttribute("aria-labelledby");
    const rotulos = rotulosDe(el)
      .map((l) => (l.innerText || l.textContent || "").trim())
      .filter(Boolean).join(" ");
    const nome = (
      el.getAttribute("aria-label") ||
      (labelledby ? labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ") : "") ||
      rotulos ||
      el.getAttribute("title") ||
      (ehCampo(el) && !botaoInput(el) ? el.getAttribute("placeholder") : "") ||
      (!ehCampo(el) || botaoInput(el) ? (el.textContent || "") : "") ||
      (botaoInput(el) ? (el.value || "") : "")
    ).trim();
    const oc = el.closest("[hidden], [aria-hidden='true'], [disabled]");
    return !nome && !oc;
  }).map((el) => {
    const id = el.id ? "#" + el.id : "";
    const aria = el.getAttribute("aria-label") ? "[aria-label]" : "";
    const ph = !aria && el.getAttribute("placeholder") ? "[placeholder]" : "";
    return `${el.tagName.toLowerCase()}${id}${aria}${ph} ${(el.className || "").toString().slice(0, 40)}`.trim();
  });
}
export { auditarNomes };
