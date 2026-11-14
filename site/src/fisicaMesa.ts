// Física da mesa compartilhada de dados 3D — módulo puro, sem React.
// Uma cena só: todos os dados do lançamento ocupam a mesma superfície,
// colidem entre si e com as bordas da mesa, e assentam na orientação
// da face recebida do servidor. A física NUNCA decide o resultado.
//
// Aproximação de colisão entre dados: esfera envolvente (raio = maior
// módulo de vértice). É conservadora no sentido de nunca deixar dois
// dados se sobreporem visualmente de forma persistente; arestas podem
// se tocar ligeiramente em impactos rasantes — limitação documentada
// no doc de decisão (SAT completo seria custo desnecessário em Canvas2D).

import {
  geometry, faceValues, normalFor, rotate, add, scale, cross,
  unit, length, slerp, qMultiply, qNormalize, fromTo,
  alturaDeRepouso, GRAVIDADE, RESTITUICAO,
  type Face, type Quat, type Vec3,
} from "./fisicaDado.ts";

export interface ItemDado {
  lados: number;
  valor: number;
}

export interface DadoMesa {
  lados: number;
  valor: number;
  vertices: Vec3[];
  faces: Face[];
  labels: number[];
  /** raio da esfera envolvente (unidades do poliedro) */
  raio: number;
  /** raio usado nas colisões — menor que o envolvente para não inflar a mesa */
  raioColisao: number;
  /** altura do centro no repouso sobre o tampo */
  repouso: number;
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  angularVelocity: Vec3;
  /** quaternion alvo: face do valor do servidor apontando para o jogador */
  alvo: Quat;
  simulationTime: number;
  settleTime: number;
  finalizado: boolean;
}

/** Semi-lado da mesa em unidades do mundo (x/y no tampo, z = altura). */
export const TETO_MESA = 7.0;
/** Semi-lado efetivo conforme a quantidade de dados (mais dados, mesa maior). */
export function semiLadoMesa(quantidade: number): number {
  return Math.min(TETO_MESA, Math.max(3.4, Math.ceil(Math.sqrt(Math.max(1, quantidade))) * 1.12));
}

