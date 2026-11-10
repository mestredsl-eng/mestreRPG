import { useEffect, useRef, useState } from "react";
import {
  add, dot, faceValues, geometry, normalFor, qMultiply, qNormalize,
  rotate, slerp, unit, fromTo,
  alturaDeRepouso, criarEstadoFisica, passoFisica,
  type Quat, type Vec3,
} from "./fisicaDado";

interface Props {
  lados: number;
  valor: number;
  indice?: number;
  estado?: "sucesso" | "falha" | null;
  className?: string;
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
    // Física local de corpo rígido simplificado (ver fisicaDado.ts):
    // gravidade, quique no tampo, atrito, limites e assentamento na face
    // do valor recebido do servidor — nunca sorteia resultado.
    let raf = 0;
    let width = 0, height = 0, dpr = 1;
    let finalizado = false;
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
    let lastFrame = started;
    const fisica = criarEstadoFisica(vertices, start, indice);
    const alvoRepouso = alturaDeRepouso(vertices, target);
    const render = (eased: number, physical?: { orientation: Quat; x: number; y: number; z: number }) => {
      const base = slerp(start, target, eased);
      const axis = unit([0.72, 0.31, 0.62]);
      const angle = Math.PI * 6 * eased;
      const tumble: Quat = [Math.cos(angle / 2), axis[0] * Math.sin(angle / 2), axis[1] * Math.sin(angle / 2), axis[2] * Math.sin(angle / 2)];
      const q = physical?.orientation ?? qMultiply(base, tumble);
      ctx.clearRect(0, 0, width, height);
      const size = Math.min(width, height);
      const restante = 1 - eased;
      const elevacao = physical ? Math.max(0, physical.z - alvoRepouso) * size * 0.20 : restante * size * 0.105;
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
        const center = face.reduce((s, index) => add(s, rotate(vertices[index], q)), [0, 0, 0] as Vec3);
        return { face, i, depth: center[2] / face.length, light: Math.max(0, dot(n, unit([-0.35, 0.55, 1]))) };
      }).filter((f) => rotate(normalFor(vertices, f.face), q)[2] > -0.04).sort((a, b) => a.depth - b.depth);
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
        const center = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length] as number[], [0, 0]);
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
    const renderFinal = () => render(1, { orientation: target, x: 0, y: 0, z: alvoRepouso });
    const draw = (now: number) => {
      if (reduced || finalizado) { renderFinal(); return; }
      const dt = Math.min(0.032, Math.max(0.001, (now - lastFrame) / 1000));
      lastFrame = now;
      passoFisica(fisica, dt, vertices, { orientation: target, repouso: alvoRepouso });
      finalizado = fisica.finalizado;
      if (finalizado) { renderFinal(); return; }
      render(1, { orientation: fisica.orientation, x: fisica.position[0], y: fisica.position[1], z: fisica.position[2] });
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
