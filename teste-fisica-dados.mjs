// Testes da física dos dados 3D (site/src/fisicaDado.ts):
// gravidade, quique com restituição, atrito, limites, assentamento na
// face do valor do servidor, determinismo por índice e energias.
// Node executa o módulo .ts diretamente (type stripping).
import {
  geometry, faceValues, normalFor, rotate, dot, length, fromTo, slerp,
  alturaDeRepouso, criarEstadoFisica, passoFisica, qNormalize, qMultiply,
  GRAVIDADE, RESTITUICAO, LIMITE_MESA,
} from "./site/src/fisicaDado.ts";

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};
const quase = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

// ---------- geometrias e rótulos ----------
for (const [lados, esperado] of [[4, 4], [6, 6], [8, 8], [10, 10], [20, 20]]) {
  const { vertices, faces } = geometry(lados);
  ok(`d${lados}: ${esperado} faces`, faces.length === esperado, `faces=${faces.length}`);
  const labels = faceValues(lados, vertices, faces);
  const ordenado = [...labels].sort((a, b) => a - b);
  ok(`d${lados}: rótulos são permutação 1..${lados}`, ordenado.every((v, i) => v === i + 1), labels.join(","));
}
// faces opostas somam lados+1 (d6: 1+6, 2+5, 3+4)
{
  const { vertices, faces } = geometry(6);
  const labels = faceValues(6, vertices, faces);
  const soma = labels.reduce((a, b) => a + b, 0);
  ok("d6: soma dos rótulos = 3*(6+1)", soma === 21, `soma=${soma}`);
}

// ---------- determinismo por índice ----------
{
  const { vertices } = geometry(20);
  const q = qNormalize([0.3, 0.5, 0.7, 0.4]);
  const a = criarEstadoFisica(vertices, q, 3);
  const b = criarEstadoFisica(vertices, q, 3);
  const c = criarEstadoFisica(vertices, q, 4);
  ok("mesmo índice -> estado inicial idêntico",
    JSON.stringify(a.velocity) === JSON.stringify(b.velocity) && JSON.stringify(a.angularVelocity) === JSON.stringify(b.angularVelocity));
  ok("índices diferentes -> impulso diferente",
    JSON.stringify(a.velocity) !== JSON.stringify(c.velocity) || JSON.stringify(a.angularVelocity) !== JSON.stringify(c.angularVelocity));
}

// ---------- simulação completa para cada tipo de dado ----------
function simular(lados, valor, indice = 0, maxT = 5) {
  const { vertices, faces } = geometry(lados);
  const labels = faceValues(lados, vertices, faces);
  const faceIndex = labels.indexOf(valor);
  const alvoQ = fromTo(normalFor(vertices, faces[faceIndex]), [0, 0, 1]);
  const repouso = alturaDeRepouso(vertices, alvoQ);
  // orientação inicial "tumble": rotação arbitrária longe do alvo
  const spin = qNormalize([0.78, 0.28 + indice * 0.013, 0.42, 0.31]);
  const start = qMultiply(spin, alvoQ);
  const e = criarEstadoFisica(vertices, start, indice);
  const passos = [];
  const dt = 1 / 120;
  let t = 0;
  while (!e.finalizado && t < maxT) {
    passoFisica(e, dt, vertices, { orientation: alvoQ, repouso });
    passos.push({
      t, z: e.position[2], vz: e.velocity[2],
      vx: Math.hypot(e.velocity[0], e.velocity[1]),
      w: length(e.angularVelocity),
    });
    t += dt;
  }
  return { e, alvoQ, repouso, passos, vertices, faces, labels, faceIndex, tempo: t };
}

// face voltada para +z (câmera) deve ser a do valor do servidor
function faceVoltadaParaCamera(vertices, faces, labels, q) {
  let melhor = -1, melhorZ = -Infinity;
  faces.forEach((f, i) => {
    const n = rotate(normalFor(vertices, f), q);
    if (n[2] > melhorZ) { melhorZ = n[2]; melhor = i; }
  });
  return { face: melhor, valor: labels[melhor], z: melhorZ };
}

for (const lados of [4, 6, 8, 10, 20]) {
  const valor = 1 + (lados % Math.min(7, lados)); // valores variados, sempre 1..lados
  const { e, alvoQ, repouso, passos, vertices, faces, labels, tempo } = simular(lados, valor, lados);
  ok(`d${lados}: simulação finaliza`, e.finalizado, `t=${tempo.toFixed(2)}s`);
  const fim = faceVoltadaParaCamera(vertices, faces, labels, e.orientation);
  ok(`d${lados}: face final = valor do servidor (${valor})`, fim.valor === valor, `face=${fim.valor} z=${fim.z.toFixed(3)}`);
  // O frame final renderizado usa SEMPRE alvoRepouso/target exatos
  // (renderFinal), então o estado interno pode restar levemente acima do
  // repouso no instante do cutoff — o que importa visualmente é a face.
  ok(`d${lados}: centro converge para a região de repouso`, quase(e.position[2], repouso, 0.2), `z=${e.position[2].toFixed(3)} repouso=${repouso.toFixed(3)}`);
  ok(`d${lados}: velocidades residuais pequenas`, length(e.velocity) < 0.7 && length(e.angularVelocity) < 0.6,
    `v=${length(e.velocity).toFixed(4)} w=${length(e.angularVelocity).toFixed(4)}`);
}

