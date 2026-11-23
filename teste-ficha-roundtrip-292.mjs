// #292 — auditoria de fidelidade/persistência da ficha (Caçadores & Caçados).
// Prova em servidor real + SQLite descartável:
//  1. PATCH faz MERGE: campos do modelo atualizam; chaves fora do modelo
//     (__sangue, __xp, __hp, campos órfãos de template antigo) sobrevivem.
//  2. Anti-injeção: cliente NÃO consegue gravar chaves "__*" nem campos
//     inexistentes — validarFicha só emite ids do modelo vigente.
//  3. Permissões: dono edita só campos permitidos (400 atômico no resto);
//     mestre edita tudo exceto arquivado.
//  4. GET projeta apenas campos do modelo — dados reservados não vazam.
//  5. Round-trip: salvar → reler → salvar de novo preserva tudo.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-ficha292-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };

const dadosBrutos = (id) => comDb(BANCO, (db) =>
  JSON.parse(db.prepare("select data from characters where id=?").get(id).data));

try {
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Ficha 292",
    jogadores: { jogador1: "jogador_f292" },
  });
  const CID = c.campId, J = c.jogadores.jogador1.cookie, M = c.cookieMestre;

  // Enriquece a estrutura publicada: texto, selecao_nivel (regraKind) e
  // campo exclusivo do mestre — cobre os tipos usados pelo Caçadores.
  {
    const w = abrirDb(BANCO);
    try {
    const ver = w.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    est.secoes[0].campos = [
      { id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" },
      { id: "apelido", label: "Alcunha", tipo: "texto" },
      { id: "segredo", label: "Segredo", tipo: "texto", editavelPor: "mestre" },
    ];
    w.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
    } finally { w.close(); }
  }

  // Personagem do jogador (dono), status rascunho → editável por ele.
  const criado = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J,
    body: {
      name: "Herói Roundtrip",
      data: {
        for: 5, apelido: "Tranca",
        __sangue: { saldo: 999 }, __xp: { hack: true }, campo_inexistente: "x",
      },
    },
  });
  t("criação aceita (201)", criado.status === 201, `status=${criado.status} ${JSON.stringify(criado.json?.erro ?? "")}`);
  const PID = criado.json?.personagem?.id;
  t("id retornado", typeof PID === "string" && PID.length > 10);

  // 1) Anti-injeção já na criação: chaves "__*" e desconhecidas não entram.
  {
    const d = dadosBrutos(PID);
    t("criação descarta __sangue forjado", d.__sangue === undefined, JSON.stringify(d.__sangue));
    t("criação descarta __xp forjado", d.__xp === undefined);
    t("criação descarta campo inexistente", d.campo_inexistente === undefined);
    t("campos legítimos persistem", d.for === 5 && d.apelido === "Tranca", JSON.stringify(d));
  }

  // Injeta dados reservados/legados direto no banco — simula ficha real
  // que já possui ledger de Sangue, marcador XP, HP e campo órfão de um
  // template antigo que foi removido do modelo vigente.
  {
    const w = abrirDb(BANCO);
    try {
    const d = JSON.parse(w.prepare("select data from characters where id=?").get(PID).data);
    d.__sangue = { saldo: 3, capacidade: 10, usos: { "ativar:abc": {} }, historico: [] };
    d.__xp = { financiado: {} };
    d.__hp = { atual: 80, historico: [] };
    d.campo_legado_fora_do_modelo = "valor-antigo";
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(d), PID);
    } finally { w.close(); }
  }

  // 2) PATCH do mestre altera um campo → merge preserva o resto.
  {
    const r = await req(BASE, "PATCH", `/characters/${PID}`, {
      cookie: M, body: { data: { for: 6 } },
    });
    t("PATCH mestre 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);
    const d = dadosBrutos(PID);
    t("campo alterado persistiu", d.for === 6);
    t("__sangue preservado", d.__sangue?.saldo === 3 && d.__sangue?.capacidade === 10);
    t("__xp preservado", d.__xp && typeof d.__xp === "object");
    t("__hp preservado", d.__hp?.atual === 80);
    t("campo órfão de template antigo preservado", d.campo_legado_fora_do_modelo === "valor-antigo");
    t("outros campos intactos", d.apelido === "Tranca");
  }

  // 3) PATCH do dono com campo permitido + chaves forjadas.
  {
    const r = await req(BASE, "PATCH", `/characters/${PID}`, {
      cookie: J,
      body: { data: { apelido: "Lince", __sangue: { saldo: 999 }, __xp: { financiado: { for: {} } }, campo_inexistente: 1 } },
    });
    t("PATCH dono 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? r.json?.detalhes ?? "")}`);
    const d = dadosBrutos(PID);
    t("apelido atualizado", d.apelido === "Lince");
    t("__sangue NÃO adulterado pelo cliente", d.__sangue?.saldo === 3, `saldo=${d.__sangue?.saldo}`);
    t("__xp NÃO adulterado", JSON.stringify(d.__xp) === JSON.stringify({ financiado: {} }));
    t("campo inexistente descartado", d.campo_inexistente === undefined);
  }

  // 4) Dono tenta alterar campo editavelPor=mestre → 400 atômico:
  //    nem o campo proibido nem o permitido do mesmo request gravam.
  {
    const r = await req(BASE, "PATCH", `/characters/${PID}`, {
      cookie: J,
      body: { data: { apelido: "NaoDeveGravar", segredo: "tentativa" } },
    });
    t("PATCH campo mestre-only → 400", r.status === 400, `status=${r.status}`);
    const d = dadosBrutos(PID);
    t("400 atômico: apelido NÃO gravou", d.apelido === "Lince", `apelido=${d.apelido}`);
    t("segredo ausente/inválido não persistiu", d.segredo === undefined || d.segredo !== "tentativa");
  }

  // 5) GET não vaza dados reservados/órfãos na projeção da ficha.
  {
    const g = await req(BASE, "GET", `/characters/${PID}`, { cookie: J });
    t("GET 200", g.status === 200);
    const campos = g.json?.ficha?.campos ?? {};
    const chaves = Object.keys(campos);
    t("ficha.campos só tem ids do modelo",
      chaves.every((k) => ["for", "apelido", "defeitos", "segredo"].includes(k)),
      chaves.join(","));
    t("__sangue ausente da projeção", !("__sangue" in campos) && !("__xp" in campos) && !("__hp" in campos));
    t("campo órfão ausente da projeção", !("campo_legado_fora_do_modelo" in campos));
    const serial = JSON.stringify(g.json?.ficha ?? {});
    t("sem vazamento de dados reservados no payload", !serial.includes("__sangue") && !serial.includes("campo_legado_fora_do_modelo"));
  }

  // 6) Round-trip completo: novo PATCH do mestre → GET → PATCH do dono.
  {
    const p1 = await req(BASE, "PATCH", `/characters/${PID}`, {
      cookie: M, body: { data: { segredo: "mestre-sabe", for: 7 } },
    });
    t("PATCH mestre 2 → 200", p1.status === 200, `status=${p1.status}`);
    const g = await req(BASE, "GET", `/characters/${PID}`, { cookie: J });
    t("GET reflete for novo", g.json?.ficha?.campos?.for === 7, JSON.stringify(g.json?.ficha?.campos?.for));
    const p2 = await req(BASE, "PATCH", `/characters/${PID}`, {
      cookie: J, body: { data: { apelido: "Final" } },
    });
    t("PATCH dono final → 200", p2.status === 200, `status=${p2.status}`);
    const d = dadosBrutos(PID);
    t("round-trip: tudo preservado",
      d.for === 7 && d.apelido === "Final" && d.segredo === "mestre-sabe"
      && d.for === 7
      && d.__sangue?.saldo === 3 && d.__hp?.atual === 80
      && d.campo_legado_fora_do_modelo === "valor-antigo");
  }

  // 7) Arquivado é somente leitura até para o mestre.
  {
    const arq = await req(BASE, "POST", `/characters/${PID}/arquivar`, { cookie: M, body: {} });
    t("arquivar ok", arq.status === 200 || arq.status === 201, `status=${arq.status}`);
    const p = await req(BASE, "PATCH", `/characters/${PID}`, {
      cookie: M, body: { data: { for: 9 } },
    });
    t("PATCH em arquivado → 403", p.status === 403, `status=${p.status}`);
    t("dado intacto após tentativa", dadosBrutos(PID).for === 7);
    const des = await req(BASE, "POST", `/characters/${PID}/desarquivar`, { cookie: M, body: {} });
    t("desarquivar ok", des.status === 200 || des.status === 201, `status=${des.status}`);
  }

  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}
