#!/usr/bin/env node
// Testes isolados — trust proxy / proxyHops (padrão seguro).
// Sobe servidores REAIS com banco SQLite temporário (MESTRE_BANCO,
// MESTRE_ARQUIVOS, MESTRE_BACKUPS, MESTRE_PORTA) — nunca toca
// banco/mestre-rpg.db do usuário nem IPs fixos de rede doméstica.
//
// Cobre:
//  - instalação nova: proxyHops padrão 0 → trust proxy DESLIGADO;
//  - X-Forwarded-For de cliente direto é ignorado (IP efetivo e rate
//    limit de login não podem ser falsificados por rotação de XFF);
//  - X-Forwarded-Proto: https de cliente direto NÃO emite cookie Secure;
//  - proxyHops: 0 explícito continua válido; valores inválidos → 400;
//  - proxyHops explícito (painel admin + reinício) volta a honrar
//    X-Forwarded-* e emitir cookie Secure;
//  - configuração persistida antes do boot (server_settings) é preservada.
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, abrirDb,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const RAIZ = dirTeste("proxy-acesso");
const dbEm = (r) => join(r, "banco", "mestre-rpg.db");

async function subir(raiz) {
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  const proc = subirServidor(porta, {
    banco: dbEm(raiz),
    arquivos: join(raiz, "arquivos", "campanhas"),
    backups: join(raiz, "backups"),
  });
  await esperarSaudavel(base, proc);
  return { proc, base };
}

async function login(base, username, password, headers = {}) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username, password }),
  });
  return { status: r.status, setCookie: r.headers.get("set-cookie") ?? "" };
}

/** Cria o admin inicial via API real e devolve cookie de sessão + id. */
async function criarAdmin(base, banco) {
  const setup = await req(base, "POST", "/auth/setup", {
    body: { username: "admin_proxy", password: "senha-forte-123", displayName: "Admin" },
  });
  if (setup.status !== 201) throw new Error("setup falhou: " + JSON.stringify(setup.json));
  const db = abrirDb(banco);
  let id;
  try { id = db.prepare("select id from users where username='admin_proxy'").get().id; }
  finally { db.close(); }
  return sessao(banco, id);
}

const ipGravado = (banco, username) => {
  const db = abrirDb(banco);
  try {
    return db.prepare(
      "select s.ip from auth_sessions s join users u on u.id=s.user_id where u.username=? order by s.created_at desc limit 1"
    ).get(username)?.ip ?? null;
  } finally { db.close(); }
};

