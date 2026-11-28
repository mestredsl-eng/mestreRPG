// D6 (#365): portabilidade do domínio público da Internet —
// GET /internet/exportar e POST /internet/importar. Pacote próprio,
// separado do backup interno (P9) e do snapshot de campanha.
// Somente mestre da campanha opera (requirePapel + requireAuth já
// montados pelo router pai). Import exige confirmacao="IMPORTAR".
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import { exportarDominioPublico, importarDominioPublico } from "../lib/internet-portabilidade.js";

const db = getDb();
export const internetPortabilidadeRouter = Router({ mergeParams: true });
internetPortabilidadeRouter.use(requireAuth);

const limiteExportar = limiteUsuario({ nome: "internet-exportar", janelaMs: 5 * 60_000, max: 12 });
const limiteImportar = limiteUsuario({ nome: "internet-importar", janelaMs: 10 * 60_000, max: 20 });

const campanhaId = (req: { params: Record<string, string> }) => req.params.campaignId as string;

/** GET /api/campaigns/:campaignId/internet/exportar — pacote público
 *  do domínio Internet (sites/páginas/publicações/denúncias) com refs
 *  opacas novas por pacote. Read-only: não muta nada. */
internetPortabilidadeRouter.get("/exportar", requirePapel("mestre"), limiteExportar, async (req, res) => {
  const cid = campanhaId(req);
  const [camp] = await db.select({ nome: campaigns.name }).from(campaigns)
    .where(eq(campaigns.id, cid)).limit(1);
  if (!camp) { res.status(404).json({ erro: "Campanha não encontrada" }); return; }
  const pacote = await exportarDominioPublico(cid, camp.nome);
  await audit(req, "internet.dominio_exportado", { campaignId: cid });
  res.json(pacote);
});

const importarSchema = z.object({
  pacote: z.unknown(),
  confirmacao: z.literal("IMPORTAR"),
});

/** POST /api/campaigns/:campaignId/internet/importar — importa o
 *  pacote D6 na campanha alvo. Toda linha importada nasce read-only
 *  (origem='importado', contas NULL). Idempotente por ID de linha. */
internetPortabilidadeRouter.post("/importar", requirePapel("mestre"), limiteImportar, async (req, res) => {
  const cid = campanhaId(req);
  const body = importarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }

  let rel;
  try {
    rel = await importarDominioPublico(cid, body.data.pacote);
  } catch (e) {
    console.error("[internet-d6] import falhou:", e);
    res.status(500).json({ erro: "import_falhou", detalhes: String(e).slice(0, 500) });
    return;
  }
  if (!rel.ok) {
    res.status(400).json({ erro: rel.erro ?? "pacote_invalido", rejeitadas: rel.rejeitadas });
    return;
  }
  await audit(req, "internet.dominio_importado", {
    campaignId: cid,
    importadas: rel.importadas, jaExistentes: rel.jaExistentes,
    rejeitadas: rel.rejeitadas?.length ?? 0,
  });
  res.json(rel);
});
