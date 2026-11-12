// Testes complementares do adendo técnico — Acervo (Issue #12, PR #55).
// Cobre os 14 cenários do §10: prévia sem efeitos, fingerprint invalidando
// em mudanças manuais (defs, config, soft delete), snapshots legados,
// decisões persistidas, chaves extras, isolamento entre campanhas/livros,
// ordem semântica e colisão de chaves entre livros.
// Banco 100% temporário via teste-base.mjs.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, comDb, abrirDb, sessao, encerrarServidor, limparDir,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("acervo-sync");
const BANCO = `${DIR}/teste.db`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;

const livro = async (body) => {
  const r = await req(BASE, "POST", "/biblioteca/livros", { cookie: CM, body });
  return { status: r.status, id: r.json?.livro?.id, json: r.json };
};
const itensLivro = async (id) => (await req(BASE, "GET", `/biblioteca/livros/${id}`, { cookie: CM })).json?.itens ?? [];
const diff = (camp, book) => req(BASE, "GET", `/campaigns/${camp}/regras/acervo/${book}/diff`, { cookie: CM });
// A aplicação exige a impressão digital da prévia: busca o token do diff
// atual quando o chamador não informa um explicitamente (cenários de 409).
const aplicar = async (camp, book, body = {}) => {
  const token = body.estadoToken ?? (await diff(camp, book)).json?.estadoToken;
  return req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${book}/aplicar`, { cookie: CM, body: { ...body, estadoToken: token } });
};
const elId = (camp, kind, key) => comDb(BANCO, (db) => db.prepare(
  `select rd.id from rule_definitions rd join rule_sets rs on rs.id=rd.rule_set_id
   where rs.campaign_id=? and rd.kind=? and rd.key=?`,
).get(camp, kind, key)?.id);
const estadoBanco = () => comDb(BANCO, (db) => ({
  rulesets: db.prepare("select count(*) c from rule_sets").get().c,
  defs: db.prepare("select count(*) c from rule_definitions").get().c,
  vinculos: db.prepare("select count(*) c from campaign_rule_books").get().c,
  livros: db.prepare("select count(*) c from rule_books").get().c,
  itensLivro: db.prepare("select count(*) c from rule_book_items").get().c,
}));

let CM, camp1, camp2, l8ref;
try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Sync A", jogadores: {} });
  CM = cenario.cookieMestre;
  camp1 = cenario.campId;
  // segunda campanha do mesmo mestre — criarCenario só garante ruleset da primeira;
  // POST /campaigns não cria ruleset (lazy via carregarRegras)
  const c2 = await req(BASE, "POST", "/campaigns", { cookie: CM, body: { name: "Campanha Sync B" } });
  camp2 = c2.json?.campanha?.id;
  t("segunda campanha criada", c2.status === 201 && !!camp2, `status=${c2.status}`);

  // ===== 1-2. Prévia sem efeitos colaterais =====
  sec("1-2. Prévia sem efeitos (inclusive sem ruleset)");
  {
    const l1 = await livro({ titulo: "Livro S1", tipo: "livro", itens: [
      { kind: "atributo", key: "s1_forca", name: "Força S1", definition: {} },
    ] });
    const antes = estadoBanco();
    const rsAntes = comDb(BANCO, (db) => db.prepare("select count(*) c from rule_sets where campaign_id=?").get(camp2).c);
    const d = await diff(camp2, l1.id);
    t("diff sem ruleset → 200 com estado vazio", d.status === 200 && d.json?.totais?.novos === 1, JSON.stringify(d.json?.totais));
    const rsDepois = comDb(BANCO, (db) => db.prepare("select count(*) c from rule_sets where campaign_id=?").get(camp2).c);
    t("prévia NÃO criou ruleset", rsAntes === 0 && rsDepois === 0, `${rsAntes}->${rsDepois}`);
    const depois = estadoBanco();
    t("prévia não alterou nenhum registro", JSON.stringify(antes) === JSON.stringify(depois), `${JSON.stringify(antes)} vs ${JSON.stringify(depois)}`);
    const ts = comDb(BANCO, (db) => db.prepare("select updated_at from rule_books where id=?").get(l1.id)?.updated_at);
    await diff(camp2, l1.id);
    const ts2 = comDb(BANCO, (db) => db.prepare("select updated_at from rule_books where id=?").get(l1.id)?.updated_at);
    t("timestamps intactos após prévia", ts === ts2, `${ts} vs ${ts2}`);
    await aplicar(camp2, l1.id);
  }

  // ===== 3-6. Fingerprint invalida prévia em mudanças manuais =====
  sec("3-6. estadoToken invalida após mudança manual");
  {
    const l2 = await livro({ titulo: "Livro S2", tipo: "livro", itens: [
      { kind: "talento", key: "s2_talento", name: "Talento S2", definition: { descricao: "v1" } },
    ] });
    await aplicar(camp1, l2.id);
    const d0 = await diff(camp1, l2.id);
    const token = d0.json?.estadoToken;
    t("diff expõe estadoToken", typeof token === "string" && token.length === 64, String(token));

    // 3) mudança manual em rule_definitions
    const el = elId(camp1, "talento", "s2_talento");
    await req(BASE, "PATCH", `/campaigns/${camp1}/regras/elementos/${el}`, { cookie: CM, body: { name: "Talento Renomeado" } });
    const r3 = await aplicar(camp1, l2.id, { estadoToken: token });
    t("mudança em rule_definitions → 409", r3.status === 409, `status=${r3.status}`);
    // desfaz a mudança para o próximo cenário
    await req(BASE, "PATCH", `/campaigns/${camp1}/regras/elementos/${el}`, { cookie: CM, body: { name: "Talento S2" } });

    // 4) exclusão manual de rule_definitions
    const d1 = await diff(camp1, l2.id);
    const token2 = d1.json?.estadoToken;
    await req(BASE, "DELETE", `/campaigns/${camp1}/regras/elementos/${el}`, { cookie: CM });
    const r4 = await aplicar(camp1, l2.id, { estadoToken: token2 });
    t("exclusão de rule_definitions → 409", r4.status === 409, `status=${r4.status}`);
    // restaura via nova aplicação (conflito preservar_remocao → usar_livro)
    const r4b = await aplicar(camp1, l2.id, { decisoes: { "talento:s2_talento": "usar_livro" } });
    t("restauração pós-409 via decisão", r4b.status === 200, `status=${r4b.status}`);

    // 5) mudança de config do ruleset
    const d2 = await diff(camp1, l2.id);
    const token3 = d2.json?.estadoToken;
    const cfg = await req(BASE, "PUT", `/campaigns/${camp1}/regras/config`, { cookie: CM, body: { aprovacaoAutomatica: true } });
    t("config do ruleset alterada", cfg.status === 200, `status=${cfg.status}`);
    const r5 = await aplicar(camp1, l2.id, { estadoToken: token3 });
    t("mudança de config → 409", r5.status === 409, `status=${r5.status}`);
    await req(BASE, "PUT", `/campaigns/${camp1}/regras/config`, { cookie: CM, body: { aprovacaoAutomatica: false } });

    // 6) soft delete + restauração do livro
    const d3 = await diff(camp1, l2.id);
    const token4 = d3.json?.estadoToken;
    await req(BASE, "DELETE", `/biblioteca/livros/${l2.id}`, { cookie: CM });
    const dDel = await diff(camp1, l2.id);
    t("diff de livro excluído → 404", dDel.status === 404, `status=${dDel.status}`);
    await req(BASE, "POST", `/biblioteca/livros/${l2.id}/restaurar`, { cookie: CM });
    const r6 = await aplicar(camp1, l2.id, { estadoToken: token4 });
    t("restauração altera fingerprint → 409", r6.status === 409, `status=${r6.status}`);
  }

  // ===== 7. Snapshot legado em array =====
  sec("7. Snapshot legado (array) sincronizável");
  {
    const l3 = await livro({ titulo: "Livro S3", tipo: "livro", itens: [
      { kind: "pericia", key: "s3_pericia", name: "Perícia S3", definition: {} },
    ] });
    await aplicar(camp2, l3.id);
    // regrava o snapshot do vínculo no formato legado (array puro)
    const snapLegado = comDb(BANCO, (db) => db.prepare(
      "select snapshot from campaign_rule_books where campaign_id=? and book_id=?",
    ).get(camp2, l3.id)?.snapshot);
    const arr = JSON.parse(snapLegado).itens ?? JSON.parse(snapLegado);
    const dbw = abrirDb(BANCO);
    try {
      dbw.prepare(
        "update campaign_rule_books set snapshot=? where campaign_id=? and book_id=?",
      ).run(JSON.stringify(arr), camp2, l3.id);
    } finally { dbw.close(); }
    const dLeg = await diff(camp2, l3.id);
    t("diff com snapshot legado → idênticos, sem conflitos",
      dLeg.status === 200 && dLeg.json?.totais?.identicos === 1 && dLeg.json?.totais?.conflitos === 0,
      JSON.stringify(dLeg.json?.totais));
    const rLeg = await aplicar(camp2, l3.id);
    t("aplicar com snapshot legado → 200", rLeg.status === 200, `status=${rLeg.status}`);
  }

  // ===== 8-9. Decisão persistida: idempotência e nova edição =====
  sec("8-9. Decisões persistidas");
  {
    const l4 = await livro({ titulo: "Livro S4", tipo: "livro", itens: [
      { kind: "vantagem", key: "s4_vant", name: "Vantagem S4", definition: { descricao: "livro" } },
    ] });
    await aplicar(camp1, l4.id);
    // campanha remove manualmente → conflito preservar_remocao → decide preservar
    const el = elId(camp1, "vantagem", "s4_vant");
    await req(BASE, "DELETE", `/campaigns/${camp1}/regras/elementos/${el}`, { cookie: CM });
    const dP = await diff(camp1, l4.id);
    t("remoção local gera conflito preservar_remocao",
      dP.json?.conflitos?.some((c) => c.chave === "vantagem:s4_vant" && c.tipo === "preservar_remocao"),
      JSON.stringify(dP.json?.conflitos));
    const rP = await aplicar(camp1, l4.id, { decisoes: { "vantagem:s4_vant": "preservar_remocao" } });
    t("preservar_remocao aplicado", rP.status === 200, `status=${rP.status}`);
    // nova prévia sem mudanças: conflito NÃO se repete
    const dP2 = await diff(camp1, l4.id);
    t("decisão persistida não repete conflito",
      dP2.status === 200 && !dP2.json?.conflitos?.length && (dP2.json?.totais?.resolvidos ?? 0) >= 1,
      JSON.stringify(dP2.json?.totais) + " " + JSON.stringify(dP2.json?.conflitos));
    const rP2 = await aplicar(camp1, l4.id);
    t("reaplicação após decisão → 200 sem novo conflito", rP2.status === 200, `status=${rP2.status}`);
    // 9) nova edição do livro invalida a decisão → conflito volta
    const it = (await itensLivro(l4.id))[0];
    await req(BASE, "PATCH", `/biblioteca/livros/${l4.id}/itens/${it.id}`, { cookie: CM, body: { name: "Vantagem S4 v2" } });
    const dP3 = await diff(camp1, l4.id);
    t("nova edição do livro exige nova avaliação",
      dP3.json?.conflitos?.some((c) => c.chave === "vantagem:s4_vant"),
      JSON.stringify(dP3.json?.conflitos));
  }

  // ===== 10. Chave extra rejeitada =====
  sec("10. Validação exata de decisões");
  {
    const l5 = await livro({ titulo: "Livro S5", tipo: "livro", itens: [
      { kind: "defeito", key: "s5_def", name: "Defeito S5", definition: { descricao: "x" } },
    ] });
    await aplicar(camp2, l5.id);
    const el = elId(camp2, "defeito", "s5_def");
    await req(BASE, "PATCH", `/campaigns/${camp2}/regras/elementos/${el}`, { cookie: CM, body: { name: "Defeito local" } });
    const rE = await aplicar(camp2, l5.id, { decisoes: { "defeito:s5_def": "usar_livro", "talento:inexistente": "manter_campanha" } });
    t("decisão com chave extra → 409", rE.status === 409, `status=${rE.status}`);
    const det = JSON.stringify(rE.json?.detalhes ?? rE.json);
    t("resposta lista chave extra", det.includes("talento:inexistente"), det.slice(0, 200));
    // decisão de uma chave não autoriza outra
    const rE2 = await aplicar(camp2, l5.id, { decisoes: { "atributo:outra": "usar_livro" } });
    t("decisão de chave errada → 409", rE2.status === 409, `status=${rE2.status}`);
    const ok = await aplicar(camp2, l5.id, { decisoes: { "defeito:s5_def": "manter_campanha" } });
    t("decisão correta → 200", ok.status === 200, `status=${ok.status}`);
  }

  // ===== 11. Isolamento entre campanhas e livros =====
  sec("11. Isolamento campanhas/livros");
  {
    const l6 = await livro({ titulo: "Livro S6", tipo: "livro", itens: [
      { kind: "conhecimento", key: "s6_conh", name: "Conhecimento S6", definition: { descricao: "v" } },
    ] });
    await aplicar(camp1, l6.id);
    // mesma situação em camp2: divergência local independente
    await aplicar(camp2, l6.id);
    const el2 = elId(camp2, "conhecimento", "s6_conh");
    await req(BASE, "PATCH", `/campaigns/${camp2}/regras/elementos/${el2}`, { cookie: CM, body: { name: "Conhecimento B local" } });
    const dA = await diff(camp1, l6.id);
    const dB = await diff(camp2, l6.id);
    t("camp1 sem conflito / camp2 com conflito (independentes)",
      !dA.json?.conflitos?.length && dB.json?.conflitos?.some((c) => c.chave === "conhecimento:s6_conh"),
      `A=${JSON.stringify(dA.json?.conflitos)} B=${JSON.stringify(dB.json?.conflitos)}`);
    // decisão em camp2 não vaza para camp1 nem autoriza nada lá
    await aplicar(camp2, l6.id, { decisoes: { "conhecimento:s6_conh": "manter_campanha" } });
    const dA2 = await diff(camp1, l6.id);
    t("decisão de camp2 não altera avaliação de camp1", !dA2.json?.conflitos?.length, JSON.stringify(dA2.json?.conflitos));
  }

  // ===== 12. Ordem semântica =====
  sec("12. Ordem de itens não gera falso conflito");
  {
    const l7 = await livro({ titulo: "Livro S7", tipo: "livro", itens: [
      { kind: "item", key: "s7_a", name: "Item A", definition: { d: 1 } },
      { kind: "item", key: "s7_b", name: "Item B", definition: { d: 2 } },
      { kind: "item", key: "s7_c", name: "Item C", definition: { d: 3 } },
    ] });
    await aplicar(camp1, l7.id);
    // reordena itens do livro (mesmo conteúdo)
    const its = await itensLivro(l7.id);
    const ids = its.map((i) => i.id).reverse();
    const ord = await req(BASE, "PUT", `/biblioteca/livros/${l7.id}/itens/ordem`, {
      cookie: CM, body: { itens: ids.map((id, i) => ({ id, ordem: i + 1 })) },
    });
    t("reordenação aceita", ord.status === 200, `status=${ord.status}`);
    const dOrd = await diff(camp1, l7.id);
    t("reordenação sem mudança semântica → sem conflitos",
      dOrd.status === 200 && dOrd.json?.totais?.conflitos === 0 && dOrd.json?.totais?.identicos === 3,
      JSON.stringify(dOrd.json?.totais));
    const rOrd = await aplicar(camp1, l7.id);
    t("aplicação após reordenação → ok", rOrd.status === 200, `status=${rOrd.status}`);
  }

  // ===== 13-14. Dois livros, mesma chave =====
  sec("13-14. Colisão de chave entre livros");
  {
    const mk = (titulo, desc) => livro({ titulo, tipo: "livro", itens: [
      { kind: "habilidade", key: "compartilhada", name: "Habilidade X", definition: { descricao: desc } },
    ] });
    const lA = await mk("Livro Colide A", "versão A");
    const lB = await mk("Livro Colide B", "versão B");
    await aplicar(camp2, lA.id);
    const snapAVel = comDb(BANCO, (db) => db.prepare(
      "select snapshot from campaign_rule_books where campaign_id=? and book_id=?",
    ).get(camp2, lA.id)?.snapshot);
    // livro B com MESMA chave e conteúdo IDÊNTICO ao atual da campanha → ainda é conflito
    const lB2 = await livro({ titulo: "Livro Colide B2", tipo: "livro", itens: [
      { kind: "habilidade", key: "compartilhada", name: "Habilidade X", definition: { descricao: "versão A" } },
    ] });
    const dCol = await diff(camp2, lB2.id);
    t("mesma chave de outro livro → conflito mesmo idêntico",
      dCol.json?.conflitos?.some((c) => c.chave === "habilidade:compartilhada" && c.tipo === "colisao"),
      JSON.stringify(dCol.json?.conflitos) + JSON.stringify(dCol.json?.totais));
    // usar_livro do B2 sobrescreve o elemento compartilhado (decisão explícita)
    const rCol = await aplicar(camp2, lB2.id, { decisoes: { "habilidade:compartilhada": "usar_livro" } });
    t("colisão resolvida por decisão explícita", rCol.status === 200, `status=${rCol.status}`);
    // 14) snapshot do livro A NÃO foi tocado pela sincronização de B2
    const snapApos = comDb(BANCO, (db) => db.prepare(
      "select snapshot from campaign_rule_books where campaign_id=? and book_id=?",
    ).get(camp2, lA.id)?.snapshot);
    t("livro A: snapshot intacto após sync de outro livro", snapAVel === snapApos, "snapshot divergiu");
    // livro B original (versão B) agora diverge → conflito de conteúdo
    const dB = await diff(camp2, lB.id);
    t("segundo livro com mesma chave → novo conflito", dB.json?.conflitos?.length >= 1, JSON.stringify(dB.json?.conflitos));
  }

  // ===== 15. Três estados: mudança somente no livro =====
  sec("15. Três estados — mudança somente no livro");
  {
    const l8 = await livro({ titulo: "Livro SL", tipo: "livro", itens: [
      { kind: "pericia", key: "sl_per", name: "Perícia SL", definition: { descricao: "v1" } },
    ] });
    l8ref = l8.id;
    await aplicar(camp1, l8.id);
    const it8 = (await itensLivro(l8.id))[0];
    await req(BASE, "PATCH", `/biblioteca/livros/${l8.id}/itens/${it8.id}`, { cookie: CM, body: { definition: { descricao: "v2 livro" } } });
    const dSL = await diff(camp1, l8.id);
    const itemSL = (dSL.json?.itens ?? []).find((i) => i.chave === "pericia:sl_per");
    t("prévia classifica mudança só no livro como atualizar",
      itemSL?.tipo === "atualizar" && itemSL?.origem === "so_livro" && dSL.json?.totais?.atualizar === 1,
      JSON.stringify(itemSL));
    t("mudança só no livro não exige decisão",
      !(dSL.json?.conflitos ?? []).some((c) => c.chave === "pericia:sl_per"), JSON.stringify(dSL.json?.conflitos));
    const rSL = await aplicar(camp1, l8.id);
    t("sync aplica atualização do livro sem decisão", rSL.status === 200 && rSL.json?.atualizados >= 1, JSON.stringify(rSL.json));
    const elSL = await req(BASE, "GET", `/campaigns/${camp1}/regras/elementos`, { cookie: CM });
    t("valor do livro v2 aplicado na campanha", JSON.stringify(elSL.json).includes("v2 livro"), "");

    // convergência: campanha editada manualmente para o MESMO valor do livro
    const elIdSL = elId(camp1, "pericia", "sl_per");
    await req(BASE, "PATCH", `/campaigns/${camp1}/regras/elementos/${elIdSL}`, { cookie: CM, body: { definition: { descricao: "v3 livro" } } });
    const it8b = (await itensLivro(l8.id))[0];
    await req(BASE, "PATCH", `/biblioteca/livros/${l8.id}/itens/${it8b.id}`, { cookie: CM, body: { definition: { descricao: "v3 livro" } } });
    const dCV = await diff(camp1, l8.id);
    const itemCV = (dCV.json?.itens ?? []).find((i) => i.chave === "pericia:sl_per");
    t("mudanças independentes convergindo → convergido sem conflito",
      itemCV?.tipo === "convergido" && !(dCV.json?.conflitos ?? []).some((c) => c.chave === "pericia:sl_per"),
      JSON.stringify(itemCV) + " " + JSON.stringify(dCV.json?.conflitos));

    // item removido do livro → preservado na campanha, fora dos pendentes
    const l8itens = await itensLivro(l8.id);
    await req(BASE, "DELETE", `/biblioteca/livros/${l8.id}/itens/${l8itens[0].id}`, { cookie: CM });
    const dRM = await diff(camp1, l8.id);
    const itemRM = (dRM.json?.itens ?? []).find((i) => i.chave === "pericia:sl_per");
    t("item removido do livro → removido_livro preservado",
      itemRM?.tipo === "removido_livro" && dRM.json?.totais?.removidosDoLivro === 1
        && !(dRM.json?.conflitos ?? []).some((c) => c.chave === "pericia:sl_per"),
      JSON.stringify(itemRM) + " " + JSON.stringify(dRM.json?.totais));
    const rRM = await aplicar(camp1, l8.id);
    t("sync de livro sem o item → 200", rRM.status === 200, `status=${rRM.status}`);
    const elAposRM = await req(BASE, "GET", `/campaigns/${camp1}/regras/elementos`, { cookie: CM });
    t("regra removida do livro permanece na campanha", JSON.stringify(elAposRM.json).includes("sl_per"), "");
    // vínculo de l8 segue na campanha para o teste de remoção de vínculo
  }

  // ===== 16. Remoção de vínculo =====
  sec("16. Remoção de vínculo (só mestre, preserva ruleset)");
  {
    // usuário jogador e espectador sintéticos na camp1
    const dbu = abrirDb(BANCO);
    const agora = Date.now();
    const mkCookie = async (username, display, role) => {
      const uid = crypto.randomUUID();
      dbu.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
        .run(uid, username, display, await hashSenha("senha-x-123"), agora, agora);
      dbu.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'" + role + "','ativo',?,?,?)")
        .run(crypto.randomUUID(), camp1, uid, agora, agora, agora);
      return sessao(BANCO, uid);
    };
    const cookieJ = await mkCookie("jog_sync", "Jogador Sync", "jogador");
    const cookieE = await mkCookie("esp_sync", "Espectador Sync", "espectador");
    dbu.close();

    const defsAntes = comDb(BANCO, (db) => db.prepare(
      `select count(*) c from rule_definitions rd join rule_sets rs on rs.id=rd.rule_set_id where rs.campaign_id=?`,
    ).get(camp1).c);
    const vincAntes = comDb(BANCO, (db) => db.prepare(
      "select count(*) c from campaign_rule_books where campaign_id=? and book_id=?",
    ).get(camp1, l8ref).c);

    const delJ = await req(BASE, "DELETE", `/campaigns/${camp1}/regras/acervo/${l8ref}/vinculo`, { cookie: cookieJ });
    t("jogador não remove vínculo → 403", delJ.status === 403, `status=${delJ.status}`);
    const delE = await req(BASE, "DELETE", `/campaigns/${camp1}/regras/acervo/${l8ref}/vinculo`, { cookie: cookieE });
    t("espectador não remove vínculo → 403", delE.status === 403, `status=${delE.status}`);

    const delM = await req(BASE, "DELETE", `/campaigns/${camp1}/regras/acervo/${l8ref}/vinculo`, { cookie: CM });
    t("mestre remove vínculo → 200", delM.status === 200 && delM.json?.ok === true, `status=${delM.status} ${JSON.stringify(delM.json)}`);
    const vincDepois = comDb(BANCO, (db) => db.prepare(
      "select count(*) c from campaign_rule_books where campaign_id=? and book_id=?",
    ).get(camp1, l8ref).c);
    const defsDepois = comDb(BANCO, (db) => db.prepare(
      `select count(*) c from rule_definitions rd join rule_sets rs on rs.id=rd.rule_set_id where rs.campaign_id=?`,
    ).get(camp1).c);
    t("apenas o registro campaign_rule_books foi excluído", vincAntes === 1 && vincDepois === 0, `${vincAntes}->${vincDepois}`);
    t("ruleset e definições integralmente preservados", defsAntes === defsDepois, `${defsAntes} vs ${defsDepois}`);
    const listaPos = await req(BASE, "GET", `/campaigns/${camp1}/regras/acervo`, { cookie: CM });
    const itemPos = (listaPos.json?.livros ?? []).find((l) => l.id === l8ref);
    t("livro volta a constar como não aplicado", itemPos?.aplicado === false && itemPos?.versaoAplicada === null, JSON.stringify(itemPos).slice(0, 160));
    const del2 = await req(BASE, "DELETE", `/campaigns/${camp1}/regras/acervo/${l8ref}/vinculo`, { cookie: CM });
    t("remover vínculo inexistente → 404", del2.status === 404, `status=${del2.status}`);
  }
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== acervo-sync: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
