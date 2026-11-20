// Ajuste idempotente: marca usadoEmTestes=true nos campos explicitamente
// bloqueados (usadoEmTestes:false) que sejam testáveis — tipos inteiro,
// decimal e selecao_nivel (cada elemento com nível é um valor de teste)
// com semântica atributo/habilidade/conhecimento/talento.
//
// Motivo: o checkbox "Usado em testes" do editor nasceu desmarcado e
// fichas antigas têm usadoEmTestes:false explícito, o que bloqueia o
// fallback semântico e esvazia o seletor do Desafio D10.
// A alteração é aditiva: só liga a flag; não toca valores de personagens,
// snapshots, ponteiros de versão, patrimônio nem campos de outras
// semânticas (moeda, item, livre, especialização, poder, defeito).
//
// Uso: node ajustar-usado-em-testes.mjs [caminho-do-banco]
//   Banco: argumento > MESTRE_BANCO > banco/mestre-rpg.db
//   Faz backup (.bak-pre-usado-em-testes-<ts>.db) antes de escrever e
//   aplica tudo dentro de UMA transação. Pode rodar com o servidor no ar.
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { statSync } from "node:fs";

const SEMANTICOS = new Set(["atributo", "habilidade", "conhecimento", "talento"]);
const TIPOS_TESTAVEIS = new Set(["inteiro", "decimal", "selecao_nivel"]);

const banco = resolve(process.argv[2] ?? process.env.MESTRE_BANCO ?? "banco/mestre-rpg.db");
console.log(`Banco: ${banco} (${statSync(banco).size} bytes)`);

const db = new Database(banco);

// Backup consistente via API de backup do SQLite (inclui estado WAL).
const backup = `${banco}.bak-pre-usado-em-testes-${Date.now()}.db`;
await db.backup(backup);
console.log(`Backup: ${backup}`);

const versoes = db.prepare("select id, template_id, version, structure from sheet_versions").all();
const atualizar = db.prepare("update sheet_versions set structure = ? where id = ?");

let versoesAlteradas = 0;
let camposMarcados = 0;
const detalhes = [];

const tx = db.transaction(() => {
  for (const v of versoes) {
    let st;
    try { st = JSON.parse(v.structure); } catch { continue; }
    let mudou = false;
    const marcados = [];
    for (const sec of st.secoes ?? []) {
      for (const c of sec.campos ?? []) {
        if (!TIPOS_TESTAVEIS.has(c.tipo) || !SEMANTICOS.has(c.semantico)) continue;
        if (c.usadoEmTestes !== false) continue; // só bloqueio explícito
        c.usadoEmTestes = true;
        mudou = true;
        camposMarcados++;
        marcados.push(`${c.semantico}:${c.label ?? c.id}`);
      }
    }
    if (mudou) {
      atualizar.run(JSON.stringify(st), v.id);
      versoesAlteradas++;
      detalhes.push(`v${v.version} ${v.id.slice(0, 8)} (${v.template_id.slice(0, 8)}): ${marcados.length} campos`);
    }
  }
});
tx();

console.log(`Versões alteradas: ${versoesAlteradas} · campos marcados: ${camposMarcados}`);
detalhes.forEach((d) => console.log("  " + d));
db.close();
