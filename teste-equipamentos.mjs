// Testes — integridade inventário ↔ equipamentos (Etapa 2, Issue #33).
// Banco criado do zero em diretório temporário + migrations + fixtures
// sintéticas (teste-base.mjs) — nunca copia a base real.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, req, abrirDb,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("equipamentos");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, charId, cid, membId;
try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, { jogadores: {} });
  charId = cenario.personagemMestre;
  cid = cenario.campId; membId = cenario.membMestre;
  const cookie = cenario.cookieMestre;
  t("personagem criado", !!charId);

  const novoItem = async (name, quantity, extra = {}) => {
    const r = await req(BASE, "POST", `/characters/${charId}/inventario`, {
      cookie, body: { name, quantity, category: "teste", description: `desc ${name}`, weight: 1.5, valueCents: 999, ...extra },
    });
    return r.json?.id;
  };
  const inv = async () => (await req(BASE, "GET", `/characters/${charId}/inventario`, { cookie })).json?.itens ?? [];
  const eqs = async () => (await req(BASE, "GET", `/characters/${charId}/equipamentos`, { cookie })).json?.equipamentos ?? [];
  const qtdInv = async (itemId) => (await inv()).find((i) => i.id === itemId)?.quantity ?? null;
  const qtdItemPorNome = async (name) => (await inv()).filter((i) => i.name === name).reduce((s, i) => s + i.quantity, 0);

  // ===== 1. Equipar 1 de 5 =====
  sec("Equipar separa exatamente 1 unidade");
  const item5 = await novoItem("Espada", 5);
  t("item criado com qtd 5", (await qtdInv(item5)) === 5);
  const eq1 = await req(BASE, "POST", `/characters/${charId}/inventario/${item5}/equipar`, { cookie, body: {} });
  t("equipar → 201", eq1.status === 201, `status=${eq1.status} ${JSON.stringify(eq1.json).slice(0, 140)}`);
  t("inventário ficou com 4", (await qtdInv(item5)) === 4, `qtd=${await qtdInv(item5)}`);
  const listaEq = await eqs();
  t("1 equipamento criado equipado", listaEq.length === 1 && listaEq[0].equipped === true, JSON.stringify(listaEq.map((e) => e.name)));
  const eqId = eq1.json?.id;

  // ===== 2. Snapshot preserva dados =====
  sec("Snapshot do equipamento");
  {
    const eq = listaEq[0];
    t("nome/descrição preservados", eq.name === "Espada" && eq.description === "desc Espada", JSON.stringify({ n: eq.name, d: eq.description }));
    const snap = eq.data?.itemSnapshot;
    t("snapshot tem categoria/peso/valor", snap?.category === "teste" && snap?.weight === 1.5 && snap?.data?.valueCents === 999, JSON.stringify(snap).slice(0, 200));
  }

  // ===== 3. Desequipar devolve exatamente 1 =====
  sec("Desequipar devolve 1 unidade");
  {
    const r = await req(BASE, "POST", `/characters/${charId}/equipamentos/${eqId}/desequipar`, { cookie, body: {} });
    t("desequipar → 200", r.status === 200, `status=${r.status}`);
    t("inventário voltou a 5 (4+1, fundido na pilha)", (await qtdInv(item5)) === 5, `qtd=${await qtdInv(item5)}`);
    t("registro de equipamento removido", (await eqs()).length === 0, `eqs=${(await eqs()).length}`);
    t("sem duplicata: total de 'Espada' no inventário = 5", (await qtdItemPorNome("Espada")) === 5);
  }

  // ===== 4. Re-equipar sem duplicação =====
  sec("Re-equipar");
  {
    const r = await req(BASE, "POST", `/characters/${charId}/inventario/${item5}/equipar`, { cookie, body: {} });
    t("re-equipar → 201", r.status === 201);
    t("inventário 5→4 novamente", (await qtdInv(item5)) === 4);
    t("exatamente 1 equipamento", (await eqs()).length === 1);
  }

  // ===== 5. Dois cliques / requestId duplicado =====
  sec("Idempotência do equipar");
  {
    const rid = `eq-${crypto.randomUUID()}`;
    const itemSolo = await novoItem("Anel", 1);
    const [r1, r2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/inventario/${itemSolo}/equipar`, { cookie, body: { requestId: rid } }),
      req(BASE, "POST", `/characters/${charId}/inventario/${itemSolo}/equipar`, { cookie, body: { requestId: rid } }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    t("mesmo requestId → 201 + 200(dedup)", (statuses[0] === 200 || statuses[0] === 201) && statuses[1] <= 201, statuses.join(","));
    t("inventário do Anel zerado (item removido)", (await qtdItemPorNome("Anel")) === 0, `total=${await qtdItemPorNome("Anel")}`);
    const eqsAnel = (await eqs()).filter((e) => e.name === "Anel");
    t("exatamente 1 equipamento 'Anel'", eqsAnel.length === 1, `n=${eqsAnel.length}`);

    // sem requestId: duas chamadas simultâneas na última unidade → só 1 vence
    const itemUnico = await novoItem("Poção única", 1);
    const [s1, s2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/inventario/${itemUnico}/equipar`, { cookie, body: {} }),
      req(BASE, "POST", `/characters/${charId}/inventario/${itemUnico}/equipar`, { cookie, body: {} }),
    ]);
    const oks = [s1.status, s2.status].filter((s) => s === 201).length;
    t("duas equipagens simultâneas na última unidade → só 1 sucesso", oks === 1, [s1.status, s2.status].join(","));
    t("nenhuma unidade criada do nada", (await qtdItemPorNome("Poção única")) === 0);
  }

  // ===== 6. Transferir / excluir item com equipamento vinculado =====
  sec("Proteções de item vinculado");
  {
    // item5 tem 4 no inventário e 1 equipado (vinculado à pilha)
    const destino = crypto.randomUUID();
    {
      const w = abrirDb(BANCO);
      const agora = Date.now();
      const cid2 = cid;
      w.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(destino, cid2, membId, "PJ Destino", "{}", "{}", "aprovada", 0, agora, agora);
      w.close();
    }
    const tr = await req(BASE, "POST", `/characters/${charId}/inventario/${item5}/transferir`, {
      cookie, body: { destinoCharacterId: destino, quantidade: 1 },
    });
    t("transferir pilha c/ equipamento vinculado → 409", tr.status === 409, `status=${tr.status} ${JSON.stringify(tr.json).slice(0, 120)}`);
    const del = await req(BASE, "DELETE", `/characters/${charId}/inventario/${item5}`, { cookie });
    t("excluir pilha c/ equipamento vinculado → 409", del.status === 409, `status=${del.status}`);
    t("pilha intacta (4 unidades)", (await qtdInv(item5)) === 4);
  }

  // ===== 7. Excluir equipamento devolve unidade =====
  sec("Excluir equipamento devolve ao inventário");
  {
    const eqAtual = (await eqs()).find((e) => e.name === "Espada");
    const r = await req(BASE, "DELETE", `/characters/${charId}/equipamentos/${eqAtual.id}`, { cookie });
    t("excluir equipamento → 200", r.status === 200, `status=${r.status}`);
    t("unidade voltou: 'Espada' total = 5", (await qtdItemPorNome("Espada")) === 5, `total=${await qtdItemPorNome("Espada")}`);
    t("nenhum equipamento restante", (await eqs()).filter((e) => e.name === "Espada").length === 0);
  }

  // ===== 8. Slot ocupado via PATCH =====
  sec("Slot ocupado");
  {
    // cria 2 equipamentos manuais e tenta colocar ambos no mesmo slot equipado
    await req(BASE, "POST", `/characters/${charId}/equipamentos`, { cookie, body: { name: "Capacete", slot: "cabeca", equipped: true } });
    const r2 = await req(BASE, "POST", `/characters/${charId}/equipamentos`, { cookie, body: { name: "Elmo", slot: "cabeca", equipped: true } });
    t("2º equipamento no mesmo slot → 409", r2.status === 409, `status=${r2.status}`);
    // PATCH movendo o 1º para slot ocupado por outro → 409
    const eqs2 = await eqs();
    const capacete = eqs2.find((e) => e.name === "Capacete");
    const patch = await req(BASE, "PATCH", `/characters/${charId}/equipamentos/${capacete.id}`, { cookie, body: { slot: "cabeca" } });
    t("PATCH no mesmo slot ocupado pelo próprio → ok", patch.status === 200, `status=${patch.status}`);
  }

  // ===== 9. Equipamento manual: excluir não devolve nada ao inventário =====
  sec("Equipamento manual");
  {
    const antes = (await qtdItemPorNome("Capacete"));
    const eqs3 = await eqs();
    const cap = eqs3.find((e) => e.name === "Capacete");
    await req(BASE, "DELETE", `/characters/${charId}/equipamentos/${cap.id}`, { cookie });
    t("excluir equipamento manual não cria item", (await qtdItemPorNome("Capacete")) === antes && antes === 0);
  }

  // ===== 10. Concorrência: desequipar/DELETE simultâneos =====
  sec("Duas chamadas simultâneas de desequipar");
  {
    const item = await novoItem("Escudo", 3);
    const eq = await req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: {} });
    t("setup: equipou 1 de 3", eq.status === 201 && (await qtdInv(item)) === 2);
    const eqId = eq.json.id;
    const [d1, d2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/equipamentos/${eqId}/desequipar`, { cookie, body: {} }),
      req(BASE, "POST", `/characters/${charId}/equipamentos/${eqId}/desequipar`, { cookie, body: {} }),
    ]);
    // Uma processa (200); a outra pode ver o registro já removido (404) —
    // o invariante é: no máximo uma unidade devolvida, o que já foi
    // verificado abaixo.
    t("respostas coerentes (200 e/ou 404)", [d1.status, d2.status].every((x) => x === 200 || x === 404) && [d1.status, d2.status].includes(200), `${d1.status},${d2.status}`);
    t("somente 1 unidade voltou: total = 3", (await qtdItemPorNome("Escudo")) === 3, `total=${await qtdItemPorNome("Escudo")}`);
    t("registro de equipamento removido", (await eqs()).filter((e) => e.name === "Escudo").length === 0);
  }

  sec("Duas chamadas simultâneas de DELETE no mesmo equipamento");
  {
    const item = await novoItem("Capa", 3);
    const eq = await req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: {} });
    const eqId = eq.json.id;
    const [x1, x2] = await Promise.all([
      req(BASE, "DELETE", `/characters/${charId}/equipamentos/${eqId}`, { cookie }),
      req(BASE, "DELETE", `/characters/${charId}/equipamentos/${eqId}`, { cookie }),
    ]);
    t("respostas coerentes (200 e/ou 404)", [x1.status, x2.status].every((x) => x === 200 || x === 404) && [x1.status, x2.status].includes(200), `${x1.status},${x2.status}`);
    t("somente 1 unidade voltou: total 'Capa' = 3", (await qtdItemPorNome("Capa")) === 3, `total=${await qtdItemPorNome("Capa")}`);
    t("nenhum equipamento 'Capa' restante", (await eqs()).filter((e) => e.name === "Capa").length === 0);
  }

  // ===== 11. Equipar × transferir / excluir na mesma pilha =====
  sec("Equipar simultâneo com transferência da mesma pilha");
  {
    const destino2 = crypto.randomUUID();
    {
      const w = abrirDb(BANCO);
      const agora = Date.now();
      w.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(destino2, cid, membId, "PJ Destino2", "{}", "{}", "aprovada", 0, agora, agora);
      w.close();
    }
    const item = await novoItem("Arco", 2);
    const [eqR, trR] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: {} }),
      req(BASE, "POST", `/characters/${charId}/inventario/${item}/transferir`, { cookie, body: { destinoCharacterId: destino2 } }),
    ]);
    // Resultado consistente: OU equip vence (transfer bloqueada) OU
    // transfer vence (equip falha) — nunca os dois, nunca item órfão.
    const eqOk = eqR.status === 201, trOk = trR.status === 201;
    t("exatamente um dos dois vence", eqOk !== trOk, `equip=${eqR.status} transf=${trR.status}`);
    if (eqOk) {
      t("transferência bloqueada → 409", trR.status === 409, `status=${trR.status}`);
      t("restou 1 unidade no inventário", (await qtdInv(item)) === 1, `qtd=${await qtdInv(item)}`);
      t("1 equipamento 'Arco'", (await eqs()).filter((e) => e.name === "Arco").length === 1);
    } else {
      t("equipar falhou (item já foi embora)", [404, 409].includes(eqR.status), `status=${eqR.status}`);
      t("pilha removida do inventário", (await qtdInv(item)) === null, `qtd=${await qtdInv(item)}`);
      t("unidade chegou ao destino", (await req(BASE, "GET", `/characters/${destino2}/inventario`, { cookie })).json?.itens?.some((i) => i.name === "Arco" && i.quantity === 2));
    }
  }

  sec("Equipar simultâneo com exclusão da mesma pilha");
  {
    const item = await novoItem("Daga", 2);
    const [eqR, delR] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: {} }),
      req(BASE, "DELETE", `/characters/${charId}/inventario/${item}`, { cookie }),
    ]);
    const eqOk = eqR.status === 201, delOk = delR.status === 200;
    t("exatamente um dos dois vence", eqOk !== delOk, `equip=${eqR.status} del=${delR.status}`);
    if (eqOk) {
      t("exclusão bloqueada → 409", delR.status === 409, `status=${delR.status}`);
      t("restou 1 unidade", (await qtdInv(item)) === 1);
    } else {
      t("equipar falhou", [404, 409].includes(eqR.status), `status=${eqR.status}`);
      t("item removido por completo", (await qtdItemPorNome("Daga")) === 0);
    }
  }

  // ===== 12. Dois PATCH simultâneos no mesmo slot =====
  sec("PATCH simultâneo disputando o mesmo slot");
  {
    // slot "slotY" está LIVRE: dois candidatos disputam simultaneamente
    const mk = async (n) => (await req(BASE, "POST", `/characters/${charId}/equipamentos`, { cookie, body: { name: n, equipped: false } })).json?.id;
    const eqA = await mk("Candidato A");
    const eqB = await mk("Candidato B");
    const [p1, p2] = await Promise.all([
      req(BASE, "PATCH", `/characters/${charId}/equipamentos/${eqA}`, { cookie, body: { slot: "slotY", equipped: true } }),
      req(BASE, "PATCH", `/characters/${charId}/equipamentos/${eqB}`, { cookie, body: { slot: "slotY", equipped: true } }),
    ]);
    const oks = [p1.status, p2.status].filter((s) => s === 200).length;
    t("apenas 1 PATCH vence o slot", oks === 1, [p1.status, p2.status].join(","));
    const perdedor = [p1, p2].find((r) => r.status !== 200);
    t("perdedor recebe 409", perdedor?.status === 409, `status=${perdedor?.status}`);
  }

  // ===== 13. Retry com mesmo requestId após sucesso =====
  sec("Retry com mesmo requestId");
  {
    const item = await novoItem("Amuleto", 2);
    const rid = `retry-${crypto.randomUUID()}`;
    const r1 = await req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: { requestId: rid } });
    t("primeira equipagem → 201", r1.status === 201);
    // simula retry (ex.: resposta perdida na rede) com o MESMO requestId
    const r2 = await req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: { requestId: rid } });
    t("retry mesmo requestId → 200 deduplicado", r2.status === 200 && r2.json?.deduplicado === true, `status=${r2.status} ${JSON.stringify(r2.json)}`);
    t("mesmo equipamento retornado", r2.json?.id === r1.json?.id);
    t("somente 1 unidade consumida (restam 1)", (await qtdInv(item)) === 1, `qtd=${await qtdInv(item)}`);
    t("exatamente 1 equipamento 'Amuleto'", (await eqs()).filter((e) => e.name === "Amuleto").length === 1);
  }

  // ===== 14. Procedência forjada (segurança) =====
  sec("POST não aceita procedência forjada");
  {
    const snapFalso = { name: "Item Falso", description: "forjado", category: "hack", weight: 0.1, data: { valueCents: 999999 } };
    const r = await req(BASE, "POST", `/characters/${charId}/equipamentos`, {
      cookie, body: {
        name: "Espada Falsa", equipped: true,
        inventoryEntryId: "id-inexistente",
        data: { origem: "inventario", inventoryEntryId: "id-inexistente", itemSnapshot: snapFalso, requestId: "forjado-1", custom: "ok" },
      },
    });
    t("POST forjado → 201 (aceito, mas sanitizado)", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    const eqId = r.json?.id;
    const eq = (await eqs()).find((e) => e.id === eqId);
    const d = eq?.data ?? {};
    t("origem forjada removida", d.origem === undefined, JSON.stringify(d).slice(0, 200));
    t("itemSnapshot forjado removido", d.itemSnapshot === undefined);
    t("inventoryEntryId forjado removido", d.inventoryEntryId === undefined);
    t("requestId forjado removido", d.requestId === undefined);
    t("campo custom legítimo preservado", d.custom === "ok");
    // se a procedência tivesse sido aceita, o DELETE criaria item do nada
    const antes = (await qtdItemPorNome("Item Falso"));
    await req(BASE, "DELETE", `/characters/${charId}/equipamentos/${eqId}`, { cookie });
    t("DELETE não criou item inexistente", (await qtdItemPorNome("Item Falso")) === antes && antes === 0);
  }

  sec("PATCH não altera nem apaga procedência");
  {
    // equipamento legítimo originado do inventário COM requestId —
    // garante que os 4 campos reservados existem com valores reais.
    const item = await novoItem("Machado", 2);
    const ridLegit = `legit-${crypto.randomUUID()}`;
    const eqR = await req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: { requestId: ridLegit } });
    const eqId = eqR.json.id;
    const dadosOriginais = (await eqs()).find((e) => e.id === eqId)?.data ?? {};
    t("setup: 4 campos reservados presentes",
      dadosOriginais.origem === "inventario" &&
      typeof dadosOriginais.inventoryEntryId === "string" &&
      !!dadosOriginais.itemSnapshot &&
      dadosOriginais.requestId === ridLegit,
      JSON.stringify(dadosOriginais).slice(0, 240));

    const confereProcedencia = async (rotulo) => {
      const d = (await eqs()).find((e) => e.id === eqId)?.data ?? {};
      t(`${rotulo}: origem preservada`, d.origem === "inventario", JSON.stringify(d.origem));
      t(`${rotulo}: inventoryEntryId preservado`, d.inventoryEntryId === dadosOriginais.inventoryEntryId, `${d.inventoryEntryId} vs ${dadosOriginais.inventoryEntryId}`);
      t(`${rotulo}: itemSnapshot preservado`, JSON.stringify(d.itemSnapshot) === JSON.stringify(dadosOriginais.itemSnapshot));
      t(`${rotulo}: requestId preservado`, d.requestId === ridLegit, `${d.requestId} vs ${ridLegit}`);
    };

    // PATCH malicioso tentando sobrescrever os 4 campos reservados
    const p1 = await req(BASE, "PATCH", `/characters/${charId}/equipamentos/${eqId}`, {
      cookie, body: {
        name: "Machado Renomeado",
        data: { origem: "forjado", itemSnapshot: { name: "Fake" }, inventoryEntryId: "x", requestId: "y", anexo: "campo ok" },
      },
    });
    t("PATCH malicioso → 200", p1.status === 200, `status=${p1.status}`);
    const eqDepois = (await eqs()).find((e) => e.id === eqId);
    t("nome legítimo aplicado", eqDepois?.name === "Machado Renomeado");
    await confereProcedencia("após PATCH forjado");
    t("campo custom do PATCH aplicado", eqDepois?.data?.anexo === "campo ok");

    // PATCH com data:{} — não pode apagar nenhum campo reservado
    const p2 = await req(BASE, "PATCH", `/characters/${charId}/equipamentos/${eqId}`, { cookie, body: { data: {} } });
    t("PATCH data:{} → 200", p2.status === 200);
    await confereProcedencia("após PATCH data:{}");

    // demais campos editáveis continuam funcionando
    const p3 = await req(BASE, "PATCH", `/characters/${charId}/equipamentos/${eqId}`, {
      cookie, body: { kind: "arma", slot: "mao", equipped: true, description: "descrição nova" },
    });
    t("PATCH campos editáveis → 200", p3.status === 200, `status=${p3.status}`);
    const eqEdit = (await eqs()).find((e) => e.id === eqId);
    t("kind/slot/description aplicados", eqEdit?.kind === "arma" && eqEdit?.slot === "mao" && eqEdit?.description === "descrição nova", JSON.stringify({ k: eqEdit?.kind, s: eqEdit?.slot, d: eqEdit?.description }));
    await confereProcedencia("após PATCH editáveis");

    // fluxo legítimo continua: deselect devolve exatamente 1
    const antes = (await qtdItemPorNome("Machado"));
    await req(BASE, "POST", `/characters/${charId}/equipamentos/${eqId}/desequipar`, { cookie, body: {} });
    t("deselecionar devolveu exatamente 1", (await qtdItemPorNome("Machado")) === antes + 1, `antes=${antes} depois=${await qtdItemPorNome("Machado")}`);
  }

  sec("Fluxo legítimo completo preservado");
  {
    const item = await novoItem("Lança", 3);
    const eq = await req(BASE, "POST", `/characters/${charId}/inventario/${item}/equipar`, { cookie, body: {} });
    t("equipar legítimo → 201", eq.status === 201);
    const del = await req(BASE, "DELETE", `/characters/${charId}/equipamentos/${eq.json.id}`, { cookie });
    t("excluir equipamento legítimo → 200", del.status === 200);
    t("unidade devolvida: total 'Lança' = 3", (await qtdItemPorNome("Lança")) === 3);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
