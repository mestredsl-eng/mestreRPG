// Testes do motor de regras — ajustes finais Etapa 5
// Isolado (Lote 0): regras montadas em memória com fixtures sintéticas
// equivalentes às da campanha original — nenhum acesso a banco, campanha
// ou UUID real. Cobre transferências, exclusividade, incompatibilidades
// e fórmulas com os mesmos elementos e custos de antes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calcularPontos } from "./servidor/dist/lib/ficha.js";

// `regras.js` executa getDb() no top-level do módulo: apontamos
// MESTRE_BANCO para um arquivo temporário ANTES do import dinâmico,
// para que nenhum banco real (nem o vazio do worktree) seja criado.
const TMP_REGRAS = mkdtempSync(join(tmpdir(), "mrpg-regras-"));
process.env.MESTRE_BANCO = join(TMP_REGRAS, "banco.db");
const { validarRegras, aplicarTransferencias, aplicarCustosSelecao, configRegrasSchema } =
  await import("./servidor/dist/lib/regras.js");

const AGORA = new Date();
const RULESET_FX = "fx-regras-lote0";
const definicaoPadrao = {
  descricao: undefined, subcategoria: undefined, custoPontos: undefined,
  custoProgressivo: undefined, minimo: undefined, maximo: undefined,
  prerequisitos: [], dependencias: [], grupoExclusividade: undefined,
  gruposExclusividade: [], exclusivos: [], obrigatorios: [],
  reservaPontos: undefined, disponivel: true, ordem: 0, formulas: {},
};
const mkEl = (kind, key, name, def) => ({
  id: `fx-${kind}-${key}`, ruleSetId: RULESET_FX, kind, key, name,
  category: null, parentKey: null,
  definition: { ...definicaoPadrao, ...def },
  createdAt: AGORA, updatedAt: AGORA,
});

// Fixtures fiéis aos elementos usados pela suíte (mesmos custos e
// grupos de exclusividade da campanha de referência).
const elementos = new Map();
const porKind = new Map();
const addEl = (e) => {
  elementos.set(`${e.kind}:${e.key}`, e);
  const l = porKind.get(e.kind) ?? [];
  l.push(e);
  porKind.set(e.kind, l);
};
addEl(mkEl("atributo", "forca", "Força", { custoPontos: 7, minimo: 0, maximo: 5 }));
addEl(mkEl("vantagem", "memoria_excepcional", "Memória Excepcional", { reservaPontos: "vantagens", custoPontos: 1 }));
addEl(mkEl("vantagem", "patrimonio", "Patrimônio", { reservaPontos: "vantagens", custoPontos: 3 }));
addEl(mkEl("vantagem", "reflexos_treinados", "Reflexos Treinados", { reservaPontos: "vantagens", custoPontos: 2 }));
addEl(mkEl("poder", "telepatia", "Telepatia", { custoPontos: 3, grupoExclusividade: "poderes_ocultos", obrigatorios: ["defeito:preco_oculto"] }));
addEl(mkEl("poder", "magia", "Magia", { custoPontos: 3, grupoExclusividade: "poderes_ocultos", obrigatorios: ["defeito:preco_oculto"] }));

const regras = { ruleSetId: RULESET_FX, config: configRegrasSchema.parse({}), elementos, porKind };
// Pontos precisam estar habilitados para os testes de transferência —
// fixamos o estado esperado em memória (determinístico, sem tocar no banco).
regras.config.pontos = { habilitado: true, pontosIniciais: 20, pools: [
  { id: "vantagens", nome: "Vantagens", pontos: 5 },
  { id: "defeitos", nome: "Defeitos", pontos: 5 },
], custos: {} };
regras.config.pontosExtras = 5;

const est = {
  versao: 1,
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  secoes: [{
    id: "s", titulo: "S", ordem: 0,
    campos: [
      { id: "forca", label: "Força", tipo: "inteiro", semantico: "atributo", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false, regra: { kind: "atributo", key: "forca" } },
      { id: "vantagens", label: "Vantagens", tipo: "selecao_multipla", semantico: "vantagem", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false, regraKind: "vantagem" },
      { id: "poderes", label: "Poderes", tipo: "selecao_multipla", semantico: "poder", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false, regraKind: "poder" },
    ],
  }],
};

