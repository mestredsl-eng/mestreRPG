// Ajuste único e idempotente (Etapa C): marca usadoEmTestes=true nos campos
// numéricos com semântica de teste (atributo, habilidade, conhecimento,
// talento) em todas as versões de ficha publicadas.
//
// Motivo: o checkbox "Usado em testes" do editor nasceu desmarcado e nunca
// foi configurado — todas as fichas existentes têm usadoEmTestes:false
// explícito. Sem este ajuste, a nova regra de elegibilidade deixaria o
// Desafio D10 sem nenhum campo. A alteração é aditiva (só liga a flag em
// campos que semanticamente já são testáveis); não toca valores de
// personagens, snapshots, ponteiros de versão nem campos de outras
// semânticas (moeda, item, livre, seleções).
//
// Uso: node ajustar-usado-em-testes.mjs   (pode rodar com o servidor no ar)
import Database from "better-sqlite3";

const SEMANTICOS = new Set(["atributo", "habilidade", "conhecimento", "talento"]);
const TIPOS_NUM = new Set(["inteiro", "decimal"]);

const db = new Database("banco/mestre-rpg.db");
const versoes = db.prepare("select id, template_id, version, structure from sheet_versions").all();

let versoesAlteradas = 0;
let camposMarcados = 0;
const detalhes = [];

const atualizar = db.prepare("update sheet_versions set structure = ? where id = ?");

for (const v of versoes) {
  let st;
  try { st = JSON.parse(v.structure); } catch { continue; }
  let mudou = false;
  const marcados = [];
  for (const sec of st.secoes ?? []) {
    for (const c of sec.campos ?? []) {
      if (!TIPOS_NUM.has(c.tipo) || !SEMANTICOS.has(c.semantico)) continue;
      if (c.usadoEmTestes === true) continue;
      c.usadoEmTestes = true;
      mudou = true;
      camposMarcados++;
      marcados.push(`${c.semantico}:${c.label}`);
    }
  }
  if (mudou) {
    atualizar.run(JSON.stringify(st), v.id);
    versoesAlteradas++;
    detalhes.push(`v${v.version} ${v.id.slice(0, 8)} (${v.template_id.slice(0, 8)}): ${marcados.length} campos`);
  }
}

console.log(`Versões alteradas: ${versoesAlteradas} · campos marcados: ${camposMarcados}`);
detalhes.forEach((d) => console.log("  " + d));
