import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type * as RapierTypes from "@dimforge/rapier3d";
import MesaDadosCanvas, { seedDeId, type ItemDadoMesa } from "./MesaDados3D";
import { faceValues, geometry, normalFor, type Vec3 } from "./fisicaDado";
import { semiLadoMesa } from "./fisicaMesa";

export { seedDeId };

interface Props {
  dados: ItemDadoMesa[];
  semente?: number;
  estado?: "sucesso" | "falha" | null;
  className?: string;
}

interface DadoFisico {
  lados: number;
  labels: number[];
  valor: number | null;
  estado: "sucesso" | "falha" | null;
  corpo: RapierTypes.RigidBody;
  grupo: THREE.Group;
  labelMesh: THREE.Mesh;
  edgeMesh: THREE.LineSegments;
  alvo: THREE.Quaternion | null;
  alvoAltura: number;
  alvoDesde: number;
  tempo: number;
  assentado: number;
  pronto: boolean;
}

interface CenaFisica {
  renderer: THREE.WebGLRenderer;
  cena: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: RapierTypes.World;
  dados: DadoFisico[];
  startAnimation: () => void;
  bandeja: THREE.MeshStandardMaterial;
  base: THREE.MeshStandardMaterial;
  feltroTexture: THREE.CanvasTexture;
  metade: number;
}

const ESCALA_DADO = 0.62;
const PASSO_FISICO = 1 / 60;
let rapierPronto: Promise<void> | null = null;
let rapierApi: typeof RapierTypes.default | null = null;

function iniciarRapier(): Promise<void> {
  rapierPronto ??= import("@dimforge/rapier3d").then(async (module) => {
    rapierApi = module.default;
  });
  return rapierPronto;
}

function motorRapier(): typeof RapierTypes.default {
  if (!rapierApi) throw new Error("Rapier ainda não foi inicializado");
  return rapierApi;
}

function numeroAleatorio(semente: number) {
  let estado = semente >>> 0;
  return () => {
    estado = (Math.imul(estado ^ (estado >>> 15), estado | 1) + 0x6d2b79f5) | 0;
    let valor = Math.imul(estado ^ (estado >>> 7), estado | 61);
    return ((valor ^ (valor >>> 14)) >>> 0) / 4294967296;
  };
}

function quaternionAleatorio(rand: () => number): THREE.Quaternion {
  const u1 = rand(), u2 = rand(), u3 = rand();
  return new THREE.Quaternion(
    Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
    Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
    Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
    Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
  );
}

function corCss(elemento: HTMLElement, variavel: string, fallback: string): THREE.Color {
  return new THREE.Color(getComputedStyle(elemento).getPropertyValue(variavel).trim() || fallback);
}

function criarTexturaFeltro(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 192;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#b6b6b6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    let seed = 937421;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 1800; i++) {
      context.fillStyle = random() > 0.5 ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.09)";
      context.beginPath();
      context.arc(random() * 192, random() * 192, random() * 1.2 + 0.25, 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = "rgba(255,255,255,.025)";
    context.lineWidth = 0.6;
    for (let y = 0; y < 192; y += 4) {
      context.beginPath(); context.moveTo(0, y + 0.5); context.lineTo(192, y + 0.5); context.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.4, 2.4);
  return texture;
}