// Força 2 = 7 pts (principal tem 25). Vantagens: memoria(1)+patrimonio(3)+reflexos(2)=6 > reserva 5.
const dadosEstouro = { forca: 2, vantagens: ["memoria_excepcional", "patrimonio", "reflexos_treinados"] };
const dadosOk = { forca: 1, vantagens: ["memoria_excepcional"] };

let pass = 0, fail = 0;
const t = (nome, cond, extra = "") => { if (cond) { pass++; console.log("  ok", nome); } else { fail++; console.log("  FALHOU", nome, extra); } };

console.log("== Transferências ==");
// A) desabilitada: estouro deve falhar mesmo com principal tendo 18 de sobra
regras.config.transferivelEntreReservas = false;
regras.config.transferencias = [];
let r = validarRegras(est, dadosEstouro, regras);
t("desabilitada: estouro rejeitado", !r.ok && r.erros.some((e) => e.codigo === "pontos"), JSON.stringify(r.erros));

// B) habilitada com aresta principal→vantagens
regras.config.transferivelEntreReservas = true;
regras.config.transferencias = [{ origem: "principal", destino: "vantagens" }];
r = validarRegras(est, dadosEstouro, regras);
t("habilitada+aresta: estouro coberto", r.ok, JSON.stringify(r.erros));

// C) aresta na direção errada: vantagens→defeitos não ajuda o déficit de vantagens
//    (nenhuma aresta sai de principal/defeitos rumo a vantagens)
regras.config.transferencias = [{ origem: "vantagens", destino: "defeitos" }];
r = validarRegras(est, dadosEstouro, regras);
t("aresta não autorizada: rejeitado", !r.ok, JSON.stringify(r.erros));

// D) limite da aresta = 0 → não transfere
regras.config.transferencias = [{ origem: "principal", destino: "vantagens", limite: 0 }];
r = validarRegras(est, dadosEstouro, regras);
t("limite 0: rejeitado", !r.ok, JSON.stringify(r.erros));

// E) limite parcial: precisa 1, limite... make deficit bigger: add more vantagens? patrimonio+reflexos+memoria=6, deficit 1.
// Use limite... need bigger deficit: choose 4 vantagens?Only 3 seeded w/ custo. custoPontos: memoria1, patrimonio3, reflexos2 =6. Deficit=1.
regras.config.transferencias = [{ origem: "principal", destino: "vantagens", limite: 1 }];
r = validarRegras(est, dadosEstouro, regras);
t("limite suficiente (1): aceito", r.ok, JSON.stringify(r.erros));

// F) transferências registradas no resultado de pontos
const estEf = (await import("./servidor/dist/lib/regras.js")).estruturaComCustosDeElementos(est, regras);
let pts = aplicarTransferencias(aplicarCustosSelecao(calcularPontos(estEf, dadosEstouro), est, dadosEstouro, regras), regras);
t("transferencias registradas", (pts.transferencias ?? []).length > 0 && pts.pools.every((p) => p.saldo >= 0), JSON.stringify(pts.transferencias));

console.log("== Múltiplos grupos de exclusividade ==");
// dados: telepatia (grupoExclusividade poderes_ocultos) + magia → conflito (legado)
r = validarRegras(est, { forca: 1, poderes: ["telepatia", "magia"], defeitos: undefined }, regras);
// defeitos não está na estrutura de teste; obrigatório vai falhar também — ok, checar grupo
const temGrupo = r.erros.some((e) => e.codigo === "exclusividade" && e.mensagem.includes("poderes_ocultos"));
t("legado: telepatia+magia conflita", temGrupo, JSON.stringify(r.erros.map(e=>e.mensagem)));

// injeta elementos de teste nos mapas do ruleset sintético
// sombra em DOIS grupos; Ritual em transformacoes apenas
regras.elementos.set("poder:sombra", mkEl("poder", "sombra", "Sombra", { gruposExclusividade: ["poderes_ocultos", "transformacoes"] }));
regras.elementos.set("poder:ritual", mkEl("poder", "ritual", "Ritual", { gruposExclusividade: ["transformacoes"] }));
regras.porKind.set("poder", [...(regras.porKind.get("poder") ?? []), regras.elementos.get("poder:sombra"), regras.elementos.get("poder:ritual")]);

r = validarRegras(est, { forca: 1, poderes: ["sombra", "ritual"] }, regras);
const conflitos = r.erros.filter((e) => e.codigo === "exclusividade");
t("elemento em 2 grupos: sombra+ritual conflita em transformacoes", conflitos.some((e) => e.mensagem.includes("transformacoes")), JSON.stringify(r.erros.map(e=>e.mensagem)));