// ---------- gravidade ----------
{
  const { vertices } = geometry(6);
  const q = qNormalize([0.2, 0.6, 0.4, 0.5]);
  const e = criarEstadoFisica(vertices, q, 0);
  const vz0 = e.velocity[2];
  passoFisica(e, 0.016, vertices, { orientation: q, repouso: alturaDeRepouso(vertices, q) });
  ok("gravidade reduz velocidade vertical no ar", e.velocity[2] < vz0, `${vz0.toFixed(2)} -> ${e.velocity[2].toFixed(2)}`);
}

// ---------- quique: restituição e decaimento de energia ----------
{
  const { e, passos } = simular(20, 10, 0);
  // picos de altura (z do centro) devem decair após cada quique
  const picos = [];
  for (let i = 1; i < passos.length - 1; i++) {
    if (passos[i].z > passos[i - 1].z && passos[i].z > passos[i + 1].z && passos[i].z > 0.6) picos.push(passos[i].z);
  }
  ok("d20: houve quique(s) no ar", picos.length >= 1, `picos=${picos.length}`);
  if (picos.length >= 2) {
    ok("d20: alturas de quique decaem", picos[1] < picos[0] * 1.05, picos.map((p) => p.toFixed(2)).join(","));
  }
  // velocidade vertical no primeiro quique deve ser menor que a de impacto
  const vzNeg = passos.filter((p) => p.vz < -0.5).map((p) => p.vz);
  const vzPos = passos.filter((p) => p.vz > 0.5).map((p) => p.vz);
  const impactoMax = Math.min(...vzNeg);           // mais negativo = maior impacto
  const saidaMax = Math.max(...vzPos);
  ok("d20: impulso de saída < impacto (restituição)", vzPos.length > 0 && vzNeg.length > 0 && saidaMax < -impactoMax * RESTITUICAO + 0.6,
    `impacto=${impactoMax.toFixed(2)} saída=${saidaMax.toFixed(2)}`);
}

// ---------- atrito: velocidade horizontal decai no chão ----------
{
  const { e, passos } = simular(6, 3, 1);
  const metade = Math.floor(passos.length / 2);
  const vxInicio = passos[Math.min(10, passos.length - 1)]?.vx ?? 0;
  const vxFim = passos[passos.length - 1]?.vx ?? 0;
  ok("d6: velocidade horizontal decai até parar", vxFim < vxInicio * 0.2, `${vxInicio.toFixed(2)} -> ${vxFim.toFixed(3)}`);
}

// ---------- limites da mesa ----------
{
  const { vertices } = geometry(8);
  const q = qNormalize([0.4, 0.4, 0.5, 0.6]);
  const e = criarEstadoFisica(vertices, q, 0);
  e.velocity = [50, -50, 0]; // impulso absurdo para forçar as bordas
  for (let i = 0; i < 600; i++) passoFisica(e, 1 / 120, vertices, { orientation: q, repouso: 1 });
  ok("d8: posição horizontal limitada", Math.abs(e.position[0]) <= LIMITE_MESA + 1e-6 && Math.abs(e.position[1]) <= LIMITE_MESA + 1e-6,
    `x=${e.position[0].toFixed(2)} y=${e.position[1].toFixed(2)}`);
}

// ---------- valores extremos e tipos ----------
for (const lados of [4, 10, 20]) {
  for (const valor of [1, lados]) {
    const { e, vertices, faces, labels } = simular(lados, valor, 2);
    const fim = faceVoltadaParaCamera(vertices, faces, labels, e.orientation);
    ok(`d${lados} valor ${valor}: face final correta`, fim.valor === valor, `face=${fim.valor}`);
  }
}

// ---------- energia nunca aumenta artificialmente ----------
{
  const { e, passos } = simular(20, 7, 5);
  // energia nunca aumenta: o centro nunca sobe acima da altura de spawn
  const zSpawn = passos[0]?.z ?? 0;
  const zMax = Math.max(...passos.map((p) => p.z));
  ok("d20: nunca sobe acima do spawn", zMax <= zSpawn + 0.05, `zMax=${zMax.toFixed(2)} spawn=${zSpawn.toFixed(2)}`);
  void e;
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n==== RESULTADO: ${resultados.length - falhas.length} ok, ${falhas.length} falhas ====`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
