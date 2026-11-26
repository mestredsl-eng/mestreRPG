import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// config.ts fica a 2 níveis da raiz tanto em src/ (dev/tsx) quanto em
// dist/ (build): servidor/src|dist → servidor → raiz do repositório.
const RAIZ = resolve(__dirname, "..", "..");
const ARQUIVO_CONFIG = resolve(RAIZ, "configuracao", "servidor.json");

interface ConfigServidor {
  host: string;
  porta: number;
  sitePorta: number;
  caminhos: { banco: string; arquivos: string; backups: string };
  arquivos: { tamanhoMaxMb: number; formatosExtras: string[] };
  acesso: { dominioPublico: string; proxyHops: number; https: boolean };
}

const padrao: ConfigServidor = {
  host: "0.0.0.0",
  porta: Number(process.env.MESTRE_PORTA) || 3001,
  sitePorta: 5173,
  caminhos: { banco: "banco/mestre-rpg.db", arquivos: "arquivos/campanhas", backups: "backups" },
  arquivos: { tamanhoMaxMb: 25, formatosExtras: [] },
  acesso: { dominioPublico: "", proxyHops: 0, https: false },
};

function carregar(): ConfigServidor {
  if (!existsSync(ARQUIVO_CONFIG)) return padrao;
  try {
    const json = JSON.parse(readFileSync(ARQUIVO_CONFIG, "utf-8")) as Partial<ConfigServidor>;
    return {
      host: json.host ?? padrao.host,
      // Prioridade efetiva histórica: MESTRE_PORTA (env) > servidor.json > 3001.
      // O env precisa vencer o JSON — é o contrato usado por todos os
      // harness/testes e por quem sobe instâncias em portas alternativas.
      porta: Number(process.env.MESTRE_PORTA) || json.porta || padrao.porta,
      sitePorta: json.sitePorta ?? padrao.sitePorta,
      caminhos: { ...padrao.caminhos, ...(json.caminhos ?? {}) },
      arquivos: { ...padrao.arquivos, ...(json.arquivos ?? {}) },
      acesso: { ...padrao.acesso, ...(json.acesso ?? {}) },
    };
  } catch {
    console.warn("[config] configuracao/servidor.json inválido — usando padrões.");
    return padrao;
  }
}

export const config = carregar();
export const RAIZ_PROJETO = RAIZ;
