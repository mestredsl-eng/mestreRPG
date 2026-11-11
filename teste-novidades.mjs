#!/usr/bin/env node
// Testes — Central de Novidades (Issue #42).
// Cobre: CRUD admin, publicar/despublicar/remover, autorização
// (admin vs usuário vs anônimo), rascunho invisível, ordenação,
// leitura individual isolada por usuário, idempotência, concorrência,
// integridade de FKs e migrations em banco limpo e existente.
// Roda 100% em banco temporário — nunca toca dados reais.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, sessao, comDb, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const RAIZ_REPO = dirname(fileURLToPath(import.meta.url));
const MIGRADOR = join(RAIZ_REPO, "servidor/dist/db/migrate.js");
const MIGRATIONS = join(RAIZ_REPO, "servidor/migrations");
const ULTIMA_MIGRACAO_ANTIGA = "0017"; // instalação anterior: schema até 0017

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

// ---------- banco limpo com todas as migrations (cenário principal) ----------
const DIR = dirTeste("novidades");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
mkdirSync(dirname(BANCO), { recursive: true });
await prepararBanco(BANCO);

sec("Migration em banco limpo");
{
  const db = new Database(BANCO, { readonly: true });
  const ts = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
  t("tabela novidades existe", ts.includes("novidades"));
  t("tabela novidade_leituras existe", ts.includes("novidade_leituras"));
  t("índice único de leitura existe", db.prepare("select name from sqlite_master where type='index' and name='novidade_leitura_unica_idx'").get() !== undefined);
  db.close();
}

const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
await esperarSaudavel(BASE, proc);

const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Novidades", jogadores: { a: "usuario_a", b: "usuario_b" } });
const M = cenario.cookieMestre;
const A = cenario.jogadores.a.cookie;
const B = cenario.jogadores.b.cookie;
console.log(`servidor teste em ${BASE}`);

