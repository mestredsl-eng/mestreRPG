// Geometria, quaternion e física dos dados 3D — módulo puro, sem React,
// para permitir testes automatizados do comportamento físico.
// Regra de ouro: a física NUNCA decide o resultado — ela só anima até
// assentar na orientação que representa o valor recebido do servidor.

export type Vec3 = [number, number, number];
export type Face = number[];
export type Quat = [number, number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, n: number): Vec3 => [a[0] * n, a[1] * n, a[2] * n];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(...a);
export const unit = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));

export function orientFaces(vertices: Vec3[], faces: Face[]): Face[] {
  return faces.map((face) => {
    const a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]];
    const normal = cross(sub(b, a), sub(c, a));
    const center = face.reduce((sum, i) => add(sum, vertices[i]), [0, 0, 0] as Vec3);
    return dot(normal, center) < 0 ? [...face].reverse() : face;
  });
}

export function geometry(sides: number): { vertices: Vec3[]; faces: Face[] } {
  if (sides === 4) {
    const v: Vec3[] = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]];
    return { vertices: v, faces: orientFaces(v, [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]) };
  }
  if (sides === 6) {
    const v: Vec3[] = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    return { vertices: v, faces: orientFaces(v, [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) };
  }
  if (sides === 8) {
    const v: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    return { vertices: v, faces: orientFaces(v, [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]) };
  }
  if (sides === 10) {
    // D10 trapezoidal correto: dual de um antiprisma pentagonal regular.
    // Cada face é um kite coplanar; a versão anterior ligava os dois polos
    // a vértices consecutivos e criava quadriláteros empenados (não planos).
    const v: Vec3[] = [
      [0.8944271910, -0.6498393925, 0.2111456180],
      [1.1055728090, 0, -0.2111456180],
      [-1.1055728090, 0, 0.2111456180],
      [-0.8944271910, 0.6498393925, -0.2111456180],
      [0.3416407865, -1.0514622242, -0.2111456180],
      [-0.3416407865, -1.0514622242, 0.2111456180],
      [-0.8944271910, -0.6498393925, -0.2111456180],
      [0.3416407865, 1.0514622242, -0.2111456180],
      [0.8944271910, 0.6498393925, 0.2111456180],
      [-0.3416407865, 1.0514622242, 0.2111456180],
      [0, 0, -2],
      [0, 0, 2],
    ];
    const faces: Face[] = [
      [8, 11, 0, 1],
      [8, 7, 9, 11],
      [11, 9, 3, 2],
      [5, 11, 2, 6],
      [4, 0, 11, 5],
      [8, 1, 10, 7],
      [7, 10, 3, 9],
      [2, 3, 10, 6],
      [10, 4, 5, 6],
      [1, 0, 4, 10],
    ];
    return { vertices: v, faces: orientFaces(v, faces) };
  }
  const phi = (1 + Math.sqrt(5)) / 2;
  const v: Vec3[] = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ];
  const faces: Face[] = [];
  for (let a = 0; a < v.length; a++) for (let b = a + 1; b < v.length; b++) for (let c = b + 1; c < v.length; c++) {
    const n = cross(sub(v[b], v[a]), sub(v[c], v[a]));
    let positive = false, negative = false;
    for (let k = 0; k < v.length; k++) {
      if (k === a || k === b || k === c) continue;
      const d = dot(n, sub(v[k], v[a]));
      if (d > 1e-6) positive = true;
      if (d < -1e-6) negative = true;
    }
    if (!(positive && negative)) faces.push([a, b, c]);
  }
  return { vertices: v, faces: orientFaces(v, faces) };
}

