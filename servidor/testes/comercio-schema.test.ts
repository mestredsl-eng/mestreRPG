// Testes — fundação de comércio 1.1.0 (Issue #286): schema de lojas,
// titularidade de caixa por estabelecimento (shop_id) no ledger único e
// roundtrip exportarCampanha → restaurarEstado preservando as coleções.
// Executar: npm run test:comercio -w servidor (após npm run build -w servidor)
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = resolve(__dirname, "..", "..");

const TMP = mkdtempSync(join(tmpdir(), "comercio-schema-"));
const BANCO = join(TMP, "banco", "mestre-rpg.db");
const ARQUIVOS = join(TMP, "arquivos", "campanhas");
const BACKUPS = join(TMP, "backups");
const STATE = join(TMP, "state");

process.env.MESTRE_BANCO = BANCO;
process.env.MESTRE_ARQUIVOS = ARQUIVOS;
process.env.MESTRE_BACKUPS = BACKUPS;
process.env.MESTRE_STATE_DIR = STATE;

let db: import("../src/db/index.js").Db;
let schema: typeof import("../src/db/schema.js");
let estado: typeof import("../src/lib/estado.js");
let restaurar: typeof import("../src/lib/restaurar.js");
let eq: typeof import("drizzle-orm").eq;

const IDS = {
  user: "u-mestre", campaign: "c-loja", membership: "mem-mestre",
  char: "ch-heroi", shop: "shop-zé", manager: "sm-1",
  offer: "so-1", order: "sord-1", shopAccount: "fa-loja", buyerAccount: "fa-heroi",
  shopTx: "tx-loja", buyerTx: "tx-heroi",
};

before(async () => {
  mkdirSync(BACKUPS, { recursive: true });
  const auth = spawnSync("node", [join(RAIZ_REPO, "scripts", "autorizar-bootstrap.mjs"), "--confirmar-provisionamento"], {
    env: { ...process.env }, encoding: "utf8",
  });
  assert.equal(auth.status, 0, `autorizar-bootstrap falhou: ${auth.stdout}${auth.stderr}`);
  const mig = spawnSync("node", [join(RAIZ_REPO, "servidor", "dist", "db", "migrate.js")], {
    env: { ...process.env }, encoding: "utf8",
  });
  assert.equal(mig.status, 0, `migrate falhou: ${mig.stderr}`);
  const idx = await import("../src/db/index.js");
  db = idx.getDb();
  schema = await import("../src/db/schema.js");
  estado = await import("../src/lib/estado.js");
  restaurar = await import("../src/lib/restaurar.js");
  ({ eq } = await import("drizzle-orm"));

  const agora = new Date();
  await db.insert(schema.users).values({ id: IDS.user, username: "mestre-loja", passwordHash: "x", createdAt: agora, updatedAt: agora });
  await db.insert(schema.campaigns).values({ id: IDS.campaign, name: "Campanha Loja", ownerId: IDS.user, createdAt: agora, updatedAt: agora });
  await db.insert(schema.memberships).values({ id: IDS.membership, campaignId: IDS.campaign, userId: IDS.user, role: "mestre", createdAt: agora, updatedAt: agora });
  await db.insert(schema.characters).values({ id: IDS.char, campaignId: IDS.campaign, membershipId: IDS.membership, name: "Herói", data: {}, createdAt: agora, updatedAt: agora });
  // loja + gestor + oferta + pedido
  await db.insert(schema.shops).values({ id: IDS.shop, campaignId: IDS.campaign, name: "Loja do Zé", category: "mercadoria", isOpen: true, createdAt: agora, updatedAt: agora });
  await db.insert(schema.shopManagers).values({ id: IDS.manager, shopId: IDS.shop, campaignId: IDS.campaign, membershipId: IDS.membership, role: "gestor", createdAt: agora });
  await db.insert(schema.shopOffers).values({ id: IDS.offer, shopId: IDS.shop, campaignId: IDS.campaign, name: "Poção", priceCents: 500, stockQty: 3, isActive: true, createdAt: agora, updatedAt: agora });
  await db.insert(schema.shopOrders).values({ id: IDS.order, campaignId: IDS.campaign, shopId: IDS.shop, requestId: "req-1", createdBy: IDS.user, direction: "compra", buyerCharacterId: IDS.char, items: [{ offerId: IDS.offer, name: "Poção", qty: 1, unitCents: 500 }], totalCents: 500, moneyTransactionIds: [IDS.shopTx, IDS.buyerTx], createdAt: agora });
  // caixa da loja: conta SEM personagem (titular = estabelecimento)
  await db.insert(schema.financialAccounts).values({ id: IDS.shopAccount, shopId: IDS.shop, campaignId: IDS.campaign, type: "especie", name: "Caixa da loja", balanceCents: 500, currency: "BRL", createdAt: agora, updatedAt: agora });
  await db.insert(schema.financialAccounts).values({ id: IDS.buyerAccount, characterId: IDS.char, campaignId: IDS.campaign, type: "especie", name: "Bolso", balanceCents: 9500, currency: "BRL", createdAt: agora, updatedAt: agora });
  // perna da loja (characterId NULL + shopId) e perna do comprador (characterId + shopId)
  await db.insert(schema.moneyTransactions).values({ id: IDS.shopTx, shopId: IDS.shop, campaignId: IDS.campaign, kind: "venda", amount: 5, amountCents: 500, balanceBeforeCents: 0, balanceAfterCents: 500, requestId: "req-1:in", accountId: IDS.shopAccount, createdBy: IDS.user, createdAt: agora });
  await db.insert(schema.moneyTransactions).values({ id: IDS.buyerTx, characterId: IDS.char, shopId: IDS.shop, campaignId: IDS.campaign, kind: "compra", amount: -5, amountCents: -500, balanceBeforeCents: 10000, balanceAfterCents: 9500, requestId: "req-1:out", accountId: IDS.buyerAccount, createdBy: IDS.user, createdAt: agora });
});