r = validarRegras(est, { forca: 1, poderes: ["sombra", "magia"] }, regras);
t("elemento em 2 grupos: sombra+magia conflita em poderes_ocultos", r.erros.some((e) => e.codigo === "exclusividade" && e.mensagem.includes("poderes_ocultos")), JSON.stringify(r.erros.map(e=>e.mensagem)));

r = validarRegras(est, { forca: 1, poderes: ["ritual"] }, regras);
t("só ritual: sem conflito de grupo", !r.erros.some((e) => e.codigo === "exclusividade"), JSON.stringify(r.erros.map(e=>e.mensagem)));

// incompatíveis diretos
regras.elementos.set("poder:fogo", mkEl("poder", "fogo", "Fogo", { exclusivos: ["poder:agua"] }));
regras.elementos.set("poder:agua", mkEl("poder", "agua", "Água", {}));
regras.porKind.set("poder", [...regras.porKind.get("poder"), regras.elementos.get("poder:fogo"), regras.elementos.get("poder:agua")]);
r = validarRegras(est, { forca: 1, poderes: ["fogo", "agua"] }, regras);
t("incompatíveis diretos", r.erros.some((e) => e.codigo === "exclusividade" && e.mensagem.includes("incompatível")), JSON.stringify(r.erros.map(e=>e.mensagem)));

console.log("== Fórmulas ==");
// elemento com fórmulas válidas
regras.elementos.set("vantagem:bonus", mkEl("vantagem", "bonus", "Bônus teste", { custoPontos: 1, reservaPontos: "vantagens", formulas: { bonus: "{forca} * 2", custo: "1" } }));
regras.porKind.set("vantagem", [...(regras.porKind.get("vantagem") ?? []), regras.elementos.get("vantagem:bonus")]);
r = validarRegras(est, { forca: 4, vantagens: ["bonus"] }, regras);
t("fórmula válida gera cálculo", r.calculos["vantagem:bonus.bonus"] === 8, JSON.stringify(r.calculos));

// fórmula com referência inexistente
regras.elementos.set("vantagem:badref", mkEl("vantagem", "badref", "Ref ruim", { formulas: { x: "{campo_que_nao_existe} + 1" } }));
regras.porKind.set("vantagem", [...regras.porKind.get("vantagem"), regras.elementos.get("vantagem:badref")]);
r = validarRegras(est, { forca: 1, vantagens: ["badref"] }, regras);
t("referência inexistente → erro", r.erros.some((e) => e.codigo === "formula_referencia"), JSON.stringify(r.erros.map(e=>e.mensagem)));

// fórmula inválida (sintaxe)
regras.elementos.set("vantagem:badform", mkEl("vantagem", "badform", "Forma ruim", { formulas: { x: "{forca} *" } }));
regras.porKind.set("vantagem", [...regras.porKind.get("vantagem"), regras.elementos.get("vantagem:badform")]);
r = validarRegras(est, { forca: 1, vantagens: ["badform"] }, regras);
t("fórmula inválida → erro", r.erros.some((e) => e.codigo === "formula_invalida"), JSON.stringify(r.erros.map(e=>e.mensagem)));

// requisito por fórmula: bonus2 exige forca>0 via "requisito" não-zero
regras.elementos.set("vantagem:req", mkEl("vantagem", "req", "Req teste", { formulas: { requisito: "{forca}" } }));
regras.porKind.set("vantagem", [...regras.porKind.get("vantagem"), regras.elementos.get("vantagem:req")]);
r = validarRegras(est, { forca: 0, vantagens: ["req"] }, regras);
t("requisito fórmula falha com forca 0", r.erros.some((e) => e.codigo === "requisito_formula"), JSON.stringify(r.erros.map(e=>e.mensagem)));
r = validarRegras(est, { forca: 2, vantagens: ["req"] }, regras);
t("requisito fórmula passa com forca 2", !r.erros.some((e) => e.codigo === "requisito_formula"), JSON.stringify(r.erros.map(e=>e.mensagem)));

console.log(`\n${pass} passaram, ${fail} falharam`);
// Limpeza dos artefatos temporários próprios (banco vazio + trava).
try { (await import("./servidor/dist/db/index.js")).fecharBanco(); } catch {}
try { rmSync(TMP_REGRAS, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
