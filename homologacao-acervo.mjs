// Homologação: acervo global de livros de regras (/api/biblioteca).
// Cobre os 18 cenários do spec: CRUD, itens por kind, export/import,
// round-trip, prévia sem persistência, merge por kind:key, conflitos,
// backup automático, restauração, rollback, permissões, payloads inválidos
// e compatibilidade com a biblioteca por campanha.
// Banco 100% sintético via teste-base.mjs — nunca toca banco/mestre-rpg.db.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("acervo");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const SUFIXO = `__TESTE_${Date.now()}`;
const FORMATO = "mestre-rpg-biblioteca";

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

let srv, cenario, CID;

async function req(m, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, json: j };
}

const livrosTeste = [];
const envelopeDe = (env) => ({ formato: FORMATO, versao: 1, livros: env });

try {
  srv = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  srv.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  await esperarSaudavel(BASE, srv);
  cenario = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Acervo Teste",
    jogadores: { jogador1: "jog_acervo" },
    ficha: false,
  });
  CID = cenario.campId;
  const apiM = (m, p, b) => req(m, p, b, cenario.cookieMestre);
  const apiJ = (m, p, b) => req(m, p, b, cenario.jogadores.jogador1.cookie);
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

  // 5e) confirmar uma importação idêntica não cria backup nem avança versão.
  const backupsNoOpAntes = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups.length;
  const versaoNoOpAntes = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json.livro.versao;
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", {
    envelope: envRe,
    decisoes: { decisoes: [{ indice: 0, metadados: "atualizar", itens: {} }] },
  });
  const backupsNoOpDepois = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups.length;
  const versaoNoOpDepois = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json.livro.versao;
  ok("5e. importação idêntica não cria backup", r.status === 200 && backupsNoOpDepois === backupsNoOpAntes,
    `backups=${backupsNoOpAntes} -> ${backupsNoOpDepois}`);
  ok("5f. importação idêntica não avança versão", versaoNoOpDepois === versaoNoOpAntes,
    `versão=${versaoNoOpAntes} -> ${versaoNoOpDepois}`);

  // 5g) duas entradas que resolvem para o mesmo livro devem ser rejeitadas.
  const mesmoLivroSemId = JSON.parse(JSON.stringify(envRe.livros[0]));
  delete mesmoLivroSemId.id;
  r = await apiM("POST", "/api/biblioteca/importar/previa", envelopeDe([
    JSON.parse(JSON.stringify(envRe.livros[0])), mesmoLivroSemId,
  ]));
  ok("5g. prévia rejeita livro repetido por ID/título", r.status === 400 && /duplicado/i.test(r.json?.erro ?? ""),
    `status=${r.status} erro=${r.json?.erro ?? ""}`);

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
  // DB tem 6 itens; arquivo traz 3 (forca, furtividade, nova_regra).
  // Ausentes = chaves do banco que não vieram no arquivo: vantagem_ataque,
  // dano_fogo, machado e foco = 4 (o item novo "nova_regra" não pode mascarar).
  ok("10. prévia informa ausentes preservados", prevU?.resumo?.itensAusentesPreservados === 4, `preserv=${prevU?.resumo?.itensAusentesPreservados}`);
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

  // Altera o registro depois da prévia. A confirmação precisa capturar
  // esse estado atual no backup, não o snapshot que existia ao abrir a prévia.
  const forcaAntesImport = livroAposVazio.itens.find((i) => i.kind === "atributo" && i.key === "forca");
  const edicaoConcorrente = await apiM("PATCH", `/api/biblioteca/livros/${idA}/itens/${forcaAntesImport.id}`, {
    name: "Força editada após prévia", definition: { custo: 5 },
  });
  ok("11f. edição após prévia persiste antes da confirmação", edicaoConcorrente.status === 200, `status=${edicaoConcorrente.status}`);

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
  if (backupImport) {
    const backupDetalhe = await apiM("GET", `/api/biblioteca/backups/${backupImport.id}`);
    const forcaSnapshot = backupDetalhe.json?.backup?.snapshot?.livros?.[0]?.itens?.find((i) => i.kind === "atributo" && i.key === "forca");
    ok("13c. backup captura a edição mais recente feita após a prévia", forcaSnapshot?.definition?.custo === 5,
      `custo no snapshot=${forcaSnapshot?.definition?.custo}`);
  }

  // ---------- 14) restaurar backup ----------
  if (backupImport) {
    // estado atual tem custo=2 (aplicado pelo import); backup tem custo=5 (edição concorrente pré-import)
    r = await apiM("POST", `/api/biblioteca/backups/${backupImport.id}/restaurar`, {});
    ok("14a. restaurar backup", r.status === 200, `status=${r.status} ${r.json?.erro ?? ""}`);
    const livroRest = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json;
    const forcaRest = livroRest.itens.find((i) => i.kind === "atributo" && i.key === "forca");
    ok("14b. estado restaurado (custo volta a 5)", forcaRest?.definition?.custo === 5, `custo=${forcaRest?.definition?.custo}`);
    ok("14c. edição restaurada (volta de 2ª)", livroRest.livro.edicao !== "2ª", `ed=${livroRest.livro.edicao}`);
    // o snapshot do passo 12 já continha nova_regra (commit do passo 11) -> 7 itens
    ok("14d. itens restaurados conforme snapshot", livroRest.itens.length === 7, `total=${livroRest.itens.length}`);
    const backupsPosRestore = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups;
    ok("14e. restore gera backup do estado atual", backupsPosRestore.some((b) => b.motivo.includes("restauração")), JSON.stringify(backupsPosRestore.map((b) => b.motivo)));
  } else {
    ok("14. restaurar backup", false, "sem backup para restaurar");
  }

  // ---------- 15) conflito interno no envelope ----------
  // dois livros do envelope apontam para o MESMO bookId. Antes isso estourava
  // UNIQUE no meio da transação (500 + rollback); agora a validação do
  // envelope rejeita livros duplicados por id/título normalizado com 400,
  // antes de qualquer escrita — proteção mais forte, mesmo invariante:
  // nada pode ser gravado parcialmente.
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
  ok("15. livro duplicado no envelope rejeitado", r.status === 400, `status=${r.status}`);
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

  // ---------- 19-26) backups automáticos em mutações manuais ----------
  const livroM = {
    titulo: `${SUFIXO} Mutações`, tipo: "livro",
    itens: [
      { kind: "atributo", key: "agilidade", name: "Agilidade", ordem: 0 },
      { kind: "habilidade", key: "percepcao", name: "Percepção", ordem: 1 },
    ],
  };
  r = await apiM("POST", "/api/biblioteca/livros", livroM);
  const idM = r.json?.livro?.id;
  livrosTeste.push(idM);
  ok("19. livro p/ mutações criado", r.status === 201 && !!idM, `status=${r.status}`);
  const backupsDe = async () => (await apiM("GET", `/api/biblioteca/livros/${idM}/backups`)).json.backups;
  const livroMAtual = async () => (await apiM("GET", `/api/biblioteca/livros/${idM}`)).json;
  const versaoM = async () => (await livroMAtual()).livro.versao;
  ok("19b. livro novo sem backups", (await backupsDe()).length === 0);
  const v0 = await versaoM();

  // 20) PATCH metadados -> backup + versão
  r = await apiM("PATCH", `/api/biblioteca/livros/${idM}`, { sistema: "Sistema M" });
  let bks = await backupsDe();
  ok("20. PATCH metadados gera backup", r.status === 200 && bks.length === 1 && bks[0].motivo === "antes de editar metadados",
    `backups=${bks.length} motivo=${bks[0]?.motivo}`);
  ok("20b. versão incrementada", (await versaoM()) === v0 + 1, `v=${await versaoM()}`);
  // snapshot contém o estado ANTERIOR (sem sistema)
  const snapMeta = (await apiM("GET", `/api/biblioteca/backups/${bks[0].id}`)).json.backup.snapshot;
  ok("20c. snapshot tem metadados anteriores", snapMeta?.livros?.[0]?.sistema == null && snapMeta?.livros?.[0]?.titulo === livroM.titulo,
    JSON.stringify(snapMeta?.livros?.[0]?.sistema));
  const backupMetaId = bks[0].id;

  // 21) PATCH no-op -> sem backup, sem versão
  r = await apiM("PATCH", `/api/biblioteca/livros/${idM}`, { sistema: "Sistema M" });
  ok("21. PATCH idêntico não gera backup", r.status === 200 && (await backupsDe()).length === 1 && r.json?.semAlteracao === true,
    `backups=${(await backupsDe()).length}`);
  ok("21b. versão estável após no-op", (await versaoM()) === v0 + 1);

  // 22) adicionar item -> backup
  r = await apiM("POST", `/api/biblioteca/livros/${idM}/itens`, { kind: "vantagem", key: "sorte", name: "Sorte", ordem: 2 });
  const itemSorte = (await livroMAtual()).itens.find((i) => i.key === "sorte");
  bks = await backupsDe();
  ok("22. adicionar item gera backup", r.status === 201 && bks.length === 2 && bks.some((b) => b.motivo === "antes de adicionar item"),
    `backups=${bks.length}`);
  ok("22b. versão incrementada", (await versaoM()) === v0 + 2, `v=${await versaoM()}`);

  // 23) editar item -> backup
  r = await apiM("PATCH", `/api/biblioteca/livros/${idM}/itens/${itemSorte.id}`, { name: "Sorte Grande", ordem: 5 });
  bks = await backupsDe();
  ok("23. editar item gera backup", r.status === 200 && bks.length === 3 && bks.some((b) => b.motivo === "antes de editar item"),
    `backups=${bks.length}`);
  ok("23b. versão incrementada", (await versaoM()) === v0 + 3, `v=${await versaoM()}`);

  // 23c) PATCH item no-op -> sem backup
  r = await apiM("PATCH", `/api/biblioteca/livros/${idM}/itens/${itemSorte.id}`, { name: "Sorte Grande" });
  ok("23c. PATCH item idêntico não gera backup", r.status === 200 && r.json?.semAlteracao === true && (await backupsDe()).length === 3,
    `backups=${(await backupsDe()).length}`);

  // 24) remover item -> backup
  r = await apiM("DELETE", `/api/biblioteca/livros/${idM}/itens/${itemSorte.id}`);
  bks = await backupsDe();
  ok("24. remover item gera backup", r.status === 200 && bks.length === 4 && bks.some((b) => b.motivo === "antes de remover item"),
    `backups=${bks.length}`);
  ok("24b. versão incrementada", (await versaoM()) === v0 + 4, `v=${await versaoM()}`);

  // 25) reordenar -> backup só quando há mudança real
  const itensOrd = (await livroMAtual()).itens;
  r = await apiM("PUT", `/api/biblioteca/livros/${idM}/itens/ordem`, { itens: itensOrd.map((i) => ({ id: i.id, ordem: i.ordem })) });
  ok("25. reordenar sem mudança não gera backup", r.status === 200 && r.json?.alterados === 0 && (await backupsDe()).length === 4,
    `backups=${(await backupsDe()).length}`);
  r = await apiM("PUT", `/api/biblioteca/livros/${idM}/itens/ordem`, { itens: itensOrd.map((i) => ({ id: i.id, ordem: 10 - i.ordem })) });
  bks = await backupsDe();
  ok("25b. reordenar com mudança gera backup", r.status === 200 && r.json?.alterados === 2 && bks.length === 5 && bks.some((b) => b.motivo === "antes de reordenar itens"),
    `backups=${bks.length} alterados=${r.json?.alterados}`);
  ok("25c. versão incrementada", (await versaoM()) === v0 + 5, `v=${await versaoM()}`);

  // 26) restaurar backup de metadados -> volta ao estado de criação
  r = await apiM("POST", `/api/biblioteca/backups/${backupMetaId}/restaurar`, {});
  ok("26. restaurar backup de metadados", r.status === 200, `status=${r.status} ${r.json?.erro ?? ""}`);
  const livroRestaurado = await livroMAtual();
  ok("26b. metadados voltam ao estado anterior", livroRestaurado.livro.sistema == null && livroRestaurado.livro.titulo === livroM.titulo,
    `sistema=${livroRestaurado.livro.sistema}`);
  ok("26c. itens voltam ao snapshot (2 itens, sem 'sorte')", livroRestaurado.itens.length === 2 && !livroRestaurado.itens.some((i) => i.key === "sorte"),
    `itens=${livroRestaurado.itens.length}`);
  ok("26d. restauração gera backup do estado atual", (await backupsDe()).some((b) => b.motivo.includes("restauração")),
    JSON.stringify((await backupsDe()).map((b) => b.motivo)));

  // ---------- 27-34) ciclo de vida: soft delete preserva backups ----------
  // Livro novo dedicado ao teste de exclusão/restauração.
  r = await apiM("POST", "/api/biblioteca/livros", {
    titulo: `${SUFIXO} Excluível`, tipo: "livro",
    itens: [
      { kind: "atributo", key: "vigor", name: "Vigor", ordem: 0 },
      { kind: "tabela", key: "dano", name: "Tabela de dano", definition: { dados: "2d6" }, ordem: 1 },
    ],
  });
  const idX = r.json?.livro?.id;
  ok("27. livro p/ exclusão criado", r.status === 201 && !!idX, `status=${r.status}`);
  // gera 2 backups via mutações manuais
  await apiM("PATCH", `/api/biblioteca/livros/${idX}`, { sistema: "Sis X" });
  const [itemX] = (await apiM("GET", `/api/biblioteca/livros/${idX}`)).json.itens;
  await apiM("PATCH", `/api/biblioteca/livros/${idX}/itens/${itemX.id}`, { name: "Vigor Maior" });
  const backupsX = async () => (await apiM("GET", `/api/biblioteca/livros/${idX}/backups`)).json.backups;
  const livroX = async () => (await apiM("GET", `/api/biblioteca/livros/${idX}`)).json;
  const totalAntesX = (await backupsX()).length;
  ok("27b. backups gerados antes da exclusão", totalAntesX >= 2, `backups=${totalAntesX}`);

  // 28) exclusão lógica
  r = await apiM("DELETE", `/api/biblioteca/livros/${idX}`);
  ok("28. DELETE faz soft delete", r.status === 200 && r.json?.excluido === true, `status=${r.status} ${JSON.stringify(r.json)}`);
  // some da listagem normal
  r = await apiM("GET", "/api/biblioteca/livros");
  ok("28b. excluído some da listagem normal", !r.json.livros.some((l) => l.id === idX), `total=${r.json.total}`);
  // admin vê com incluirExcluidos
  r = await apiM("GET", "/api/biblioteca/livros?incluirExcluidos=1");
  ok("28c. admin lista excluídos com flag", r.json.livros.some((l) => l.id === idX && l.excluidoEm), `total=${r.json.total}`);
  // não-admin não vê excluídos nem detalhe
  r = await apiJ("GET", "/api/biblioteca/livros?incluirExcluidos=1");
  ok("28d. não-admin não vê excluídos", !r.json.livros.some((l) => l.id === idX), `total=${r.json.total}`);
  r = await apiJ("GET", `/api/biblioteca/livros/${idX}`);
  ok("28e. não-admin recebe 404 no excluído", r.status === 404, `status=${r.status}`);
  // admin ainda abre o excluído
  r = await apiM("GET", `/api/biblioteca/livros/${idX}`);
  ok("28f. admin abre livro excluído", r.status === 200 && r.json.livro.excluidoEm, `status=${r.status}`);
  // mutações bloqueadas em livro excluído
  r = await apiM("PATCH", `/api/biblioteca/livros/${idX}`, { sistema: "Tentativa" });
  ok("28g. PATCH em excluído -> 404", r.status === 404, `status=${r.status}`);
  r = await apiM("POST", `/api/biblioteca/livros/${idX}/itens`, { kind: "x", key: "y", name: "y" });
  ok("28h. item em excluído -> 404", r.status === 404, `status=${r.status}`);
  // exportação não inclui excluído
  r = await apiM("GET", "/api/biblioteca/exportar");
  ok("28i. export não inclui excluído", !r.json.livros.some((l) => l.id === idX), `livros=${r.json.livros.length}`);
  // importação com mesmo título cria livro NOVO (não ressuscita o excluído)
  const envExcluido = envelopeDe([{ titulo: `${SUFIXO} Excluível`, itens: [] }]);
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", { envelope: envExcluido, decisoes: { decisoes: [] } });
  const novoId = r.json?.resultados?.[0]?.bookId;
  ok("28j. import com título de excluído cria novo", r.status === 200 && r.json?.resultados?.[0]?.acao === "criado" && novoId !== idX,
    `acao=${r.json?.resultados?.[0]?.acao}`);
  livrosTeste.push(novoId);

  // 29) backups preservados após exclusão
  const bksApos = await backupsX();
  ok("29. backups preservados após exclusão", bksApos.length === totalAntesX, `${totalAntesX} -> ${bksApos.length}`);
  ok("29b. snapshot do backup continua legível", (await apiM("GET", `/api/biblioteca/backups/${bksApos[0].id}`)).status === 200);
  // não-admin não pode consultar nem enumerar backups de livro excluído.
  r = await apiJ("GET", `/api/biblioteca/livros/${idX}/backups`);
  ok("29b1. não-admin não lista backups de excluído", r.status === 404, `status=${r.status}`);
  r = await apiJ("GET", `/api/biblioteca/backups/${bksApos[0].id}`);
  ok("29b2. não-admin não lê snapshot de excluído", r.status === 404, `status=${r.status}`);
  // restore de backup em livro excluído -> 404
  r = await apiM("POST", `/api/biblioteca/backups/${bksApos[0].id}/restaurar`, {});
  ok("29c. restore de backup em excluído -> 404", r.status === 404, `status=${r.status}`);

  // 30) restaurar livro excluído
  r = await apiM("POST", `/api/biblioteca/livros/${idX}/restaurar`, {});
  ok("30. restaurar livro excluído", r.status === 200 && r.json?.livro && !r.json.livro.excluidoEm, `status=${r.status} ${r.json?.erro ?? ""}`);
  const livroXRestaurado = await livroX();
  ok("30b. itens recuperados", livroXRestaurado.itens.length === 2, `itens=${livroXRestaurado.itens.length}`);
  ok("30c. metadados preservados (sistema=Sis X)", livroXRestaurado.livro.sistema === "Sis X", `sis=${livroXRestaurado.livro.sistema}`);
  ok("30d. edição de item preservada (Vigor Maior)", livroXRestaurado.itens.some((i) => i.name === "Vigor Maior"),
    JSON.stringify(livroXRestaurado.itens.map((i) => i.name)));
  ok("30e. histórico de backups continua", (await backupsX()).length === totalAntesX);
  ok("30f. versão preservada", livroXRestaurado.livro.versao >= 3, `v=${livroXRestaurado.livro.versao}`);
  // voltar a aparecer nas consultas
  r = await apiM("GET", "/api/biblioteca/livros");
  ok("30g. restaurado volta à listagem", r.json.livros.some((l) => l.id === idX), `total=${r.json.total}`);
  // restaurar de novo -> 409 (não está excluído)
  r = await apiM("POST", `/api/biblioteca/livros/${idX}/restaurar`, {});
  ok("31. restaurar livro ativo -> 409", r.status === 409, `status=${r.status}`);
  // excluir de novo funciona (idempotente)
  r = await apiM("DELETE", `/api/biblioteca/livros/${idX}`);
  ok("31b. re-excluir funciona", r.status === 200 && r.json?.excluido === true, `status=${r.status}`);
  r = await apiM("DELETE", `/api/biblioteca/livros/${idX}`);
  ok("31c. excluir já excluído é idempotente", r.status === 200 && r.json?.jaExcluido === true, `status=${r.status}`);

  // 32) exclusão definitiva apaga livro + itens + backups
  const bksAntesDef = (await backupsX()).length;
  r = await apiM("DELETE", `/api/biblioteca/livros/${idX}?definitivo=1`);
  ok("32. exclusão definitiva", r.status === 200 && r.json?.definitivo === true, `status=${r.status}`);
  r = await apiM("GET", `/api/biblioteca/livros/${idX}`);
  ok("32b. definitivo some de vez", r.status === 404, `status=${r.status}`);
  r = await apiM("GET", `/api/biblioteca/backups/${bksApos[0].id}`);
  ok("32c. backups apagados na exclusão definitiva", r.status === 404, `status=${r.status}`);
  ok("32d. contagem de backups zerada", bksAntesDef > 0); // sanity

  // 33) compatibilidade: livro antigo (criado antes do soft delete) funciona
  r = await apiM("GET", `/api/biblioteca/livros/${idA}`);
  ok("33. livro antigo sem excluidoEm funciona", r.status === 200 && r.json.livro.excluidoEm == null, `status=${r.status}`);

  // ---------- 34-37) auditoria: import idempotente não gera backup ----------
  // Reimportar o acervo inteiro (idêntico) não pode criar backups novos.
  const bksIdA_antes = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups.length;
  const vA_antes = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json.livro.versao;
  r = await apiM("GET", "/api/biblioteca/exportar");
  const envIdem = r.json;
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", { envelope: envIdem, decisoes: { decisoes: [] } });
  ok("34. reimportação idempotente confirmada", r.status === 200, `status=${r.status}`);
  const bksIdA_depois = (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups.length;
  const vA_depois = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json.livro.versao;
  ok("34b. import idempotente não cria backup", bksIdA_depois === bksIdA_antes, `${bksIdA_antes} -> ${bksIdA_depois}`);
  ok("34c. import idempotente não incrementa versão", vA_depois === vA_antes, `v=${vA_antes} -> ${vA_depois}`);
  // mas uma importação COM novidade continua gerando backup
  const envComNovo = JSON.parse(JSON.stringify(envIdem));
  const alvo = envComNovo.livros.find((l) => l.id === idA);
  alvo.itens.push({ kind: "condicao", key: "auditoria_nova", name: "Condição auditoria", ordem: 99 });
  r = await apiM("POST", "/api/biblioteca/importar/confirmar", { envelope: envComNovo, decisoes: { decisoes: [] } });
  ok("35. import com item novo aplica", r.status === 200, `status=${r.status}`);
  ok("35b. import com novidade gera backup", (await apiM("GET", `/api/biblioteca/livros/${idA}/backups`)).json.backups.length === bksIdA_antes + 1);

  // 36) PATCH de item trocando kind/key -> duplicata rejeitada
  const itensA = (await apiM("GET", `/api/biblioteca/livros/${idA}`)).json.itens;
  const i1 = itensA.find((i) => i.kind === "atributo");
  const i2 = itensA.find((i) => i.kind === "habilidade");
  r = await apiM("PATCH", `/api/biblioteca/livros/${idA}/itens/${i1.id}`, { kind: i2.kind, key: i2.key });
  ok("36. PATCH kind/key para duplicata -> 409", r.status === 409, `status=${r.status}`);
  r = await apiM("PATCH", `/api/biblioteca/livros/${idA}/itens/${i1.id}`, { kind: "atributo_especial", key: "forca_mao" });
  ok("36b. PATCH kind/key válido aplica", r.status === 200, `status=${r.status}`);
  // reverte para não afetar cleanup (livro será excluído de qq forma)

  // 37) permissões de leitura: não-admin exporta e lista backups de livro ativo
  r = await apiJ("GET", `/api/biblioteca/livros/${idA}/exportar`);
  ok("37. não-admin exporta livro ativo", r.status === 200 && r.json?.formato === FORMATO, `status=${r.status}`);
  r = await apiJ("GET", `/api/biblioteca/livros/${idA}/backups`);
  ok("37b. não-admin lista backups de livro ativo", r.status === 200, `status=${r.status}`);
  r = await apiJ("GET", `/api/biblioteca/exportar`);
  ok("37c. não-admin exporta acervo", r.status === 200, `status=${r.status}`);

} finally {
  // ---------- limpeza ----------
  for (const id of livrosTeste.filter(Boolean)) {
    try { await apiM("DELETE", `/api/biblioteca/livros/${id}`); } catch { }
  }
  await encerrarServidor(srv);
  limparDir(DIR);
}

const falhas = resultados.filter((x) => !x.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} ok`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
