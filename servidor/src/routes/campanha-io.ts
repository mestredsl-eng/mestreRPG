import { Router } from "express";
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, CAMINHOS } from "../db/index.js";
import {
  campaigns, memberships, users, snapshots, sessions, guilds,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { ehGM } from "../lib/guildas.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha, iniciarBarreiraRestauracao, liberarBarreiraRestauracao, notificarPermissaoAtualizada, reconciliarMembrosAposRestauracao, pausaTesteEmit } from "../lib/io.js";
import { exportarCampanha, exportarPacote, type EstadoCampanha, type PacoteExportacao } from "../lib/estado.js";
import { restaurarEstado, inserirEstado } from "../lib/restaurar.js";
import { limiteUsuario } from "../lib/ratelimit.js";

const db = getDb();
export const campanhaIORouter = Router({ mergeParams: true });
campanhaIORouter.use(requireAuth);

// Operações pesadas: exportar serializa a campanha inteira; importar grava
// até 80MB de pacote + binários (Etapa 15, R4).
const limiteExportar = limiteUsuario({ nome: "exportar-campanha", janelaMs: 5 * 60_000, max: 12 });
const limiteImportar = limiteUsuario({ nome: "importar-campanha", janelaMs: 10 * 60_000, max: 20 });

/** GET /api/campaigns/:campaignId/exportar — pacote completo da campanha (mestre) */
campanhaIORouter.get("/:campaignId/exportar", requirePapel("mestre"), limiteExportar, async (req, res) => {
  const pacote = await exportarPacote(req.params.campaignId);
  await audit(req, "campanha.exportada", { campaignId: req.params.campaignId });
  res.setHeader("content-disposition", `attachment; filename="campanha-${req.params.campaignId}.json"`);
  res.json(pacote);
});

const importarSchema = z.object({
  pacote: z.unknown(),
  modo: z.enum(["nova", "substituir"]).default("nova"),
  campaignId: z.string().optional(),
  confirmacao: z.string().optional(),
});

function pacoteValido(p: unknown): p is PacoteExportacao {
  const pacote = p as PacoteExportacao;
  return !!pacote && pacote.versao === 1 && typeof pacote.campanhaId === "string"
    && !!pacote.estado && typeof pacote.estado === "object"
    && typeof pacote.estado.campanha === "object" && pacote.estado.campanha !== null
    && Array.isArray(pacote.estado.memberships) && Array.isArray(pacote.estado.characters)
    && typeof pacote.arquivos === "object" && pacote.arquivos !== null;
}

/** Garante que todas as entidades do pacote pertencem ao campaignId declarado (anti-adulteração). */
function coerenteComCampanha(estado: EstadoCampanha, cid: string): boolean {
  const colecoes = [
    estado.memberships, estado.invitations, estado.sheetTemplates, estado.characters,
    estado.ruleSets, estado.itemTemplates, estado.vehicles, estado.financialAccounts,
    estado.moneyTransactions, estado.sessions, estado.chatMessages, estado.rolls,
    estado.tests, estado.notes, estado.files, estado.folders,
  ];
  return colecoes.every((rows) =>
    (rows ?? []).every((r) => (r as { campaignId?: string }).campaignId === cid));
}

/** POST /api/campaigns/importar — importa pacote exportado (Etapa 12) */
campanhaIORouter.post("/importar", limiteImportar, async (req, res) => {
  const body = importarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const { pacote, modo } = body.data;
  if (!pacoteValido(pacote)) { res.status(400).json({ erro: "Pacote de campanha inválido ou incompatível" }); return; }
  const estado = pacote.estado;

  // ---- modo substituir: restaura sobre campanha existente do próprio usuário ----
  if (modo === "substituir") {
    const cid = body.data.campaignId;
    if (!cid) { res.status(400).json({ erro: "campaignId obrigatório no modo substituir" }); return; }
    if (body.data.confirmacao !== "SUBSTITUIR") {
      res.status(400).json({ erro: 'Confirmação obrigatória: { "confirmacao": "SUBSTITUIR" }' }); return;
    }
    const [m] = await db.select().from(memberships)
      .where(and(eq(memberships.campaignId, cid), eq(memberships.userId, req.usuario!.id), eq(memberships.role, "mestre"), eq(memberships.status, "ativo"))).limit(1);
    if (!m) { res.status(403).json({ erro: "Somente o mestre da campanha pode substituí-la" }); return; }
    if (pacote.campanhaId !== cid || !coerenteComCampanha(estado, cid)) {
      res.status(400).json({ erro: "O pacote não pertence a esta campanha" }); return;
    }

    // mesma barreira exclusiva do snapshot: drena leases, evacua
    // sockets e bloqueia entradas/operações ANTES de capturar o
    // estado; uma segunda substituição recebe 409 e NUNCA cria
    // snapshot prévio próprio
    const restoreId = await iniciarBarreiraRestauracao(cid);
    if (restoreId === "timeout") {
      res.status(503).json({ erro: "Substituição abortada: operações em andamento não terminaram a tempo — tente novamente" });
      return;
    }
    if (restoreId === "falha") {
      res.status(503).json({ erro: "Substituição abortada: falha ao preparar a barreira — tente novamente" });
      return;
    }
    if (!restoreId) {
      res.status(409).json({ erro: "Já existe uma restauração em andamento nesta campanha" });
      return;
    }
    // REVALIDAÇÃO pós-barreira: o papel de mestre foi verificado antes
    // da drenagem — a membership pode ter mudado nesse intervalo.
    // Sem mestre ativo, libera em modo falha (nada commitado) e 403.
    await pausaTesteEmit("importar:revalidar");
    const [mAgora] = await db.select().from(memberships)
      .where(and(eq(memberships.campaignId, cid), eq(memberships.userId, req.usuario!.id), eq(memberships.role, "mestre"), eq(memberships.status, "ativo"))).limit(1);
    if (!mAgora) {
      await liberarBarreiraRestauracao(cid, restoreId, "falha").catch(() => false);
      res.status(403).json({ erro: "Autorização revogada antes da substituição" });
      return;
    }
    let commitado = false;
    try {
      const delayBarreira = Number(process.env.MESTRE_RESTORE_DELAY_MS ?? 0);
      if (process.env.NODE_ENV === "test" && delayBarreira > 0) {
        await new Promise((r) => setTimeout(r, delayBarreira));
      }
      // snapshot do estado atual DEPOIS da drenagem: captura
      // consistente, sem leases em voo (spec §5)
      const preSnapId = crypto.randomUUID();
      await db.insert(snapshots).values({
        id: preSnapId, campaignId: cid, kind: "pre_restauracao",
        description: `Automático — antes de importar pacote sobre a campanha`,
        data: (await exportarCampanha(cid)) as never, createdBy: req.usuario!.id, createdAt: new Date(),
      });
      // membros atuais ANTES de substituir: quem não constar no pacote
      // precisa ser revogado e notificado — consultar só o estado final
      // perderia esses usuários.
      const membrosAntes = await db.select().from(memberships).where(eq(memberships.campaignId, cid));
      const sessoesAntes = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, cid))).map((s) => s.id);
      let resultado;
      try {
        resultado = await restaurarEstado(cid, estado, { gravarArquivos: pacote.arquivos });
        commitado = true;
      } catch (e) {
        await liberarBarreiraRestauracao(cid, restoreId, "falha");
        res.status(500).json({ erro: "Falha ao importar/substituir", detalhe: String(e) });
        return;
      }
      const membrosDepois = await db.select().from(memberships).where(eq(memberships.campaignId, cid));
      const sessoesDepois = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, cid))).map((s) => s.id);
      const rec = await reconciliarMembrosAposRestauracao(cid, membrosAntes, membrosDepois, sessoesAntes, sessoesDepois);
      if (rec.falhas.length) {
        await liberarBarreiraRestauracao(cid, restoreId, "sucesso");
        res.status(500).json({ erro: "Importação aplicada, mas a reconciliação de sockets falhou para alguns membros", detalhes: rec.falhas });
        return;
      }
      const liberou = await liberarBarreiraRestauracao(cid, restoreId, "sucesso");
      if (!liberou) {
        res.status(500).json({ erro: "Importação aplicada, mas a reconstrução das salas falhou — a campanha permanece bloqueada e a recuperação será retomada" });
        return;
      }
      await audit(req, "campanha.importada_substituida", { campaignId: cid, preSnapshotId: preSnapId, ...resultado });
      emitirCampanha(cid, "campanha:restaurada", { campaignId: cid });
      res.json({ ok: true, campaignId: cid, modo, ...resultado });
      return;
    } catch (e) {
      console.error(`[importar] falha não tratada campanha=${cid}:`, e);
      await liberarBarreiraRestauracao(cid, restoreId, commitado ? "sucesso" : "falha").catch(() => false);
      if (!res.headersSent) {
        res.status(500).json({ erro: commitado ? "Importação aplicada, mas a finalização falhou" : "Falha ao importar/substituir", detalhe: String(e) });
      }
      return;
    }
  }

  // ---- modo nova: cria campanha a partir do pacote ----
  const cid = pacote.campanhaId ?? crypto.randomUUID();
  if (typeof cid !== "string" || !/^[\w-]{8,64}$/.test(cid)) { res.status(400).json({ erro: "Identificador de campanha inválido no pacote" }); return; }
  if (!coerenteComCampanha(estado, cid)) {
    res.status(400).json({ erro: "Pacote inconsistente: entidades de outra campanha" }); return;
  }
  const [existente] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, cid)).limit(1);
  if (existente) {
    res.status(409).json({ erro: "Já existe uma campanha com este identificador", sugestao: "Use modo 'substituir' (somente o mestre da campanha) ou edite o pacote." });
    return;
  }

  // membros do pacote precisam existir nesta instalação
  const userIds = [...new Set((estado.memberships as { userId: string }[]).map((m) => m.userId))];
  if (userIds.length) {
    const encontrados = await db.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
    const set = new Set(encontrados.map((u) => u.id));
    const faltando = userIds.filter((u) => !set.has(u));
    if (faltando.length) {
      res.status(422).json({ erro: "O pacote referencia usuários que não existem nesta instalação", usuariosAusentes: faltando.length });
      return;
    }
  }

  // grava binários ANTES da transação: se o SQLite falhar, removemos apenas o
  // que esta operação criou (arquivos preexistentes nunca são tocados)
  const baseDir = resolve(CAMINHOS.arquivos, cid);
  const gravados = new Set<string>();
  for (const [fileId, arq] of Object.entries(pacote.arquivos ?? {})) {
    const meta = (estado.files as { id: string; storageName: string | null }[]).find((f) => f.id === fileId);
    if (!meta?.storageName || !arq?.conteudo) continue;
    const destino = resolve(baseDir, meta.storageName);
    if (!destino.startsWith(baseDir + sep) || gravados.has(destino)) continue;
    try {
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(destino, Buffer.from(arq.conteudo, "base64"));
      gravados.add(destino);
    } catch { /* best-effort: arquivo fica ausente, metadados ainda importam */ }
  }

  // guildId vem do pacote e pode ser forjado: só é honrado se o
  // importador for ADMIN ou GM ativo daquela guilda — caso contrário
  // a campanha nasceria vinculada à guilda de terceiros (IDOR).
  // (validado ANTES da transação: better-sqlite3 não aceita await dentro)
  const camposCampanha = estado.campanha as Record<string, unknown>;
  const guildIdPacote = typeof camposCampanha.guildId === "string" ? camposCampanha.guildId : null;
  let guildIdValido: string | null = null;
  if (guildIdPacote) {
    const [g] = await db.select({ id: guilds.id }).from(guilds)
      .where(and(eq(guilds.id, guildIdPacote), eq(guilds.status, "ativa"))).limit(1);
    if (g && (req.usuario!.isAdmin || (await ehGM(g.id, req.usuario!.id)))) guildIdValido = g.id;
  }

  const precisaMembroExtra = !(estado.memberships as { userId: string }[]).some((m) => m.userId === req.usuario!.id);
  try {
    db.transaction((tx) => {
      const { id: _i, ownerId: _o, createdAt: _c, updatedAt: _u, ...campos } = camposCampanha;
      tx.insert(campaigns).values({
        id: cid, ownerId: req.usuario!.id,
        ...(campos as object),
        guildId: guildIdValido,
        createdAt: new Date(), updatedAt: new Date(),
      } as never).run();
      inserirEstado(tx, estado);
      // garante o importador como mestre mesmo que o pacote não o tenha
      if (precisaMembroExtra) {
        tx.insert(memberships).values({
          id: crypto.randomUUID(), campaignId: cid, userId: req.usuario!.id, role: "mestre",
          permissions: {}, status: "ativo", joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
        } as never).run();
      }
    });
  } catch (e) {
    // rollback dos artefatos físicos criados por esta operação
    for (const p of gravados) { try { rmSync(p); } catch { /* ignora */ } }
    try { rmdirSync(baseDir); } catch { /* diretório pode ter conteúdo preexistente */ }
    res.status(422).json({ erro: "Falha de integridade ao importar pacote", detalhe: String(e) });
    return;
  }

  // A importação pode criar/reactivar memberships de usuários já conectados
  // (userIds validados acima) — notifica cada um com seu papel/status atuais.
  const membrosImportados = await db.select().from(memberships).where(eq(memberships.campaignId, cid));
  for (const m of membrosImportados) {
    notificarPermissaoAtualizada(cid, { userId: m.userId, role: m.role, status: m.status, permissions: m.permissions });
  }
  await audit(req, "campanha.importada", { campaignId: cid, arquivosGravados: gravados.size });
  res.status(201).json({ ok: true, campaignId: cid, modo, arquivosGravados: gravados.size });
});