// PRNG determinístico (mulberry32) — trajetórias reproduzíveis por semente,
// nunca derivadas do resultado sorteado no servidor.
function mulberry32(semente: number) {
  let a = semente >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quaternionAleatorio(rand: () => number): Quat {
  // Amostragem uniforme em SO(3) via quatérnio de 4 gaussianas aproximadas.
  const g = () => {
    const u = Math.max(rand(), 1e-9), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const q = qNormalize([g(), g(), g(), g()]);
  return q;
}

function lowestVertex(vertices: Vec3[], q: Quat) {
  let min = Infinity, index = 0;
  vertices.forEach((v, i) => {
    const z = rotate(v, q)[2];
    if (z < min) { min = z; index = i; }
  });
  return { min, index };
}

/**
 * Cria a cena: um DadoMesa por item, distribuídos em grade com jitter
 * dentro da mesa, sem sobreposição inicial, cada um com impulso e giro
 * variados (determinísticos pela semente da rolagem).
 */
export function criarCenaMesa(itens: ItemDado[], semente = 1): DadoMesa[] {
  const n = itens.length;
  const limite = semiLadoMesa(n);
  const rand = mulberry32(semente);
  const cols = Math.ceil(Math.sqrt(n));
  const passo = Math.min(2.4, (limite * 1.7) / Math.max(1, cols));
  const inicio = -((cols - 1) * passo) / 2;
  return itens.map((item, i) => {
    const { vertices, faces } = geometry(item.lados);
    const labels = faceValues(item.lados, vertices, faces);
    const idxFace = labels.indexOf(Math.round(item.valor));
    const alvo = fromTo(normalFor(vertices, faces[idxFace >= 0 ? idxFace : 0]), [0, 0, 1]);
    const inicio_q = quaternionAleatorio(rand);
    const gx = inicio + (i % cols) * passo + (rand() - 0.5) * passo * 0.35;
    const gy = inicio + Math.floor(i / cols) * passo + (rand() - 0.5) * passo * 0.35;
    const raio = Math.max(...vertices.map((v) => length(v)));
    const raioColisao = raio * 0.7;
    const repouso = alturaDeRepouso(vertices, alvo);
    const spin = quaternionAleatorio(rand);
    return {
      lados: item.lados,
      valor: item.valor,
      vertices, faces, labels,
      raio, raioColisao,
      repouso,
      position: [gx, gy, 1.6 + (i % 7) * 0.35 + rand() * 0.5],
      velocity: [
        (rand() - 0.5) * 3.4,
        (rand() - 0.5) * 3.4,
        -(0.5 + rand() * 1.2),
      ],
      orientation: qMultiply(spin, inicio_q),
      angularVelocity: [
        (rand() - 0.5) * 14,
        (rand() - 0.5) * 14,
        (rand() - 0.5) * 14,
      ],
      alvo,
      simulationTime: 0,
      settleTime: 0,
      finalizado: false,
    };
  });
}

/**
 * Avança a cena em `dt` segundos. Integra todos os dados, resolve
 * tampo/bordas por dado e depois as colisões entre pares (fase
 * estreita com esfera envolvente). Retorna true se houve quique.
 */
export function passoCena(dados: DadoMesa[], dt: number): boolean {
  const limite = semiLadoMesa(dados.length);
  let quique = false;
  const ativo = (d: DadoMesa) => !d.finalizado;

  for (const d of dados) {
    if (!ativo(d)) continue;
    d.simulationTime += dt;
    d.velocity[2] -= GRAVIDADE * dt;
    d.position = add(d.position, scale(d.velocity, dt));
    const w = length(d.angularVelocity);
    if (w > 0.0001) {
      const half = w * dt * 0.5;
      const axis = unit(d.angularVelocity);
      const delta: Quat = [Math.cos(half), axis[0] * Math.sin(half), axis[1] * Math.sin(half), axis[2] * Math.sin(half)];
      d.orientation = qNormalize(qMultiply(delta, d.orientation));
    }

    // Tampo: vértice mais baixo não pode penetrar z=0.
    const contact = lowestVertex(d.vertices, d.orientation);
    const penetration = d.position[2] + contact.min;
    if (penetration < 0) {
      d.position[2] -= penetration;
      if (d.velocity[2] < 0) {
        const impact = -d.velocity[2];
        if (impact > 0.18) quique = true;
        const impulse = impact * 1.38;
        d.velocity[2] = impact > 0.72 ? impact * RESTITUICAO : 0;
        const arm = rotate(d.vertices[contact.index], d.orientation);
        const torque = cross(arm, [0, 0, impulse]);
        d.angularVelocity = add(d.angularVelocity, scale(torque, 0.48));
        d.angularVelocity[0] += d.velocity[0] * 0.55;
        d.angularVelocity[1] += d.velocity[1] * 0.55;
        d.velocity[0] *= 0.78;
        d.velocity[1] *= 0.78;
      }
    }

    // Bordas da mesa: cada dado rebate dentro do limite efetivo.
    for (const axis of [0, 1] as const) {
      const margem = d.raioColisao * 0.8;
      const hi = limite - margem, lo = -limite + margem;
      if (d.position[axis] > hi) { d.position[axis] = hi; d.velocity[axis] = -Math.abs(d.velocity[axis]) * 0.42; }
      if (d.position[axis] < lo) { d.position[axis] = lo; d.velocity[axis] = Math.abs(d.velocity[axis]) * 0.42; }
    }

    // Amortecimento: no chão gira e desliza menos; no ar quase livre.
    const noChao = d.position[2] + lowestVertex(d.vertices, d.orientation).min <= 0.05;
    const damping = noChao ? 2.25 : 0.42;
    d.angularVelocity = scale(d.angularVelocity, Math.exp(-damping * dt));
    d.velocity[0] *= Math.exp(-1.45 * dt);
    d.velocity[1] *= Math.exp(-1.45 * dt);

    // Repouso natural + teto de tempo: energia baixa por 0.28s contínuos
    // assenta na face do servidor; passado o teto, força o fim.
    if (d.simulationTime > 1.15) {
      d.angularVelocity = scale(d.angularVelocity, Math.exp(-2.1 * dt));
      const energiaBaixa = noChao
        && length(d.angularVelocity) < 1.05
        && Math.hypot(d.velocity[0], d.velocity[1], d.velocity[2]) < 0.72;
      if (energiaBaixa) {
        d.settleTime += dt;
        d.orientation = slerp(d.orientation, d.alvo, Math.min(1, dt * 5.5));
        d.position[2] += (d.repouso - d.position[2]) * Math.min(1, dt * 5);
        d.velocity = scale(d.velocity, Math.exp(-5 * dt));
        if (d.settleTime >= 0.28) {
          d.finalizado = true;
          d.orientation = d.alvo;
          d.position[2] = d.repouso;
          d.velocity = [0, 0, 0];
          d.angularVelocity = [0, 0, 0];
        }
      } else {
        d.settleTime = 0;
      }
    }
    if (d.simulationTime >= 3.2) {
      // Teto de segurança: força assentamento direto no alvo.
      d.orientation = d.alvo;
      d.position[2] = d.repouso;
      d.velocity = [0, 0, 0];
      d.angularVelocity = [0, 0, 0];
      d.finalizado = true;
    }
  }

  // Colisões entre dados (fase estreita: esfera envolvente).
  // A separação é limitada pelo espaço livre até as bordas. Um dado
  // finalizado não recebe impulso nem gira; só pode ser deslocado por
  // correção posicional se o dado móvel estiver fisicamente encurralado
  // contra a borda. Isso evita expulsar o móvel da mesa e congelá-lo
  // ainda sobreposto ao dado assentado.
  const capacidadeXY = (d: DadoMesa, dx: number, dy: number): number => {
    const margem = d.raioColisao * 0.8;
    const hi = limite - margem, lo = -limite + margem;
    let max = Infinity;
    if (dx > 1e-9) max = Math.min(max, (hi - d.position[0]) / dx);
    else if (dx < -1e-9) max = Math.min(max, (lo - d.position[0]) / dx);
    if (dy > 1e-9) max = Math.min(max, (hi - d.position[1]) / dy);
    else if (dy < -1e-9) max = Math.min(max, (lo - d.position[1]) / dy);
    return Number.isFinite(max) ? Math.max(0, max) : Infinity;
  };

  // Passadas iterativas: corrigir B×C pode criar uma nova penetração
  // A×B cujo par já foi visitado. Repete até estabilizar ou até um teto
  // proporcional à quantidade de dados; cada passada recalcula as capacidades.
  const passadasMaximas = Math.min(30, Math.max(6, dados.length));
  for (let rodada = 0; rodada < passadasMaximas; rodada++) {
    let corrigiuPosicao = false;
    for (let i = 0; i < dados.length; i++) {
      for (let j = i + 1; j < dados.length; j++) {
      const a = dados[i], b = dados[j];
      const movA = !a.finalizado, movB = !b.finalizado;
      const soma = a.raioColisao + b.raioColisao;
      const dx = b.position[0] - a.position[0];
      const dy = b.position[1] - a.position[1];
      const distPlano = Math.hypot(dx, dy);
      if (distPlano >= soma || distPlano < 1e-6) continue;
      const dz = b.position[2] - a.position[2];
      // Só colide se as alturas se sobrepõem de verdade.
      if (Math.abs(dz) > soma * 0.9) continue;
      const dist3 = Math.sqrt(distPlano * distPlano + dz * dz);
      if (dist3 >= soma || dist3 < 1e-6) continue;

      const nx = dx / distPlano, ny = dy / distPlano;
      const pen = soma - dist3;
      const capA = capacidadeXY(a, -nx, -ny);
      const capB = capacidadeXY(b, nx, ny);
      let deslocA = 0, deslocB = 0;

      if (movA && !movB) {
        // Primeiro tenta resolver tudo movendo apenas o corpo ativo.
        deslocA = Math.min(pen, capA);
        // Sem espaço suficiente, o assentado cede apenas o restante,
        // por translação: orientação, velocidade e giro permanecem intactos.
        deslocB = Math.min(pen - deslocA, capB);
      } else if (!movA && movB) {
        deslocB = Math.min(pen, capB);
        deslocA = Math.min(pen - deslocB, capA);
      } else {
        // Dois móveis ou dois assentados: divisão equilibrada, redistribuindo
        // a parcela bloqueada para o corpo que ainda tem espaço na mesa.
        let restante = pen;
        let livres: ("a" | "b")[] = ["a", "b"];
        while (restante > 1e-6 && livres.length) {
          const parcela = restante / livres.length;
          let aplicado = 0;
          const proximos: ("a" | "b")[] = [];
          for (const lado of livres) {
            if (lado === "a") {
              const addA = Math.min(parcela, capA - deslocA);
              deslocA += addA; aplicado += addA;
              if (capA - deslocA > 1e-6) proximos.push("a");
            } else {
              const addB = Math.min(parcela, capB - deslocB);
              deslocB += addB; aplicado += addB;
              if (capB - deslocB > 1e-6) proximos.push("b");
            }
          }
          if (aplicado < 1e-6) break;
          restante -= aplicado;
          livres = proximos;
        }
      }

      a.position[0] -= nx * deslocA;
      a.position[1] -= ny * deslocA;
      b.position[0] += nx * deslocB;
      b.position[1] += ny * deslocB;
      if (deslocA + deslocB > 1e-6) corrigiuPosicao = true;

      // Separação vertical somente nos corpos ainda móveis.
      const movCount = (movA ? 1 : 0) + (movB ? 1 : 0);
      if (movCount > 0 && Math.abs(dz) > 0.35) {
        const wz = (Math.sign(dz) * pen * 0.4) / movCount;
        if (movA) a.position[2] -= wz;
        if (movB) b.position[2] += wz;
      }

      // Troca de impulso somente nos corpos móveis (massa igual).
      const rvx = b.velocity[0] - a.velocity[0];
      const rvy = b.velocity[1] - a.velocity[1];
      const closing = rvx * nx + rvy * ny;
      if (movCount > 0 && closing < 0) {
        const jimp = -(1 + 0.32) * closing / movCount;
        if (movA) { a.velocity[0] -= jimp * nx; a.velocity[1] -= jimp * ny; }
        if (movB) { b.velocity[0] += jimp * nx; b.velocity[1] += jimp * ny; }
        // O impacto "engata" giro somente nos corpos móveis.
        const kick = Math.min(6, Math.abs(closing) * 0.9);
        if (movA) a.angularVelocity[2] += kick * (i % 2 === 0 ? 1 : -1);
        if (movB) b.angularVelocity[2] -= kick * (j % 2 === 0 ? 1 : -1);
        if (Math.abs(closing) > 0.4) quique = true;
      }
      }
    }
    if (!corrigiuPosicao) break;
  }
  return quique;
}

export function cenaRepousada(dados: DadoMesa[]): boolean {
  return dados.every((d) => d.finalizado);
}
