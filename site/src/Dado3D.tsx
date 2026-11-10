import { useEffect, useRef, useState } from "react";

type Vec3 = [number, number, number];
type Face = number[];

interface Props {
  lados: number;
  valor: number;
  indice?: number;
  estado?: "sucesso" | "falha" | null;
  className?: string;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, n: number): Vec3 => [a[0] * n, a[1] * n, a[2] * n];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));

function orientFaces(vertices: Vec3[], faces: Face[]): Face[] {
  return faces.map((face) => {
    const a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]];
    const normal = cross(sub(b, a), sub(c, a));
    const center = face.reduce((sum, i) => add(sum, vertices[i]), [0, 0, 0] as Vec3);
    return dot(normal, center) < 0 ? [...face].reverse() : face;
  });
}

function geometry(sides: number): { vertices: Vec3[]; faces: Face[] } {
  if (sides === 4) {
    const v: Vec3[] = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]];
    return { vertices: v, faces: orientFaces(v, [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]) };
  }
  if (sides === 6) {
    const v: Vec3[] = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
    return { vertices: v, faces: orientFaces(v, [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]]) };
  }
  if (sides === 8) {
    const v: Vec3[] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    return { vertices: v, faces: orientFaces(v, [[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]]) };
  }
  if (sides === 10) {
    const v: Vec3[] = [[0,0,1],[0,0,-1]];
    for (let i = 0; i < 10; i++) {
      const a = i * Math.PI / 5;
      v.push([Math.cos(a), Math.sin(a), i % 2 === 0 ? 0.34 : -0.34]);
    }
    const faces: Face[] = [];
    for (let i = 0; i < 10; i++) faces.push([0, 2 + i, 1, 2 + ((i + 1) % 10)]);
    return { vertices: v, faces: orientFaces(v, faces) };
  }
  const phi = (1 + Math.sqrt(5)) / 2;
  const v: Vec3[] = [
    [-1,phi,0],[1,phi,0],[-1,-phi,0],[1,-phi,0],
    [0,-1,phi],[0,1,phi],[0,-1,-phi],[0,1,-phi],
    [phi,0,-1],[phi,0,1],[-phi,0,-1],[-phi,0,1],
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

type Quat = [number, number, number, number];
const qNormalize = (q: Quat): Quat => {
  const n = Math.hypot(...q);
  return q.map((x) => x / n) as Quat;
};
const qMultiply = (a: Quat, b: Quat): Quat => [
  a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],
  a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
  a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],
  a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0],
];
function fromTo(a: Vec3, b: Vec3): Quat {
  const cosine = dot(a, b);
  const axis = cross(a, b);
  if (cosine < -0.9999) {
    const perpendicular = Math.abs(a[0]) < 0.8 ? unit(cross(a, [1, 0, 0])) : unit(cross(a, [0, 1, 0]));
    return [0, perpendicular[0], perpendicular[1], perpendicular[2]];
  }
  return qNormalize([1 + cosine, axis[0], axis[1], axis[2]]);
}
function rotate(v: Vec3, q: Quat): Vec3 {
  const p: Quat = [0, v[0], v[1], v[2]];
  const r = qMultiply(qMultiply(q, p), [q[0], -q[1], -q[2], -q[3]]);
  return [r[1], r[2], r[3]];
}
function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.reduce((s, x, i) => s + x * b[i], 0);
  let end = b;
  if (cos < 0) { cos = -cos; end = b.map((x) => -x) as Quat; }
  if (cos > 0.9995) return qNormalize(a.map((x, i) => x + (end[i] - x) * t) as Quat);
  const theta = Math.acos(Math.min(1, cos));
  const sin = Math.sin(theta);
  const x = Math.sin((1 - t) * theta) / sin, y = Math.sin(t * theta) / sin;
  return a.map((v, i) => v * x + end[i] * y) as Quat;
}

