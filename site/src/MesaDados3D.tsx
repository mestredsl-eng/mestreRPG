import { useEffect, useRef, useState } from "react";
import { normalFor, rotate, add, dot, unit, type Vec3 } from "./fisicaDado";
import { faceExibida, EFEITO_RESULTADO_MS, type EstadoEfeitoDado } from "./convencaoD10";
import {
  criarCenaMesa, passoCena, cenaRepousada, semiLadoMesa, definirAlvoDado,
  type DadoMesa,
} from "./fisicaMesa";

export interface ItemDadoMesa {
  lados: number;
  /** valor oficial do servidor; null = dado em tumble aguardando o ACK */
  valor: number | null;
  /** Estado visual opcional por dado, preservando pools mistos de sucesso/falha. */
  estado?: EstadoEfeitoDado;
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
  estado?: EstadoEfeitoDado;
  className?: string;
}

interface FaceVisivel {
  pts: { x: number; y: number; z: number }[];
  profundidade: number;
  luz: number;
  rotulo: number;
  estado?: EstadoEfeitoDado;
  dado: DadoMesa;
}

// Textura de feltro cacheada por combinação de cores do tema — gerada
// uma única vez (ruído determinístico) e reutilizada como pattern.
let padraoFeltro: { chave: string; padrao: CanvasPattern | null } | null = null;
function feltroPadrao(ctx: CanvasRenderingContext2D, chave: string): CanvasPattern | null {
  if (padraoFeltro?.chave === chave) return padraoFeltro.padrao;
  const s = document.createElement("canvas");
  s.width = s.height = 96;
  const g = s.getContext("2d");
  let padrao: CanvasPattern | null = null;
  if (g) {
    let seed = 987654321;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    // motas claras/escuras: a feltragem do pano
    for (let i = 0; i < 1100; i++) {
      g.fillStyle = rnd() > 0.5 ? "rgba(255,255,255,.055)" : "rgba(0,0,0,.08)";
      g.beginPath();
      g.arc(rnd() * 96, rnd() * 96, rnd() * 1.15 + 0.25, 0, Math.PI * 2);
      g.fill();
    }
    // trama sutil de linhas
    g.strokeStyle = "rgba(255,255,255,.025)";
    g.lineWidth = 0.6;
    for (let y = 0; y < 96; y += 3) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(96, y + 0.5); g.stroke();
    }
    padrao = ctx.createPattern(s, "repeat");
  }
  padraoFeltro = { chave, padrao };
  return padrao;
}

/**
 * Mesa compartilhada de dados 3D: uma única cena/canvas para todos os
 * dados do lançamento — mesma superfície, bordas visíveis e colisões
 * entre dados. O resultado de cada face vem exclusivamente do valor
 * recebido do servidor; a física só anima até assentar nessa face.
 */
