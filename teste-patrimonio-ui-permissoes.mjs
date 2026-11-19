#!/usr/bin/env node
// Regressão estática da Issue #165: a UI de Patrimônio deve usar as permissões
// granulares já carregadas de /regras, não uma configuração financeira parcial
// obtida de /financeiro. O enforcement real continua no backend; este teste
// evita que a UI volte a exibir compra/estorno para jogador sem permissão.
import { readFileSync } from "node:fs";

const src = readFileSync("site/src/paginas/Patrimonio.tsx", "utf8");
const checks = [
  ["compra/venda usa permissoes.compraVenda", /const podeOperar = !somenteLeitura && \(souMestre \|\| permissoes\.compraVenda\);/],
  ["estorno usa permissoes.compraVenda", /!somenteLeitura && \(souMestre \|\| permissoes\.compraVenda\) &&/],
  ["não usa fallback antigo de jogadorCompraVenda", !src.includes("fin?.config.jogadorCompraVenda") && !src.includes("cfg.jogadorCompraVenda")],
];
let falhas = 0;
for (const [nome, ok] of checks) {
  if (ok instanceof RegExp ? ok.test(src) : ok) console.log("  ok", nome);
  else { console.log("  FALHOU", nome); falhas++; }
}
if (falhas) process.exit(1);
console.log(`${checks.length} verificações, 0 falhas`);
