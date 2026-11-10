// Homologação: acervo global de livros de regras (/api/biblioteca).
// Cobre os 18 cenários do spec: CRUD, itens por kind, export/import,
// round-trip, prévia sem persistência, merge por kind:key, conflitos,
// backup automático, restauração, rollback, permissões, payloads inválidos
// e compatibilidade com a biblioteca por campanha.
// Sobe um servidor próprio na porta 3002 com o banco real (WAL) e limpa
// os livros de teste ao final.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

// Homologa sempre em cópia descartável: nunca escreve no banco real.
const DIR = resolve("simulacao-limpeza", "homologacao-acervo");
const BANCO = resolve(DIR, "mestre-rpg-teste.db");
mkdirSync(DIR, { recursive: true });
for (const suf of ["", "-wal", "-shm"]) rmSync(BANCO + suf, { force: true });
{
  const origem = new Database("banco/mestre-rpg.db", { readonly: true });
  const destino = BANCO.replace(/\\\\/g, "/").replace(/'/g, "''");
  origem.prepare(`VACUUM INTO '${destino}'`).run();
  origem.close();
}

function portaLivre() {
  return new Promise((resolvePorta, reject) => {
    const servidor = createServer();
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", () => {
      const porta = servidor.address().port;
      servidor.close(() => resolvePorta(porta));
    });
  });
}
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CID = "7a1c9c2e-3c7a-4805-9145-d8622d755a36"; // Caçadores & Caças
const SUFIXO = `__TESTE_${Date.now()}`;
const FORMATO = "mestre-rpg-biblioteca";

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

// ---------- servidor ----------
const srv = spawn(process.execPath, ["servidor/dist/index.js"], {
  env: {
    ...process.env,
    MESTRE_PORTA: String(PORTA),
    MESTRE_BANCO: BANCO,
    MESTRE_ARQUIVOS: resolve(DIR, "arquivos"),
    MESTRE_BACKUPS: resolve(DIR, "backups"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));

async function esperarServidor() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("servidor não subiu");
}

// ---------- sessões ----------
const db = new Database(BANCO);
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "hom-acervo", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='fernandoqc_@hotmail.com'").get();
const tokM = sessao(admin.id, "acervo-m");
const tokJ = sessao(jog.id, "acervo-j");

async function req(m, path, body, token) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, json: j };
}
const apiM = (m, p, b) => req(m, p, b, tokM);
const apiJ = (m, p, b) => req(m, p, b, tokJ);

const livrosTeste = [];
const envelopeDe = (env) => ({ formato: FORMATO, versao: 1, livros: env });

