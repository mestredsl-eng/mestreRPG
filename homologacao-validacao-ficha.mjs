// Homologação E2E — mensagens de validação ao salvar ficha de personagem.
// Servidor isolado (banco novo + migrations + build do site) + Playwright.
// Cobre desktop e mobile: painel persistente, erros específicos, destaque
// de campo, navegação "ir para o campo" e preservação dos dados.
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-val-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };

const browser = await chromium.launch();
try {
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Validação Ficha", jogadores: { jogador1: "jogador_um" } });
  const CID = c.campId, M = c.cookieMestre, J = c.jogadores.jogador1.cookie;
  const JID = c.jogadores.jogador1.id;

  const ep = `/campaigns/${CID}/regras/elementos`;
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "defeito", key: "covardia", name: "Covardia", definition: { disponivel: true } } });
  await req(BASE, "POST", ep, { cookie: M, body: { kind: "poder", key: "teleporte", name: "Teleporte", definition: { dependencias: [{ kind: "defeito", key: "covardia" }], disponivel: true } } });

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
        // visível para todos, mas só o mestre altera — deve ficar somente leitura
        { id: "f-nota", label: "Anotação do mestre", tipo: "texto", editavelPor: "mestre" },
        // IDs legítimos que colidem com chaves internas do payload de erro
        { id: "pontos", label: "Pontos", tipo: "tabela", colunas: [{ key: "sit", label: "Situação", tipo: "selecao", opcoes: ["ativo", "inativo"] }] },
        { id: "erros", label: "Erros", tipo: "tabela", colunas: [{ key: "mot", label: "Motivo", tipo: "selecao", opcoes: ["x", "y"] }] },
      ],
    }],
    pontos: { habilitado: true, pontosIniciais: 10, pools: [{ id: "principal", nome: "Principal", pontos: 10 }], custos: { atributo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });

  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J, body: { name: "Val Desk", templateVersionId: vid } });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: J, body: { data: { "f-apelido": "Val", "f-forca": 2, "f-int": 3 } } });
  const pj2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J, body: { name: "Val Mob", templateVersionId: vid } });
  const CHAR2 = pj2.json?.personagem?.id ?? pj2.json?.id;
  await req(BASE, "PATCH", `/characters/${CHAR2}`, { cookie: J, body: { data: { "f-apelido": "ValM", "f-forca": 2, "f-int": 3 } } });
  t("personagens seed criados", !!CHAR && !!CHAR2);

  const cookieValor = J.split("=")[1];
  async function cenario(w, h, nome, nomePersonagem, apelidoEsp) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieValor, url: BASE }]);
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).click();
    await p.waitForTimeout(700);
    await p.locator(".cartao-campanha", { hasText: "Campanha Validação Ficha" }).first().click();
    await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /Personagens/ }).click();
    await p.waitForTimeout(800);
    await p.locator("tr", { hasText: nomePersonagem }).first().click();
    await p.waitForTimeout(1200);

    await p.getByRole("button", { name: "Editar ficha" }).click();
    await p.waitForTimeout(1000);
    // campo exclusivo do mestre: sem input editável + dica visível
    const notaInputs = await p.locator("#ficha-campo-f-nota input, #ficha-campo-f-nota textarea, #ficha-campo-f-nota select").count();
    t(`${nome}: campo do mestre sem input`, notaInputs === 0, `inputs=${notaInputs}`);
    const notaTexto = await p.locator("#ficha-campo-f-nota").innerText().catch(() => "");
    t(`${nome}: dica 'somente o mestre' visível`, notaTexto.includes("somente o mestre"), notaTexto.slice(0, 150));
    // marca Teleporte sem Covardia -> dependência violada
    await p.locator("#ficha-campo-f-poderes").getByText("Teleporte").click();
    await p.waitForTimeout(1400); // debounce 300ms + requisição

    // prévia ao vivo: erro de regra aparece antes mesmo de salvar
    const previa = p.locator(".simulacao-erros");
    const previaVisivel = await previa.isVisible().catch(() => false);
    const previaTexto = previaVisivel ? await previa.innerText() : "";
    t(`${nome}: prévia mostra dependência ao vivo`, previaVisivel && previaTexto.includes("Teleporte") && previaTexto.includes("Covardia"), previaTexto.slice(0, 300));

    await p.getByRole("button", { name: "Salvar" }).click();
    await p.waitForTimeout(1200);

    const painel = p.locator(".erros-salvamento");
    const visivel = await painel.isVisible().catch(() => false);
    const texto = visivel ? await painel.innerText() : "";
    t(`${nome}: painel de erros visível`, visivel);
    t(`${nome}: mensagem geral orientativa`, texto.includes("Não foi possível salvar"), texto.slice(0, 120));
    t(`${nome}: dependência explicada`, texto.includes("Teleporte") && texto.includes("Covardia"), texto.slice(0, 300));
    t(`${nome}: campo destacado`, (await p.locator(".campo-com-erro").count()) > 0);
    t(`${nome}: botão ir para o campo`, (await painel.getByRole("button", { name: /ir para o campo/ }).count()) > 0);
    const apelido = await p.locator("#ficha-campo-f-apelido input").inputValue().catch(() => "");
    t(`${nome}: dados preservados`, apelido === apelidoEsp, `apelido="${apelido}"`);
    const overflow = await p.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    t(`${nome}: sem overflow horizontal`, overflow === 0, `overflow=${overflow}`);

    // Cancelar: restaura valores/nome e limpa painel + destaques
    await p.getByRole("button", { name: "Cancelar" }).click();
    await p.waitForTimeout(600);
    t(`${nome}: cancelar sai da edição`, (await p.getByRole("button", { name: "Editar ficha" }).count()) > 0);
    t(`${nome}: painel some ao cancelar`, !(await painel.isVisible().catch(() => false)));
    t(`${nome}: destaques somem ao cancelar`, (await p.locator(".campo-com-erro").count()) === 0);
    const apelidoAposCancelar = await p.locator("#ficha-campo-f-apelido .valor-leitura").innerText().catch(() => "");
    t(`${nome}: valor original restaurado`, apelidoAposCancelar === apelidoEsp, `lido="${apelidoAposCancelar}"`);

    // Nova edição não mostra erros antigos
    await p.getByRole("button", { name: "Editar ficha" }).click();
    await p.waitForTimeout(800);
    t(`${nome}: reedição sem erros antigos`, !(await painel.isVisible().catch(() => false)) && (await p.locator(".campo-com-erro").count()) === 0);

    // corrige: Teleporte + Covardia nível 1
    await p.locator("#ficha-campo-f-poderes").getByText("Teleporte").click();
    await p.waitForTimeout(400);
    const bolinha = p.locator("#ficha-campo-f-defeitos .bolinha").first();
    if (await bolinha.count()) await bolinha.click();
    await p.waitForTimeout(1400); // debounce + requisição
    // prévia: erro some assim que o requisito é atendido
    const previaApos = await p.locator(".simulacao-erros").innerText().catch(() => "");
    t(`${nome}: prévia limpa após corrigir`, !previaApos.includes("Teleporte") || !(await p.locator(".simulacao-erros").isVisible().catch(() => false)), previaApos.slice(0, 200));
    await p.getByRole("button", { name: "Salvar" }).click();
    await p.waitForTimeout(1500);
    const salvo = await p.locator("text=Ficha salva").count();
    const aindaErro = await painel.isVisible().catch(() => false);
    t(`${nome}: após corrigir salva`, salvo > 0 && !aindaErro, `salvo=${salvo} erro=${aindaErro}`);
    t(`${nome}: sem erros de página`, erros.length === 0, erros.slice(0, 2).join(" | "));

    // IDs legítimos 'pontos'/'erros': valores inválidos devem aparecer no painel
    await p.getByRole("button", { name: "Editar ficha" }).click();
    await p.waitForTimeout(800);
    for (const [campoId, placeholder] of [["pontos", "Situação"], ["erros", "Motivo"]]) {
      await p.locator(`#ficha-campo-${campoId} button`, { hasText: "+ Adicionar" }).click();
      await p.waitForTimeout(300);
      await p.locator(`#ficha-campo-${campoId} input[placeholder="${placeholder}"]`).fill("zzz");
    }
    await p.waitForTimeout(300);
    await p.getByRole("button", { name: "Salvar" }).click();
    await p.waitForTimeout(1200);
    const painel2 = await painel.innerText().catch(() => "");
    t(`${nome}: erro do campo 'pontos' exibido`, painel2.includes("Pontos") && painel2.includes("Situação"), painel2.slice(0, 300));
    t(`${nome}: erro do campo 'erros' exibido`, painel2.includes("Erros") && painel2.includes("Motivo"), painel2.slice(0, 300));
    t(`${nome}: ambos destacados`, (await p.locator("#ficha-campo-pontos.campo-com-erro, #ficha-campo-erros.campo-com-erro").count()) === 2);
    await ctx.close();
  }

  await cenario(1280, 800, "desktop", "Val Desk", "Val");
  await cenario(390, 844, "mobile", "Val Mob", "ValM");
} finally {
  await browser.close();
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n==== homologação validação-ficha: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
