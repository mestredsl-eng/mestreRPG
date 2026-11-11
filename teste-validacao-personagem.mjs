// Testes — mensagens de validação na criação/edição de personagens.
// Banco SQLite NOVO + migrations + cenário sintético (teste-base.mjs).
// Cobre: salvamento válido, erros estruturados, dependência habilidade→defeito,
// pré-requisito de atributo, pontos insuficientes, múltiplos erros,
// dados preservados após falha, correção e aprovação do mestre.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, abrirDb } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-validacao-"));
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

try {
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Validação Ficha", jogadores: { jogador1: "jogador_um" } });
  const CID = c.campId, M = c.cookieMestre, J = c.jogadores.jogador1.cookie;

  // regras: elementos com dependência + pré-requisito de atributo
  const ep = `/campaigns/${CID}/regras/elementos`;
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "defeito", key: "covardia", name: "Covardia", definition: { disponivel: true } } });
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "poder", key: "teleporte", name: "Teleporte", definition: { dependencias: [{ kind: "defeito", key: "covardia" }], disponivel: true } } });
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "poder", key: "mente", name: "Mente aguçada", definition: { prerequisitos: [{ kind: "atributo", key: "inteligencia", nivel: 3 }], disponivel: true } } });
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "habilidade", key: "manipulacao", name: "Manipulação", definition: { disponivel: true } } });
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "habilidade", key: "furtividade", name: "Furtividade", definition: { disponivel: true } } });
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "poder", key: "labia", name: "Lábia", definition: { dependencias: [{ kind: "habilidade", key: "manipulacao" }], disponivel: true } } });
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "poder", key: "furtivo", name: "Presença furtiva", definition: { dependencias: [{ kind: "habilidade", key: "furtividade" }], disponivel: true } } });

  // modelo de ficha com atributos + seleções de biblioteca + obrigatório
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Validação" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Atributos", ordem: 0, campos: [
        { id: "f-forca", label: "Força", tipo: "inteiro", semantico: "atributo", minimo: 0, maximo: 10 },
        { id: "f-int", label: "Inteligência", tipo: "inteiro", semantico: "atributo", minimo: 0, maximo: 10 },
        { id: "f-defeitos", label: "Defeitos", tipo: "selecao_nivel", regraKind: "defeito" },
        { id: "f-poderes", label: "Poderes", tipo: "selecao_multipla", regraKind: "poder" },
        { id: "f-apelido", label: "Apelido", tipo: "texto", obrigatorio: true },
        // IDs legítimos que colidem com chaves internas do payload de erro
        { id: "pontos", label: "Pontos", tipo: "inteiro", minimo: 0 },
        { id: "erros", label: "Erros", tipo: "inteiro", minimo: 0 },
        // campo oculto p/ jogador: requisito pode estar salvo aqui sem que
        // o jogador o veja ou edite — a prévia precisa preservá-lo
        { id: "f-hab", label: "Habilidades", tipo: "selecao_multipla", regraKind: "habilidade", visibilidade: "mestre", editavelPor: "mestre" },
      ],
    }],
    pontos: { habilitado: true, pontosIniciais: 10, pools: [{ id: "principal", nome: "Principal", pontos: 10 }], custos: { atributo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });

  // personagem do jogador (cria via API — fluxo real de criação)
  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J, body: { name: "Val Teste", templateVersionId: vid } });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  t("personagem criado", !!CHAR, JSON.stringify(pj.json).slice(0, 150));

  sec("Salvamento válido");
  {
    const ok = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: J, body: { data: { "f-apelido": "Val", "f-forca": 2, "f-int": 3 } } });
    t("ficha válida salva", ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 120)}`);
  }

  sec("Erros estruturados de regras no 400");
  let det;
  {
    const r = await req(BASE, "PATCH", `/characters/${CHAR}`, {
      cookie: J,
      body: { data: { "f-forca": 9, "f-int": 1, "f-defeitos": [], "f-poderes": ["teleporte", "mente"] } },
    });
    t("PATCH inválido -> 400", r.status === 400, `status=${r.status}`);
    det = r.json?.detalhes;
    t("detalhes.erros é lista", Array.isArray(det?.erros), JSON.stringify(det).slice(0, 200));
    const msgs = (det?.erros ?? []).map((e) => e.mensagem).join(" | ");
    t("dependência Teleporte→Covardia informada", msgs.includes("Teleporte") && msgs.includes("Covardia"), msgs.slice(0, 300));
    t("pré-requisito de atributo informado", msgs.includes("Mente") && (msgs.includes("Inteligência") || msgs.includes("inteligencia")), msgs.slice(0, 300));
    t("pontos insuficientes informado", msgs.includes("ponto") || msgs.includes("Principal"), msgs.slice(0, 300));
    t("erros têm codigo/mensagem", (det?.erros ?? []).every((e) => typeof e.mensagem === "string" && typeof e.codigo === "string"), JSON.stringify(det?.erros?.[0]));
    t("algum erro tem campoId para localização", (det?.erros ?? []).some((e) => typeof e.campoId === "string"), JSON.stringify(det?.erros).slice(0, 200));
    t("múltiplos problemas listados", (det?.erros ?? []).length >= 3, `n=${det?.erros?.length}`);
  }

  sec("Erros estruturados de ficha no 400");
  {
    const r = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: J, body: { data: { "f-forca": "abc" } } });
    t("tipo inválido -> 400", r.status === 400, `status=${r.status}`);
    const detF = r.json?.detalhes;
    t("detalhes identifica o campo", typeof detF === "object" && detF !== null && Object.keys(detF).length > 0, JSON.stringify(detF).slice(0, 200));
    t("campo apontado é f-forca", detF && detF["f-forca"] !== undefined, JSON.stringify(detF).slice(0, 200));
  }

  sec("IDs legítimos 'pontos'/'erros' não são descartados");
  {
    const r = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: J, body: { data: { "pontos": "abc", "erros": "xyz" } } });
    t("valores inválidos -> 400", r.status === 400, `status=${r.status}`);
    const detP = r.json?.detalhes;
    t("chave 'pontos' presente", detP && detP["pontos"] !== undefined, JSON.stringify(detP).slice(0, 200));
    t("chave 'erros' presente", detP && detP["erros"] !== undefined, JSON.stringify(detP).slice(0, 200));
  }

  sec("Prévia de pontos retorna erros de regras (somente leitura)");
  {
    const base = { "f-apelido": "Val", "f-forca": 2, "f-int": 3 };
    // rascunho com Teleporte sem Covardia -> dependência aparece na prévia
    const r1 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J,
      body: { dados: { ...base, "f-defeitos": [], "f-poderes": ["teleporte"] } },
    });
    t("prévia 200", r1.status === 200, `status=${r1.status}`);
    const errs1 = r1.json?.validacao?.erros ?? [];
    t("prévia expõe dependência", errs1.some((e) => e.mensagem.includes("Teleporte") && e.mensagem.includes("Covardia")), JSON.stringify(errs1).slice(0, 300));
    // corrigindo o rascunho o erro some
    const r2 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J,
      body: { dados: { ...base, "f-defeitos": [{ key: "covardia", nivel: 1 }], "f-poderes": ["teleporte"] } },
    });
    const errs2 = r2.json?.validacao?.erros ?? [];
    t("prévia sem erro após corrigir", !errs2.some((e) => e.mensagem.includes("Teleporte")), JSON.stringify(errs2).slice(0, 300));
    // removendo o defeito o erro reaparece
    const r3 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J,
      body: { dados: { ...base, "f-defeitos": [], "f-poderes": ["teleporte"] } },
    });
    t("prévia reflete remoção do requisito", (r3.json?.validacao?.erros ?? []).some((e) => e.mensagem.includes("Teleporte")));
    // pontos insuficientes aparecem na prévia
    const r4 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J,
      body: { dados: { ...base, "f-forca": 9, "f-int": 9 } },
    });
    t("prévia expõe pontos insuficientes", (r4.json?.validacao?.erros ?? []).some((e) => e.codigo === "pontos" || e.mensagem.toLowerCase().includes("ponto")), JSON.stringify(r4.json?.validacao?.erros).slice(0, 300));
    // limite de poderes excedido aparece na prévia (máx. 1 por personagem)
    const r5 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J,
      body: { dados: { ...base, "f-defeitos": [{ key: "covardia", nivel: 1 }], "f-poderes": ["teleporte", "mente"] } },
    });
    const errs5 = r5.json?.validacao?.erros ?? [];
    t("prévia expõe limite excedido", errs5.some((e) => e.codigo === "limite_poderes" || e.mensagem.includes("Limite")), JSON.stringify(errs5).slice(0, 300));
    // voltando ao limite o erro some (Mente tem pré-requisito próprio — ok ter outros erros)
    const r6 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J,
      body: { dados: { ...base, "f-defeitos": [{ key: "covardia", nivel: 1 }], "f-poderes": ["teleporte"] } },
    });
    const errs6 = r6.json?.validacao?.erros ?? [];
    t("prévia limpa limite ao respeitar", !errs6.some((e) => e.codigo === "limite_poderes" || e.mensagem.includes("Limite")), JSON.stringify(errs6).slice(0, 300));
    // nada foi gravado: ficha salva não ganhou os poderes do rascunho
    const g = await req(BASE, "GET", `/characters/${CHAR}`, { cookie: J });
    const d = g.json?.ficha?.campos ?? {};
    t("prévia não gravou nada", !JSON.stringify(d["f-poderes"] ?? "").includes("teleporte"), JSON.stringify(d["f-poderes"]));
  }

  sec("Prévia preserva campos ocultos/não-editáveis");
  {
    // Lábia depende de Manipulação — que vive no campo oculto f-hab
    // (visibilidade/edição: mestre). O mestre grava o requisito.
    const seed = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: M, body: { data: { "f-hab": ["manipulacao"] } } });
    t("mestre grava campo oculto", seed.status === 200, `status=${seed.status} ${JSON.stringify(seed.json).slice(0, 150)}`);

    const base2 = { "f-apelido": "Val", "f-forca": 2, "f-int": 3 };
    const errosDe = (r) => r.json?.validacao?.erros ?? [];

    // rascunho do jogador não inclui f-hab (ele não a vê): a prévia deve
    // mesclar sobre os persistidos e NÃO acusar dependência ausente.
    const r1 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J, body: { dados: { ...base2, "f-poderes": ["labia"] } },
    });
    t("prévia reconhece requisito em campo oculto", !errosDe(r1).some((e) => e.mensagem.includes("Lábia")), JSON.stringify(errosDe(r1)).slice(0, 300));

    // jogador tenta enviar f-hab vazio para "remover" o requisito:
    // o campo não é editável por ele -> valor ignorado, persistido mantido.
    const r2 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J, body: { dados: { ...base2, "f-hab": [], "f-poderes": ["labia"] } },
    });
    t("alteração em campo oculto é ignorada", !errosDe(r2).some((e) => e.mensagem.includes("Lábia")), JSON.stringify(errosDe(r2)).slice(0, 300));
    const gM = await req(BASE, "GET", `/characters/${CHAR}`, { cookie: M });
    t("dado persistido do campo oculto intacto", JSON.stringify(gM.json?.ficha?.campos?.["f-hab"] ?? "").includes("manipulacao"), JSON.stringify(gM.json?.ficha?.campos?.["f-hab"]));

    // dependência realmente ausente: Presença furtiva exige Furtividade,
    // que não está em nenhum campo -> erro deve aparecer.
    const r3 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: J, body: { dados: { ...base2, "f-poderes": ["furtivo"] } },
    });
    const errs3 = errosDe(r3);
    t("prévia acusa dependência realmente ausente", errs3.some((e) => e.mensagem.includes("Presença furtiva") && e.mensagem.includes("Furtividade")), JSON.stringify(errs3).slice(0, 300));
    t("sem vazamento de campo oculto nas mensagens", !errs3.some((e) => e.campoId === "f-hab" || e.mensagem.includes("Habilidades")), JSON.stringify(errs3).slice(0, 300));

    // corrigir: rascunho com Lábia (requisito oculto presente) -> sem erro
    const r4 = await req(BASE, "POST", `/characters/${CHAR}/pontos-previa`, {
      cookie: M, body: { dados: { ...base2, "f-hab": ["manipulacao"], "f-poderes": ["labia"] } },
    });
    t("mestre pré-visualiza com campo oculto editável", !errosDe(r4).some((e) => e.mensagem.includes("Lábia")), JSON.stringify(errosDe(r4)).slice(0, 300));

    // e nada disso foi persistido: poderes do jogador continuam vazios
    const gJ = await req(BASE, "GET", `/characters/${CHAR}`, { cookie: J });
    t("prévia segue sem persistir", !JSON.stringify(gJ.json?.ficha?.campos?.["f-poderes"] ?? "").match(/labia|furtivo/), JSON.stringify(gJ.json?.ficha?.campos?.["f-poderes"]));
  }

  sec("Dados preservados após falha");
  {
    const g = await req(BASE, "GET", `/characters/${CHAR}`, { cookie: J });
    const d = g.json?.ficha?.campos ?? g.json?.personagem?.data ?? {};
    t("apelido anterior preservado", d["f-apelido"] === "Val", JSON.stringify(d).slice(0, 150));
  }

  sec("Correção permite salvar");
  {
    const fix = await req(BASE, "PATCH", `/characters/${CHAR}`, {
      cookie: J,
      body: { data: { "f-apelido": "Val", "f-forca": 2, "f-int": 3, "f-defeitos": [{ key: "covardia", nivel: 1 }], "f-poderes": ["teleporte"] } },
    });
    t("após corrigir salva", fix.status === 200, `status=${fix.status} ${JSON.stringify(fix.json).slice(0, 200)}`);
    const g = await req(BASE, "GET", `/characters/${CHAR}`, { cookie: J });
    const d = g.json?.ficha?.campos ?? {};
    t("poder salvo", JSON.stringify(d["f-poderes"]).includes("teleporte"), JSON.stringify(d).slice(0, 150));
  }

  sec("Jogador não contorna validação");
  {
    const hack = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: J, body: { data: { "f-forca": 99 } } });
    t("valor fora do range rejeitado", hack.status === 400 || hack.status === 403, `status=${hack.status}`);
    const g = await req(BASE, "GET", `/characters/${CHAR}`, { cookie: J });
    const d = g.json?.ficha?.campos ?? {};
    t("valor não persistido", d["f-forca"] === 2, JSON.stringify(d["f-forca"]));
  }

  sec("Aprovação do mestre segue funcionando");
  {
    const sub = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: J, body: { status: "aguardando_aprovacao" } });
    t("jogador envia p/ aprovação", sub.status === 200, `status=${sub.status} ${JSON.stringify(sub.json).slice(0, 120)}`);
    const apr = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: M, body: { status: "aprovada" } });
    t("mestre aprova", apr.status === 200 && apr.json?.personagem?.status === "aprovada", `status=${apr.status} ${JSON.stringify(apr.json).slice(0, 150)}`);
  }
} finally {
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n==== validação-personagem: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