function normalFor(vertices: Vec3[], face: Face): Vec3 {
  return unit(cross(sub(vertices[face[1]], vertices[face[0]]), sub(vertices[face[2]], vertices[face[0]])));
}

function faceValues(sides: number, vertices: Vec3[], faces: Face[]): number[] {
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

export default function Dado3D({ lados, valor, indice = 0, estado, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) { setCanvasUnavailable(true); return; }
    setCanvasUnavailable(false);
    const { vertices, faces } = geometry(lados);
    const labels = faceValues(lados, vertices, faces);
    const indexDaFace = labels.indexOf(Math.round(valor));
    const faceIndex = indexDaFace >= 0 ? indexDaFace : 0;
    const target = fromTo(normalFor(vertices, faces[faceIndex]), [0, 0, 1]);
    const spin: Quat = qNormalize([0.78, 0.28 + indice * 0.013, 0.42, 0.31]);
    const start = qMultiply(spin, target);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Simulação local de corpo rígido simplificado: gravidade, impulso no
    // contato com a mesa, atrito, paredes da área do dado e amortecimento.
    // O destino continua sendo exclusivamente o valor recebido do servidor.
    let raf = 0;
    let width = 0, height = 0, dpr = 1;
    let finalizado = reduced;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(32, rect.width); height = Math.max(32, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Redefinir canvas.width apaga o bitmap: se a animação já terminou
      // (ou motion reduzido, que desenha um único frame), redesenha o
      // estado final — senão o dado ficaria em branco até remontar.
      if (finalizado) renderFinal();
    };
    resize();
    const colors = getComputedStyle(canvas);
    const fill = colors.getPropertyValue("--dado-fundo").trim() || "#2b3350";
    const text = colors.getPropertyValue("--dado-texto").trim() || "#e8ecf7";
    const border = estado === "sucesso" ? "#2e8f5b" : estado === "falha" ? "#8a3a3a" : "#8290bd";
    // Paridade com o SVG anterior: sucesso/falha tingem o número.
    const textColor = estado === "sucesso" ? "#8fe6b0" : estado === "falha" ? "#e8a0a0" : text;
    const started = performance.now();
    let orientation = start;
    let position: Vec3 = [0, 0, 1.42];
    let velocity: Vec3 = [
      Math.sin(indice * 1.7 + 0.4) * 1.65,
      Math.cos(indice * 1.13 + 0.8) * 1.25,
      0.35 + (indice % 3) * 0.18,
    ];
    let angularVelocity: Vec3 = [7.2 + (indice % 3), 8.1, 6.4 + (indice % 4) * 0.35];
    let lastFrame = started;
    let simulationTime = 0;
    let settleTime = 0;
    const lowestVertex = (q: Quat) => {
      let min = Infinity, index = 0;
      vertices.forEach((v, i) => {
        const z = rotate(v, q)[2];
        if (z < min) { min = z; index = i; }
      });
      return { min, index };
    };
    const alturaDeRepouso = (q: Quat) => -lowestVertex(q).min + 0.025;
    const render = (eased: number, physical?: { orientation: Quat; x: number; y: number; z: number }) => {
      const base = slerp(start, target, eased);
      const axis = unit([0.72, 0.31, 0.62]);
      const angle = Math.PI * 6 * eased;
      const tumble: Quat = [Math.cos(angle / 2), axis[0] * Math.sin(angle / 2), axis[1] * Math.sin(angle / 2), axis[2] * Math.sin(angle / 2)];
      const q = physical?.orientation ?? qMultiply(base, tumble);
      ctx.clearRect(0, 0, width, height);
      const size = Math.min(width, height);
      const restante = 1 - eased;
      const elevacao = physical ? Math.max(0, physical.z) * size * 0.31 : restante * size * 0.105;
      const deslocamento = physical ? physical.x * size * 0.16 : Math.sin(eased * Math.PI * 2 + indice * 0.7) * restante * size * 0.055;
      const deslocamentoY = physical ? physical.y * size * 0.16 : 0;
      ctx.save();
      ctx.translate(width / 2 + deslocamento, height / 2 + deslocamentoY + size * 0.29);
      ctx.globalAlpha = 0.22 + eased * 0.18;
      ctx.shadowColor = "rgba(0,0,0,.75)";
      ctx.shadowBlur = 2 + elevacao * 0.35;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(0, 0, size * (0.30 + elevacao / size * 0.35), size * 0.075, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      const projected = vertices.map((v) => {
        const p = rotate(v, q);
        const perspective = 3.8 / (3.8 - p[2] * 0.22);
        return [width / 2 + deslocamento + p[0] * size * 0.31 * perspective, height / 2 + deslocamentoY - elevacao - p[1] * size * 0.31 * perspective, p[2]] as const;
      });
      const visible = faces.map((face, i) => {
        const n = rotate(normalFor(vertices, face), q);
        const center = face.reduce((s, index) => add(s, rotate(vertices[index], q)), [0,0,0] as Vec3);
        return { face, i, depth: center[2] / face.length, light: Math.max(0, dot(n, unit([-0.35, 0.55, 1]))) };
      }).filter((f) => rotate(normalFor(vertices, f.face), q)[2] > -0.04).sort((a,b) => a.depth - b.depth);
      const gradient = ctx.createRadialGradient(width * 0.35, height * 0.22, 1, width / 2, height / 2, size * 0.62);
      gradient.addColorStop(0, "rgba(255,255,255,.20)");
      gradient.addColorStop(1, "rgba(0,0,0,.20)");
      for (const item of visible) {
        const pts = item.face.map((i) => projected[i]);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        const shade = 0.48 + item.light * 0.48;
        ctx.fillStyle = fill;
        ctx.globalAlpha = shade;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.lineWidth = Math.max(1, size * 0.018);
        ctx.stroke();
        const center = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length] as number[], [0,0]);
        const faceValue = labels[item.i];
        // Filete interno dá leitura de aresta/bevel sem depender de WebGL.
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const insetX = center[0] + (pts[i][0] - center[0]) * 0.86;
          const insetY = center[1] + (pts[i][1] - center[1]) * 0.86;
          if (i === 0) ctx.moveTo(insetX, insetY);
          else ctx.lineTo(insetX, insetY);
        }
        ctx.closePath();
        ctx.strokeStyle = "rgba(255,255,255,.19)";
        ctx.lineWidth = Math.max(0.7, size * 0.012);
        ctx.stroke();

        const edge = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
        let labelAngle = Math.atan2(edge[1], edge[0]);
        // Mantém os algarismos legíveis, sem ficarem de cabeça para baixo.
        if (labelAngle > Math.PI / 2 || labelAngle < -Math.PI / 2) labelAngle += Math.PI;
        ctx.save();
        ctx.translate(center[0], center[1]);
        ctx.rotate(labelAngle);
        ctx.fillStyle = textColor;
        ctx.font = `800 ${Math.max(9, size * (lados === 20 ? 0.13 : 0.16))}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(0,0,0,.58)";
        ctx.lineWidth = Math.max(1.2, size * 0.025);
        ctx.strokeText(String(faceValue), 0, 0);
        ctx.shadowColor = "rgba(0,0,0,.45)";
        ctx.shadowBlur = 2;
        ctx.fillText(String(faceValue), 0, 0);
        ctx.restore();
      }
    };
    const renderFinal = () => render(1, { orientation: target, x: 0, y: 0, z: alturaDeRepouso(target) });
    const draw = (now: number) => {
      if (reduced || finalizado) { renderFinal(); return; }
      const dt = Math.min(0.032, Math.max(0.001, (now - lastFrame) / 1000));
      lastFrame = now;
      simulationTime += dt;

      // Gravidade e integração da rotação por velocidade angular.
      velocity[2] -= 8.6 * dt;
      position = add(position, scale(velocity, dt));
      const angularSpeed = length(angularVelocity);
      if (angularSpeed > 0.0001) {
        const half = angularSpeed * dt * 0.5;
        const axis = unit(angularVelocity);
        const delta: Quat = [Math.cos(half), axis[0] * Math.sin(half), axis[1] * Math.sin(half), axis[2] * Math.sin(half)];
        orientation = qNormalize(qMultiply(delta, orientation));
      }

      // Colisão com o tampo: corrige penetração, aplica restituição e
      // transfere parte do impulso para a rotação no ponto de contato.
      const contact = lowestVertex(orientation);
      const penetration = position[2] + contact.min;
      if (penetration < 0) {
        position[2] -= penetration;
        if (velocity[2] < 0) {
          const impact = -velocity[2];
          const impulse = impact * 1.38;
          velocity[2] = impact > 0.72 ? impact * 0.38 : 0;
          const arm = rotate(vertices[contact.index], orientation);
          const torque = cross(arm, [0, 0, impulse]);
          angularVelocity = add(angularVelocity, scale(torque, 0.48));
          velocity[0] *= 0.78;
          velocity[1] *= 0.78;
        }
      }

      // Limites da área de rolagem: o dado rebate nas quatro bordas.
      for (const axis of [0, 1] as const) {
        if (position[axis] > 0.82) { position[axis] = 0.82; velocity[axis] = -Math.abs(velocity[axis]) * 0.42; }
        if (position[axis] < -0.82) { position[axis] = -0.82; velocity[axis] = Math.abs(velocity[axis]) * 0.42; }
      }

      const noChao = position[2] + lowestVertex(orientation).min <= 0.04;
      const damping = noChao ? 2.25 : 0.42;
      angularVelocity = scale(angularVelocity, Math.exp(-damping * dt));
      velocity[0] *= Math.exp(-1.45 * dt);
      velocity[1] *= Math.exp(-1.45 * dt);

      // A energia se dissipa progressivamente; quando o corpo quase para,
      // assenta na face que representa o resultado recebido do servidor.
      if (simulationTime > 1.15) {
        angularVelocity = scale(angularVelocity, Math.exp(-2.1 * dt));
        if (noChao && length(angularVelocity) < 1.05 && Math.hypot(velocity[0], velocity[1], velocity[2]) < 0.72) {
          settleTime += dt;
          orientation = slerp(orientation, target, Math.min(1, dt * 5.5));
          position[2] += (alturaDeRepouso(target) - position[2]) * Math.min(1, dt * 5);
          position[0] *= Math.exp(-3.2 * dt);
          position[1] *= Math.exp(-3.2 * dt);
          velocity = scale(velocity, Math.exp(-5 * dt));
          if (settleTime >= 0.28) finalizado = true;
        }
      }
      if (simulationTime >= 2.9) finalizado = true;

      if (finalizado) {
        renderFinal();
        return;
      }
      render(1, { orientation, x: position[0], y: position[1], z: position[2] });
      raf = requestAnimationFrame(draw);
    };
    if (reduced) renderFinal();
    else raf = requestAnimationFrame(draw);
    const observer = new ResizeObserver(() => {
      resize();
      // Redimensionar limpa o bitmap interno; redesenha mesmo após a animação.
      if (raf) cancelAnimationFrame(raf);
      if (finalizado || reduced) renderFinal();
      else raf = requestAnimationFrame(draw);
    });
    observer.observe(canvas);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [lados, valor, indice, estado]);

  return (
    <>
      <canvas ref={canvasRef} className={`dado-3d-canvas dado-shape d${lados} ${canvasUnavailable ? "dado-3d-indisponivel" : ""} ${estado ? `estado-${estado}` : ""} ${className ?? ""}`} role="img" aria-label={`Dado de ${lados} lados: resultado ${valor}`} title={`d${lados} = ${valor}`} />
      {canvasUnavailable && <span className={`dado-3d-fallback ${className ?? ""}`} title={`d${lados} = ${valor}`}>{valor}</span>}
    </>
  );
}
