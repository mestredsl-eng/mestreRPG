// Item 2 da ordem do Dono (#318) — E2E do procedimento OFICIAL de boot
// sobre instalação legada 1.0.8, em fixture 100% descartável:
//
//   árvore-fonte da candidata via `git archive HEAD` (sem .git) +
//   banco REAL no schema 1.0.8 (journal truncado nas 34 migrations de
//   main@7e17c9b — arquivos idênticos, diff vazio vs. candidata) +
//   usuário/campanha/personagem → iniciar-mestre-rpg.bat REAL via
//   cmd.exe → adoção assistida → auto-update (sem .git ⇒ skip
//   conservador) → builds → migrate → servidor → /api/health + login +
//   dados preservados → taskkill (interrupção) → novo BAT → health de
//   novo (retomada).
//
// Nunca toca a instalação real: fixture em temp, state/backups/arquivos
// isolados por env, node_modules por junction (npm ci é pulado).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { hashSenha } from "./servidor/dist/lib/password.js";
import { lerReciboInstalacao } from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.error("  FALHOU", n, extra); }
};
const ROOT = dirname(fileURLToPath(import.meta.url));
const ULTIMO_IDX_108 = 33; // main@7e17c9b: 34 migrations, idx 0..33
const TEMP = mkdtempSync(join(tmpdir(), "mrpg-adocao-e2e-"));
const FIX = join(TEMP, "instalacao-legada");
const STATE = join(TEMP, "state");
let batLog = "";

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120000, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}: ${(r.stderr ?? r.stdout ?? "").slice(0, 300)}`);
  return (r.stdout ?? "").trim();
};
const portaLivre = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
async function esperarHealth(base, timeoutMs = 480000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    try {
      const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return await r.json().catch(() => ({}));
    } catch { }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout aguardando /api/health em ${base}`);
}
function matarArvore(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((res) => {
    spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { encoding: "utf8" });
    proc.once("exit", res);
    setTimeout(res, 10000);
  });
}

