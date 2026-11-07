import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/** Hash de senha com scrypt (nativo do Node, sem dependências). */
export async function hashSenha(senha: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(senha, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

export async function verificarSenha(senha: string, armazenado: string): Promise<boolean> {
  const [algo, salt, hashHex] = armazenado.split("$");
  if (algo !== "scrypt" || !salt || !hashHex) return false;
  const esperado = Buffer.from(hashHex, "hex");
  const calculado = (await scryptAsync(senha, salt, KEY_LENGTH)) as Buffer;
  return esperado.length === calculado.length && timingSafeEqual(esperado, calculado);
}

export function gerarToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  // SHA-256 simples para indexar sessões sem guardar o token em claro.
  return createHash("sha256").update(token).digest("hex");
}