export const qNormalize = (q: Quat): Quat => {
  const n = Math.hypot(...q);
  return q.map((x) => x / n) as Quat;
};
export const qMultiply = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export function fromTo(a: Vec3, b: Vec3): Quat {
  const cosine = dot(a, b);
  const axis = cross(a, b);
  if (cosine < -0.9999) {
    const perpendicular = Math.abs(a[0]) < 0.8 ? unit(cross(a, [1, 0, 0])) : unit(cross(a, [0, 1, 0]));
    return [0, perpendicular[0], perpendicular[1], perpendicular[2]];
  }
  return qNormalize([1 + cosine, axis[0], axis[1], axis[2]]);
}
export function rotate(v: Vec3, q: Quat): Vec3 {
  const p: Quat = [0, v[0], v[1], v[2]];
  const r = qMultiply(qMultiply(q, p), [q[0], -q[1], -q[2], -q[3]]);
  return [r[1], r[2], r[3]];
}
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.reduce((s, x, i) => s + x * b[i], 0);
  let end = b;
  if (cos < 0) { cos = -cos; end = b.map((x) => -x) as Quat; }
  if (cos > 0.9995) return qNormalize(a.map((x, i) => x + (end[i] - x) * t) as Quat);
  const theta = Math.acos(Math.min(1, cos));
  const sin = Math.sin(theta);
  const x = Math.sin((1 - t) * theta) / sin, y = Math.sin(t * theta) / sin;
  return a.map((v, i) => v * x + end[i] * y) as Quat;
}

export function normalFor(vertices: Vec3[], face: Face): Vec3 {
  return unit(cross(sub(vertices[face[1]], vertices[face[0]]), sub(vertices[face[2]], vertices[face[0]])));
}

export function faceValues(sides: number, vertices: Vec3[], faces: Face[]): number[] {
  const values = Array(faces.length).fill(0) as number[];
  if (sides === 4) return faces.map((_, i) => i + 1);
  const normals = faces.map((face) => normalFor(vertices, face));
  const pairs: { a: number; b: number; alignment: number }[] = [];
  for (let a = 0; a < faces.length; a++) for (let b = a + 1; b < faces.length; b++) {
    pairs.push({ a, b, alignment: dot(normals[a], normals[b]) });
  }
  pairs.sort((a, b) => a.alignment - b.alignment);
  const used = new Set<number>();
  let low = 1;
  for (const pair of pairs) {
    if (pair.alignment > -0.92 || used.has(pair.a) || used.has(pair.b)) continue;
    values[pair.a] = low;
    values[pair.b] = sides + 1 - low;
    used.add(pair.a);
    used.add(pair.b);
    low++;
  }
  for (let i = 0; i < values.length; i++) if (values[i] === 0) values[i] = i + 1;
  return values;
}

// ---------------------------------------------------------------------------
// Física do dado (unidades do próprio poliedro; y = altura acima da mesa)
// ---------------------------------------------------------------------------

export interface EstadoFisica {
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  /** velocidade angular em rad/s (vetor = eixo * magnitude) */
  angularVelocity: Vec3;
  simulationTime: number;
  settleTime: number;
  finalizado: boolean;
}

export const GRAVIDADE = 8.6;
export const RESTITUICAO = 0.38;
export const LIMITE_MESA = 0.82;

function lowestVertex(vertices: Vec3[], q: Quat) {
  let min = Infinity, index = 0;
  vertices.forEach((v, i) => {
    const z = rotate(v, q)[2];
    if (z < min) { min = z; index = i; }
  });
  return { min, index };
}

/** Altura do centro para o vértice mais baixo tocar o plano z=0 (+ folga). */
export function alturaDeRepouso(vertices: Vec3[], q: Quat): number {
  return -lowestVertex(vertices, q).min + 0.025;
}

export function criarEstadoFisica(
  vertices: Vec3[],
  orientationInicial: Quat,
  indice: number,
): EstadoFisica {
  // Impulso determinístico por índice: dados da mesma rolagem não são
  // clones — direção, intensidade e giro variam de forma reproduzível.
  const variacao = (n: number) => Math.sin(indice * n + 0.7) * 0.5 + Math.cos(indice * n * 0.37) * 0.5;
  return {
    position: [0, 0, alturaDeRepouso(vertices, orientationInicial) + 1.15],
    velocity: [
      variacao(1.7) * 1.9 + 0.4,
      0.35 + (indice % 3) * 0.18,
      variacao(2.3) * 0.9,
    ],
    orientation: orientationInicial,
    angularVelocity: [
      (7.2 + variacao(0.9) * 1.4) * (indice % 2 === 0 ? 1 : -1),
      8.1 + variacao(1.3) * 1.6,
      6.4 + (indice % 4) * 0.35 + variacao(2.9) * 0.8,
    ],
    simulationTime: 0,
    settleTime: 0,
    finalizado: false,
  };
}

