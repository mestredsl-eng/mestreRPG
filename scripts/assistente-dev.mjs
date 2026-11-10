import { readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const repo = process.env.GITHUB_REPOSITORY ?? "local";
const token = process.env.GITHUB_TOKEN;
const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: \`Bearer \${token}\` } : {}) };

async function github(endpoint) {
  if (!token) return null;
  const response = await fetch(\`\${apiBase}/repos/\${repo}\${endpoint}\`, { headers });
  if (!response.ok) throw new Error(\`GitHub API \${response.status} em \${endpoint}: \${(await response.text()).slice(0, 300)}\`);
  return response.json();
}

async function walk(dir, output = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(absolute, output);
    else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

async function scanMarkers() {
  const files = (await Promise.all(["servidor/src", "site/src"].map((dir) => walk(path.join(root, dir))))).flat();
  const markers = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\b(TODO|FIXME|XXX)\b/i.test(line)) markers.push({ file: path.relative(root, file).replaceAll("\\", "/"), line: index + 1, marker: line.trim().slice(0, 220) });
    });
  }
  return { filesScanned: files.length, markers: markers.slice(0, 80), total: markers.length };
}

function isDevin(commit) {
  const author = commit.author?.login ?? "";
  const committer = commit.committer?.login ?? "";
  const message = commit.commit?.message ?? "";
  return /devin/i.test(author) || /devin/i.test(committer) || /Generated with \[?Devin|Co-Authored-By:\s*Devin/i.test(message);
}

async function inspectPullRequests() {
  const pulls = await github("/pulls?state=open&per_page=100") ?? [];
  return Promise.all(pulls.map(async (pr) => {
    const [commits, checks] = await Promise.all([
      github(\`/pulls/\${pr.number}/commits?per_page=20\`).catch(() => []),
      github(\`/commits/\${pr.head.sha}/check-runs\`).catch(() => ({ check_runs: [] })),
    ]);
    const runs = checks?.check_runs ?? [];
    const failed = runs.filter((check) => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion));
    const pending = runs.filter((check) => check.status !== "completed");
    const devinCommits = (commits ?? []).filter(isDevin).map((commit) => ({
      sha: commit.sha?.slice(0, 8), message: (commit.commit?.message ?? "").split("\n")[0],
      author: commit.author?.login ?? commit.commit?.author?.name ?? "desconhecido",
      date: commit.commit?.author?.date ?? null, url: commit.html_url,
    }));
    return {
      number: pr.number, title: pr.title, url: pr.html_url, head: pr.head.ref, base: pr.base.ref,
      updatedAt: pr.updated_at, ageDays: Math.floor((Date.now() - Date.parse(pr.updated_at)) / 86400000),
      mergeable: pr.mergeable, draft: pr.draft,
      checks: { total: runs.length, failed: failed.length, pending: pending.length, failedNames: failed.map((x) => x.name) },
      devinCommits,
    };
  }));
}

function priorityList(prs, markers, readme) {
  const tasks = [];
  for (const pr of prs) {
    if (pr.checks.failed) tasks.push({ priority: "P0", title: \`Corrigir CI da PR #\${pr.number}\`, detail: pr.checks.failedNames.join(", "), url: pr.url });
    if (pr.mergeable === false) tasks.push({ priority: "P1", title: \`Resolver conflitos da PR #\${pr.number}\`, detail: \`\${pr.head} → \${pr.base}\`, url: pr.url });
    if (pr.ageDays >= 14) tasks.push({ priority: "P2", title: \`Revisar PR #\${pr.number} sem atualização há \${pr.ageDays} dias\`, detail: pr.title, url: pr.url });
    if (pr.base !== "main") tasks.push({ priority: "P2", title: \`Verificar ordem da PR empilhada #\${pr.number}\`, detail: \`\${pr.head} depende de \${pr.base}\`, url: pr.url });
  }
  if (markers.total) tasks.push({ priority: "P2", title: \`Revisar \${markers.total} marcadores TODO/FIXME/XXX\`, detail: "Pistas para avaliação humana; não são defeitos confirmados.", url: null });
  const pending = readme.match(/### Pendências que dependem de decisão do mestre([\s\S]*?)(?:\n### |\n## |$)/i)?.[1]?.trim();
  if (pending && pending !== "- Nenhuma.") tasks.push({ priority: "P3", title: "Revisar pendências documentadas que dependem de decisão", detail: pending.replace(/\s+/g, " ").slice(0, 500), url: null });
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return tasks.sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, 50);
}

const [prs, markers, readme] = await Promise.all([
  token ? inspectPullRequests() : Promise.resolve([]),
  scanMarkers(),
  readFile(path.join(root, "README.md"), "utf8").catch(() => ""),
]);
const devin = prs.flatMap((pr) => pr.devinCommits.map((commit) => ({ ...commit, pr: pr.number, prUrl: pr.url })));
const tasks = priorityList(prs, markers, readme);
const now = new Date().toISOString();
const report = {
  generatedAt: now, repository: repo, ref: process.env.GITHUB_REF ?? "local",
  sha: process.env.GITHUB_SHA ?? "local", event: process.env.GITHUB_EVENT_NAME ?? "local",
  pullRequests: prs, devinActivity: devin, sourceScan: markers, priorities: tasks,
  note: "Análise automatizada por heurísticas. Não substitui revisão funcional, homologação no navegador nem decisão do mestre.",
};
const lines = [
  "# Mestre RPG — relatório do Assistente de Desenvolvimento", "",
  \`- Gerado: \${now}\`, \`- Repositório: \${repo}\`, \`- Ref: \${report.ref}\`, \`- Commit: \${report.sha}\`, \`- Evento: \${report.event}\`, "",
  "## Resumo", "", \`- PRs abertas: **\${prs.length}**\`,
  \`- Commits atribuídos ao Devin nas PRs abertas: **\${devin.length}**\`,
  \`- Arquivos de código inspecionados: **\${markers.filesScanned}**\`,
  \`- Marcadores TODO/FIXME/XXX: **\${markers.total}**\`, "",
  "## Prioridades", "",
  ...(tasks.length ? tasks.map((t) => \`- **\${t.priority} — \${t.title}**\${t.url ? \` ([abrir](\${t.url}))\` : ""}\n  \${t.detail}\`) : ["Nenhuma pendência automática identificada."]),
  "", "## PRs abertas", "",
  ...(prs.length ? prs.map((pr) => \`- [#\${pr.number} — \${pr.title}](\${pr.url})\n  - \${pr.head} → \${pr.base}; atualizada há \${pr.ageDays} dia(s); mergeable: \${pr.mergeable ?? "não informado"}; checks: \${pr.checks.failed} falha(s), \${pr.checks.pending} pendente(s).\`) : ["Nenhuma PR aberta encontrada ou consulta indisponível."]),
  "", "## Atividade do Devin", "",
  ...(devin.length ? devin.map((c) => \`- PR #\${c.pr}: \${c.message} (\${c.author}, \${c.date ?? "data desconhecida"}) — [commit](\${c.url})\`) : ["Nenhum commit identificável como Devin nas PRs abertas consultadas."]),
  "", "## Marcadores no código", "",
  ...(markers.markers.length ? markers.markers.map((m) => \`- \${m.file}:\${m.line} — \${m.marker.replaceAll("\`", "'")}\`) : ["Nenhum TODO/FIXME/XXX encontrado em servidor/src e site/src."]),
  "", "## Limites desta auditoria", "",
  "- A CI executa os builds do servidor e do site; não executa homologações que dependem de banco persistente, contas de teste ou dados locais.",
  "- A identificação do Devin usa login/committer e marcas de coautoria; outras identidades podem não ser reconhecidas.",
  "- TODO/FIXME e pendências do README são sinais para revisão, não prova de defeito.",
  "- Relatório somente leitura: não cria branches, não altera arquivos do projeto, não comenta PRs e não faz merge.", "",
].join("\n");

await writeFile("assistente-dev-relatorio.md", lines, "utf8");
await writeFile("assistente-dev-relatorio.json", JSON.stringify(report, null, 2) + "\n", "utf8");
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines, "utf8");
console.log(\`Relatório gerado: \${prs.length} PRs, \${devin.length} commits Devin, \${markers.total} marcadores.\`);
