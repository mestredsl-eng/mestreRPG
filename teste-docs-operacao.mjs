#!/usr/bin/env node
// Verificação do GUIA-OPERACAO.md em ambiente temporário isolado:
// migrate → sobe servidor → cria dados → backup → altera dado →
// restauração pendente → aplicar-restauracao → restart → dados íntegros.
// Nunca toca banco/mestre-rpg.db real do usuário.
import { spawn } from "child_process";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import {
  req, dirTeste, portaLivre, esperarSaudavel, encerrarServidor, limparDir, criarCenario,
} from "./teste-base.mjs";

const DIR = dirTeste("docs-operacao");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const CFG = join(DIR, "configuracao");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;
const t = (d, ok, det = "") => { ok ? (console.log(`  ok ${d}`), pass++) : (console.log(`  FALHOU ${d} ${det}`), fail++); };

const envIsolado = {
  ...process.env,
  MESTRE_HOME: DIR,
  MESTRE_BANCO: BANCO,
  MESTRE_ARQUIVOS: ARQ,
  MESTRE_BACKUPS: BKS,
  MESTRE_PORTA: String(PORTA),
};

function rodar(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: process.cwd(), env: envIsolado, stdio: "pipe", shell: process.platform === "win32" });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (c) => res({ code: c, out }));
  });
}

try {
  for (const d of [join(DIR, "banco"), ARQ, BKS, CFG]) mkdirSync(d, { recursive: true });

  // 1) npm run db:migrate (documentado)
  const mig = await rodar("npm", ["run", "db:migrate", "-w", "servidor"]);
  t("db:migrate exit 0", mig.code === 0, mig.out.slice(-300));
  t("banco criado", existsSync(BANCO));

  // 2) sobe servidor (npm start -w servidor = node dist/index.js)
  proc = spawn("node", ["servidor/dist/index.js"], { env: envIsolado, stdio: "pipe" });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const health = await req(BASE, "GET", "/health");
  t("health ok", health.status === 200, `status=${health.status}`);

  // 3) cria dados reais via API
  const c = await criarCenario(BASE, BANCO);
  t("cenário criado (admin+campanha+ficha)", !!c.campId && !!c.personagemMestre);

  // 3b) aponta a pasta de backups para o diretório isolado (config do painel admin)
  const cfgBk = await req(BASE, "PUT", "/admin/servidor/config", {
    cookie: c.cookieMestre, body: { backup: { pasta: BKS } },
  });
  t("pasta de backups configurada", cfgBk.status === 200, `status=${cfgBk.status} ${JSON.stringify(cfgBk.json).slice(0, 120)}`);

  // 4) backup manual via API admin
  const bk = await req(BASE, "POST", "/admin/servidor/backups", { cookie: c.cookieMestre, body: {} });
  t("backup criado", bk.status === 200 || bk.status === 201, JSON.stringify(bk.json).slice(0, 200));
  const lista = await req(BASE, "GET", "/admin/servidor/backups", { cookie: c.cookieMestre });
  const backupId = lista.json?.backups?.[0]?.id;
  t("backup listado", !!backupId, JSON.stringify(lista.json).slice(0, 200));

  // 5) altera dado para provar que a restauração volta atrás
  const renomear = await req(BASE, "PATCH", `/campaigns/${c.campId}`, {
    cookie: c.cookieMestre, body: { name: "Nome Alterado Pos-Backup" },
  });
  t("campanha renomeada", renomear.status === 200, `status=${renomear.status}`);

  // 6) prepara restauração (documentado: confirmação RESTAURAR)
  const rest = await req(BASE, "POST", `/admin/servidor/backups/${backupId}/restaurar`, {
    cookie: c.cookieMestre, body: { confirmacao: "RESTAURAR", modo: "preparar" },
  });
  t("restauração preparada", rest.status === 200, JSON.stringify(rest.json).slice(0, 200));

  // 7) encerra e aplica restauração (documentado: node dist/db/aplicar-restauracao.js com servidor parado)
  await encerrarServidor(proc);
  proc = null;
  const apl = await rodar("node", ["servidor/dist/db/aplicar-restauracao.js"]);
  t("aplicar-restauracao exit 0", apl.code === 0, apl.out.slice(-300));

  // 8) sobe de novo e confere integridade
  proc = spawn("node", ["servidor/dist/index.js"], { env: envIsolado, stdio: "pipe" });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const camp = await req(BASE, "GET", `/campaigns/${c.campId}`, { cookie: c.cookieMestre });
  const nome = camp.json?.campanha?.name ?? camp.json?.name;
  t("nome original restaurado", nome === "Campanha Teste", `nome=${nome}`);
  const pers = await req(BASE, "GET", `/campaigns/${c.campId}/characters`, { cookie: c.cookieMestre });
  t("personagem preservado", (pers.json?.personagens ?? []).some((p) => p.id === c.personagemMestre));
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