describe("comércio 1.1.0 — schema e titularidade", () => {
  it("tabelas shops/shop_managers/shop_offers/shop_orders exportadas no schema", async () => {
    const { getTableConfig } = await import("drizzle-orm/sqlite-core");
    const nomes = [schema.shops, schema.shopManagers, schema.shopOffers, schema.shopOrders]
      .map((t) => getTableConfig(t as never).name);
    assert.deepEqual(nomes.sort(), ["shop_managers", "shop_offers", "shop_orders", "shops"]);
    // linhas semeadas provam que as tabelas existem de fato no banco migrado
    const [{ c }] = await db.select({ c: schema.shops.id }).from(schema.shops);
    assert.equal(c, IDS.shop);
  });

  it("conta de loja existe sem character_id e com shop_id", async () => {
    const [conta] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.id, IDS.shopAccount));
    assert.equal(conta.shopId, IDS.shop);
    assert.equal(conta.characterId, null);
    assert.equal(conta.balanceCents, 500);
  });

  it("transação da loja tem characterId NULL e shopId preenchido; perna do comprador tem ambos", async () => {
    const [txLoja] = await db.select().from(schema.moneyTransactions).where(eq(schema.moneyTransactions.id, IDS.shopTx));
    assert.equal(txLoja.characterId, null);
    assert.equal(txLoja.shopId, IDS.shop);
    const [txHeroi] = await db.select().from(schema.moneyTransactions).where(eq(schema.moneyTransactions.id, IDS.buyerTx));
    assert.equal(txHeroi.characterId, IDS.char);
    assert.equal(txHeroi.shopId, IDS.shop);
  });
});

describe("comércio 1.1.0 — export/restore", () => {
  it("exportarCampanha inclui as 4 coleções de loja com campaignId coerente", async () => {
    const est = await estado.exportarCampanha(IDS.campaign);
    assert.equal(est.shops.length, 1);
    assert.equal(est.shops[0].id, IDS.shop);
    assert.equal(est.shopManagers.length, 1);
    assert.equal(est.shopOffers.length, 1);
    assert.equal(est.shopOrders.length, 1);
    for (const col of [est.shops, est.shopManagers, est.shopOffers, est.shopOrders]) {
      for (const r of col) assert.equal((r as { campaignId: string }).campaignId, IDS.campaign);
    }
    // conta da loja viaja dentro de financialAccounts (mesmo ledger)
    const contaLoja = est.financialAccounts.find((a) => a.id === IDS.shopAccount);
    assert.ok(contaLoja, "conta da loja exportada em financialAccounts");
    assert.equal(contaLoja.characterId, null);
    assert.equal(contaLoja.shopId, IDS.shop);
  });

  it("restaurarEstado (origem interna) preserva lojas, ofertas, pedidos e caixa", async () => {
    const est = await estado.exportarCampanha(IDS.campaign);
    // adultera fora do estado para provar que a restauração realmente reinsere
    await db.delete(schema.shopOrders).where(eq(schema.shopOrders.id, IDS.order));
    await db.delete(schema.shopOffers).where(eq(schema.shopOffers.id, IDS.offer));
    const res = await restaurar.restaurarEstado(IDS.campaign, est, { origem: "interna" });
    assert.ok(res, "restauração retornou relatório");
    const est2 = await estado.exportarCampanha(IDS.campaign);
    assert.equal(est2.shops.length, 1);
    assert.equal(est2.shopManagers.length, 1);
    assert.equal(est2.shopOffers.length, 1);
    assert.equal(est2.shopOrders.length, 1);
    assert.equal(est2.shopOrders[0].requestId, "req-1");
    assert.equal(est2.shopOffers[0].stockQty, 3);
    const conta = est2.financialAccounts.find((a) => a.id === IDS.shopAccount);
    assert.equal(conta?.balanceCents, 500);
    assert.equal(conta?.shopId, IDS.shop);
  });
});
