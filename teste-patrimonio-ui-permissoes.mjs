#!/usr/bin/env node
// Regressão estática da Issue #165: a UI de Patrimônio deve usar as permissões
// granulares já carregadas de /regras, não uma configuração financeira parcial
// obtida de /financeiro. O enforcement real continua no backend; este teste
// evita que a UI volte a exibir ações sem a permissão correspondente ou volte
// ao estado fail-open durante o carregamento das regras.
import { readFileSync } from "node:fs";

const src = readFileSync("site/src/paginas/Patrimonio.tsx", "utf8");
const checks = [
  ["permissoes inicia null (fail-closed no carregamento)", /useState<PermissoesPatrimonio \| null>\(null\)/],
  ["compra/venda usa permissoes.compraVenda", /permissoes\?\.compraVenda === true/],
  ["estorno usa permissoes.compraVenda", /!somenteLeitura && \(souMestre \|\| permissoes\?\.compraVenda === true\) &&/],
  ["não usa fallback antigo de jogadorCompraVenda", !src.includes("fin?.config.jogadorCompraVenda") && !src.includes("cfg.jogadorCompraVenda")],
  ["adiciona itens gateado", /podeAdicionar = souMestre \|\| permissoes\?\.adicionaItens === true/],
  ["remove itens gateado", /podeRemover = souMestre \|\| permissoes\?\.removeItens === true/],
  ["equipamentos gateado", /permissoes\?\.editaEquipamentos === true/],
  ["veículos gateado", /permissoes\?\.editaVeiculos === true/],
  ["criar contas gateado", /permissoes\?\.criaContas === true/],
  ["pix gateado", /permissoes\?\.pix === true/],
  ["transferência item filtra destino por adicionaItens (ehEu)", /p\.id !== proprioId && \(podeReceberDeOutros \|\| p\.ehEu\)/],
  ["NovaConta esconde saldo/limite sem compraVenda", /podeDefinirValor && \(\s*<input placeholder="Saldo inicial"/],
  ["nenhum acesso direto a permissoes sem optional chaining", !/permissoes\.(adicionaItens|removeItens|editaEquipamentos|editaVeiculos|criaContas|compraVenda|pix)\b/.test(src)],
];
let falhas = 0;
for (const [nome, ok] of checks) {
  if (ok instanceof RegExp ? ok.test(src) : ok) console.log("  ok", nome);
  else { console.log("  FALHOU", nome); falhas++; }
}
if (falhas) process.exit(1);
console.log(`${checks.length} verificações, 0 falhas`);