let batProc = null;
try {
  if (process.platform !== "win32") {
    console.log("E2E do BAT exige Windows (cmd.exe + taskkill).");
    process.exitCode = 2;
  } else {
    console.log("== E2E oficial: BAT real sobre instalação 1.0.8 em fixture descartável ==");

    // Porta sorteada ANTES da extração: MESTRE_PORTA e
    // configuracao/servidor.json recebem a mesma porta efetiva — sem
    // isso o fixture colidiria com um servidor dev na 3001.
    const PORTA = await portaLivre();
    const BASE = `http://127.0.0.1:${PORTA}`;

    // 1. Árvore-fonte da candidata via git archive (somente arquivos
    //    rastreados do HEAD testado — sem .git, node_modules, dados).
    const tarPath = join(TEMP, "fonte.tar");
    sh("git", ["-C", ROOT, "archive", "--format=tar", "-o", tarPath, "HEAD"]);
    mkdirSync(FIX, { recursive: true });
    sh("tar", ["--force-local", "-xf", tarPath, "-C", FIX]);
    t("árvore da candidata extraída", existsSync(join(FIX, "iniciar-mestre-rpg.bat"))
      && existsSync(join(FIX, "scripts", "adotar-legado.mjs"))
      && !existsSync(join(FIX, ".git")));

    // Porta efetiva do fixture: MESTRE_PORTA (env) e json.porta recebem
    // o MESMO valor — a precedência env > json > 3001 de config.ts e
    // boot-lock.mjs é irrelevante aqui; o objetivo é só desviar da 3001.
    {
      const cfgPath = join(FIX, "configuracao", "servidor.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      cfg.porta = PORTA;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }

    // 2. Banco legado REAL: subconjunto de migrations idêntico ao de
    //    main@7e17c9b (entries idx<=33; diff dos arquivos vs. 1.0.8 é
    //    vazio — migrations são append-only) + dados de usuário.
    const journal = JSON.parse(
      readFileSync(join(ROOT, "servidor", "migrations", "meta", "_journal.json"), "utf8"),
    );
    const antigas = journal.entries.filter((e) => e.idx <= ULTIMO_IDX_108);
    const pastaAntigas = join(TEMP, "migrations-108");
    mkdirSync(join(pastaAntigas, "meta"), { recursive: true });
    const MIGRATIONS = join(ROOT, "servidor", "migrations");
    for (const e of antigas) {
      copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(pastaAntigas, `${e.tag}.sql`));
    }
    writeFileSync(join(pastaAntigas, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: antigas }));
    t("subconjunto 1.0.8 montado", antigas.length === 34, String(antigas.length));

    const BANCO = join(FIX, "banco", "mestre-rpg.db");
    mkdirSync(dirname(BANCO), { recursive: true });
    {
      const sqlite = new Database(BANCO);
      sqlite.pragma("journal_mode = WAL");
      await migrate(drizzle(sqlite), { migrationsFolder: pastaAntigas });
      const agora = Date.now();
      const senha = await hashSenha("senha-e2e-123");
      sqlite.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,1,'ativo',?,?)")
        .run("u-e2e", "mestre_e2e", senha, agora, agora);
      sqlite.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
        .run("c-e2e", "Campanha E2E 1.0.8", "andamento", "u-e2e", "{}", agora, agora);
      sqlite.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run("m-e2e", "c-e2e", "u-e2e", "mestre", "{}", "ativo", agora, agora, agora);
      sqlite.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run("ch-e2e", "c-e2e", "m-e2e", "Herói E2E", "{}", "{}", "aprovada", agora, agora);

      // --- Fixture rica (#272): domínios reais de uma instalação 1.0.8 ---
      // Segundo membro/personagem (jogador) para chat e vínculos.
      sqlite.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,0,'ativo',?,?)")
        .run("u-j1", "jogador_e2e", senha, agora, agora);
      sqlite.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run("m-j1", "c-e2e", "u-j1", "jogador", "{}", "ativo", agora, agora, agora);
      // __xp/__sangue viajam dentro de characters.data (ledger reservado).
      const dadosHeroi = JSON.stringify({
        nome: "Herói E2E", nivel: 3,
        __xp: { saldo: 120, ancora: 0, historico: [
          { tipo: "concessao", quantidade: 100, motivo: "sessão 0", em: new Date(agora - 86400000).toISOString(), por: "u-e2e" },
          { tipo: "compra", quantidade: -20, motivo: "perícia", em: new Date(agora - 3600000).toISOString(), por: "u-e2e" },
        ] },
        __sangue: { saldo: 3, usos: {}, historico: [] },
      });
      sqlite.prepare("update characters set data=? where id=?").run(dadosHeroi, "ch-e2e");
      sqlite.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run("ch-j1", "c-e2e", "m-j1", "Aliada J1", JSON.stringify({ nome: "Aliada J1" }), "{}", "aprovada", agora, agora);

      // Inventário + modelo + equipamento vinculado.
      sqlite.prepare("insert into item_templates (id,campaign_id,name,category,description,data,is_active,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run("it-e2e", "c-e2e", "Poção de Cura", "consumivel", "Cura 1d6+1 PV", "{}", 1, agora, agora);
      sqlite.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("inv-e2e-1", "ch-e2e", "Poção de Cura", 3, "do template it-e2e", "consumivel", "mochila", "novo", 0.2, JSON.stringify({ templateId: "it-e2e" }), agora, agora);
      sqlite.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("inv-e2e-2", "ch-e2e", "Corda 20m", 1, null, "utilidade", "mochila", "usado", 1.5, "{}", agora, agora);
      sqlite.prepare("insert into equipment_entries (id,character_id,name,kind,slot,equipped,description,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run("eq-e2e-1", "ch-e2e", "Espada Curta", "arma", "mao_direita", 1, "dano 1d6", "{}", agora, agora);
      sqlite.prepare("insert into equipment_entries (id,character_id,name,kind,slot,equipped,description,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run("eq-e2e-2", "ch-e2e", "Gibão de Couro", "armadura", "torso", 0, "CA 12", "{}", agora, agora);

      // Veículo + contas/transações financeiras.
      sqlite.prepare("insert into vehicles (id,character_id,campaign_id,name,kind,brand,model,year,color,plate,serial_number,condition,value_cents,fuel,capacity,ownership,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("veh-e2e", "ch-e2e", "c-e2e", "Carroça do Bardo", "terrestre", "Genérica", "Carroça", 2020, "marrom", "XYZ-1234", "SN-E2E-001", "boa", 250000, 0.5, 4, "propriedade", "{}", agora, agora);
      sqlite.prepare("insert into financial_accounts (id,character_id,campaign_id,type,name,institution,agency,account_number,holder,currency,balance_cents,credit_limit_cents,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("fin-e2e", "ch-e2e", "c-e2e", "banco", "Conta do Tesouro", "Banco Real", "0001", "12345-6", "Herói E2E", "BRL", 150050, null, "{}", agora, agora);
      sqlite.prepare("insert into money_transactions (id,character_id,campaign_id,kind,amount,currency,account,description,created_by,created_at,account_id,amount_cents,balance_before_cents,balance_after_cents,request_id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("mtx-e2e-1", "ch-e2e", "c-e2e", "saldo_inicial", 1000, "BRL", "banco", "saldo inicial da fixture", "u-e2e", agora, "fin-e2e", 100000, 0, 100000, "req-e2e-1");
      sqlite.prepare("insert into money_transactions (id,character_id,campaign_id,kind,amount,currency,account,description,created_by,created_at,account_id,amount_cents,balance_before_cents,balance_after_cents,request_id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("mtx-e2e-2", "ch-e2e", "c-e2e", "entrada", 500.5, "BRL", "banco", "pagamento da guilda", "u-e2e", agora, "fin-e2e", 50050, 100000, 150050, "req-e2e-2");

      // XP em lote (ledger) + configurações + pasta.
      sqlite.prepare("insert into xp_lotes (id,campaign_id,request_id,payload_hash,motivo,itens,total_personagens,total_xp,created_by,created_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run("xpl-e2e", "c-e2e", "req-xp-e2e", "hash-fixture-e2e", "recompensa da sessão 0", JSON.stringify([{ personagemId: "ch-e2e", xp: 120 }]), 1, 120, "u-e2e", agora);
      sqlite.prepare("insert into server_settings (key,value,updated_at) values (?,?,?)")
        .run("fixture.chave_e2e", "valor-config-e2e", agora);
      sqlite.prepare("insert into server_settings (key,value,updated_at) values (?,?,?)")
        .run("regra.dados_e2e", "{\"narracao\":\"livre\"}", agora);
      sqlite.prepare("insert into folders (id,campaign_id,parent_id,name,allow_player_uploads,created_by,created_at) values (?,?,?,?,?,?,?)")
        .run("fld-e2e", "c-e2e", null, "Mapas", 0, "u-e2e", agora);

      // Mesa: sessão + turno + rolagem + chat OOC/diegético + teste.
      sqlite.prepare("insert into sessions (id,campaign_id,number,name,summary,started_at,status,created_by,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run("ses-e2e", "c-e2e", 1, "Sessão 0 — Tumba dos Ecos", "abertura da campanha", agora - 7200000, "encerrada", "u-e2e", agora - 7200000, agora);
      sqlite.prepare("insert into turns (id,session_id,state,updated_by,updated_at) values (?,?,?, ?,?)")
        .run("trn-e2e", "ses-e2e", "{}", "u-e2e", agora);
      sqlite.prepare("insert into rolls (id,campaign_id,session_id,character_id,user_id,dice,results,reason,visibility,created_at,request_id) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run("rol-e2e", "c-e2e", "ses-e2e", "ch-e2e", "u-e2e",
          JSON.stringify([{ sides: 20, count: 1 }]),
          JSON.stringify({ grupos: [{ lados: 20, resultados: [17] }], total: 17 }),
          "teste de perícia", "publica", agora - 3600000, "req-roll-e2e");
      sqlite.prepare("insert into chat_messages (id,campaign_id,session_id,author_id,kind,content,visibility,created_at,speaker_character_id,speaker_name,speaker_gender) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run("msg-e2e-ooc", "c-e2e", "ses-e2e", "u-j1", "texto", "(OOC) quem tem a chave mestra?", "publica", agora - 3500000, null, null, null);
      sqlite.prepare("insert into chat_messages (id,campaign_id,session_id,author_id,kind,content,visibility,created_at,speaker_character_id,speaker_name,speaker_gender) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run("msg-e2e-ic", "c-e2e", "ses-e2e", "u-j1", "texto", "Eu tenho, colega.", "publica", agora - 3400000, "ch-j1", "Aliada J1", "feminino");
      sqlite.prepare("insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,roll_id,visibility,created_at,updated_at,request_id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("tst-e2e", "c-e2e", "ses-e2e", "ch-e2e", "u-e2e", "pericia", "[]", 1, 20, 15, "sucesso", "rol-e2e", "publica", agora - 3600000, agora - 3600000, "req-tst-e2e");

      // Anexo real em disco + linha files + nota vinculada.
      const ANEXO_DIR = join(FIX, "arquivos", "campanhas", "c-e2e");
      mkdirSync(ANEXO_DIR, { recursive: true });
      const ANEXO_NOME = "anexo-e2e-mapa.txt";
      const ANEXO_CONTEUDO = "MAPA DA TOMBA DOS ECOS — fixture 1.0.8\ncorredor norte -> sala do guardiao\n";
      writeFileSync(join(ANEXO_DIR, ANEXO_NOME), ANEXO_CONTEUDO);
      sqlite.prepare("insert into files (id,campaign_id,folder_path,file_name,mime_type,size_bytes,uploaded_by,visibility,created_at,folder_id,display_name,description,category,status,storage_name,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("fil-e2e", "c-e2e", "/Mapas", "mapa-da-tumba.txt", "text/plain", Buffer.byteLength(ANEXO_CONTEUDO), "u-e2e", "mestre", agora, "fld-e2e", "Mapa da Tumba", "mapa da sessão 0", "mapa", "aprovado", ANEXO_NOME, agora);
      sqlite.prepare("insert into notes (id,campaign_id,owner_id,character_id,category,title,content,visibility,status,created_at,updated_at,kind,important) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("nte-e2e", "c-e2e", "u-e2e", "ch-e2e", "sessao", "Gancho: chave mestra", "A chave mestra abre a sala norte.", "mestre", "concluida", agora - 3000000, agora - 3000000, "diario", 1);
      sqlite.prepare("insert into note_attachments (id,note_id,file_id,created_by,created_at) values (?,?,?,?,?)")
        .run("nat-e2e", "nte-e2e", "fil-e2e", "u-e2e", agora);
      sqlite.close();
    }

    // Baseline determinístico (#272): contagens + campos semânticos +
    // hash do anexo em disco — comparado após o upgrade.
    const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const ANEXO_PATH = join(FIX, "arquivos", "campanhas", "c-e2e", "anexo-e2e-mapa.txt");
    const BASELINE = {};
    {
      const db = new Database(BANCO, { readonly: true });
      const tabelas = ["users", "campaigns", "memberships", "characters", "item_templates",
        "inventory_entries", "equipment_entries", "vehicles", "financial_accounts",
        "money_transactions", "xp_lotes", "folders", "sessions",
        "turns", "rolls", "chat_messages", "tests", "files", "notes", "note_attachments"];
      for (const tb of tabelas) BASELINE["n_" + tb] = db.prepare(`select count(*) c from ${tb}`).get().c;
      // server_settings é chave-valor: o boot pode LEGITIMAMENTE semear
      // chaves novas — a prova é que as chaves da fixture sobrevivem
      // intactas, não que o total de chaves é imutável.
      BASELINE.server_settings = Object.fromEntries(
        db.prepare("select key, value from server_settings order by key").all().map((r) => [r.key, r.value]),
      );
      BASELINE.characters_data = Object.fromEntries(
        db.prepare("select id, data from characters order by id").all().map((r) => [r.id, r.data]),
      );
      BASELINE.contas = db.prepare("select id, balance_cents from financial_accounts order by id").all();
      BASELINE.fk_violations = db.pragma("foreign_key_check").length;
      BASELINE.integrity = db.pragma("integrity_check")[0].integrity_check;
      db.close();
    }
    BASELINE.anexo_sha256 = sha256(ANEXO_PATH);
    BASELINE.anexo_bytes = readFileSync(ANEXO_PATH).length;
    {
      const db = new Database(BANCO, { readonly: true });
      const n = db.prepare("select count(*) c from __drizzle_migrations").get().c;
      db.close();
      t("banco legado com 34 migrations", n === 34, String(n));
    }

    // 3. node_modules por junction — `if not exist node_modules` do BAT
    //    pula npm ci; dependências idênticas às da árvore testada.
    symlinkSync(join(ROOT, "node_modules"), join(FIX, "node_modules"), "junction");
    t("node_modules junction criado", existsSync(join(FIX, "node_modules", "better-sqlite3")));

    const env = {
      ...process.env,
      PATH: dirname(process.execPath) + ";" + (process.env.PATH || ""),
      MESTRE_STATE_DIR: STATE,
      MESTRE_PORTA: String(PORTA),
      MESTRE_BANCO: BANCO,
      MESTRE_BACKUPS: join(FIX, "backups"),
      MESTRE_ARQUIVOS: join(FIX, "arquivos", "campanhas"),
    };

    const dispararBat = (entrada) => {
      batLog = "";
      const proc = spawn("cmd.exe", ["/d", "/c", "iniciar-mestre-rpg.bat"], {
        cwd: FIX, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      proc.stdout.on("data", (d) => { batLog += d; });
      proc.stderr.on("data", (d) => { batLog += d; });
      proc.stdin.write(entrada);
      return proc;
    };

    // 4. PRIMEIRO BOOT do launcher novo sobre instalação 1.0.8.
    console.log("  … primeiro boot do BAT (build + adoção + migrate + start) — pode levar minutos");
    batProc = dispararBat("S\r\nx\r\nx\r\n");
    const health1 = await esperarHealth(BASE);
    t("/api/health OK no primeiro boot", !!health1, JSON.stringify(health1).slice(0, 200));

    const login = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mestre_e2e", password: "senha-e2e-123" }),
    });
    const lj = await login.json().catch(() => ({}));
    t("login do usuário legado funciona", login.ok && !!lj.usuario, `status ${login.status}`);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const camps = await (await fetch(BASE + "/api/campaigns", { headers: { cookie } })).json().catch(() => ({}));
    const lista = camps.campanhas ?? camps.campaigns ?? (Array.isArray(camps) ? camps : []);
    t("campanha legada listada na API", lista.some((c) => c.name === "Campanha E2E 1.0.8"), JSON.stringify(camps).slice(0, 160));

    const envClone = { ...process.env, MESTRE_STATE_DIR: STATE, MESTRE_BANCO: BANCO };
    t("recibo de instalação concluída (adoção)", lerReciboInstalacao(FIX, envClone).status === "ok");
    const backupsDir = join(FIX, "backups");
    const adocaoBackups = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((n) => n.startsWith("pre_adocao_")) : [];
    t("backup pre_adocao criado", adocaoBackups.length === 1, adocaoBackups.join(","));

    // 5. Migrações aplicadas: banco agora no schema completo — a contagem
    //    esperada é derivada do journal (não hardcoded), para não quebrar
    //    a cada migration futura.
    {
      const db = new Database(BANCO, { readonly: true });
      const n = db.prepare("select count(*) c from __drizzle_migrations").get().c;
      const users = db.prepare("select count(*) c from users").get().c;
      const campsDb = db.prepare("select count(*) c from campaigns").get().c;
      const chars = db.prepare("select count(*) c from characters").get().c;
      db.close();
      t("migrations completas aplicadas no boot", n === journal.entries.length, `${n} vs ${journal.entries.length}`);
      t("dados preservados após migrate", users === 2 && campsDb === 1 && chars === 2,
        `users=${users} campaigns=${campsDb} characters=${chars}`);
    }

    // 6. INTERrupção: mata a árvore cmd→npm→node e sobe de novo.
    console.log("  … taskkill da árvore do servidor (interrupção)");
    await matarArvore(batProc);
    batProc = null;
    await new Promise((r) => setTimeout(r, 1500));

    console.log("  … segundo boot do BAT (retomada pós-interrupção)");
    batProc = dispararBat("\r\n");
    const health2 = await esperarHealth(BASE, 240000);
    t("/api/health OK no segundo boot (retomada)", !!health2);
    const login2 = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mestre_e2e", password: "senha-e2e-123" }),
    });
    t("login funciona após retomada", login2.ok, `status ${login2.status}`);

    // 7. Preservação integral da fixture rica (#272): compara o banco
    //    pós-upgrade com o baseline — contagens, dados semânticos das
    //    fichas (__xp/__sangue), saldos, integridade/FK e hash do anexo.
    {
      const db = new Database(BANCO, { readonly: true });
      const diffs = [];
      for (const [k, v] of Object.entries(BASELINE)) {
        if (k.startsWith("n_")) {
          const tb = k.slice(2);
          const agora = db.prepare(`select count(*) c from ${tb}`).get().c;
          if (agora !== v) diffs.push(`${tb}: ${v}→${agora}`);
        }
      }
      t("contagens de todos os domínios preservadas", diffs.length === 0, diffs.join("; "));
      const dataAgora = Object.fromEntries(
        db.prepare("select id, data from characters order by id").all().map((r) => [r.id, r.data]),
      );
      t("characters.data íntegro (__xp/__sangue inclusos)",
        JSON.stringify(dataAgora) === JSON.stringify(BASELINE.characters_data));
      const contasAgora = db.prepare("select id, balance_cents from financial_accounts order by id").all();
      t("saldos financeiros preservados",
        JSON.stringify(contasAgora) === JSON.stringify(BASELINE.contas),
        JSON.stringify(contasAgora));
      const settingsAgora = Object.fromEntries(
        db.prepare("select key, value from server_settings order by key").all().map((r) => [r.key, r.value]),
      );
      const settingsPerdidas = Object.entries(BASELINE.server_settings)
        .filter(([k, v]) => settingsAgora[k] !== v).map(([k]) => k);
      t("server_settings da fixture preservadas", settingsPerdidas.length === 0,
        settingsPerdidas.join(","));
      t("foreign_key_check limpo pós-upgrade", db.pragma("foreign_key_check").length === 0);
      t("integrity_check ok pós-upgrade", db.pragma("integrity_check")[0].integrity_check === "ok");
      db.close();
      t("anexo em disco preservado (sha256)", sha256(ANEXO_PATH) === BASELINE.anexo_sha256
        && readFileSync(ANEXO_PATH).length === BASELINE.anexo_bytes);
    }
  }
} catch (e) {
  fail++;
  console.error("  FALHOU exceção:", e?.message ?? e);
  if (batLog) console.error("  --- últimas linhas do BAT ---\n" + batLog.slice(-3000));
} finally {
  await matarArvore(batProc);
  try { rmSync(join(FIX, "node_modules"), { force: true }); } catch { }
  rmSync(TEMP, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