let pub1, pub2, pub3;
try {
  sec("1-4. CRUD administrativo");
  {
    const r = await req(BASE, "POST", "/admin/novidades", {
      cookie: M,
      body: { titulo: "Bem-vindos à central", resumo: "Primeira publicação", conteudo: "Conteúdo completo\nSegunda linha", versao: "1.0.0", categoria: "novidade", estado: "rascunho" },
    });
    t("admin cria publicação -> 201", r.status === 201, JSON.stringify(r.json).slice(0, 200));
    pub1 = r.json?.novidade;
    t("nasce como rascunho por padrão", pub1?.estado === "rascunho");

    const r2 = await req(BASE, "POST", "/admin/novidades", {
      cookie: M,
      body: { titulo: "Correção de dados", categoria: "correcao", estado: "publicada", conteudo: "Texto" },
    });
    pub2 = r2.json?.novidade;
    t("admin cria já publicada", r2.status === 201 && pub2?.estado === "publicada" && pub2?.publicadoEm != null);

    const r3 = await req(BASE, "POST", "/admin/novidades", {
      cookie: M,
      body: { titulo: "Melhoria na mesa", categoria: "melhoria", conteudo: "Texto", estado: "publicada" },
    });
    pub3 = r3.json?.novidade;

    const ed = await req(BASE, "PATCH", `/admin/novidades/${pub1.id}`, {
      cookie: M,
      body: { titulo: "Bem-vindos (editado)", resumo: "Resumo novo", categoria: "melhoria" },
    });
    t("admin edita publicação", ed.status === 200 && ed.json?.novidade?.titulo === "Bem-vindos (editado)" && ed.json?.novidade?.categoria === "melhoria");

    const pub = await req(BASE, "POST", `/admin/novidades/${pub1.id}/publicar`, { cookie: M });
    t("publicar rascunho -> 200 publicada", pub.status === 200 && pub.json?.novidade?.estado === "publicada" && pub.json?.novidade?.publicadoEm != null);

    const des = await req(BASE, "POST", `/admin/novidades/${pub1.id}/despublicar`, { cookie: M });
    t("despublicar -> rascunho", des.status === 200 && des.json?.novidade?.estado === "rascunho");

    const listaAdmin = await req(BASE, "GET", "/admin/novidades", { cookie: M });
    t("admin lista inclui rascunhos", listaAdmin.status === 200 && listaAdmin.json?.novidades?.length === 3);
  }

  sec("5-6. Autorização");
  {
    const ops = [
      ["POST", "/admin/novidades", { titulo: "x" }],
      ["PATCH", `/admin/novidades/${pub2.id}`, { titulo: "x" }],
      ["POST", `/admin/novidades/${pub2.id}/publicar`],
      ["POST", `/admin/novidades/${pub2.id}/despublicar`],
      ["DELETE", `/admin/novidades/${pub2.id}`],
    ];
    for (const [metodo, path, body] of ops) {
      const r = await req(BASE, metodo, path, { cookie: A, body });
      t(`usuário comum ${metodo} ${path.split("/").pop()} -> 403`, r.status === 403, `status=${r.status}`);
    }
    for (const [metodo, path] of [["GET", "/novidades"], ["GET", "/novidades/nao-lidas"], ["GET", `/novidades/${pub2.id}`], ["POST", `/novidades/${pub2.id}/lida`]]) {
      const r = await req(BASE, metodo, path);
      t(`anônimo ${metodo} ${path} -> 401`, r.status === 401, `status=${r.status}`);
    }
    const rAdmin = await req(BASE, "GET", "/admin/novidades");
    t("anônimo GET /admin/novidades -> 401", rAdmin.status === 401);
  }

  sec("7-8. Rascunho invisível + ordenação");
  {
    // pub1 está em rascunho (despublicada acima)
    const listaA = await req(BASE, "GET", "/novidades", { cookie: A });
    const ids = (listaA.json?.novidades ?? []).map((n) => n.id);
    t("rascunho não aparece para usuário", !ids.includes(pub1.id), ids.join(","));
    const det = await req(BASE, "GET", `/novidades/${pub1.id}`, { cookie: A });
    t("GET detalhe de rascunho -> 404", det.status === 404);
    const lidaRasc = await req(BASE, "POST", `/novidades/${pub1.id}/lida`, { cookie: A });
    t("marcar rascunho como lida -> 404", lidaRasc.status === 404);
    const inexistent = await req(BASE, "POST", "/novidades/id-inexistente/lida", { cookie: A });
    t("marcar publicação inexistente -> 404", inexistent.status === 404);

    // Ordenação determinística: ajusta publicado_em direto no banco
    {
      const w = abrirDb(BANCO);
      w.prepare("update novidades set publicado_em=? where id=?").run(new Date("2026-01-01").getTime(), pub2.id);
      w.prepare("update novidades set publicado_em=? where id=?").run(new Date("2026-03-01").getTime(), pub3.id);
      w.prepare("update novidades set estado='publicada', publicado_em=? where id=?").run(new Date("2026-02-01").getTime(), pub1.id);
      w.close();
    }
    const ord = await req(BASE, "GET", "/novidades", { cookie: A });
    const ordem = (ord.json?.novidades ?? []).map((n) => n.id);
    t("ordena da mais recente para a mais antiga", ordem[0] === pub3.id && ordem[1] === pub1.id && ordem[2] === pub2.id, ordem.join(","));
    // devolve pub1 a rascunho para os próximos cenários
    await req(BASE, "POST", `/admin/novidades/${pub1.id}/despublicar`, { cookie: M });
    {
      const w = abrirDb(BANCO);
      w.prepare("update novidades set publicado_em=? where id=?").run(new Date("2026-01-15").getTime(), pub1.id);
      w.close();
    }
  }

  sec("9-12. Leitura individual e contadores");
  {
    // estado: pub2 e pub3 publicadas; pub1 rascunho
    const antes = await req(BASE, "GET", "/novidades/nao-lidas", { cookie: A });
    t("contador inicial = 2 publicadas", antes.json?.naoLidas === 2, JSON.stringify(antes.json));

    const listaA1 = await req(BASE, "GET", "/novidades", { cookie: A });
    t("listagem não marca como lida (A)", listaA1.json?.novidades?.every((n) => n.lida === false));
    const lidasAposLista = comDb(BANCO, (db) => db.prepare("select count(*) c from novidade_leituras where user_id=?").get(cenario.jogadores.a.id).c);
    t("zero registros de leitura após listagem", lidasAposLista === 0, String(lidasAposLista));

    const marcar = await req(BASE, "POST", `/novidades/${pub2.id}/lida`, { cookie: A });
    t("A abre publicação -> marca lida", marcar.status === 200 && marcar.json?.ok === true);

    const depois = await req(BASE, "GET", "/novidades", { cookie: A });
    const lidaPub2 = depois.json?.novidades?.find((n) => n.id === pub2.id);
    t("publicação aparece como lida para A", lidaPub2?.lida === true);
    t("contador de A cai para 1", depois.json?.naoLidas === 1, String(depois.json?.naoLidas));

    // usuário B não é afetado
    const listaB = await req(BASE, "GET", "/novidades", { cookie: B });
    const lidaPub2B = listaB.json?.novidades?.find((n) => n.id === pub2.id);
    t("leitura de A não altera B", lidaPub2B?.lida === false);
    t("contador de B continua 2", listaB.json?.naoLidas === 2, String(listaB.json?.naoLidas));

    // reabrir não duplica
    await req(BASE, "POST", `/novidades/${pub2.id}/lida`, { cookie: A });
    const duplicatas = comDb(BANCO, (db) => db.prepare("select count(*) c from novidade_leituras where novidade_id=? and user_id=?").get(pub2.id, cenario.jogadores.a.id).c);
    t("reabrir não duplica registro", duplicatas === 1, String(duplicatas));
  }

  sec("13. Persistência após refresh/novo login");
  {
    const cookieA2 = sessao(BANCO, cenario.jogadores.a.id); // "novo login" = nova sessão
    const r = await req(BASE, "GET", "/novidades", { cookie: cookieA2 });
    const lidaPub2 = r.json?.novidades?.find((n) => n.id === pub2.id);
    t("leitura persiste em nova sessão", lidaPub2?.lida === true);
    t("contador persiste", r.json?.naoLidas === 1);
  }

  sec("14-15. Remoção e concorrência");
  {
    // concorrência: 6 marcações simultâneas da pub3 por B
    await Promise.all(Array.from({ length: 6 }, () => req(BASE, "POST", `/novidades/${pub3.id}/lida`, { cookie: B })));
    const regsB = comDb(BANCO, (db) => db.prepare("select count(*) c from novidade_leituras where novidade_id=? and user_id=?").get(pub3.id, cenario.jogadores.b.id).c);
    t("marcações concorrentes não duplicam", regsB === 1, String(regsB));

    const antes = await req(BASE, "GET", "/admin/novidades", { cookie: M });
    const leiturasAntes = antes.json?.novidades?.find((n) => n.id === pub3.id)?.leituras;
    t("admin vê contagem de leituras", leiturasAntes === 1, String(leiturasAntes));

    const del = await req(BASE, "DELETE", `/admin/novidades/${pub3.id}`, { cookie: M });
    t("admin remove publicação", del.status === 200);
    const leiturasDepois = comDb(BANCO, (db) => db.prepare("select count(*) c from novidade_leituras where novidade_id=?").get(pub3.id).c);
    t("leituras removidas em cascata (sem órfãos)", leiturasDepois === 0, String(leiturasDepois));
    const detPub3 = await req(BASE, "GET", `/novidades/${pub3.id}`, { cookie: A });
    t("detalhe de removida -> 404", detPub3.status === 404);
    const listaApos = await req(BASE, "GET", "/novidades", { cookie: B });
    t("removida some da listagem", !(listaApos.json?.novidades ?? []).some((n) => n.id === pub3.id));
  }

  sec("Validações e integridade extra");
  {
    const vazio = await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "" } });
    t("título vazio rejeitado", vazio.status === 400);
    const catRuim = await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "x", categoria: "invalida" } });
    t("categoria inválida rejeitada", catRuim.status === 400);
    const estRuim = await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "x", estado: "arquivada" } });
    t("estado inválido rejeitado", estRuim.status === 400);
    const naoExiste = await req(BASE, "PATCH", "/admin/novidades/id-falso", { cookie: M, body: { titulo: "x" } });
    t("PATCH inexistente -> 404", naoExiste.status === 404);
    const naoExiste2 = await req(BASE, "DELETE", "/admin/novidades/id-falso", { cookie: M });
    t("DELETE inexistente -> 404", naoExiste2.status === 404);
    // integridade referencial: leitura de usuário removido cai em cascata
    const uidTmp = crypto.randomUUID();
    {
      const w = abrirDb(BANCO);
      const agora = Date.now();
      w.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,0,'ativo',?,?)")
        .run(uidTmp, "tmp_leitura", "x", agora, agora);
      w.prepare("insert into novidade_leituras (id,novidade_id,user_id,lida_em) values (?,?,?,?)")
        .run(crypto.randomUUID(), pub2.id, uidTmp, agora);
      w.close();
    }
    {
      const w = abrirDb(BANCO);
      w.prepare("delete from users where id=?").run(uidTmp);
      w.close();
    }
    const orfaos = comDb(BANCO, (db) => db.prepare("select count(*) c from novidade_leituras where user_id=?").get(uidTmp).c);
    t("leitura de usuário excluído cai em cascata", orfaos === 0, String(orfaos));
  }
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 600));
} finally {
  await encerrarServidor(proc);
}

