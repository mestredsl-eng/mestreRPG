// Infra compartilhada das homologações visuais (14, 14b e futuras).
// Garante um backend servindo o build de produção do site:
// - se http://localhost:3001 já responde /api/health, reutiliza (não encerra);
// - senão, compila site/, sobe servidor/dist/index.js em porta livre
//   (MESTRE_PORTA) e encerra o processo ao final — só o que ele mesmo subiu.
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";

const HEALTH_3001 = "http://localhost:3001/api/health";

async function saudável(base) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** @returns {Promise<{base:string, proprio:boolean, encerrar:()=>Promise<void>}>} */
export async function garantirBackend() {
  // Build de produção sempre: garante que o que está no ar reflete o código atual.
  console.log("[homologacao] compilando site (build de produção)…");
  execSync("npm --prefix site run build", { stdio: "inherit" });
  if (await saudável("http://localhost:3001")) {
    return { base: "http://localhost:3001", proprio: false, encerrar: async () => {} };
  }
  if (!existsSync("servidor/dist/index.js")) {
    throw new Error("servidor/dist/index.js não existe — rode `npm --prefix servidor run build` antes da homologação.");
  }
  console.log("[homologacao] :3001 fora do ar — subindo backend de teste…");
  const porta = await portaLivre();
  const base = `http://localhost:${porta}`;
  const proc = spawn("node", ["servidor/dist/index.js"], {
    env: { ...process.env, MESTRE_PORTA: String(porta) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv!] ${d}`));
  const limite = Date.now() + 45000;
  while (Date.now() < limite) {
    if (await saudável(base)) {
      console.log(`[homologacao] backend de teste no ar em ${base} (pid ${proc.pid})`);
      return {
        base, proprio: true,
        encerrar: async () => { proc.kill(); await new Promise((r) => proc.once("exit", r)); },
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error(`backend de teste não respondeu em ${base} dentro de 45s`);
}
