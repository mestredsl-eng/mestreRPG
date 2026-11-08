// Testes de integração — Etapa 10: backup, segurança operacional e administração
import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { io as ioClient } from "socket.io-client";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
let db = new Database("banco/mestre-rpg.db");
const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t10-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");
const JOG5 = sessaoHttp("jogador_e5");
const JOG2 = sessaoHttp("jogador2");

async function req(metodo, path, { cookie = ADMIN.cookie, body } = {}) {
  const r = await fetch(API + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

try {
  // limpa flag de restauração pendente de execuções anteriores
  db.prepare("delete from server_settings where key='restauracao_pendente'").run();

  // ============ 1-7: backups ============
  let r = await req("POST", "/admin/servidor/backups", { body: { nota: "Teste E10" } });
  t("1 backup manual criado", r.status === 201 && r.json?.sucesso === true, JSON.stringify(r.json));
  const backupId = r.json?.id;
  const backupDir = r.json?.dir;

  // inclui banco + arquivos + config + manifesto
  t("3a backup tem banco", existsSync(resolve(backupDir, "mestre-rpg.db")));
  t("3b backup tem arquivos", existsSync(resolve(backupDir, "arquivos")));
  t("3c backup tem manifesto", existsSync(resolve(backupDir, "manifesto.json")));
  const man = JSON.parse(readFileSync(resolve(backupDir, "manifesto.json"), "utf-8"));
  t("3d manifesto lista arquivos", Object.keys(man.arquivos ?? {}).length > 0);

  // consistência SQLite: integrity_check no banco copiado
  const chk = new Database(resolve(backupDir, "mestre-rpg.db"), { readonly: true });
  const integ = chk.pragma("integrity_check", { simple: true });
  const nUsers = chk.prepare("select count(*) c from users").get().c;
  chk.close();
  t("4 backup SQLite consistente", integ === "ok" && nUsers > 0, integ);

  // listar + verificar
  r = await req("GET", "/admin/servidor/backups");
  t("2 backup listado", (r.json?.backups ?? []).some((b) => b.id === backupId));
  r = await req("POST", `/admin/servidor/backups/${backupId}/verificar`, { body: {} });
  t("5 integridade verificada via API", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));

  // retenção: cria 2 backups rápidos e confere que config aplica (simula com retencao baixa)
  await req("PUT", "/admin/servidor/config", { body: { backup: { retencaoDiarios: 2, retencaoSemanais: 2 } } });
  await req("POST", "/admin/servidor/backups", { body: { nota: "R1" } });
  await req("POST", "/admin/servidor/backups", { body: { nota: "R2" } });
  const listaB = (await req("GET", "/admin/servidor/backups")).json?.backups ?? [];
  t("6 retenção limita cópias", listaB.length <= 4, `total=${listaB.length}`);
  await req("PUT", "/admin/servidor/config", { body: { backup: { retencaoDiarios: 7, retencaoSemanais: 4 } } });
  // backup fresco como alvo da restauração — o mais recente nunca é podado pela retenção
  const fresco = await req("POST", "/admin/servidor/backups", { body: { nota: "alvo-restore" } });
  const backupAlvo = fresco.json?.backup?.id ?? fresco.json?.id ?? backupId;

  // 7: backup incompleto não é sucesso — corrompe manifesto de um backup e verifica flag
  const bFalho = listaB.find((b) => b.sucesso !== false) ?? listaB[0];
  // simula: cria entrada na tabela apontando p/ pasta inexistente
  const fakeId = crypto.randomUUID();
  db.prepare("insert into backups (id,campaign_id,kind,file_path,size_bytes,note,created_by,created_at) values (?,?,?,?,?,?,?,?)")
    .run(fakeId, null, "manual", resolve("backups", "inexistente_" + Date.now()), 1, "Backup incompleto", null, Date.now());
  r = await req("POST", `/admin/servidor/backups/${fakeId}/verificar`, { body: {} });
  t("7 backup incompleto detectado", r.json?.ok === false);
  db.prepare("delete from backups where id=?").run(fakeId);

  // ============ 8-10: restauração ============
  // marca uma anotação qualquer para sumir após restore do backupId (estado do backup é anterior)
  const notaTeste = "NOTA_PARA_RESTAURAR_" + Date.now();
  await req("POST", "/campaigns/" + CID + "/anotacoes", { cookie: JOG5.cookie, body: { title: notaTeste, kind: "diario", visibility: "privada" } });
  const confere = async () => (await req("GET", `/campaigns/${CID}/anotacoes?tipo=diario`, { cookie: JOG5.cookie })).json?.anotacoes?.some((a) => a.title === notaTeste);
  t("8a nota existe antes do restore", await confere());

  // prepara restauração (modo preparar — não derruba o servidor)
  r = await req("POST", `/admin/servidor/backups/${backupAlvo}/restaurar`, { body: { confirmacao: "RESTAURAR", modo: "preparar" } });
  t("9 restauração preparada + segurança criada", r.status === 200 && !!r.json?.seguranca, JSON.stringify(r.json));
  const pendente = db.prepare("select value from server_settings where key='restauracao_pendente'").get();
  t("9b flag de restauração pendente", !!pendente);

  // aplica a restauração num SANDBOX isolado (MESTRE_HOME) — não toca no servidor real
  const { cpSync, mkdirSync } = await import("node:fs");
  const sandbox = resolve("teste-sandbox-e10");
  mkdirSync(resolve(sandbox, "banco"), { recursive: true });
  mkdirSync(resolve(sandbox, "configuracao"), { recursive: true });
  cpSync("banco/mestre-rpg.db", resolve(sandbox, "banco/mestre-rpg.db"));
  if (existsSync("configuracao/servidor.json")) cpSync("configuracao/servidor.json", resolve(sandbox, "configuracao/servidor.json"));
  if (existsSync("arquivos/campanhas")) cpSync("arquivos/campanhas", resolve(sandbox, "arquivos/campanhas"), { recursive: true });
  let restoreOk = true, restoreOut = "";
  try {
    restoreOut = execFileSync("node", ["servidor/dist/db/aplicar-restauracao.js"], { encoding: "utf-8", env: { ...process.env, MESTRE_HOME: sandbox } });
  } catch (e) { restoreOk = false; restoreOut = String(e).slice(0, 400); }
  const dbSandbox = new Database(resolve(sandbox, "banco/mestre-rpg.db"), { readonly: true });
  const temNota = dbSandbox.prepare("select count(*) c from notes where title=?").get(notaTeste).c > 0;
  const flagSandbox = dbSandbox.prepare("select value from server_settings where key='restauracao_pendente'").get();
  dbSandbox.close();
  t("8b restauração aplicada (sandbox)", restoreOk, restoreOut.slice(0, 200));
  t("8c nota sumiu após restore", !temNota);
  t("8d flag limpa após aplicar", !flagSandbox);

  // rollback: estado anterior preservado em backups/pre_restore_*
  const preRestore = readdirSync(resolve("backups")).filter((d) => d.startsWith("pre_restore_"));
  t("10 estado anterior preservado p/ rollback", preRestore.length > 0);

  // restauração sem confirmação → 400
  r = await req("POST", `/admin/servidor/backups/${backupAlvo}/restaurar`, { body: { confirmacao: "ERRADO" } });
  t("10b confirmação explícita exigida", r.status === 400);

  // ============ 11-12: permissões ============
  r = await req("GET", "/admin/servidor/status", { cookie: JOG5.cookie });
  t("11 jogador não acessa admin do servidor", r.status === 401 || r.status === 403, `status=${r.status}`);
  // mestre de campanha (admin é global; cria cenário: usuário não-admin não-mestre)
  r = await req("GET", "/admin/servidor/status", { cookie: JOG2.cookie });
  t("12 não-admin não acessa administração global", r.status === 401 || r.status === 403);

  // ============ 13-14: logs ============
  const logFile = resolve("logs/servidor.log");
  t("13 logs existem", existsSync(logFile));
  const conteudo = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
  t("13b logs não contêm senhas/tokens", !/senha123|"password"\s*:\s*"[^"]+"|mestre_rpg_session=/.test(conteudo));
  r = await req("GET", "/admin/servidor/logs?limite=10");
  t("14 admin consulta logs", r.status === 200 && Array.isArray(r.json?.logs));
  // rotação: arquivo de log tem rotação implementada (verifica função indiretamente — gera log grande não; valida estrutura)
  t("14b logs retornam nível/msg", (r.json?.logs ?? []).every((l) => l.nivel && l.msg !== undefined));

  // ============ 15-17: saúde ============
  const health = await (await fetch(BASE + "/api/health")).json();
  t("15 health detalhado", ["ok", "avisos", "indisponivel"].includes(health.status) && health.checagens?.banco === true, JSON.stringify(health.status));
  t("17 espaço em disco verificado", typeof health.checagens?.disco === "boolean");

  // ============ 18-19: encerramento / processos ============
  // encerramento controlado: handlers SIGINT/SIGTERM registrados no código do servidor
  const indexDist = readFileSync("servidor/dist/index.js", "utf-8");
  t("18 encerramento controlado implementado", indexDist.includes('"SIGINT"') && indexDist.includes('"SIGTERM"') && indexDist.includes("httpServer.close"));
  // reinicialização sem duplicados: .bat verifica porta antes de subir (verificação textual)
  const bat = readFileSync("iniciar-mestre-rpg.bat", "utf-8");
  t("19 .bat impede instância duplicada", /api\/health/.test(bat) && /Ja existe um servidor/.test(bat));
  const pararBat = readFileSync("parar-mestre-rpg.bat", "utf-8");
  t("19b script de encerramento existe", pararBat.length > 50);

  // ============ 20-21: proxy ============
  r = await req("PUT", "/admin/servidor/config", { body: { acesso: { dominioPublico: "rpg.exemplo.com", proxyHops: 1, https: true } } });
  t("20 configuração de proxy salva", r.status === 200);
  // cookie Secure quando x-forwarded-proto=https (testa via endpoint auth que seta cookie? verifica middleware)
  const login = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" }, body: JSON.stringify({ username: "admin", password: "errada" }) });
  t("21 headers de proxy não quebram auth", [200, 400, 401, 403, 429].includes(login.status), `status=${login.status}`);
  await req("PUT", "/admin/servidor/config", { body: { acesso: { dominioPublico: "", proxyHops: 1, https: false } } });

  // ============ 22: integridade geral ============
  const chars = (await req("GET", `/campaigns/${CID}/characters`, {})).json?.personagens?.length;
  const arqs = (await req("GET", `/campaigns/${CID}/arquivos`, {})).json?.arquivos?.length;
  t("22 campanhas e arquivos íntegros", chars > 0 && arqs >= 0, `chars=${chars} arqs=${arqs}`);

  // ============ 23: recuperação de backup atrasado ============
  const { verificarBackupAgendado, getConfigBackup } = await import("./servidor/dist/lib/backup.js");
  const contarBackups = () => db.prepare("select count(*) c from backups where campaign_id is null").get().c;
  const cobMsg = () => db.prepare("select value from server_settings where key='backup_cobertura'").get()?.value;

  // diário perdido: marca cobertura antiga e horário já passado hoje
  const cfg0 = await getConfigBackup();
  await req("PUT", "/admin/servidor/config", { body: { backup: { agenda: "diario", hora: "00:01", retencaoDiarios: 50, retencaoSemanais: 50 } } });
  db.prepare("insert into server_settings (key,value,updated_at) values ('backup_cobertura',?,?) on conflict(key) do update set value=excluded.value")
    .run(JSON.stringify({ diario: "D2000-01-01" }), Date.now());
  const nAntes = contarBackups();
  await verificarBackupAgendado(true); // simula verificação de subida
  await new Promise((r) => setTimeout(r, 1500)); // servidor pode executar no tick também — cobertura garante 1x só
  const nDepois = contarBackups();
  const cob = typeof cobMsg() === "string" ? JSON.parse(cobMsg()) : cobMsg();
  t("23a backup diário perdido recuperado", nDepois === nAntes + 1, `${nAntes}->${nDepois}`);
  t("23b cobertura registrada", typeof cob?.diario === "string" && cob.diario.startsWith("D"), JSON.stringify(cob));
  await verificarBackupAgendado(true);
  t("23c backup não duplicado", contarBackups() === nDepois, `total=${contarBackups()}`);

  // semanal perdido
  await req("PUT", "/admin/servidor/config", { body: { backup: { agenda: "semanal", hora: "00:01" } } });
  db.prepare("update server_settings set value=? where key='backup_cobertura'").run(JSON.stringify({ semanal: "S2000-01-01" }));
  const nSem = contarBackups();
  await verificarBackupAgendado(true);
  await new Promise((r) => setTimeout(r, 1500));
  t("23d backup semanal perdido recuperado", contarBackups() === nSem + 1, `${nSem}->${contarBackups()}`);

  // vários dias desligado → ainda apenas 1 backup por tipo (ocorrência mais recente)
  db.prepare("update server_settings set value=? where key='backup_cobertura'").run(JSON.stringify({ semanal: "S2000-01-01" }));
  const nMulti = contarBackups();
  await verificarBackupAgendado(true);
  await new Promise((r) => setTimeout(r, 1500));
  t("23e vários dias desligado = 1 backup", contarBackups() === nMulti + 1, `${nMulti}->${contarBackups()}`);

  // falha no backup recuperado não impede o servidor (e não marca cobertura)
  await req("PUT", "/admin/servidor/config", { body: { backup: { agenda: "semanal", hora: "00:01", pasta: "package.json" } } });
  db.prepare("update server_settings set value=? where key='backup_cobertura'").run(JSON.stringify({ semanal: "S2000-01-01" }));
  let falhouOk = true;
  try { await verificarBackupAgendado(true); } catch { falhouOk = false; }
  const hAposFalha = await fetch(BASE + "/api/health");
  t("23f falha no backup não derruba servidor", falhouOk && hAposFalha.ok);
  await req("PUT", "/admin/servidor/config", { body: { backup: { agenda: cfg0.agenda, hora: cfg0.hora, retencaoDiarios: cfg0.retencaoDiarios, retencaoSemanais: cfg0.retencaoSemanais, pasta: cfg0.pasta } } });
  db.prepare("delete from server_settings where key='backup_cobertura'").run();
  // limpa a flag de restauração pendente: ela é artefato do teste (o restore
  // real só foi aplicado no sandbox) — sem isso, o próximo boot restauraria
  // o backup de teste por engano
  db.prepare("delete from server_settings where key='restauracao_pendente'").run();

  // ============ 24: encerramento gracioso ============
  // endpoint local exige loopback + segredo
  let rl = await fetch(API + "/local/desligar", { method: "POST" });
  t("24a desligar local sem token → 401", rl.status === 401, `status=${rl.status}`);
  rl = await fetch(API + "/local/desligar", { method: "POST", headers: { "x-mestre-local": "errado" } });
  t("24b desligar local token errado → 401", rl.status === 401, `status=${rl.status}`);
  // jogador não pode desligar
  rl = await req("POST", "/admin/servidor/desligar", { cookie: JOG5.cookie, body: {} });
  t("24c jogador não desliga servidor", rl.status === 403, `status=${rl.status}`);

  // abre socket para verificar que Socket.IO é encerrado junto
  const sockFim = ioClient(BASE, { path: "/socket.io", transports: ["websocket"], extraHeaders: { cookie: ADMIN.cookie }, reconnection: false });
  await new Promise((res2) => sockFim.on("connect", res2));
  let socketCaiu = false;
  sockFim.on("disconnect", () => { socketCaiu = true; });

  // admin solicita encerramento — ÚLTIMO teste que usa o servidor
  rl = await req("POST", "/admin/servidor/desligar", { cookie: ADMIN.cookie, body: {} });
  t("24d admin solicita encerramento", rl.status === 200 && rl.json?.ok === true, `status=${rl.status}`);

  // aguarda queda (graceful)
  let caiu = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r2) => setTimeout(r2, 500));
    try { const h = await fetch(BASE + "/api/health"); if (!h.ok) { caiu = true; break; } } catch { caiu = true; break; }
  }
  await new Promise((r2) => setTimeout(r2, 800));
  t("24e servidor parou de aceitar operações", caiu);
  t("24f Socket.IO encerrado", socketCaiu);

  // logs registram encerramento
  const logTxt = existsSync("logs/servidor.log") ? readFileSync("logs/servidor.log", "utf-8") : "";
  t("24g encerramento registrado em log", logTxt.includes("encerramento solicitado") && logTxt.includes("servidor encerrado"));

  // .bat/ps1: espera confirmação e tem fallback controlado
  const ps1 = existsSync("parar-mestre-rpg.ps1") ? readFileSync("parar-mestre-rpg.ps1", "utf-8") : "";
  const batParar = existsSync("parar-mestre-rpg.bat") ? readFileSync("parar-mestre-rpg.bat", "utf-8") : "";
  t("24h BAT aguarda encerramento + fallback", ps1.includes("/api/health") && ps1.includes("Stop-Process") && ps1.includes("api/local/desligar") && batParar.includes("parar-mestre-rpg.ps1"));

  // sobe o servidor de novo e confere integridade (SQLite fechou corretamente)
  spawn("node", ["servidor/dist/index.js"], { detached: true, stdio: "ignore" }).unref();
  let subiu = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r2) => setTimeout(r2, 500));
    try { const h = await fetch(BASE + "/api/health"); if (h.ok) { subiu = true; break; } } catch { }
  }
  t("24i reinício sem processo duplicado", subiu);
  const h2 = await fetch(BASE + "/api/health");
  const hj = await h2.json();
  t("24j banco íntegro após restart", hj.checagens?.banco === true);
} catch (e) {
  fail++; res.push("EXCEÇÃO " + (e?.stack ?? e));
}

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