// ---------- migration em banco existente (schema até 0017 + dados) ----------
sec("Migration em banco existente preserva dados");
{
  const RAIZ2 = dirTeste("novidades-upgrade");
  try {
    const ANTIGAS = join(RAIZ2, "migrations-0017");
    mkdirSync(join(ANTIGAS, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"));
    const antigas = journal.entries.filter((e) => parseInt(e.tag.slice(0, 4), 10) <= parseInt(ULTIMA_MIGRACAO_ANTIGA, 10));
    for (const e of antigas) cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(ANTIGAS, `${e.tag}.sql`));
    writeFileSync(join(ANTIGAS, "meta/_journal.json"), JSON.stringify({ ...journal, entries: antigas }));

    const BANCO_VELHO = join(RAIZ2, "banco", "mestre-rpg.db");
    mkdirSync(dirname(BANCO_VELHO), { recursive: true });
    {
      const sqlite = new Database(BANCO_VELHO);
      sqlite.pragma("journal_mode = WAL");
      const db = drizzle(sqlite);
      await migrate(db, { migrationsFolder: ANTIGAS });
      sqlite.close();
    }
    const uid = crypto.randomUUID();
    {
      const db = new Database(BANCO_VELHO);
      const agora = Date.now();
      db.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,1,'ativo',?,?)")
        .run(uid, "admin_legado", "x", agora, agora);
      db.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), "Campanha Legada", "andamento", uid, "{}", agora, agora);
      db.close();
    }
    const antes = comDb(BANCO_VELHO, (db) => ({
      users: db.prepare("select count(*) c from users").get().c,
      campaigns: db.prepare("select count(*) c from campaigns").get().c,
    }));

    const mig = spawnSync("node", [MIGRADOR], { env: { ...process.env, MESTRE_BANCO: BANCO_VELHO }, encoding: "utf8" });
    t("migrate em banco existente -> exit 0", mig.status === 0, (mig.stderr ?? "").slice(-300));

    const db2 = new Database(BANCO_VELHO, { readonly: true });
    const ts = db2.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
    t("novidades criadas no upgrade", ts.includes("novidades") && ts.includes("novidade_leituras"));
    t("dados preservados", db2.prepare("select count(*) c from users").get().c === antes.users && db2.prepare("select count(*) c from campaigns").get().c === antes.campaigns);
    db2.close();
  } finally {
    limparDir(RAIZ2);
  }
}

limparDir(DIR);
console.log(`\n==== novidades: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);

