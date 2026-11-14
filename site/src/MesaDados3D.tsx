import { useEffect, useRef, useState } from "react";
import { normalFor, rotate, add, dot, unit, type Vec3 } from "./fisicaDado";
import {
  criarCenaMesa, passoCena, cenaRepousada, semiLadoMesa,
  type DadoMesa,
} from "./fisicaMesa";

export interface ItemDadoMesa {
  lados: number;
  valor: number;
}

/** Semente estável a partir do id da rolagem — trajetória reproduzível. */
export function seedDeId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Props {
  dados: ItemDadoMesa[];
  /** semente estável por rolagem (ex.: hash do id) — trajetória reproduzível */
  semente?: number;
  estado?: "sucesso" | "falha" | null;
  className?: string;
}

interface FaceVisivel {
  pts: { x: number; y: number; z: number }[];
  profundidade: number;
  luz: number;
  rotulo: number;
  dado: DadoMesa;
}

/**
 * Mesa compartilhada de dados 3D: uma única cena/canvas para todos os
 * dados do lançamento — mesma superfície, bordas visíveis e colisões
 * entre dados. O resultado de cada face vem exclusivamente do valor
 * recebido do servidor; a física só anima até assentar nessa face.
 */
export default function MesaDados3D({ dados, semente = 7, estado, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const chave = dados.map((d) => `${d.lados}:${d.valor}`).join(",");

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || dados.length === 0) {
      if (dados.length === 0) return;
      setCanvasUnavailable(true);
      return;
    }
    setCanvasUnavailable(false);

    const cena: DadoMesa[] = criarCenaMesa(dados, semente);
    const limite = semiLadoMesa(cena.length);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // Sem simulação: cada dado já nasce assentado na face do servidor,
      // distribuído na grade de spawn — resultado final imediato.
      cena.forEach((d) => {
        d.orientation = d.alvo;
        d.position[2] = d.repouso;
        d.velocity = [0, 0, 0];
        d.angularVelocity = [0, 0, 0];
        d.finalizado = true;
      });
    }

    let raf = 0;
    let width = 0, height = 0, dpr = 1;
    let finalizado = reduced || cenaRepousada(cena);
    let fill = "#2b3350";
    let textColor = "#e8ecf7";
    const lerCores = () => {
      const colors = getComputedStyle(canvas);
      fill = colors.getPropertyValue("--dado-fundo").trim() || "#2b3350";
      const text = colors.getPropertyValue("--dado-texto").trim() || "#e8ecf7";
      textColor = estado === "sucesso" ? "#8fe6b0" : estado === "falha" ? "#e8a0a0" : text;
    };
    lerCores();
    const border = estado === "sucesso" ? "#2e8f5b" : estado === "falha" ? "#8a3a3a" : "#8290bd";

    const desenhar = () => {
      // Mundo → tela: mesa ocupa ~92% do menor lado; z alto vira elevação.
      const k = Math.min(width, height) / (limite * 2 + 2.4);
      const cx = width / 2, cy = height / 2;
      const mesaW = limite * 2 * k, mesaH = limite * 2 * k;

      ctx.clearRect(0, 0, width, height);
      // Tampo: feltro com borda visível — o "limite" da mesa.
      const margem = k * 0.22;
      const rx = cx - mesaW / 2 - margem, ry = cy - mesaH / 2 - margem;
      const rw = mesaW + margem * 2, rh = mesaH + margem * 2;
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, k * 0.35);
      else ctx.rect(rx, ry, rw, rh);
      const feltro = ctx.createRadialGradient(cx, cy - rh * 0.2, k, cx, cy, Math.max(rw, rh) * 0.7);
      feltro.addColorStop(0, "rgba(38,52,86,.55)");
      feltro.addColorStop(1, "rgba(18,24,40,.75)");
      ctx.fillStyle = feltro;
      ctx.fill();
      ctx.strokeStyle = "rgba(130,144,189,.55)";
      ctx.lineWidth = Math.max(1, k * 0.06);
      ctx.stroke();
      ctx.restore();

      // Coleta faces visíveis de TODOS os dados para ordenação global
      // por profundidade — oclusão correta entre dados sobre a mesa.
      const facesVisiveis: FaceVisivel[] = [];
      for (const d of cena) {
        const elevacao = Math.max(0, d.position[2] - d.repouso) * k * 0.85;
        const px = cx + d.position[0] * k;
        const py = cy + d.position[1] * k + elevacao;
        const projetados = d.vertices.map((v) => {
          const p = rotate(v, d.orientation) as Vec3;
          const perspectiva = 3.8 / (3.8 - p[2] * 0.16);
          return {
            x: px + p[0] * k * 0.40 * perspectiva,
            y: py - p[1] * k * 0.40 * perspectiva,
            z: p[2],
          };
        });
        for (let fi = 0; fi < d.faces.length; fi++) {
          const face = d.faces[fi];
          const n = rotate(normalFor(d.vertices, face), d.orientation);
          if (n[2] <= -0.04) continue;
          const centro = face.reduce((s, i) => add(s, rotate(d.vertices[i], d.orientation)), [0, 0, 0] as Vec3);
          // Profundidade global: z local da face + altura do corpo —
          // um dado acima na mesa cobre o que está abaixo na tela.
          const profundidade = centro[2] / face.length + d.position[2] * 0.6;
          const luz = Math.max(0, dot(n, unit([-0.35, 0.55, 1])));
          facesVisiveis.push({
            pts: face.map((i) => projetados[i]),
            profundidade, luz, rotulo: d.labels[fi], dado: d,
          });
        }
        // Sombra do dado no tampo.
        const sombraY = cy + d.position[1] * k + k * 0.06;
        const altura = Math.max(0, d.position[2] - d.repouso);
        ctx.save();
        ctx.globalAlpha = Math.max(0.08, 0.3 - altura * 0.05);
        ctx.shadowColor = "rgba(0,0,0,.7)";
        ctx.shadowBlur = 2 + altura * k * 0.2;
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.ellipse(px, sombraY, d.raio * k * 0.5, d.raio * k * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      facesVisiveis.sort((a, b) => a.profundidade - b.profundidade);

      const gradient = ctx.createRadialGradient(cx - k, cy - k, k * 0.2, cx, cy, k * limite);
      gradient.addColorStop(0, "rgba(255,255,255,.16)");
      gradient.addColorStop(1, "rgba(0,0,0,.22)");
      for (const f of facesVisiveis) {
        const pts = f.pts;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        const shade = 0.48 + f.luz * 0.48;
        ctx.fillStyle = fill;
        ctx.globalAlpha = shade;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.lineWidth = Math.max(1, k * 0.045);
        ctx.stroke();
        // Rótulo da face, sempre legível (eixo de tela, sem rotação).
        const centroX = pts.reduce((s, p) => s + p.x / pts.length, 0);
        const centroY = pts.reduce((s, p) => s + p.y / pts.length, 0);
        ctx.font = `800 ${Math.max(8, Math.min(22, k * (f.dado.lados === 20 ? 0.34 : 0.42)))}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(0,0,0,.6)";
        ctx.lineWidth = Math.max(1, k * 0.05);
        ctx.strokeText(String(f.rotulo), centroX, centroY);
        ctx.fillStyle = textColor;
        ctx.fillText(String(f.rotulo), centroX, centroY);
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(120, rect.width); height = Math.max(90, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      desenhar();
    };
    resize();

    let lastFrame = performance.now();
    const draw = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - lastFrame) / 1000));
      lastFrame = now;
      passoCena(cena, dt);
      finalizado = cenaRepousada(cena);
      desenhar();
      if (!finalizado) raf = requestAnimationFrame(draw);
    };
    if (!finalizado) {
      raf = requestAnimationFrame(draw);
    } else {
      desenhar();
    }

    const observer = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      resize();
      if (!finalizado) raf = requestAnimationFrame(draw);
    });
    observer.observe(canvas);
    const prefsObserver = new MutationObserver(() => {
      lerCores();
      desenhar();
    });
    prefsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      prefsObserver.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, semente, estado]);

  if (canvasUnavailable || dados.length === 0) {
    return (
      <span className={`mesa-dados-fallback ${className ?? ""}`}>
        {dados.map((d, i) => (
          <span key={i} className="dado-3d-fallback" title={`d${d.lados} = ${d.valor}`}>{d.valor}</span>
        ))}
      </span>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      className={`mesa-dados-3d-canvas ${estado ? `estado-${estado}` : ""} ${className ?? ""}`}
      role="img"
      aria-label={`Mesa de dados: ${dados.map((d) => `d${d.lados}=${d.valor}`).join(", ")}`}
    />
  );
}
