/**
 * Testes unitários do limitador Socket.IO (Issue #68).
 * Executar: npx tsx servidor/testes/socket-rate-limit.test.ts
 *
 * Cobre os itens de aceite que não dependem do handshake Socket.IO:
 * cotas por usuário (compartilhadas entre sockets/abas), independência
 * entre ações, retryAfterMs e recuperação após a janela.
 */
import assert from "node:assert/strict";
import {
  criarLimitadorSocket,
  chaveSocket,
  LIMITES_SOCKET_MESA,
  type AcaoMesaLimitada,
} from "../src/lib/socket-rate-limit.js";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

let falhas = 0;
function teste(nome: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok ${nome}`))
    .catch((e) => {
      falhas += 1;
      console.error(`  FALHOU ${nome}:`, e);
    });
}

async function main() {
  console.log("limitador socket — cotas e buckets");

  await teste("rajada acima da capacidade é rejeitada com retryAfterMs", async () => {
    const l = criarLimitadorSocket({ nome: "t", capacidade: 3, porSegundo: 1 });
    for (let i = 0; i < 3; i++) assert.equal(l.consumir("u1:chat").permitido, true);
    const r = l.consumir("u1:chat");
    assert.equal(r.permitido, false);
    assert.ok(r.retryAfterMs > 0, "retryAfterMs deve ser positivo");
  });

  await teste("taxa sustentada repõe tokens com o tempo", async () => {
    const l = criarLimitadorSocket({ nome: "t", capacidade: 2, porSegundo: 100 });
    assert.equal(l.consumir("u:chat").permitido, true);
    assert.equal(l.consumir("u:chat").permitido, true);
    assert.equal(l.consumir("u:chat").permitido, false);
    await dormir(30); // ~3 tokens repostos, teto é 2
    assert.equal(l.consumir("u:chat").permitido, true);
    assert.equal(l.consumir("u:chat").permitido, true);
    assert.equal(l.consumir("u:chat").permitido, false);
  });

  await teste("ações distintas têm cotas independentes", async () => {
    const l = criarLimitadorSocket({ nome: "t", capacidade: 1, porSegundo: 0.001 });
    const acoes: AcaoMesaLimitada[] = ["chat", "rolagem", "turno"];
    for (const acao of acoes) {
      assert.equal(l.consumir(chaveSocket("u1", acao)).permitido, true, acao);
      assert.equal(l.consumir(chaveSocket("u1", acao)).permitido, false, `${acao} estourou`);
    }
    // esgotou as três, mas cada bucket é próprio
    for (const acao of acoes) {
      assert.equal(l.consumir(chaveSocket("u1", acao)).permitido, false);
    }
    assert.equal(l.consumir(chaveSocket("u2", "chat")).permitido, true, "outro usuário não divide cota");
  });

  await teste("múltiplos sockets do mesmo usuário compartilham a cota", async () => {
    const l = criarLimitadorSocket({ nome: "t", capacidade: 2, porSegundo: 0.001 });
    // dois "sockets" do mesmo userId consomem o mesmo bucket
    assert.equal(l.consumir(chaveSocket("userA", "chat")).permitido, true);
    assert.equal(l.consumir(chaveSocket("userA", "chat")).permitido, true);
    assert.equal(l.consumir(chaveSocket("userA", "chat")).permitido, false);
  });

  await teste("usuários distintos não compartilham cota", async () => {
    const l = criarLimitadorSocket({ nome: "t", capacidade: 1, porSegundo: 0.001 });
    assert.equal(l.consumir(chaveSocket("userA", "rolagem")).permitido, true);
    assert.equal(l.consumir(chaveSocket("userA", "rolagem")).permitido, false);
    assert.equal(l.consumir(chaveSocket("userB", "rolagem")).permitido, true);
  });

  await teste("LIMITES_SOCKET_MESA cobre todas as ações de escrita previstas", () => {
    const esperadas: AcaoMesaLimitada[] = [
      "chat", "rolagem", "testePedir", "testeRolar", "testeDecidir", "turno",
      "vttMapa", "vttToken", "vttNevoa", "vttSync", "entrar",
    ];
    for (const acao of esperadas) {
      const cfg = LIMITES_SOCKET_MESA[acao];
      assert.ok(cfg.capacidade >= 1 && cfg.porSegundo > 0, acao);
      assert.ok(cfg.nome.startsWith("mesa-"), acao);
    }
  });

  await teste("reiniciar zera os buckets", async () => {
    const l = criarLimitadorSocket({ nome: "t", capacidade: 1, porSegundo: 0.001 });
    assert.equal(l.consumir("u:x").permitido, true);
    assert.equal(l.consumir("u:x").permitido, false);
    l.reiniciar();
    assert.equal(l.consumir("u:x").permitido, true);
  });

  await teste("maxChaves não remove buckets ativos nem renova cotas", async () => {
    // capacidade 2: uA esgota a cota; uB/uC seguem ativos (1 token).
    // O 4º usuário dispara podar() — nenhum bucket pode ser removido
    // porque todos estão parcialmente consumidos.
    const l = criarLimitadorSocket({ nome: "t", capacidade: 2, porSegundo: 0.0001, maxChaves: 3, limpezaMs: 60_000 });
    assert.equal(l.consumir("uA:x").permitido, true);
    assert.equal(l.consumir("uA:x").permitido, true);
    assert.equal(l.consumir("uA:x").permitido, false, "uA esgotado");
    assert.equal(l.consumir("uB:x").permitido, true);
    assert.equal(l.consumir("uC:x").permitido, true);
    // uD é a 4ª chave: com o bug antigo, podar() apagaria uA (ordem de
    // inserção) e a próxima chamada de uA voltaria a ser permitida.
    assert.equal(l.consumir("uD:x").permitido, true, "chave nova é aceita");
    assert.equal(l.consumir("uA:x").permitido, false, "cota de uA NÃO foi renovada pela poda");
    assert.equal(l.consumir("uB:x").permitido, true, "uB ainda tem seu token");
  });

  await teste("podar remove buckets expirados mesmo abaixo do teto", async () => {
    // limpezaMs curto: bucket ocioso por >10x é podado; recriar a chave
    // é seguro porque o usuário esteve inativo além da janela de refill.
    const l = criarLimitadorSocket({ nome: "t", capacidade: 1, porSegundo: 0.0001, limpezaMs: 30 });
    assert.equal(l.consumir("u:x").permitido, true);
    assert.equal(l.consumir("u:x").permitido, false);
    await dormir(400); // ~13x limpezaMs — bucket expirado
    assert.equal(l.consumir("u:x").permitido, true, "após expirar, a cota reinicia");
  });

  console.log(falhas === 0 ? "\nTodos os testes passaram." : `\n${falhas} teste(s) falharam.`);
  process.exit(falhas === 0 ? 0 : 1);
}

void main();
