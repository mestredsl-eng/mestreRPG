// Auditor de nomes acessíveis type-aware (HTML-AAM) — autocontido para
// page.evaluate (o Playwright serializa só o fonte da função).
// Endurecimentos #7110968271:
//  - value de input e textContent de <option> NÃO são nome acessível;
//  - placeholder/aria-placeholder só onde o HTML-AAM prevê fallback
//    (input de tipos texto-like + textarea — nunca select/checkbox/etc.);
//  - disabled NÃO elimina a obrigação de nome (SC 4.1.2 cobre todos os
//    componentes); input[type=hidden] e não-renderizados ficam fora;
//  - aria-hidden em controle renderizado e focalizável ⇒ CONFLITO próprio
//    (não é falta de nome — é quebra da árvore de acessibilidade);
//  - texto interno usa innerText (texto computável/renderizado), não
//    textContent bruto — descendentes display:none não viram nome.
// Retorna { semNome: [...], conflitos: [...] }.
function auditarNomes(alvo) {
  const raiz = typeof alvo === "string"
    ? (alvo ? document.querySelector(alvo) : document)
    : (alvo && typeof alvo.querySelectorAll === "function" ? alvo : document);
  if (!raiz || typeof raiz.querySelectorAll !== "function") {
    return { semNome: ["<raiz ausente>"], conflitos: [] };
  }
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
  // HTML-AAM: placeholder é fallback de nome apenas para input de tipos
  // texto-like e textarea — nunca para select, checkbox, radio, button…
  const TIPOS_PLACEHOLDER = new Set([
    "text", "search", "url", "tel", "email", "password", "number",
    "date", "month", "week", "time", "datetime-local",
  ]);
  const placeholderValido = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input" || botaoInput(el)) return false;
    return TIPOS_PLACEHOLDER.has(tipoInput(el));
  };
  const desc = (el) => {
    const id = el.id ? "#" + el.id : "";
    const aria = el.getAttribute("aria-label") ? "[aria-label]" : "";
    const ph = !aria && el.getAttribute("placeholder") ? "[placeholder]" : "";
    const dis = el.disabled || el.closest("[disabled]") ? "[disabled]" : "";
    return `${el.tagName.toLowerCase()}${id}${aria}${ph}${dis} ${(el.className || "").toString().slice(0, 40)}`.trim();
  };
  const out = { semNome: [], conflitos: [] };
  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && tipoInput(el) === "hidden") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") continue;
    if (!el.getClientRects().length) continue; // não renderizado (ancestral display:none etc.)
    const ariaHidden = !!el.closest("[aria-hidden='true']");
    const focalizavel = el.tabIndex >= 0;
    if (ariaHidden) {
      // aria-hidden em componente visível e focalizável: conflito de
      // árvore de acessibilidade — verificação própria, não é "sem nome"
      if (focalizavel) out.conflitos.push(desc(el));
      continue;
    }
    const labelledby = el.getAttribute("aria-labelledby");
    const rotulos = rotulosDe(el)
      .map((l) => (l.innerText || "").trim())
      .filter(Boolean).join(" ");
    const phOk = placeholderValido(el);
    const nome = (
      el.getAttribute("aria-label") ||
      (labelledby ? labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ") : "") ||
      rotulos ||
      el.getAttribute("title") ||
      (phOk ? (el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || "") : "") ||
      (!ehCampo(el) || botaoInput(el) ? (el.innerText || "") : "") ||
      (botaoInput(el) ? (el.value || "") : "")
    ).trim();
    // disabled/aria-disabled NÃO excluem: o componente continua exposto
    // na árvore de acessibilidade e SC 4.1.2 exige nome para ele.
    if (!nome) out.semNome.push(desc(el));
  }
  return out;
}
export { auditarNomes };