export interface ResultadoPasso {
  /** true no frame em que o dado quica na mesa (impacto acima do mínimo). */
  quique: boolean;
}

/**
 * Avança a simulação em `dt` segundos (já limitado pelo chamador).
 * `alvoRepouso`/`alvoOrientacao` são usados SÓ no assentamento final —
 * a orientação exibida converge para a face do valor do servidor.
 */
export function passoFisica(
  e: EstadoFisica,
  dt: number,
  vertices: Vec3[],
  alvo: { orientation: Quat; repouso: number },
): ResultadoPasso {
  let quique = false;
  e.simulationTime += dt;

  // Gravidade + integração linear e angular.
  e.velocity[2] -= GRAVIDADE * dt;
  e.position = add(e.position, scale(e.velocity, dt));
  const angularSpeed = length(e.angularVelocity);
  if (angularSpeed > 0.0001) {
    const half = angularSpeed * dt * 0.5;
    const axis = unit(e.angularVelocity);
    const delta: Quat = [Math.cos(half), axis[0] * Math.sin(half), axis[1] * Math.sin(half), axis[2] * Math.sin(half)];
    e.orientation = qNormalize(qMultiply(delta, e.orientation));
  }

  // Colisão com o tampo: corrige penetração do vértice mais baixo,
  // restituição progressiva e transferência de impulso para a rotação.
  const contact = lowestVertex(vertices, e.orientation);
  const penetration = e.position[2] + contact.min;
  if (penetration < 0) {
    e.position[2] -= penetration;
    if (e.velocity[2] < 0) {
      const impact = -e.velocity[2];
      if (impact > 0.18) quique = true;
      const impulse = impact * 1.38;
      e.velocity[2] = impact > 0.72 ? impact * RESTITUICAO : 0;
      const arm = rotate(vertices[contact.index], e.orientation);
      const torque = cross(arm, [0, 0, impulse]);
      e.angularVelocity = add(e.angularVelocity, scale(torque, 0.48));
      // Atrito de contato: o impacto "engata" a rotação no deslize.
      e.angularVelocity[0] += e.velocity[0] * 0.55;
      e.angularVelocity[1] += e.velocity[1] * 0.55;
      e.velocity[0] *= 0.78;
      e.velocity[1] *= 0.78;
    }
  }

  // Limites da área de rolagem: o dado rebate nas quatro bordas.
  for (const axis of [0, 1] as const) {
    if (e.position[axis] > LIMITE_MESA) { e.position[axis] = LIMITE_MESA; e.velocity[axis] = -Math.abs(e.velocity[axis]) * 0.42; }
    if (e.position[axis] < -LIMITE_MESA) { e.position[axis] = -LIMITE_MESA; e.velocity[axis] = Math.abs(e.velocity[axis]) * 0.42; }
  }

  const noChao = e.position[2] + lowestVertex(vertices, e.orientation).min <= 0.04;
  const damping = noChao ? 2.25 : 0.42;
  e.angularVelocity = scale(e.angularVelocity, Math.exp(-damping * dt));
  e.velocity[0] *= Math.exp(-1.45 * dt);
  e.velocity[1] *= Math.exp(-1.45 * dt);

  // Dissipação: passado o tempo mínimo, energia extra morre mais rápido.
  if (e.simulationTime > 1.15) {
    e.angularVelocity = scale(e.angularVelocity, Math.exp(-2.1 * dt));
    const energiaBaixa = noChao
      && length(e.angularVelocity) < 1.05
      && Math.hypot(e.velocity[0], e.velocity[1], e.velocity[2]) < 0.72;
    if (energiaBaixa) {
      e.settleTime += dt;
      e.orientation = slerp(e.orientation, alvo.orientation, Math.min(1, dt * 5.5));
      e.position[2] += (alvo.repouso - e.position[2]) * Math.min(1, dt * 5);
      e.position[0] *= Math.exp(-3.2 * dt);
      e.position[1] *= Math.exp(-3.2 * dt);
      e.velocity = scale(e.velocity, Math.exp(-5 * dt));
      if (e.settleTime >= 0.28) e.finalizado = true;
    } else {
      // Saiu do regime de baixa energia (novo quique): zera o assentamento.
      e.settleTime = 0;
    }
  }
  if (e.simulationTime >= 2.9) e.finalizado = true;
  return { quique };
}