let srv = null;
try {
  sec("Instalação nova — proxyHops padrão 0 (acesso direto)");
  const r1 = join(RAIZ, "padrao");
  await prepararBanco(dbEm(r1));
  srv = await subir(r1);
  const cookieAdmin = await criarAdmin(srv.base, dbEm(r1));

  const cfg = await req(srv.base, "GET", "/admin/servidor/config", { cookie: cookieAdmin });
  t("proxyHops padrão é 0", cfg.json?.acesso?.proxyHops === 0, JSON.stringify(cfg.json?.acesso));

  // cliente direto forja X-Forwarded-For e X-Forwarded-Proto
  const lg1 = await login(srv.base, "admin_proxy", "senha-forte-123", {
    "x-forwarded-for": "203.0.113.77",
    "x-forwarded-proto": "https",
  });
  t("login direto com XFF+XFP forjados → 200", lg1.status === 200, String(lg1.status));
  t("cookie SEM Secure (XFP ignorado)", !/;\s*Secure/i.test(lg1.setCookie), lg1.setCookie.slice(0, 100));
  t("cookie mantém HttpOnly+SameSite", /HttpOnly/i.test(lg1.setCookie) && /SameSite=Lax/i.test(lg1.setCookie));
  const ip1 = ipGravado(dbEm(r1), "admin_proxy");
  t("IP efetivo ignora X-Forwarded-For", !!ip1 && !ip1.includes("203.0.113.77") && ip1.includes("127.0.0.1"), String(ip1));

  // rotação de XFF não contorna o limite de login por IP (10/5min; 1 já usada acima)
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const r = await login(srv.base, "vitima_rl", "errada-123", {
      "x-forwarded-for": `198.51.100.${i + 1}`,
    });
    statuses.push(r.status);
  }
  t("rotação de XFF não evita 429 no limite por IP", statuses.includes(429) && statuses.filter((s) => s === 401).length <= 10,
    statuses.join(","));

  // proxyHops: 0 explícito permanece válido
  const putZero = await req(srv.base, "PUT", "/admin/servidor/config", {
    cookie: cookieAdmin, body: { acesso: { proxyHops: 0 } },
  });
  t("proxyHops: 0 explícito aceito", putZero.status === 200, String(putZero.status));

  // valores inválidos continuam rejeitados
  for (const [i, v] of [-1, 11, 1.5, "2"].entries()) {
    const r = await req(srv.base, "PUT", "/admin/servidor/config", {
      cookie: cookieAdmin, body: { acesso: { proxyHops: v } },
    });
    t(`proxyHops inválido rejeitado (${JSON.stringify(v)})`, r.status === 400, String(r.status));
  }
  const cfgDepois = await req(srv.base, "GET", "/admin/servidor/config", { cookie: cookieAdmin });
  t("config de acesso preservada após rejeições", cfgDepois.json?.acesso?.proxyHops === 0, JSON.stringify(cfgDepois.json?.acesso));

  sec("proxyHops explícito = 1 via painel + reinício");
  const put = await req(srv.base, "PUT", "/admin/servidor/config", {
    cookie: cookieAdmin,
    body: { acesso: { dominioPublico: "rpg.teste.local", proxyHops: 1, https: true } },
  });
  t("config de proxy salva", put.status === 200, String(put.status));
  await encerrarServidor(srv.proc);
  srv = await subir(r1); // reinício — trust proxy só muda no boot

  const cfg2 = await req(srv.base, "GET", "/admin/servidor/config", { cookie: cookieAdmin });
  t("configuração explícita preservada após restart", cfg2.json?.acesso?.proxyHops === 1
    && cfg2.json?.acesso?.dominioPublico === "rpg.teste.local", JSON.stringify(cfg2.json?.acesso));

  const lg2 = await login(srv.base, "admin_proxy", "senha-forte-123", {
    "x-forwarded-for": "198.51.100.23",
    "x-forwarded-proto": "https",
  });
  t("login via proxy HTTPS → cookie Secure", lg2.status === 200 && /;\s*Secure/i.test(lg2.setCookie),
    `${lg2.status} ${lg2.setCookie.slice(0, 100)}`);
  const ip2 = ipGravado(dbEm(r1), "admin_proxy");
  t("X-Forwarded-For honrado com proxy configurado", !!ip2 && ip2.includes("198.51.100.23"), String(ip2));

  await encerrarServidor(srv.proc);

  sec("Configuração persistida antes do boot é respeitada");
  const r3 = join(RAIZ, "semeado");
  await prepararBanco(dbEm(r3));
  {
    const db = new Database(dbEm(r3));
    db.prepare("insert into server_settings (key,value,updated_at) values ('acesso',?,?)")
      .run(JSON.stringify({ dominioPublico: "rpg.semeado.local", proxyHops: 2, https: true }), Date.now());
    db.close();
  }
  srv = await subir(r3);
  const cookie3 = await criarAdmin(srv.base, dbEm(r3));
  const cfg3 = await req(srv.base, "GET", "/admin/servidor/config", { cookie: cookie3 });
  t("server_settings lido no boot", cfg3.json?.acesso?.proxyHops === 2
    && cfg3.json?.acesso?.dominioPublico === "rpg.semeado.local", JSON.stringify(cfg3.json?.acesso));
  const lg3 = await login(srv.base, "admin_proxy", "senha-forte-123", { "x-forwarded-proto": "https" });
  t("proxy semeado emite cookie Secure", lg3.status === 200 && /;\s*Secure/i.test(lg3.setCookie),
    `${lg3.status} ${lg3.setCookie.slice(0, 100)}`);
  await encerrarServidor(srv.proc);
} finally {
  await encerrarServidor(srv?.proc);
  limparDir(RAIZ);
  console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
  process.exit(fail ? 1 : 0);
}