try {
  await esperarServidor();
  console.log("servidor ok — iniciando testes\n");

  // ---------- 16) permissões (antecipado: não-admin não modifica) ----------
  let r = await apiJ("GET", "/api/biblioteca/livros");
  ok("16a. não-admin consulta acervo", r.status === 200, `status=${r.status}`);
  r = await apiJ("POST", "/api/biblioteca/livros", { titulo: `${SUFIXO} invasão` });
  ok("16b. não-admin não cria livro", r.status === 403, `status=${r.status}`);
  r = await apiJ("POST", "/api/biblioteca/importar/previa", envelopeDe([{ titulo: "x", itens: [] }]));
  ok("16c. não-admin não importa", r.status === 403, `status=${r.status}`);
  r = await apiJ("DELETE", "/api/biblioteca/livros/inexistente");
  ok("16d. não-admin não exclui", r.status === 403, `status=${r.status}`);

  // ---------- 1/2) criar livro manual com kinds variados ----------
  const livroA = {
    titulo: `${SUFIXO} Livro Alpha`,
    descricao: "Livro de teste do acervo",
    autor: "Mestre Teste",
    sistema: "Sistema X",
    edicao: "1ª",
    tipo: "livro",
    itens: [
      { kind: "atributo", key: "forca", name: "Força", definition: { custo: 1 } },
      { kind: "habilidade", key: "furtividade", name: "Furtividade", category: "Físicas", parentKey: "destreza" },
      { kind: "regra_combate", key: "vantagem_ataque", name: "Vantagem em ataque", definition: { dados: 2 } },
      { kind: "tabela", key: "dano_fogo", name: "Dano de fogo", definition: { colunas: ["1d6", "2d6"] } },
      { kind: "equipamento", key: "machado", name: "Machado", definition: { peso: 2, dano: "1d8" } },
      { kind: "vantagem", key: "foco", name: "Foco", definition: { limite: 1 } },
    ],
  };
  r = await apiM("POST", "/api/biblioteca/livros", livroA);
  ok("1. criar livro manual", r.status === 201, `status=${r.status} ${r.json?.erro ?? ""}`);
  const idA = r.json?.livro?.id;
  livrosTeste.push(idA);
  ok("2. livro com 6 kinds distintos", r.json?.livro?.totalItens === 6, `itens=${r.json?.livro?.totalItens}`);

  // tipos fechados são rejeitados? kind é string livre — validar charset
  r = await apiM("POST", "/api/biblioteca/livros", { titulo: `${SUFIXO} kind inválido`, itens: [{ kind: "Kind Maiúsculo!", key: "x", name: "x" }] });
  ok("kind inválido rejeitado", r.status === 400, `status=${r.status}`);

  // item CRUD
  r = await apiM("POST", `/api/biblioteca/livros/${idA}/itens`, { kind: "desvantagem", key: "cego", name: "Cego", definition: {} });
  ok("adicionar item avulso", r.status === 201, `status=${r.status}`);
  const itemCego = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json.itens.find((i) => i.key === "cego");
  r = await apiM("PATCH", `/api/biblioteca/livros/${idA}/itens/${itemCego.id}`, { name: "Cego (severo)", ordem: 99 });
  ok("editar item", r.status === 200, `status=${r.status}`);
  r = await apiM("DELETE", `/api/biblioteca/livros/${idA}/itens/${itemCego.id}`);
  ok("remover item", r.status === 200, `status=${r.status}`);
  const itensApos = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json.itens;
  ok("item removido de fato", !itensApos.some((i) => i.key === "cego"), `total=${itensApos.length}`);

  // ---------- 3) exportar livro ----------
  r = await apiM("GET", `/api/biblioteca/livros/${idA}/exportar`);
  const envLivro = r.json;
  ok("3. exportar livro usa envelope oficial", r.status === 200 && envLivro?.formato === FORMATO && envLivro?.versao === 1 && envLivro?.livros?.length === 1 && envLivro.livros[0].itens.length === 6,
    `status=${r.status} itens=${envLivro?.livros?.[0]?.itens?.length}`);
  ok("export inclui id estável do livro", envLivro?.livros?.[0]?.id === idA);

  // ---------- 4) importar livro exportado (ids removidos -> livro novo) ----------
  const envSemId = JSON.parse(JSON.stringify(envLivro));
  envSemId.livros[0].id = undefined;
  envSemId.livros[0].titulo = `${SUFIXO} Livro Alpha (cópia)`;
  delete envSemId.livros[0].id;
  for (const it of envSemId.livros[0].itens) delete it.id;
  r = await apiM("POST", "/api/biblioteca/importar/previa", envSemId);
  ok("4a. prévia do livro exportado", r.status === 200 && r.json?.novos === 1, `status=${r.status}`);
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", { envelope: envSemId, decisoes: { decisoes: [] } });
  ok("4b. confirmar importação", r.status === 200 && r.json?.resultados?.[0]?.acao === "criado", `status=${r.status}`);
  const idCopia = r.json?.resultados?.[0]?.bookId;
  livrosTeste.push(idCopia);
  const copia = (await apiM("GET", `/api/biblioteca/livros/${idCopia}`)).json;
  ok("4c. round-trip preserva itens", copia.itens.length === 6 && copia.itens.every((i) => i.definition && typeof i.definition === "object"),
    `itens=${copia.itens.length}`);
  ok("4d. round-trip preserva ordem/kind/key", copia.itens.map((i) => `${i.kind}:${i.key}`).sort().join(",") ===
    envSemId.livros[0].itens.map((i) => `${i.kind}:${i.key}`).sort().join(","));

  // ---------- 5) round-trip do acervo completo ----------
  r = await apiM("GET", "/api/biblioteca/exportar");
  const envAcervo = r.json;
  const totalAntes = envAcervo.livros.length;
  ok("5a. exportar acervo completo", r.status === 200 && envAcervo?.formato === FORMATO && envAcervo.livros.length >= 2, `livros=${envAcervo?.livros?.length}`);
  // reimportar o mesmo acervo: ids batem -> merge idempotente
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", { envelope: envAcervo, decisoes: { decisoes: [] } });
  ok("5b. reimportar acervo não duplica", r.status === 200 && r.json?.resultados?.every((x) => x.acao === "atualizado"),
    `status=${r.status}`);
  r = await apiM("GET", "/api/biblioteca/livros");
  ok("5c. total de livros preservado", r.json.total === totalAntes, `${r.json.total} vs ${totalAntes}`);
  // round-trip: livro exportado individualmente -> importar -> conteúdo igual
  const livroExport2 = envAcervo.livros.find((l) => l.id === idA);
  const envRe = envelopeDe([JSON.parse(JSON.stringify(livroExport2))]);
  r = await apiM("POST", "/api/biblioteca/importar/previa", envRe);
  const prevRe = r.json?.livros?.[0];
  ok("5d. reimportação idempotente: 0 novos/0 alterados", prevRe?.resumo?.itensNovos === 0 && prevRe?.resumo?.itensAlterados === 0 && prevRe?.resumo?.itensIdenticos === 6,
    JSON.stringify(prevRe?.resumo));

  // ---------- 6-10) prévia, merge e conflitos ----------
  // envelope de atualização do livro A: 1 item alterado, 1 novo, 1 ausente (forca fica de fora)
  const livroAAtual = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json;
  const envUpdate = {
    formato: FORMATO, versao: 1,
    livros: [{
      id: idA, titulo: `${SUFIXO} Livro Alpha`, autor: "Mestre Teste",
      sistema: "Sistema X", edicao: "2ª", tipo: "livro",
      itens: [
        { kind: "atributo", key: "forca", name: "Força", definition: { custo: 2 } }, // ALTERADO
        { kind: "habilidade", key: "furtividade", name: "Furtividade", category: "Físicas", parentKey: "destreza" }, // idêntico
        { kind: "regra_combate", key: "nova_regra", name: "Regra nova", definition: { x: 1 } }, // NOVO
        // machado, tabela, vantagem ausentes -> preservados
      ],
    }],
  };
  r = await apiM("POST", "/api/biblioteca/importar/previa", envUpdate);
  const prevU = r.json?.livros?.[0];
  ok("6. prévia não grava nada", r.status === 200 && prevU?.acao === "atualizar", `status=${r.status}`);
  const livroAposPrevia = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json;
  ok("6b. prévia sem persistência (itens inalterados)", livroAposPrevia.itens.length === 6 && livroAposPrevia.livro.edicao !== "2ª",
    `itens=${livroAposPrevia.itens.length} ed=${livroAposPrevia.livro.edicao}`);
  ok("7. prévia detecta item novo", prevU?.resumo?.itensNovos === 1, JSON.stringify(prevU?.resumo));
  ok("8. prévia detecta item alterado", prevU?.resumo?.itensAlterados === 1 && prevU?.conflitos?.some((c) => c.kind === "atributo" && c.key === "forca"),
    JSON.stringify(prevU?.conflitos));
  ok("9. prévia conta idênticos", prevU?.resumo?.itensIdenticos === 1, `ident=${prevU?.resumo?.itensIdenticos}`);
  ok("10. prévia informa ausentes preservados", prevU?.resumo?.itensAusentesPreservados === 3, `preserv=${prevU?.resumo?.itensAusentesPreservados}`);
  ok("prévia mostra metadados alterados", prevU?.metadadosAlterados?.some((m) => m.campo === "edicao"), JSON.stringify(prevU?.metadadosAlterados));

  // ---------- 11) confirmação sem decisões -> nada sobrescreve ----------
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", { envelope: envUpdate, decisoes: { decisoes: [] } });
  ok("11. confirmação sem decisão não sobrescreve", r.status === 200, `status=${r.status}`);
  const livroAposVazio = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json;
  const forcaApos = livroAposVazio.itens.find((i) => i.kind === "atributo" && i.key === "forca");
  ok("11b. conflito preservado sem decisão", forcaApos?.definition?.custo === 1, `custo=${forcaApos?.definition?.custo}`);
  ok("11c. metadados preservados sem decisão", livroAposVazio.livro.edicao !== "2ª", `ed=${livroAposVazio.livro.edicao}`);
  ok("11d. item novo entra mesmo sem decisão", livroAposVazio.itens.some((i) => i.key === "nova_regra"), `total=${livroAposVazio.itens.length}`);
  ok("11e. ausentes preservados após merge", livroAposVazio.itens.length === 7, `total=${livroAposVazio.itens.length}`);

  // ---------- 12/13) confirmação com decisão -> atualiza + backup ----------
  const backupsAntes = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups.length;
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", {
    envelope: envUpdate,
    decisoes: { decisoes: [{ indice: 0, metadados: "atualizar", itens: { "atributo:forca": "atualizar" } }] },
  });
  ok("12. confirmação com decisão aplica", r.status === 200, `status=${r.status} ${r.json?.erro ?? ""}`);
  const livroAposDec = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json;
  const forcaDec = livroAposDec.itens.find((i) => i.kind === "atributo" && i.key === "forca");
  ok("12b. item alterado aplicado", forcaDec?.definition?.custo === 2, `custo=${forcaDec?.definition?.custo}`);
  ok("12c. metadados aplicados", livroAposDec.livro.edicao === "2ª", `ed=${livroAposDec.livro.edicao}`);
  const backupsDepois = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups;
  ok("13. backup automático antes da atualização", backupsDepois.length === backupsAntes + 1, `${backupsAntes} -> ${backupsDepois.length}`);
  const backupImport = backupsDepois.find((b) => b.motivo === "antes da importação");
  ok("13b. snapshot contém estado anterior", !!backupImport, JSON.stringify(backupsDepois.map((b) => b.motivo)));

  // ---------- 14) restaurar backup ----------
  if (backupImport) {
    // estado atual tem custo=2; backup tem custo=1
    r = await apiM("POST", `/api/biblioteca/backups/${backupImport.id}/restaurar`, {});
    ok("14a. restaurar backup", r.status === 200, `status=${r.status} ${r.json?.erro ?? ""}`);
    const livroRest = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json;
    const forcaRest = livroRest.itens.find((i) => i.kind === "atributo" && i.key === "forca");
    ok("14b. estado restaurado (custo volta a 1)", forcaRest?.definition?.custo === 1, `custo=${forcaRest?.definition?.custo}`);
    ok("14c. edição restaurada (volta de 2ª)", livroRest.livro.edicao !== "2ª", `ed=${livroRest.livro.edicao}`);
    // o snapshot do passo 12 já continha nova_regra (commit do passo 11) -> 7 itens
    ok("14d. itens restaurados conforme snapshot", livroRest.itens.length === 7, `total=${livroRest.itens.length}`);
    const backupsPosRestore = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups;
    ok("14e. restore gera backup do estado atual", backupsPosRestore.some((b) => b.motivo.includes("restauração")), JSON.stringify(backupsPosRestore.map((b) => b.motivo)));
  } else {
    ok("14. restaurar backup", false, "sem backup para restaurar");
  }

  // ---------- 15) rollback em falha ----------
  // dois livros do envelope apontam para o MESMO bookId e inserem o mesmo
  // kind:key -> UNIQUE estoura na 2ª inserção -> rollback integral.
  const envRollback = {
    formato: FORMATO, versao: 1,
    livros: [
      { id: idCopia, titulo: `${SUFIXO} Livro Alpha (cópia)`, itens: [{ kind: "teste_rb", key: "dup", name: "RB1" }] },
      { id: idCopia, titulo: `${SUFIXO} Livro Alpha (cópia)`, itens: [{ kind: "teste_rb", key: "dup", name: "RB2" }] },
    ],
  };
  const totalItensCopiaAntes = (await apiM("GET", `/api/biblioteca/livros/${idCopia}`)).json.itens.length;
  const backupsCopiaAntes = (await apiM("GET", `/api/biblioteca/livros/${idCopia}/backups`)).json.backups.length;
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", { envelope: envRollback, decisoes: { decisoes: [] } });
  ok("15. importação com conflito interno falha", r.status === 500, `status=${r.status}`);
  const copiaApos = (await apiM("GET", `/api/biblioteca/livros/${idCopia}`)).json;
  ok("15b. rollback: nenhum item parcial gravado", copiaApos.itens.length === totalItensCopiaAntes && !copiaApos.itens.some((i) => i.key === "dup"),
    `itens=${copiaApos.itens.length} vs ${totalItensCopiaAntes}`);
  const backupsCopiaDepois = (await apiM("GET", `/api/biblioteca/livros/${idCopia}/backups`)).json.backups.length;
  ok("15c. rollback: backup também revertido", backupsCopiaDepois === backupsCopiaAntes, `${backupsCopiaAntes} -> ${backupsCopiaDepois}`);

  // ---------- 17) payloads inválidos / grandes ----------
  r = await apiM("POST", "/api/biblioteca/importar/previa", { formato: "errado", versao: 1, livros: [] });
  ok("17a. formato inválido rejeitado", r.status === 400, `status=${r.status}`);
  r = await apiM("POST", "/api/biblioteca/importar/previa", { formato: FORMATO, versao: 99, livros: [{ titulo: "x" }] });
  ok("17b. versão inválida rejeitada", r.status === 400, `status=${r.status}`);
  r = await apiM("POST", "/api/biblioteca/importar/previa", envelopeDe([{ titulo: "x", itens: [{ kind: "a", key: "b", name: "n", definition: { blob: "x".repeat(70 * 1024) } }] }]));
  ok("17c. definition >64KB rejeitada", r.status === 400, `status=${r.status}`);
  const muitosLivros = Array.from({ length: 51 }, (_, i) => ({ titulo: `L${i}`, itens: [] }));
  r = await apiM("POST", "/api/biblioteca/importar/previa", envelopeDe(muitosLivros));
  ok("17d. >50 livros rejeitado", r.status === 400, `status=${r.status}`);
  r = await apiM("POST", "/api/biblioteca/importar/previa", "não-json");
  ok("17e. corpo não-objeto rejeitado", r.status === 400 || r.status === 500, `status=${r.status}`);

  // item duplicado kind:key dentro do mesmo livro do envelope
  r = await apiM("POST", "/api/biblioteca/importar/previa", envelopeDe([{ titulo: "dup", itens: [
    { kind: "a", key: "x", name: "1" }, { kind: "a", key: "x", name: "2" },
  ] }]));
  ok("17f. kind:key duplicado no envelope rejeitado", r.status === 400, `status=${r.status}`);

  // ---------- 18) biblioteca por campanha intacta ----------
  r = await apiM("GET", `/api/campaigns/${CID}/regras/elementos`);
  ok("18. biblioteca por campanha continua funcionando", r.status === 200 && Array.isArray(r.json?.elementos ?? r.json), `status=${r.status}`);

  // metadados editáveis via PATCH
  r = await apiM("PATCH", `/api/biblioteca/livros/${idA}`, { sistema: "Sistema Y" });
  ok("PATCH metadados", r.status === 200 && r.json?.livro?.sistema === "Sistema Y", `status=${r.status}`);

  // lista/busca
  r = await apiM("GET", `/api/biblioteca/livros?q=${encodeURIComponent(SUFIXO)}`);
  ok("busca por sufixo encontra livros de teste", r.status === 200 && r.json.total >= 2, `total=${r.json?.total}`);

} finally {
  // ---------- limpeza ----------
  for (const id of livrosTeste.filter(Boolean)) {
    try { await apiM("DELETE", `/api/biblioteca/livros/${id}`); } catch { }
  }
  try { srv.kill(); } catch { }
  db.close();
  rmSync(DIR, { recursive: true, force: true });
}

const falhas = resultados.filter((x) => !x.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} ok`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