export default function MesaDados3D({ dados, semente = 7, estado, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cenaRef = useRef<DadoMesa[] | null>(null);
  const sementeRef = useRef<number | null>(null);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const chave = dados.map((d) => `${d.lados}:${d.valor ?? "…"}:${d.estado ?? ""}`).join(",");

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      setCanvasUnavailable(true);
      return;
    }
    setCanvasUnavailable(false);

    // Cena persistente: mesma semente + mesma quantidade/tipos de dados
    // → os dados EM VOO continuam a trajetória; só o alvo de assentamento
    // é atualizado quando o resultado do servidor chega (ACK). Nova
    // semente ou nova quantidade → cena nova (novo lançamento).
    const anterior = cenaRef.current;
    const compativel = anterior !== null
      && sementeRef.current === semente
      && anterior.length === dados.length
      && dados.every((item, i) => anterior[i].lados === item.lados);
    let cena: DadoMesa[];
    if (compativel) {
      cena = anterior;
      dados.forEach((item, i) => {
        const d = cena[i];
        if (d.estado !== item.estado) d.efeitoAte = undefined;
        d.estado = item.estado;
        const mudou = item.valor === null
          ? d.alvo !== null
          : d.valor !== item.valor || d.alvo === null;
        if (mudou) { definirAlvoDado(d, item.valor); d.efeitoAte = undefined; }
      });
    } else {
      cena = criarCenaMesa(dados, semente);
      cenaRef.current = cena;
      sementeRef.current = semente;
    }
    const limite = semiLadoMesa(cena.length);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // Sem simulação: cada dado já nasce assentado na face do servidor,
      // distribuído na grade de spawn — resultado final imediato.
      cena.forEach((d) => {
        if (d.alvo) {
          d.orientation = d.alvo;
          d.position[2] = d.repouso;
        }
        d.velocity = [0, 0, 0];
        d.angularVelocity = [0, 0, 0];
        d.finalizado = true;
      });
    }

    let raf = 0;
    let fxTimer: ReturnType<typeof setTimeout> | null = null;
    let width = 0, height = 0, dpr = 1;
    let finalizado = reduced || cenaRepousada(cena);
    let fill = "#2b3350";
    let textColor = "#e8ecf7";
    // Cores da bandeja: tema do usuário via variáveis CSS --mesa-*
    // (aplicadas por aplicarTemaMesa); fallbacks = tema azul original.
    let mesaFeltro = "#263456", mesaFeltroEscuro = "#121828";
    let mesaBorda = "rgba(130,144,189,.55)", mesaAcabamento = "rgba(255,255,255,.14)";
    let mesaLuz = "rgba(255,255,255,.16)", mesaSombra = "rgba(0,0,0,.22)";
    const lerCores = () => {
      const colors = getComputedStyle(canvas);
      fill = colors.getPropertyValue("--dado-fundo").trim() || "#2b3350";
      const text = colors.getPropertyValue("--dado-texto").trim() || "#e8ecf7";
      textColor = estado === "sucesso" ? "#8fe6b0" : estado === "falha" ? "#e8a0a0"
        : estado === "acerto_critico" ? "#ffd75e" : estado === "erro_critico" ? "#ff9d8f" : text;
      mesaFeltro = colors.getPropertyValue("--mesa-feltro").trim() || mesaFeltro;
      mesaFeltroEscuro = colors.getPropertyValue("--mesa-feltro-escuro").trim() || mesaFeltroEscuro;
      mesaBorda = colors.getPropertyValue("--mesa-borda").trim() || mesaBorda;
      mesaAcabamento = colors.getPropertyValue("--mesa-acabamento").trim() || mesaAcabamento;
      mesaLuz = colors.getPropertyValue("--mesa-luz").trim() || mesaLuz;
      mesaSombra = colors.getPropertyValue("--mesa-sombra").trim() || mesaSombra;
    };
    lerCores();
    const border = estado === "sucesso" ? "#2e8f5b" : estado === "falha" ? "#8a3a3a"
      : estado === "acerto_critico" ? "#c9a227" : estado === "erro_critico" ? "#a33327" : "#8290bd";

    const agoraEfeito = () => performance.now();
    const desenhar = () => {
      const agoraFx = agoraEfeito();
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
      // Sombra projetada da bandeja — profundidade sob o tampo.
      ctx.shadowColor = mesaSombra;
      ctx.shadowBlur = k * 0.5;
      ctx.shadowOffsetY = k * 0.12;
      const fundoTray = ctx.createLinearGradient(rx, ry, rx + rw * 0.25, ry + rh);
      fundoTray.addColorStop(0, mesaFeltro);
      fundoTray.addColorStop(1, mesaFeltroEscuro);
      ctx.fillStyle = fundoTray;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      // Textura de feltro (pattern cacheado por tema).
      const feltroTex = feltroPadrao(ctx, `${mesaFeltro}|${mesaFeltroEscuro}`);
      if (feltroTex) {
        ctx.fillStyle = feltroTex;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Luz ambiente do tema: brilho suave no topo do tampo.
      const luzTray = ctx.createRadialGradient(cx, cy - rh * 0.28, k * 0.2, cx, cy, Math.max(rw, rh) * 0.75);
      luzTray.addColorStop(0, mesaLuz);
      luzTray.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = luzTray;
      ctx.fill();
      // Borda externa do tema + filete de acabamento interno (recuo).
      ctx.strokeStyle = mesaBorda;
      ctx.lineWidth = Math.max(1.5, k * 0.07);
      ctx.stroke();
      const recuo = k * 0.11;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(rx + recuo, ry + recuo, rw - recuo * 2, rh - recuo * 2, k * 0.26);
      else ctx.rect(rx + recuo, ry + recuo, rw - recuo * 2, rh - recuo * 2);
      ctx.strokeStyle = mesaAcabamento;
      ctx.lineWidth = Math.max(1, k * 0.028);
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
            profundidade, luz,
            // D10: o valor interno 10 é exibido como face "0" (Issue #147)
            rotulo: faceExibida(d.lados, d.labels[fi]),
            estado: (d.efeitoAte ?? 0) > agoraFx ? (d.estado ?? estado) : estado,
            dado: d,
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

      // Efeitos transitórios de crítico no canvas inteiro: pulso dourado
      // (acerto crítico) e impacto vermelho (erro crítico). As classes
      // são removidas quando o efeito expira — a animação é CSS e o
      // prefers-reduced-motion a desativa (ver estilos.css).
      let temCrit = false, temErroCrit = false;
      for (const d of cena) {
        if ((d.efeitoAte ?? 0) > agoraFx && d.estado) {
          if (d.estado === "acerto_critico") temCrit = true;
          if (d.estado === "erro_critico") temErroCrit = true;
        }
      }
      canvas.classList.toggle("mesa-efeito-critico", temCrit);
      canvas.classList.toggle("mesa-efeito-erro-critico", temErroCrit);

      const gradient = ctx.createRadialGradient(cx - k, cy - k, k * 0.2, cx, cy, k * limite);
      gradient.addColorStop(0, mesaLuz);
      gradient.addColorStop(1, mesaSombra);
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
        const estadoFace = f.estado;
        const bordaFace = estadoFace === "sucesso" ? "#2e8f5b"
          : estadoFace === "falha" ? "#8a3a3a"
          : estadoFace === "acerto_critico" ? "#c9a227"
          : estadoFace === "erro_critico" ? "#a33327" : border;
        const textoFace = estadoFace === "sucesso" ? "#8fe6b0"
          : estadoFace === "falha" ? "#e8a0a0"
          : estadoFace === "acerto_critico" ? "#ffd75e"
          : estadoFace === "erro_critico" ? "#ff9d8f" : textColor;
        ctx.strokeStyle = bordaFace;
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
        ctx.fillStyle = textoFace;
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
      // O flash de resultado começa quando o dado ASSENTA na face
      // oficial — não na chegada do ACK (Issue #147).
      for (const d of cena) {
        if (d.finalizado && d.estado && d.efeitoAte === undefined) {
          d.efeitoAte = now + EFEITO_RESULTADO_MS;
        }
      }
      finalizado = cenaRepousada(cena)
        && !cena.some((d) => (d.efeitoAte ?? 0) > now);
      desenhar();
      if (!finalizado) raf = requestAnimationFrame(draw);
    };
    // Cena já assentada na montagem (ex.: prefers-reduced-motion): o
    // flash de resultado ainda precisa aparecer — arma efeitoAte e uma
    // repintura única para restaurar a aparência normal ao expirar.
    const tSetup = performance.now();
    for (const d of cena) {
      if (d.finalizado && d.estado && d.efeitoAte === undefined) {
        d.efeitoAte = tSetup + EFEITO_RESULTADO_MS;
      }
    }
    if (!finalizado) {
      raf = requestAnimationFrame(draw);
    } else {
      desenhar();
      const restanteFx = Math.max(0, ...cena.map((d) => (d.efeitoAte ?? 0) - performance.now()));
      if (restanteFx > 0) {
        fxTimer = setTimeout(() => { fxTimer = null; desenhar(); }, restanteFx + 60);
      }
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
      if (fxTimer) clearTimeout(fxTimer);
      observer.disconnect();
      prefsObserver.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, semente, estado]);

  // Sem contexto 2D o resultado continua legível como texto; com
  // contexto o canvas SEMPRE renderiza — mesmo vazio ele mostra a
  // bandeja, tornando a área de dados visível antes do primeiro roll.
  if (canvasUnavailable) {
    return (
      <span className={`mesa-dados-fallback ${className ?? ""}`}>
        {dados.map((d, i) => (
          <span key={i} className="dado-3d-fallback" title={`d${d.lados} = ${d.valor == null ? "…" : faceExibida(d.lados, d.valor)}`}>{d.valor == null ? "…" : faceExibida(d.lados, d.valor)}</span>
        ))}
      </span>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      className={`mesa-dados-3d-canvas ${estado ? `estado-${estado}` : ""} ${className ?? ""}`}
      role="img"
      aria-label={dados.length === 0
        ? "Mesa de dados: bandeja vazia aguardando a rolagem"
        : `Mesa de dados: ${dados.map((d) => `d${d.lados}=${d.valor == null ? "rolando" : faceExibida(d.lados, d.valor)}${d.estado ? ` (${d.estado})` : ""}`).join(", ")}`}
    />
  );
}