function criarAtlasRotulos(lados: number, labels: number[], estado: DadoFisico["estado"], corTexto: THREE.Color): THREE.CanvasTexture {
  const colunas = Math.ceil(Math.sqrt(labels.length));
  const linhas = Math.ceil(labels.length / colunas);
  const celula = 128;
  const canvas = document.createElement("canvas");
  canvas.width = colunas * celula;
  canvas.height = linhas * celula;
  const context = canvas.getContext("2d");
  if (context) {
    const cor = estado === "sucesso" ? "#b4ffd0" : estado === "falha" ? "#ffc0c0"
      : `#${corTexto.getHexString()}`;
    context.font = `800 ${lados === 20 ? 76 : 88}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 10;
    context.strokeStyle = "rgba(0,0,0,.78)";
    context.fillStyle = cor;
    labels.forEach((label, index) => {
      const x = (index % colunas) * celula + celula / 2;
      const y = Math.floor(index / colunas) * celula + celula / 2;
      context.strokeText(String(label), x, y);
      context.fillText(String(label), x, y);
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function criarGeometria(poliedro: ReturnType<typeof geometry>, escala: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const face of poliedro.faces) {
    const n = normalFor(poliedro.vertices, face);
    for (let i = 1; i < face.length - 1; i++) {
      for (const index of [face[0], face[i], face[i + 1]]) {
        const v = poliedro.vertices[index];
        positions.push(v[0] * escala, v[1] * escala, v[2] * escala);
        normals.push(n[0], n[1], n[2]);
      }
    }
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  result.computeBoundingSphere();
  return result;
}

function criarRotulos(
  vertices: Vec3[], faces: number[][], labels: number[], escala: number,
  atlas: THREE.CanvasTexture,
): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const columns = Math.ceil(Math.sqrt(labels.length));
  const rows = Math.ceil(labels.length / columns);
  const largura = escala * (labels.length === 20 ? 0.64 : labels.length === 4 ? 0.82 : 0.76);
  const altura = largura * 0.72;

  faces.forEach((face, index) => {
    const normalBase = normalFor(vertices, face);
    const normal = new THREE.Vector3(...normalBase).normalize();
    const reference = Math.abs(normal.z) > 0.92 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(reference, normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right).normalize();
    const center = face.reduce((sum, vertexIndex) => {
      const v = vertices[vertexIndex];
      return sum.add(new THREE.Vector3(v[0], v[1], v[2]).multiplyScalar(escala / face.length));
    }, new THREE.Vector3());
    const origin = center.addScaledVector(normal, escala * 0.012);
    const p0 = origin.clone().addScaledVector(right, -largura / 2).addScaledVector(up, -altura / 2);
    const p1 = origin.clone().addScaledVector(right, largura / 2).addScaledVector(up, -altura / 2);
    const p2 = origin.clone().addScaledVector(right, largura / 2).addScaledVector(up, altura / 2);
    const p3 = origin.clone().addScaledVector(right, -largura / 2).addScaledVector(up, altura / 2);
    positions.push(...p0.toArray(), ...p1.toArray(), ...p2.toArray(), ...p0.toArray(), ...p2.toArray(), ...p3.toArray());

    const column = index % columns;
    const row = Math.floor(index / columns);
    const u0 = column / columns, u1 = (column + 1) / columns;
    const v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows;
    uvs.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  });

  const labelGeometry = new THREE.BufferGeometry();
  labelGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  labelGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  labelGeometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({
    map: atlas, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, toneMapped: false,
  });
  const labelMesh = new THREE.Mesh(labelGeometry, material);
  labelMesh.renderOrder = 2;
  return labelMesh;
}

function corEstado(estado: DadoFisico["estado"]): string {
  return estado === "sucesso" ? "#2e8f5b" : estado === "falha" ? "#8a3a3a" : "#c3c9d8";
}

function sincronizarGrupo(dado: DadoFisico) {
  const position = dado.corpo.translation();
  const rotation = dado.corpo.rotation();
  dado.grupo.position.set(position.x, position.y, position.z);
  dado.grupo.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
}

function criarArestas(faces: number[][], vertices: Vec3[], escala: number, estado: DadoFisico["estado"]): THREE.LineSegments {
  const edges = new Map<string, [number, number]>();
  for (const face of faces) for (let i = 0; i < face.length; i++) {
    const a = face[i], b = face[(i + 1) % face.length];
    edges.set(`${Math.min(a, b)}:${Math.max(a, b)}`, [a, b]);
  }
  const points: number[] = [];
  for (const [a, b] of edges.values()) {
    points.push(...vertices[a].map((v) => v * escala), ...vertices[b].map((v) => v * escala));
  }
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({ color: corEstado(estado), transparent: true, opacity: 0.92, toneMapped: false });
  return new THREE.LineSegments(edgeGeometry, edgeMaterial);
}

function alvoDoValor(lados: number, valor: number): { orientation: THREE.Quaternion; altura: number } {
  const poly = geometry(lados);
  const labels = faceValues(lados, poly.vertices, poly.faces);
  const faceIndex = Math.max(0, labels.indexOf(Math.round(valor)));
  const n = normalFor(poly.vertices, poly.faces[faceIndex]);
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...n), new THREE.Vector3(0, 0, 1));
  let lowest = Infinity;
  for (const v of poly.vertices) lowest = Math.min(lowest, new THREE.Vector3(...v).applyQuaternion(orientation).z * ESCALA_DADO);
  return { orientation, altura: -lowest + 0.035 };
}

function criarBandeja(scene: THREE.Scene, world: RapierTypes.World, canvas: HTMLCanvasElement, half: number) {
  const RAPIER = motorRapier();
  const baseColor = corCss(canvas, "--mesa-feltro", "#263456");
  const woodColor = new THREE.Color("#201b1a");
  const base = new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.48, metalness: 0.16 });
  const feltroTexture = criarTexturaFeltro();
  const bandeja = new THREE.MeshStandardMaterial({ map: feltroTexture, color: baseColor, roughness: 0.92, metalness: 0.02 });
  const baseMesh = new THREE.Mesh(new THREE.BoxGeometry((half + 0.36) * 2, (half + 0.36) * 2, 0.22), base);
  baseMesh.position.z = -0.16;
  baseMesh.receiveShadow = true;
  scene.add(baseMesh);

  const feltro = new THREE.Mesh(new THREE.BoxGeometry(half * 2, half * 2, 0.035), bandeja);
  feltro.position.z = -0.0175;
  feltro.receiveShadow = true;
  scene.add(feltro);

  const railMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color("#36312e"), roughness: 0.36, metalness: 0.22 });
  const thickness = 0.17, height = 0.35, center = half + thickness / 2;
  const rails: [number, number, number, number, number, number][] = [
    [0, center, 0.15, half + thickness, thickness, height],
    [0, -center, 0.15, half + thickness, thickness, height],
    [center, 0, 0.15, thickness, half, height],
    [-center, 0, 0.15, thickness, half, height],
  ];
  for (const [x, y, z, sx, sy, sz] of rails) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2), railMaterial);
    rail.position.set(x, y, z);
    rail.castShadow = true;
    rail.receiveShadow = true;
    scene.add(rail);
  }

  const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -0.08));
  world.createCollider(RAPIER.ColliderDesc.cuboid(half + 0.36, half + 0.36, 0.08).setFriction(0.84).setRestitution(0.22), floorBody);
  const railPhysics = [
    [0, center, 0.15, half + thickness, thickness, height],
    [0, -center, 0.15, half + thickness, thickness, height],
    [center, 0, 0.15, thickness, half, height],
    [-center, 0, 0.15, thickness, half, height],
  ];
  for (const [x, y, z, sx, sy, sz] of railPhysics) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(sx, sy, sz).setFriction(0.72).setRestitution(0.28), body);
  }
  return { bandeja, base, feltroTexture };
}

function atualizarCores(cena: CenaFisica, canvas: HTMLCanvasElement) {
  cena.bandeja.color.set(corCss(canvas, "--mesa-feltro", "#263456"));
  cena.bandeja.needsUpdate = true;
  cena.dados.forEach((dado) => {
    const cor = corCss(canvas, "--dado-fundo", "#2b3350");
    const texto = corCss(canvas, "--dado-texto", "#e8ecf7");
    dado.grupo.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshPhysicalMaterial) obj.material.color.copy(cor);
    });
    const labelMaterial = dado.labelMesh.material as THREE.MeshBasicMaterial;
    labelMaterial.map?.dispose();
    labelMaterial.map = criarAtlasRotulos(dado.lados, dado.labels, dado.estado, texto);
    labelMaterial.needsUpdate = true;
    (dado.edgeMesh.material as THREE.LineBasicMaterial).color.set(corEstado(dado.estado));
  });
}

function definirResultado(dado: DadoFisico, item: ItemDadoMesa, padrao: Props["estado"], reduzido: boolean) {
  dado.estado = item.estado ?? padrao ?? null;
  const resultadoIgual = item.valor === dado.valor && (item.valor === null || dado.alvo !== null);
  if (resultadoIgual && (!reduzido || !dado.alvo || dado.pronto)) return;
  dado.valor = item.valor;
  const target = item.valor === null ? null : alvoDoValor(item.lados, item.valor);
  dado.alvo = target?.orientation ?? null;
  dado.alvoAltura = target?.altura ?? 0;
  dado.alvoDesde = dado.tempo;
  dado.assentado = 0;
  dado.pronto = false;
  dado.corpo.wakeUp();
  if (reduzido && dado.alvo) {
    dado.corpo.setRotation(dado.alvo, true);
    const translation = dado.corpo.translation();
    dado.corpo.setTranslation({ x: translation.x, y: translation.y, z: dado.alvoAltura }, true);
    dado.corpo.setLinvel({ x: 0, y: 0, z: 0 }, true);
    dado.corpo.setAngvel({ x: 0, y: 0, z: 0 }, true);
    dado.pronto = true;
    sincronizarGrupo(dado);
  }
}

export default function MesaDadosFisica({ dados, semente = 7, estado, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<CenaFisica | null>(null);
  const propsRef = useRef({ dados, semente, estado });
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const [physicsReady, setPhysicsReady] = useState(false);
  const [physicsSettled, setPhysicsSettled] = useState(false);
  propsRef.current = { dados, semente, estado };
  const key = `${semente}:${dados.map((d) => d.lados).join(",")}`;
  const valuesKey = dados.map((d) => `${d.lados}:${d.valor ?? "…"}:${d.estado ?? ""}`).join(",");

  useEffect(() => {
    setPhysicsReady(false);
    setPhysicsSettled(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let frame = 0;
    let width = 0, height = 0;
    let runtime: CenaFisica | null = null;
    let rendererInstance: THREE.WebGLRenderer | null = null;
    let lastFrame = performance.now();
    let accumulator = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const render = () => {
      if (!runtime) return;
      runtime.renderer.render(runtime.cena, runtime.camera);
    };
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(120, rect.width);
      height = Math.max(100, rect.height);
      if (!runtime) return;
      runtime.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      runtime.renderer.setSize(width, height, false);
      runtime.camera.aspect = width / height;
      runtime.camera.updateProjectionMatrix();
      render();
    };
    const requestFrame = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(draw);
    };
    const draw = (now: number) => {
      frame = 0;
      if (disposed || !runtime) return;
      const delta = Math.min(0.05, Math.max(0, (now - (lastFrame || now)) / 1000));
      lastFrame = now;
      accumulator = Math.min(accumulator + delta, PASSO_FISICO * 5);
      while (accumulator >= PASSO_FISICO) {
        runtime.world.timestep = PASSO_FISICO;
        runtime.world.step();
        for (const dado of runtime.dados) {
          dado.tempo += PASSO_FISICO;
          if (dado.alvo && !dado.pronto) {
            const targetAge = dado.tempo - dado.alvoDesde;
            const rotation = dado.corpo.rotation();
            const current = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
            const error = dado.alvo.clone().multiply(current.invert()).normalize();
            if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
            const angle = 2 * Math.acos(THREE.MathUtils.clamp(error.w, -1, 1));
            if (targetAge > 0.38 && angle > 0.012) {
              const sine = Math.sqrt(Math.max(0, 1 - error.w * error.w));
              const axis = sine > 1e-5
                ? new THREE.Vector3(error.x / sine, error.y / sine, error.z / sine)
                : new THREE.Vector3(0, 0, 1);
              const speed = Math.min(8.5, angle * 4.2);
              const desired = axis.multiplyScalar(speed);
              const currentAngular = dado.corpo.angvel();
              const follow = THREE.MathUtils.clamp(PASSO_FISICO * 2.8, 0, 1);
              dado.corpo.setAngvel({
                x: THREE.MathUtils.lerp(currentAngular.x, desired.x, follow),
                y: THREE.MathUtils.lerp(currentAngular.y, desired.y, follow),
                z: THREE.MathUtils.lerp(currentAngular.z, desired.z, follow),
              }, true);
            }
            const linear = dado.corpo.linvel();
            const angular = dado.corpo.angvel();
            const slow = Math.hypot(linear.x, linear.y, linear.z) < 0.34
              && Math.hypot(angular.x, angular.y, angular.z) < 0.82 && angle < 0.16;
            dado.assentado = slow ? dado.assentado + PASSO_FISICO : 0;
            if (dado.assentado >= 0.18 || targetAge >= 3.6) {
              dado.corpo.setRotation(dado.alvo, true);
              const position = dado.corpo.translation();
              dado.corpo.setTranslation({ x: position.x, y: position.y, z: dado.alvoAltura }, true);
              dado.corpo.setLinvel({ x: 0, y: 0, z: 0 }, true);
              dado.corpo.setAngvel({ x: 0, y: 0, z: 0 }, true);
              dado.pronto = true;
            }
          }
          sincronizarGrupo(dado);
        }
        accumulator -= PASSO_FISICO;
      }
      render();
      if (runtime.dados.every((dado) => dado.pronto)) setPhysicsSettled(true);
      const needsAnotherFrame = runtime.dados.some(
        (dado) => !dado.pronto && (!dado.corpo.isSleeping() || dado.alvo !== null),
      );
      if (needsAnotherFrame) requestFrame();
    };

    const cleanupRenderer = () => {
      if (frame) cancelAnimationFrame(frame);
      if (runtime) {
        runtime.world.free();
        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        const textures = new Set<THREE.Texture>();
        runtime.cena.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry) geometries.add(mesh.geometry);
          const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
          for (const material of list) {
            materials.add(material);
            const texture = (material as THREE.MeshStandardMaterial).map;
            if (texture) textures.add(texture);
          }
        });
        textures.forEach((texture) => texture.dispose());
        materials.forEach((material) => material.dispose());
        geometries.forEach((geometry) => geometry.dispose());
        runtime.renderer.dispose();
        rendererInstance = null;
        runtime = null;
        runtimeRef.current = null;
      } else if (rendererInstance) {
        rendererInstance.dispose();
        rendererInstance = null;
      }
    };

    const initialize = async () => {
      try {
        await iniciarRapier();
        if (disposed) return;
        const RAPIER = motorRapier();
        const renderer = new THREE.WebGLRenderer({
          canvas, alpha: false, antialias: true, powerPreference: "high-performance",
          preserveDrawingBuffer: true,
        });
        rendererInstance = renderer;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.18;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color("#111722");
        const initial = propsRef.current;
        const half = semiLadoMesa(initial.dados.length);
        const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
        world.timestep = PASSO_FISICO;
        const { bandeja, base, feltroTexture } = criarBandeja(scene, world, canvas, half);

        const ambient = new THREE.HemisphereLight(0xd9e7ff, 0x211c28, 1.35);
        scene.add(ambient);
        const keyLight = new THREE.DirectionalLight(0xfff0d7, 3.4);
        keyLight.position.set(-half * 0.72, -half * 0.62, half * 1.7);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.set(1024, 1024);
        keyLight.shadow.camera.left = -half * 1.6;
        keyLight.shadow.camera.right = half * 1.6;
        keyLight.shadow.camera.top = half * 1.6;
        keyLight.shadow.camera.bottom = -half * 1.6;
        keyLight.shadow.bias = -0.0004;
        scene.add(keyLight);
        const fillLight = new THREE.PointLight(0x9bb7ff, 22, half * 4.5, 2);
        fillLight.position.set(half * 0.75, half * 0.55, half * 0.9);
        scene.add(fillLight);

        const distance = half * 3.0 + 1.5;
        const camera = new THREE.PerspectiveCamera(42, Math.max(1, width) / Math.max(1, height), 0.1, 100);
        camera.up.set(0, 0, 1);
        camera.position.set(0, -distance * 0.73, distance * 0.69);
        camera.lookAt(0, 0, 0.12);
        runtime = { renderer, cena: scene, camera, world, dados: [], startAnimation: requestFrame, bandeja, base, feltroTexture, metade: half };
        runtimeRef.current = runtime;

        const rand = numeroAleatorio(initial.semente || 7);
        const count = initial.dados.length;
        const columns = Math.ceil(Math.sqrt(count));
        const spacing = Math.min(1.75, half * 1.55 / Math.max(1, columns));
        const start = -((columns - 1) * spacing) / 2;
        for (let i = 0; i < count; i++) {
          const item = initial.dados[i];
          const poly = geometry(item.lados);
          const labels = faceValues(item.lados, poly.vertices, poly.faces);
          const color = corCss(canvas, "--dado-fundo", "#2b3350");
          const state = item.estado ?? initial.estado ?? null;
          const atlas = criarAtlasRotulos(item.lados, labels, state, corCss(canvas, "--dado-texto", "#e8ecf7"));
          const solid = new THREE.MeshPhysicalMaterial({
            color, metalness: 0.18, roughness: 0.27, clearcoat: 0.86,
            clearcoatRoughness: 0.18, flatShading: true,
          });
          const group = new THREE.Group();
          const bodyMesh = new THREE.Mesh(criarGeometria(poly, ESCALA_DADO), solid);
          bodyMesh.castShadow = true;
          bodyMesh.receiveShadow = true;
          group.add(bodyMesh);
          const labelMesh = criarRotulos(poly.vertices, poly.faces, labels, ESCALA_DADO, atlas);
          const edgeMesh = criarArestas(poly.faces, poly.vertices, ESCALA_DADO, state);
          group.add(labelMesh);
          group.add(edgeMesh);
          scene.add(group);

          const target = item.valor === null ? null : alvoDoValor(item.lados, item.valor);
          const startX = start + (i % columns) * spacing + (rand() - 0.5) * 0.45;
          const startY = start + Math.floor(i / columns) * spacing + (rand() - 0.5) * 0.45;
          const rotation = quaternionAleatorio(rand);
          const points = new Float32Array(poly.vertices.flatMap((v) => v.map((coordinate) => coordinate * ESCALA_DADO)));
          const collider = RAPIER.ColliderDesc.roundConvexHull(points, 0.018)
            ?? RAPIER.ColliderDesc.convexHull(points);
          if (!collider) throw new Error(`Não foi possível gerar o collider d${item.lados}`);
          collider.setFriction(0.58).setRestitution(0.34).setDensity(1.1);
          const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(startX, startY, 2.0 + rand() * 1.25)
            .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
            .setLinvel((rand() - 0.5) * 3.3, (rand() - 0.5) * 3.3, -0.4 - rand() * 1.4)
            .setAngvel({ x: (rand() - 0.5) * 15, y: (rand() - 0.5) * 15, z: (rand() - 0.5) * 15 })
            .setLinearDamping(0.12).setAngularDamping(0.34).setCcdEnabled(true);
          const body = world.createRigidBody(bodyDesc);
          world.createCollider(collider, body);
          group.position.set(startX, startY, 2.0);
          group.quaternion.copy(rotation);
          const die: DadoFisico = {
            lados: item.lados, labels, valor: item.valor, estado: state, corpo: body, grupo: group,
            labelMesh, edgeMesh,
            alvo: target?.orientation ?? null, alvoAltura: target?.altura ?? 0,
            alvoDesde: 0, tempo: 0, assentado: 0, pronto: false,
          };
          runtime.dados.push(die);
          if (reduced && target) definirResultado(die, item, initial.estado, true);
        }
        setPhysicsSettled(runtime.dados.every((die) => die.pronto));
        fit();
        if (runtime.dados.some((die) => !die.pronto)) requestFrame();
        else render();
        setPhysicsReady(true);
        setCanvasUnavailable(false);
      } catch {
        if (!disposed) {
          setPhysicsReady(false);
          setCanvasUnavailable(true);
        }
        cleanupRenderer();
      }
    };

    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    const preferences = new MutationObserver(() => {
      if (!runtime) return;
      atualizarCores(runtime, canvas);
      render();
    });
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-tema-mesa"] });
    void initialize();

    return () => {
      disposed = true;
      observer.disconnect();
      preferences.disconnect();
      cleanupRenderer();
    };
    // The scene is recreated only for a new roll, not when its server result arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    runtime.dados.forEach((die, index) => {
      const item = dados[index];
      if (!item) return;
      definirResultado(die, item, estado, reduced);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const color = corCss(canvas, "--dado-fundo", "#2b3350");
      const text = corCss(canvas, "--dado-texto", "#e8ecf7");
      die.grupo.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (object.material instanceof THREE.MeshPhysicalMaterial) object.material.color.copy(color);
      });
      const labelMaterial = die.labelMesh.material as THREE.MeshBasicMaterial;
      labelMaterial.map?.dispose();
      labelMaterial.map = criarAtlasRotulos(die.lados, die.labels, die.estado, text);
      labelMaterial.needsUpdate = true;
      (die.edgeMesh.material as THREE.LineBasicMaterial).color.set(corEstado(die.estado));
      if (!die.pronto) {
        // wakeUp and a fresh RAF ensure an ACK arriving after a sleeping tumble resumes guidance.
        die.corpo.wakeUp();
      }
    });
    setPhysicsSettled(runtime.dados.every((die) => die.pronto));
    runtime.startAnimation();
  }, [valuesKey, estado]);

  if (canvasUnavailable) {
    return <MesaDadosCanvas dados={dados} semente={semente} estado={estado} className={className} />;
  }
  return (
    <canvas
      ref={canvasRef}
      className={`mesa-dados-3d-canvas mesa-dados-webgl ${estado ? `estado-${estado}` : ""} ${className ?? ""}`}
      data-renderer="three-rapier"
      data-physics-ready={physicsReady ? "true" : "false"}
      data-physics-settled={physicsSettled ? "true" : "false"}
      role="img"
      aria-label={dados.length === 0
        ? "Mesa 3D de dados: bandeja de feltro aguardando rolagem"
        : `Mesa 3D de dados: ${dados.map((d) => `d${d.lados}=${d.valor ?? "rolando"}${d.estado ? ` (${d.estado})` : ""}`).join(", ")}`}
    />
  );
}