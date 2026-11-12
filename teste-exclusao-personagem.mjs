// Testes — exclusão física e arquivamento de personagens.
// Banco SQLite NOVO + migrations + cenário sintético (teste-base.mjs).
// Cobre: permissões de exclusão por papel/status, preservação histórica
// (tests/money_transactions bloqueiam; rolls/notes/anotações preservadas;
// counterparty anulado), atomicidade, arquivamento/reversão e proteção
// das rotas de alteração sobre personagem arquivado.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io as ioClient } from "socket.io-client";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, abrirDb, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-excluir-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };
const uid = () => crypto.randomUUID();
const agora = () => Date.now();

try {
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Exclusão", jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" } });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie, J2 = c.jogadores.jogador2.cookie;
  const UID1 = c.jogadores.jogador1.id, UID2 = c.jogadores.jogador2.id;

  const novoChar = async (cookie, nome, statusInicial = null) => {
    const r = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie, body: { name: nome } });
    const id = r.json?.personagem?.id;
    if (!id) throw new Error("criar personagem falhou: " + JSON.stringify(r.json).slice(0, 200));
    if (statusInicial) comDb((db) => db.prepare("update characters set status=? where id=?").run(statusInicial, id));
    return id;
  };
  const existe = (id) => comDb((db) => !!db.prepare("select id from characters where id=?").get(id));
  const statusDe = (id) => comDb((db) => db.prepare("select status from characters where id=?").get(id)?.status ?? null);
  const dadosDe = (id) => comDb((db) => JSON.parse(db.prepare("select data from characters where id=?").get(id)?.data ?? "{}"));

  sec("Jogador exclui o próprio personagem nos status permitidos");
  {
    const a = await novoChar(J1, "Rascunho J1");
    const d1 = await req(BASE, "DELETE", `/characters/${a}`, { cookie: J1 });
    t("jogador exclui rascunho", d1.status === 200 && d1.json?.ok === true, `status=${d1.status}`);
    t("rascunho sumiu", !existe(a));

    const b = await novoChar(J1, "Devolvida J1", "devolvida");
    const d2 = await req(BASE, "DELETE", `/characters/${b}`, { cookie: J1 });
    t("jogador exclui devolvida", d2.status === 200, `status=${d2.status}`);

    const d3c = await novoChar(J1, "Reaberta J1", "reaberta");
    const d3 = await req(BASE, "DELETE", `/characters/${d3c}`, { cookie: J1 });
    t("jogador exclui reaberta", d3.status === 200, `status=${d3.status}`);
  }

  sec("Jogador NÃO exclui: de outro, nem status restritos");
  {
    const deJ2 = await novoChar(J2, "Char do J2");
    const d = await req(BASE, "DELETE", `/characters/${deJ2}`, { cookie: J1 });
    t("jogador não exclui de outro", d.status === 403, `status=${d.status}`);
    t("personagem alheio intacto", existe(deJ2) && statusDe(deJ2) === "rascunho");

    for (const st of ["aguardando_aprovacao", "aprovada", "bloqueada"]) {
      const id = await novoChar(J1, `Status ${st}`, st);
      const r = await req(BASE, "DELETE", `/characters/${id}`, { cookie: J1 });
      t(`jogador não exclui ${st}`, r.status === 403, `status=${r.status}`);
      t(`${st} permanece intacto`, existe(id) && statusDe(id) === st);
    }
  }

  sec("Mestre exclui personagem em qualquer status");
  {
    const arquivadoId = await novoChar(J1, "Serã Arquivado", "aprovada");
    await req(BASE, "POST", `/characters/${arquivadoId}/arquivar`, { cookie: M });
    for (const st of ["rascunho", "aguardando_aprovacao", "devolvida", "reaberta", "aprovada", "bloqueada", "arquivado"]) {
      const id = st === "arquivado" ? arquivadoId : await novoChar(J1, `Mestre del ${st}`, st);
      const r = await req(BASE, "DELETE", `/characters/${id}`, { cookie: M });
      t(`mestre exclui ${st}`, r.status === 200 && !existe(id), `status=${r.status}`);
    }
  }

  sec("Histórico bloqueia exclusão física (409) sem apagar nada");
  {
    // personagem com teste de sessão
    const comTeste = await novoChar(J1, "Com Teste", "aprovada");
    comDb((db) => {
      db.prepare(`insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,roll_id,outcome,outcome_note,visibility,request_id,created_at,updated_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uid(), CID, null, comTeste, UID1, "{}", "{}", 1, 10, null, "pendente", null, null, null, "publica", null, agora(), agora());
      db.prepare(`insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uid(), comTeste, "Espada", 1, null, null, null, null, null, "{}", agora(), agora());
    });
    const r1 = await req(BASE, "DELETE", `/characters/${comTeste}`, { cookie: M });
    t("exclusão bloqueada por testes", r1.status === 409 && r1.json?.codigo === "historico_testes", `status=${r1.status} ${JSON.stringify(r1.json).slice(0, 160)}`);
    t("personagem com teste intacto", existe(comTeste));
    t("inventário NÃO removido parcialmente", comDb((db) => db.prepare("select id from inventory_entries where character_id=?").all(comTeste).length === 1));

    // personagem com transação financeira própria
    const comTx = await novoChar(J1, "Com Finanças", "aprovada");
    comDb((db) => db.prepare(`insert into money_transactions (id,character_id,campaign_id,kind,amount,currency,account,counterparty,counterparty_character_id,account_id,description,amount_cents,balance_before_cents,balance_after_cents,request_id,created_by,created_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uid(), comTx, CID, "entrada", 100, "BRL", null, null, null, null, "mesada", 10000, null, null, null, UID1, agora()));
    const r2 = await req(BASE, "DELETE", `/characters/${comTx}`, { cookie: M });
    t("exclusão bloqueada por finanças", r2.status === 409 && r2.json?.codigo === "historico_financeiro", `status=${r2.status}`);
    t("personagem com tx intacto", existe(comTx));

    // conta referenciada por transação de OUTRO personagem → bloqueia
    const donoConta = await novoChar(J1, "Dono Conta", "aprovada");
    const outroChar = await novoChar(J2, "Outro Char", "aprovada");
    const contaId = uid();
    comDb((db) => {
      db.prepare(`insert into financial_accounts (id,character_id,campaign_id,type,name,institution,agency,account_number,holder,currency,balance_cents,credit_limit_cents,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(contaId, donoConta, CID, "especie", "Bolso", null, null, null, null, "BRL", 0, null, "{}", agora(), agora());
      db.prepare(`insert into money_transactions (id,character_id,campaign_id,kind,amount,currency,account,counterparty,counterparty_character_id,account_id,description,amount_cents,balance_before_cents,balance_after_cents,request_id,created_by,created_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uid(), outroChar, CID, "entrada", 50, "BRL", null, null, null, contaId, "depósito", 5000, null, null, null, UID2, agora());
    });
    const r3 = await req(BASE, "DELETE", `/characters/${donoConta}`, { cookie: M });
    t("conta referenciada por terceiro bloqueia", r3.status === 409 && r3.json?.codigo === "conta_referenciada", `status=${r3.status} ${JSON.stringify(r3.json).slice(0, 140)}`);
    t("dono da conta intacto", existe(donoConta));
  }

  sec("Histórico de terceiros é preservado na exclusão");
  {
    const alvo = await novoChar(J1, "Alvo Histórico", "aprovada");
    const pagador = await novoChar(J2, "Pagador", "aprovada");
    const rollId = uid(), noteId = uid(), txId = uid();
    comDb((db) => {
      db.prepare(`insert into rolls (id,campaign_id,session_id,character_id,user_id,dice,results,reason,visibility,request_id,created_at) values (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(rollId, CID, null, alvo, UID1, "[]", "{}", null, "publica", null, agora());
      db.prepare(`insert into notes (id,campaign_id,owner_id,character_id,kind,category,title,content,important,visibility,recipients,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(noteId, CID, UID1, alvo, "diario", null, "Nota", "texto", 0, "privada", null, "pendente", agora(), agora());
      // transação de OUTRO personagem usando 'alvo' como contraparte
      db.prepare(`insert into money_transactions (id,character_id,campaign_id,kind,amount,currency,account,counterparty,counterparty_character_id,account_id,description,amount_cents,balance_before_cents,balance_after_cents,request_id,created_by,created_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(txId, pagador, CID, "transferencia", 10, "BRL", null, "alvo", alvo, null, "pagou alvo", 1000, null, null, null, UID2, agora());
      db.prepare(`insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uid(), alvo, "Poção", 3, null, null, null, null, null, "{}", agora(), agora());
    });
    const r = await req(BASE, "DELETE", `/characters/${alvo}`, { cookie: M });
    t("mestre exclui personagem com histórico de terceiros", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    const checks = comDb((db) => ({
      roll: db.prepare("select character_id from rolls where id=?").get(rollId),
      note: db.prepare("select character_id from notes where id=?").get(noteId),
      tx: db.prepare("select character_id, counterparty_character_id from money_transactions where id=?").get(txId),
      inv: db.prepare("select id from inventory_entries where character_id=?").all(alvo).length,
    }));
    t("roll preservada com character_id nulo", checks.roll && checks.roll.character_id === null);
    t("anotação preservada com character_id nulo", checks.note && checks.note.character_id === null);
    t("transação de terceiro preservada", !!checks.tx);
    t("counterparty anulado", checks.tx?.counterparty_character_id === null);
    t("inventário exclusivo removido (cascata)", checks.inv === 0);
  }

  sec("Arquivamento: permissões e metadado");
  {
    const alvo = await novoChar(J1, "Vai Arquivar", "aprovada");
    const ja = await req(BASE, "POST", `/characters/${alvo}/arquivar`, { cookie: J1 });
    t("jogador não arquiva", ja.status === 403, `status=${ja.status}`);
    const ar = await req(BASE, "POST", `/characters/${alvo}/arquivar`, { cookie: M });
    t("mestre arquiva", ar.status === 200 && ar.json?.statusAnterior === "aprovada", `status=${ar.status} ${JSON.stringify(ar.json).slice(0, 140)}`);
    t("status virou arquivado", statusDe(alvo) === "arquivado");
    const meta = dadosDe(alvo).__arquivamento;
    t("metadado __arquivamento gravado", meta?.statusAnterior === "aprovada" && !!meta?.arquivadoEm, JSON.stringify(meta));

    // idempotente
    const ar2 = await req(BASE, "POST", `/characters/${alvo}/arquivar`, { cookie: M });
    t("re-arquivar é idempotente", ar2.status === 200 && ar2.json?.jaArquivado === true, `status=${ar2.status}`);

    // listagens
    const ativos = await req(BASE, "GET", `/campaigns/${CID}/characters`, { cookie: M });
    t("arquivado fora da lista ativa", !(ativos.json?.personagens ?? []).some((p) => p.id === alvo));
    const arqs = await req(BASE, "GET", `/campaigns/${CID}/characters?arquivados=1`, { cookie: M });
    const itemArq = (arqs.json?.personagens ?? []).find((p) => p.id === alvo);
    t("arquivado na lista de arquivados", !!itemArq);
    t("lista de arquivados expõe status anterior", itemArq?.arquivadoDe === "aprovada", JSON.stringify(itemArq));

    // leitura continua permitida
    const det = await req(BASE, "GET", `/characters/${alvo}`, { cookie: M });
    t("consulta do arquivado funciona", det.status === 200 && det.json?.personagem?.status === "arquivado", `status=${det.status}`);
    t("detalhe expõe arquivadoDe", det.json?.personagem?.arquivadoDe === "aprovada");

    // histórico de pontos: arquivamento não pode esconder dados do mestre
    comDb((db) => {
      const row = db.prepare("select data from characters where id=?").get(alvo);
      const d = JSON.parse(row.data);
      d.__pontos = { bonus: 7, historico: [
        { em: "2024-01-01T00:00:00.000Z", quantidade: 7, motivo: "bônus inicial", autorId: null, autorNome: "Mestre" },
        { em: "2024-01-02T00:00:00.000Z", quantidade: -2, motivo: "penalidade teste", autorId: null, autorNome: "Mestre" },
      ] };
      db.prepare("update characters set data=? where id=?").run(JSON.stringify(d), alvo);
    });
    const detM = await req(BASE, "GET", `/characters/${alvo}`, { cookie: M });
    const pbM = detM.json?.ficha?.pontosBonus;
    t("mestre vê saldo de pontos do arquivado", pbM?.bonus === 7, JSON.stringify(pbM));
    t("mestre vê histórico de pontos do arquivado", Array.isArray(pbM?.historico) && pbM.historico.length === 2 && pbM.historico[0]?.motivo === "bônus inicial", JSON.stringify(pbM?.historico));
    const detJ = await req(BASE, "GET", `/characters/${alvo}`, { cookie: J1 });
    const pbJ = detJ.json?.ficha?.pontosBonus;
    t("dono vê saldo mas não o histórico de pontos", pbJ?.bonus === 7 && pbJ?.historico === undefined, JSON.stringify(pbJ));

    // proteção de rotas de alteração
    const patch = await req(BASE, "PATCH", `/characters/${alvo}`, { cookie: M, body: { data: { "f-forca": 9 } } });
    t("PATCH bloqueado em arquivado", patch.status === 403, `status=${patch.status}`);
    const hp = await req(BASE, "POST", `/characters/${alvo}/hp`, { cookie: M, body: { acao: "ajuste", quantidade: 1 } });
    t("HP bloqueado em arquivado", hp.status === 403, `status=${hp.status}`);
    const pts = await req(BASE, "POST", `/characters/${alvo}/pontos`, { cookie: M, body: { acao: "conceder", quantidade: 1, motivo: "teste" } });
    t("pontos bloqueados em arquivado", pts.status === 403, `status=${pts.status}`);
    const inv = await req(BASE, "POST", `/characters/${alvo}/inventario`, { cookie: M, body: { name: "Item" } });
    t("patrimônio bloqueado em arquivado", inv.status === 403, `status=${inv.status}`);
    const nota = await req(BASE, "POST", `/campaigns/${CID}/anotacoes`, { cookie: J1, body: { title: "x", characterId: alvo } });
    t("anotação vinculada bloqueada", nota.status === 409, `status=${nota.status}`);
    // jogador também não altera arquivado
    const patchJ = await req(BASE, "PATCH", `/characters/${alvo}`, { cookie: J1, body: { data: {} } });
    t("PATCH de jogador bloqueado", patchJ.status === 403, `status=${patchJ.status}`);

    // exclusão por jogador de arquivado próprio
    const delJ = await req(BASE, "DELETE", `/characters/${alvo}`, { cookie: J1 });
    t("jogador não exclui arquivado", delJ.status === 403, `status=${delJ.status}`);

    // socket: mesa:teste:pedir recusa arquivado
    const sess = await req(BASE, "POST", `/campaigns/${CID}/sessoes`, { cookie: M, body: { name: "Sessão teste" } });
    const sessId = sess.json?.sessao?.id;
    const sock = ioClient(BASE, { path: "/socket.io", transports: ["polling", "websocket"], extraHeaders: { cookie: M }, reconnection: false });
    try {
      await new Promise((res, rej) => { sock.on("connect", res); sock.on("connect_error", rej); setTimeout(() => rej(new Error("timeout connect")), 8000); });
      await new Promise((res) => sock.emit("mesa:entrar", { sessionId: sessId }, res));
      const resp = await new Promise((res) => sock.emit("mesa:teste:pedir", { sessionId: sessId, characterId: alvo, requestId: uid() }, res));
      t("socket barra novo teste de arquivado", resp?.ok === false, JSON.stringify(resp).slice(0, 140));
    } finally { sock.close(); }

    // restauração
    const desJ = await req(BASE, "POST", `/characters/${alvo}/desarquivar`, { cookie: J1 });
    t("jogador não restaura", desJ.status === 403, `status=${desJ.status}`);
    const des = await req(BASE, "POST", `/characters/${alvo}/desarquivar`, { cookie: M });
    t("mestre restaura status anterior", des.status === 200 && des.json?.status === "aprovada", `status=${des.status} ${JSON.stringify(des.json)}`);
    t("status restaurado no banco", statusDe(alvo) === "aprovada");
    t("metadado removido", dadosDe(alvo).__arquivamento === undefined);
    const des2 = await req(BASE, "POST", `/characters/${alvo}/desarquivar`, { cookie: M });
    t("restauração duplicada bloqueada", des2.status === 409, `status=${des2.status}`);
    const patchOk = await req(BASE, "PATCH", `/characters/${alvo}`, { cookie: M, body: { data: {} } });
    t("edição volta após restaurar", patchOk.status === 200, `status=${patchOk.status}`);
    const detPos = await req(BASE, "GET", `/characters/${alvo}`, { cookie: M });
    const pbPos = detPos.json?.ficha?.pontosBonus;
    t("histórico de pontos preservado após restaurar", pbPos?.bonus === 7 && Array.isArray(pbPos?.historico) && pbPos.historico.length === 2, JSON.stringify(pbPos));
  }

  sec("Autorização revalidada: vínculo/papel alterado recusa a operação");
  {
    const membMestre = () => comDb((db) => db.prepare("select id from memberships where campaign_id=? and role='mestre'").get(CID));
    const membJ1 = () => comDb((db) => db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, UID1));
    const setMemb = (id, col, val) => comDb((db) => db.prepare(`update memberships set ${col}=? where id=?`).run(val, id));
    const MESTRE_MEMB = membMestre().id;
    const J1_MEMB = membJ1().id;

    // Mestre rebaixado a jogador entre requisições: arquivar é recusado.
    const alvoPapel = await novoChar(J1, "Papel Alterado", "aprovada");
    setMemb(MESTRE_MEMB, "role", "jogador");
    const arNeg = await req(BASE, "POST", `/characters/${alvoPapel}/arquivar`, { cookie: M });
    t("mestre rebaixado não arquiva (403)", arNeg.status === 403, `status=${arNeg.status}`);
    t("personagem intacto após recusa", statusDe(alvoPapel) === "aprovada" && dadosDe(alvoPapel).__arquivamento === undefined);
    setMemb(MESTRE_MEMB, "role", "mestre");

    // Vínculo do jogador bloqueado: exclusão do próprio rascunho recusada.
    const alvoVinc = await novoChar(J1, "Vinculo Bloqueado", "rascunho");
    setMemb(J1_MEMB, "status", "bloqueado");
    const delNeg = await req(BASE, "DELETE", `/characters/${alvoVinc}`, { cookie: J1 });
    t("vínculo bloqueado não exclui (403)", delNeg.status === 403, `status=${delNeg.status}`);
    t("personagem intacto após recusa", existe(alvoVinc) && statusDe(alvoVinc) === "rascunho");
    setMemb(J1_MEMB, "status", "ativo");

    // Vínculo do mestre removido: desarquivar recusado, metadado preservado.
    await req(BASE, "POST", `/characters/${alvoPapel}/arquivar`, { cookie: M });
    setMemb(MESTRE_MEMB, "status", "removido");
    const desNeg = await req(BASE, "POST", `/characters/${alvoPapel}/desarquivar`, { cookie: M });
    t("vínculo removido não restaura (403)", desNeg.status === 403, `status=${desNeg.status}`);
    t("segue arquivado após recusa", statusDe(alvoPapel) === "arquivado");
    setMemb(MESTRE_MEMB, "status", "ativo");
    const desOk = await req(BASE, "POST", `/characters/${alvoPapel}/desarquivar`, { cookie: M });
    t("após restaurar vínculo, mestre restaura", desOk.status === 200 && statusDe(alvoPapel) === "aprovada", `status=${desOk.status}`);
  }

  sec("Transferências não alteram personagem arquivado (409, sem parcial)");
  {
    const A = await novoChar(J1, "Transf Origem", "aprovada");
    const B = await novoChar(J2, "Transf Destino", "aprovada");
    const C = await novoChar(J2, "Transf Ativo", "aprovada");
    const mkConta = async (charId, nome, saldo) => {
      const r = await req(BASE, "POST", `/characters/${charId}/financeiro/contas`, { cookie: M, body: { type: "especie", name: nome, balanceReais: saldo } });
      return r.json?.id;
    };
    const contaA = await mkConta(A, "Carteira A", 100);
    const contaB = await mkConta(B, "Carteira B", 50);
    const contaC = await mkConta(C, "Carteira C", 0);
    t("contas criadas", !!contaA && !!contaB && !!contaC);
    const item = await req(BASE, "POST", `/characters/${A}/inventario`, { cookie: M, body: { name: "Espada longa", quantity: 2 } });
    const itemId = item.json?.id;
    t("item criado na origem", !!itemId, JSON.stringify(item.json).slice(0, 120));
    await req(BASE, "POST", `/characters/${B}/arquivar`, { cookie: M });

    const saldoDe = async (charId) => {
      const f = await req(BASE, "GET", `/characters/${charId}/financeiro`, { cookie: M });
      return f.json?.contas?.[0]?.balanceCents;
    };
    const txCount = (charId) => comDb((db) => db.prepare("select count(*) n from money_transactions where character_id=?").get(charId).n);

    // 1) financeiro ativo → arquivado (mestre)
    const antesB = await saldoDe(B), txBAntes = txCount(B);
    const tfM = await req(BASE, "POST", `/characters/${A}/financeiro/transferir`, { cookie: M, body: { origemAccountId: contaA, destinoAccountId: contaB, valor: 10 } });
    t("mestre: transferência p/ arquivado bloqueada", tfM.status === 409, `status=${tfM.status} ${JSON.stringify(tfM.json).slice(0, 140)}`);
    t("saldo do arquivado inalterado", (await saldoDe(B)) === antesB);
    t("nenhuma movimentação criada no arquivado", txCount(B) === txBAntes);
    t("saldo da origem inalterado", (await saldoDe(A)) === 10000);

    // 2) mesmo bloqueio via jogador (PIX fictício)
    const tfJ = await req(BASE, "POST", `/characters/${A}/financeiro/transferir`, { cookie: J1, body: { origemAccountId: contaA, destinoAccountId: contaB, valor: 5 } });
    t("jogador: transferência p/ arquivado bloqueada", tfJ.status === 409, `status=${tfJ.status}`);
    t("saldo do arquivado segue inalterado", (await saldoDe(B)) === antesB);

    // 3) inventário ativo → arquivado
    const invAntes = await req(BASE, "GET", `/characters/${A}/inventario`, { cookie: M });
    const qtdAntes = invAntes.json?.itens?.find((i) => i.id === itemId)?.quantity;
    const trM = await req(BASE, "POST", `/characters/${A}/inventario/${itemId}/transferir`, { cookie: M, body: { destinoCharacterId: B } });
    t("mestre: item p/ arquivado bloqueado", trM.status === 409, `status=${trM.status} ${JSON.stringify(trM.json).slice(0, 140)}`);
    const invDepois = await req(BASE, "GET", `/characters/${A}/inventario`, { cookie: M });
    t("estoque da origem preservado", invDepois.json?.itens?.find((i) => i.id === itemId)?.quantity === qtdAntes);
    const invB = await req(BASE, "GET", `/characters/${B}/inventario`, { cookie: M });
    t("arquivado não recebeu item", !(invB.json?.itens ?? []).some((i) => i.name === "Espada longa"));

    // 4) operação entre dois ativos continua funcionando
    const tfOk = await req(BASE, "POST", `/characters/${A}/financeiro/transferir`, { cookie: M, body: { origemAccountId: contaA, destinoAccountId: contaC, valor: 10 } });
    t("transferência entre ativos funciona", tfOk.status === 201, `status=${tfOk.status} ${JSON.stringify(tfOk.json).slice(0, 120)}`);
    t("saldo destino creditado", (await saldoDe(C)) === 1000);
    const trOk = await req(BASE, "POST", `/characters/${A}/inventario/${itemId}/transferir`, { cookie: M, body: { destinoCharacterId: C, quantidade: 1 } });
    t("item entre ativos funciona", trOk.status === 200, `status=${trOk.status}`);
    const invC = await req(BASE, "GET", `/characters/${C}/inventario`, { cookie: M });
    t("destino recebeu 1 unidade", invC.json?.itens?.some((i) => i.name === "Espada longa" && i.quantity === 1));
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== exclusão-personagem: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
