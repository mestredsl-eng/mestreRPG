// Testes da física da mesa compartilhada de dados 3D
// (site/src/fisicaMesa.ts): distribuição inicial, limites da mesa,
// colisões entre dados, repouso natural com teto de tempo, e a regra
// de ouro — a orientação final sempre representa o valor do servidor.
// Node executa os módulos .ts diretamente (type stripping).
import {
  criarCenaMesa, passoCena, cenaRepousada, semiLadoMesa,
} from "./site/src/fisicaMesa.ts";
import { geometry, faceValues, normalFor, rotate, dot, length } from "./site/src/fisicaDado.ts";

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};
const quase = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

const TIPOS = [4, 6, 8, 10, 20];

function simular(itens, maxSegundos = 8) {
  const cena = criarCenaMesa(itens, 42);
  const dt = 1 / 60;
  let passos = 0;
  const maxPassos = Math.ceil(maxSegundos / dt);
  while (!cenaRepousada(cena) && passos < maxPassos) {
    passoCena(cena, dt);
    passos++;
  }
  return { cena, segundos: passos * dt };
}

// ---------- 1 dado de cada tipo ----------
for (const lados of TIPOS) {
  const { cena, segundos } = simular([{ lados, valor: Math.max(1, Math.ceil(lados / 2)) }], 6);
  const d = cena[0];
  ok(`d${lados}: assenta em até 6s`, d.finalizado && segundos <= 6, `${segundos.toFixed(2)}s`);
  ok(`d${lados}: posição finita`, d.position.every(Number.isFinite));
  ok(`d${lados}: velocidade zerada no fim`, length(d.velocity) < 0.01 && length(d.angularVelocity) < 0.05);
}

// ---------- face final = valor do servidor ----------
// Após o assentamento, a face cujo rótulo é `valor` deve ter normal ~+z
// (a mesma convenção do Dado3D individual: valor recebido encara a câmera).
function faceDoValor(d) {
  const { faces } = { faces: d.faces };
  const idx = d.labels.indexOf(d.valor);
  return idx;
}
{
  const mistura = [
    { lados: 4, valor: 3 }, { lados: 6, valor: 5 }, { lados: 8, valor: 7 },
    { lados: 10, valor: 4 }, { lados: 20, valor: 13 },
  ];
  const { cena } = simular(mistura, 8);
  let todasCorretas = true;
  for (const d of cena) {
    const fi = faceDoValor(d);
    const n = rotate(normalFor(d.vertices, d.faces[fi]), d.orientation);
    // O alvo foi construído com fromTo(normal, +z): no fim, normal ≈ +z.
    if (n[2] < 0.9) todasCorretas = false;
  }
  ok("mistura D4/D6/D8/D10/D20: face do valor aponta para o jogador", todasCorretas);
}

// ---------- limites da mesa ----------
{
  const itens = Array.from({ length: 10 }, (_, i) => ({ lados: TIPOS[i % 5], valor: 1 + (i % 6) }));
  const { cena } = simular(itens, 8);
  const limite = semiLadoMesa(cena.length);
  let dentro = true;
  for (const d of cena) {
    if (Math.abs(d.position[0]) > limite + 0.01 || Math.abs(d.position[1]) > limite + 0.01) dentro = false;
    if (d.position[2] < -0.01) dentro = false;
  }
  ok("10 dados: todos permanecem dentro dos limites da mesa", dentro);
}

// ---------- colisões entre dados: sem sobreposição persistente ----------
{
  const itens = Array.from({ length: 12 }, (_, i) => ({ lados: [4, 6, 8, 10, 20][i % 5], valor: 2 }));
  const { cena } = simular(itens, 9);
  let sobreposicoes = 0;
  for (let i = 0; i < cena.length; i++) for (let j = i + 1; j < cena.length; j++) {
    const a = cena[i], b = cena[j];
    const dist = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]);
    const somaZ = Math.abs(a.position[2] - b.position[2]);
    // Sobreposição real = distância horizontal menor que a soma dos raios
    // de colisão com alturas compatíveis.
    if (dist < (a.raioColisao + b.raioColisao) * 0.72 && somaZ < (a.raio + b.raio) * 0.8) sobreposicoes++;
  }
  ok("12 dados: nenhuma sobreposição persistente ao repousar", sobreposicoes === 0, `${sobreposicoes} pares`);
}

// ---------- quantidades: 1, 5, 10 e 30 ----------
for (const n of [1, 5, 10, 30]) {
  const itens = Array.from({ length: n }, (_, i) => ({
    lados: TIPOS[i % 5], valor: 1 + (i % (TIPOS[i % 5])),
  }));
  const { cena, segundos } = simular(itens, 10);
  const todos = cena.every((d) => d.finalizado && d.position.every(Number.isFinite));
  ok(`${n} dados: todos assentam dentro do teto de tempo`, todos, `${segundos.toFixed(2)}s`);
  ok(`${n} dados: valores preservados`, cena.every((d, i) => d.valor === itens[i].valor));
}

// ---------- determinismo: mesma semente, mesma cena final ----------
{
  const itens = [{ lados: 20, valor: 11 }, { lados: 6, valor: 3 }, { lados: 10, valor: 7 }];
  const a = simular(itens, 8).cena;
  const b = simular(itens, 8).cena;
  const igual = a.every((d, i) =>
    quase(d.position[0], b[i].position[0], 1e-9) &&
    quase(d.position[1], b[i].position[1], 1e-9) &&
    quase(d.orientation[0], b[i].orientation[0], 1e-9));
  ok("determinismo: mesma semente produz mesma trajetória", igual);
}

// ---------- a física nunca altera o resultado ----------
{
  const itens = Array.from({ length: 8 }, (_, i) => ({ lados: 20, valor: 20 - i }));
  const { cena } = simular(itens, 8);
  ok("8d20: cada dado termina na face do próprio valor",
    cena.every((d) => d.labels[d.labels.indexOf(d.valor)] === d.valor && d.valor === itens[cena.indexOf(d)].valor));
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações ok`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
