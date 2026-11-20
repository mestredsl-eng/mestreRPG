// Helpers de fixture descartável — homologação Issue #155 (Etapas 1–3).
// Somente TESTES: produzem backups/estado sintéticos em diretórios
// temporários. Nunca apontam para a instalação ou banco reais.
//
// gerarManifestoBackup(dir): emite manifesto.json v2 íntegro para um
// diretório de backup montado manualmente, no MESMO formato que
// servidor/src/lib/backup.ts produz (campos exigidos por
// validar-backup.ts):
//   { manifestoVersao: 2, banco: {size,sha256},
//     configuracao: null | {size,sha256},
//     arquivos: { "arquivos/<rel>": {size,sha256} } }
// Arquivos fora das categorias conhecidas (exceto manifesto.json) são
// declarados em `extras` se o chamador quiser — por padrão o helper
// FALHA se encontrar arquivo não categorizado, para não mascarar
// inventário sujo em fixtures que pretendem ser válidas.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256Arquivo(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function meta(p) {
  return { size: statSync(p).size, sha256: sha256Arquivo(p) };
}

/** Enumera arquivos regulares sob `base` como rel posix (sem o prefixo). */
function inventario(base) {
  const out = [];
  const andar = (atual, rel) => {
    for (const e of readdirSync(atual, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(atual, e.name);
      if (e.isDirectory()) andar(p, r);
      else if (e.isFile()) out.push(r);
      // symlinks e não-regulares ficam de fora — o validador os rejeita
    }
  };
  if (existsSync(base)) andar(base, "");
  return out.sort();
}

/**
 * Gera manifesto.json v2 para `dir` (diretório de backup).
 * opts.extras: Set de rel paths adicionais a declarar (ex.: "notas.txt").
 * Retorna o objeto do manifesto escrito.
 */
export function gerarManifestoBackup(dir, { extras = [] } = {}) {
  const man = {
    manifestoVersao: 2,
    arquivos: {},
    criadoEm: new Date().toISOString(),
    versao: "teste-fixture",
  };
  const db = join(dir, "mestre-rpg.db");
  if (!existsSync(db)) throw new Error(`fixture: ${dir} sem mestre-rpg.db`);
  man.banco = meta(db);

  const cfg = join(dir, "configuracao", "servidor.json");
  man.configuracao = existsSync(cfg) ? meta(cfg) : null;

  const cobertos = new Set(["mestre-rpg.db", "manifesto.json"]);
  if (man.configuracao) cobertos.add("configuracao/servidor.json");
  // somente o servidor.json é categorizado; outros arquivos em
  // configuracao/ tornam a fixture inválida por desenho do validador.
  for (const rel of inventario(join(dir, "arquivos"))) {
    const chave = `arquivos/${rel}`;
    man.arquivos[chave] = meta(join(dir, "arquivos", rel));
    cobertos.add(chave);
  }
  for (const rel of extras) {
    const p = join(dir, ...rel.split("/"));
    if (!existsSync(p)) throw new Error(`fixture: extra declarado ausente: ${rel}`);
    man.arquivos[rel] = meta(p);
    cobertos.add(rel);
  }
  // confere se há arquivo real não declarado (fora de arquivos/ e
  // configuracao/servidor.json) — evidência de fixture suja
  const todos = [];
  const andarTudo = (atual, rel) => {
    for (const e of readdirSync(atual, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(atual, e.name);
      if (e.isDirectory()) andarTudo(p, r);
      else if (e.isFile()) todos.push(r);
    }
  };
  andarTudo(dir, "");
  const soltos = todos.filter((r) => !cobertos.has(r) && r !== "manifesto.json");
  if (soltos.length) {
    throw new Error(`fixture: arquivos não categorizados em ${dir}: ${soltos.join(", ")}`);
  }

  writeFileSync(join(dir, "manifesto.json"), JSON.stringify(man, null, 2));
  return man;
}

/** Remove o manifesto de um backup (cenário de rejeição). */
export function removerManifesto(dir) {
  rmSync(join(dir, "manifesto.json"), { force: true });
}
