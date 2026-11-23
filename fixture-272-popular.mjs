#!/usr/bin/env node
// Fixture descartável 1.0.8 para a Issue #272 — popula uma instalação
// sintética real (servidor 1.0.8 buildado) e emite baseline-108.json.
// Uso: node fixture-272-popular.mjs <dir-de-trabalho>
// Não usa dados reais; entidades via API quando possível, inserts
// sintéticos apenas para dados que não têm endpoint simples.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, abrirDb,
} from "./teste-base.mjs";

const WORK = process.argv[2];
if (!WORK) { console.error("uso: node fixture-272-popular.mjs <dir>"); process.exit(2); }
mkdirSync(WORK, { recursive: true });
const DIR = join(WORK, "instancia-108");
const BANCO = join(DIR, "mestre-rpg-teste.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const SAIDA = join(WORK, "baseline-108.json");

let falhas = 0;
const check = (n, c, x = "") => { console.log(`${c ? "ok" : "FALHOU"} ${n}${x ? " — " + x : ""}`); if (!c) falhas++; };

prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });

try {
  await esperarSaudavel(BASE, proc);

  const cA = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Alfa 1.0.8",
    config: { pontosSangue: { habilitado: true }, experiencia: { personagemGain: 100 } },
  });
  check("cenário base criado", !!cA.campId);

  const p1 = cA.novoPersonagem(cA.jogadores.jogador1.membershipId, "Lupina Alfa", { for: 8, agi: 6 });
  const p2 = cA.novoPersonagem(cA.jogadores.jogador2.membershipId, "Torin Bravo", { for: 4, int: 9 });
  const p3 = cA.novoPersonagem(cA.membMestre, "Sombra Companheira", { for: 3 });
  check("personagens criados", !!(p1 && p2 && p3));

  // Selo de pontos exigido pelo xp-lote (mesmo mecanismo de teste-xp-lote.mjs)
  {
    const seloDb = abrirDb(BANCO);
    const selo = { em: new Date().toISOString(), autorId: cA.adminId, autorNome: "Mestre Teste" };
    for (const pid of [p1, p2, cA.personagemMestre]) {
      const row = seloDb.prepare("select data from characters where id=?").get(pid);
      const data = JSON.parse(row.data);
      data.__pontos = { bonus: 0, historico: [], selo };
      seloDb.prepare("update characters set data=? where id=?").run(JSON.stringify(data), pid);
    }
    seloDb.close();
  }

  const campB = await req(BASE, "POST", "/campaigns", { cookie: cA.cookieMestre, body: { name: "Campanha Beta 1.0.8" } });
  check("segunda campanha", campB.status === 201 || campB.status === 200, JSON.stringify(campB.json?.erro ?? "").slice(0, 120));
  const campBId = campB.json?.campanha?.id;

  const inv = await req(BASE, "POST", `/campaigns/${campBId}/invitations`, { cookie: cA.cookieMestre, body: { papel: "jogador" } });
  check("convite emitido", [200, 201].includes(inv.status), JSON.stringify(inv.json ?? {}).slice(0, 120));

  const reqId = randomUUID();
  const loteBody = {
    requestId: reqId, motivo: "fixture-272",
    itens: [
      { characterId: p1, quantidade: 150 },
      { characterId: p2, quantidade: 75 },
      { characterId: cA.personagemMestre, quantidade: 200 },
    ],
  };
  const lote = await req(BASE, "POST", `/campaigns/${cA.campId}/xp-lote`, { cookie: cA.cookieMestre, body: loteBody });
  check("xp-lote concedido", [200, 201].includes(lote.status), JSON.stringify(lote.json ?? {}).slice(0, 160));

  const loteRetry = await req(BASE, "POST", `/campaigns/${cA.campId}/xp-lote`, { cookie: cA.cookieMestre, body: loteBody });
  console.log("  info retry xp-lote status:", loteRetry.status, "(idempotência — só registro)");

  const db = abrirDb(BANCO);
  const agora = Date.now();
  const id = () => randomUUID();
  // Inventário + equipamento + catálogo (schema 1.0.8 verificado via PRAGMA)
  db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id(), p1, "Espada curta", 1, "fixture", "arma", "mochila", "bom", 1.2, "{}", agora, agora);
  db.prepare("insert into equipment_entries (id,character_id,name,kind,slot,equipped,description,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(id(), p1, "Espada curta", "arma", "maos", 1, "fixture", "{}", agora, agora);
  db.prepare("insert into item_templates (id,campaign_id,name,category,description,data,is_active,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(id(), cA.campId, "Poção menor", "consumivel", "fixture", "{}", 1, agora, agora);
  // Financeiro fictício (personagem + campanha)
  db.prepare("insert into financial_accounts (id,character_id,campaign_id,type,name,currency,balance_cents,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(id(), p1, cA.campId, "especie", "Bolsa de Lupina", "BRL", 5000, "{}", agora, agora);
  db.prepare("insert into money_transactions (id,character_id,campaign_id,kind,amount,currency,account,counterparty,description,amount_cents,balance_before_cents,balance_after_cents,request_id,created_by,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id(), p1, cA.campId, "despesa", -25, "BRL", "especie", "Taverna do Porto", "fixture", -2500, 5000, 2500, randomUUID(), cA.adminId, agora);
  // Sessão + turno + chat + rolagem
  const sessId = id();
  db.prepare("insert into sessions (id,campaign_id,number,name,summary,status,created_by,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(sessId, cA.campId, 1, "Sessão fixture", "resumo fixture", "ativa", cA.adminId, agora, agora);
  db.prepare("insert into turns (id,session_id,state,updated_by,updated_at) values (?,?,?,?,?)")
    .run(id(), sessId, "{}", cA.adminId, agora);
  db.prepare("insert into chat_messages (id,campaign_id,session_id,author_id,kind,content,visibility,created_at) values (?,?,?,?,?,?,?,?)")
    .run(id(), cA.campId, sessId, cA.adminId, "texto", "fixture chat ooc", "publica", agora);
  db.prepare("insert into rolls (id,campaign_id,session_id,character_id,user_id,dice,results,reason,visibility,created_at,request_id) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id(), cA.campId, sessId, p1, cA.jogadores.jogador1.id, JSON.stringify([{ sides: 20, count: 1 }]), JSON.stringify({ total: 14, rolls: [14] }), "fixture", "publica", agora, randomUUID());
  // Anexo físico + registro
  const campDir = join(ARQ, "campanhas", cA.campId);
  mkdirSync(campDir, { recursive: true });
  const storageName = `fixture-${randomUUID()}.txt`;
  writeFileSync(join(campDir, storageName), "anexo sintetico fixture-272\n");
  db.prepare("insert into files (id,campaign_id,folder_path,display_name,file_name,mime_type,size_bytes,uploaded_by,visibility,storage_name,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id(), cA.campId, "/", "Mapa da cidade", "mapa-cidade.txt", "text/plain", 27, cA.adminId, "mestre", storageName, "aprovado", agora, agora);
  // Config de backup em server_settings (json mode → texto)
  db.prepare("insert into server_settings (key,value,updated_at) values (?,?,?) on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at")
    .run("backup", JSON.stringify({ agenda: "diario", hora: "03:00", retencaoDiarios: 30, retencaoSemanais: 12, pasta: BKS }), agora);
  db.close();
  check("dados sintéticos inseridos", true);

  // Baseline
  const w = abrirDb(BANCO);
  const tabelas = w.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map(r => r.name);
  const contagens = {};
  for (const t of tabelas) contagens[t] = w.prepare(`select count(*) c from "${t}"`).get().c;
  const integridade = w.prepare("pragma integrity_check").get().integrity_check;
  const fk = w.prepare("pragma foreign_key_check").all().length;
  w.prepare("pragma wal_checkpoint(TRUNCATE)").get();
  w.close();

  const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const arquivos = {};
  const andar = (d, rel = "") => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) andar(p, r); else arquivos[r] = { bytes: statSync(p).size, sha256: sha256(p) };
    }
  };
  andar(DIR);

  const baseline = {
    geradoEm: new Date().toISOString(),
    versao: "1.0.8", shaBase: "a9585225ffb7b1a59d475d5f8a965692fe963fb7",
    banco: BANCO, integridade, fkViolacoes: fk, contagens, arquivos,
    resumo: { campanhas: contagens.campaigns, personagens: contagens.characters, usuarios: contagens.users, memberships: contagens.memberships, xpLotes: contagens.xp_lotes },
  };
  writeFileSync(SAIDA, JSON.stringify(baseline, null, 2));
  console.log(`\n==== baseline gravado em ${SAIDA} ====`);
  console.log("integridade:", integridade, "| fk violations:", fk);
  console.log("resumo:", JSON.stringify(baseline.resumo));
} finally {
  await encerrarServidor(proc);
}
process.exit(falhas ? 1 : 0);
