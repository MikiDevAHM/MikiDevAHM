#!/usr/bin/env node
/**
 * language-stats.mjs
 * ---------------------------------------------------------------
 * Gera um ranking ponderado das linguagens mais usadas considerando:
 *   - volume de código (bytes reportados pela API do GitHub, em escala log)
 *   - número de repositórios distintos que usam a linguagem
 *   - bônus se a linguagem foi usada em algum commit nos últimos N dias
 *
 * Cobre repositórios próprios, de organizações (ownerAffiliations) e
 * repositórios de terceiros aos quais o usuário contribuiu
 * (repositoriesContributedTo) — tudo via GraphQL, sem clonar nada,
 * então roda em segundos, não em minutos.
 *
 * Env vars:
 *   GH_TOKEN          (obrigatório) token com escopo repo/read:org
 *   GH_LOGIN          (obrigatório) usuário alvo, ex: MikiDevAHM
 *   RECENT_DAYS       (default 15)
 *   MIN_LANGUAGES     (default 5)   apenas informativo/validação
 *   MAX_LANGUAGES     (default 8)
 *   WEIGHT_BYTES      (default 0.5)
 *   WEIGHT_REPOS      (default 0.3)
 *   RECENT_BONUS      (default 0.3)
 *   IGNORED_LANGUAGES (default "")  ex: "html,css"
 *   OUT_SVG           (default "language-stats.svg")
 *   OUT_JSON          (default "language-stats.json")
 * ---------------------------------------------------------------
 */

const GH_TOKEN = process.env.GH_TOKEN;
const GH_LOGIN = process.env.GH_LOGIN;
const RECENT_DAYS = Number(process.env.RECENT_DAYS ?? 15);
const MIN_LANGUAGES = Number(process.env.MIN_LANGUAGES ?? 5);
const MAX_LANGUAGES = Number(process.env.MAX_LANGUAGES ?? 8);
const WEIGHT_BYTES = Number(process.env.WEIGHT_BYTES ?? 0.5);
const WEIGHT_REPOS = Number(process.env.WEIGHT_REPOS ?? 0.3);
const RECENT_BONUS = Number(process.env.RECENT_BONUS ?? 0.3);
const IGNORED_LANGUAGES = (process.env.IGNORED_LANGUAGES ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const OUT_SVG = process.env.OUT_SVG ?? "language-stats.svg";
const OUT_JSON = process.env.OUT_JSON ?? "language-stats.json";

if (!GH_TOKEN || !GH_LOGIN) {
  console.error("Erro: defina GH_TOKEN e GH_LOGIN nas env vars.");
  process.exit(1);
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${GH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const REPO_FRAGMENT = `
  nameWithOwner
  isFork
  languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
    edges { size node { name color } }
  }
`;

const OWNED_QUERY = `
  query($login: String!, $after: String) {
    user(login: $login) {
      repositories(
        first: 100
        after: $after
        ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]
        isArchived: false
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REPO_FRAGMENT} }
      }
    }
  }
`;

const CONTRIBUTED_QUERY = `
  query($login: String!, $after: String) {
    user(login: $login) {
      repositoriesContributedTo(
        first: 100
        after: $after
        includeUserRepositories: true
        contributionTypes: [COMMIT]
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REPO_FRAGMENT} }
      }
    }
  }
`;

const RECENT_QUERY = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner }
        }
      }
    }
  }
`;

async function fetchAllRepos(query, connectionName) {
  const repos = [];
  let after = null;
  let hasNext = true;
  while (hasNext) {
    const data = await graphql(query, { login: GH_LOGIN, after });
    const conn = data.user[connectionName];
    repos.push(...conn.nodes);
    hasNext = conn.pageInfo.hasNextPage;
    after = conn.pageInfo.endCursor;
  }
  return repos;
}

async function fetchRecentRepoNames(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const data = await graphql(RECENT_QUERY, {
    login: GH_LOGIN,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const rows = data.user.contributionsCollection.commitContributionsByRepository;
  return new Set(rows.map((r) => r.repository.nameWithOwner));
}

function aggregate(repos, recentRepoNames) {
  // dedup by nameWithOwner (repo pode vir das duas queries)
  const byRepo = new Map();
  for (const r of repos) {
    if (r.isFork) continue;
    if (!byRepo.has(r.nameWithOwner)) byRepo.set(r.nameWithOwner, r);
  }

  const langs = new Map(); // name -> { bytes, repos: Set, color, recent }
  for (const repo of byRepo.values()) {
    const isRecentRepo = recentRepoNames.has(repo.nameWithOwner);
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      if (IGNORED_LANGUAGES.includes(name.toLowerCase())) continue;
      if (!langs.has(name)) {
        langs.set(name, {
          name,
          color: edge.node.color ?? "#8b949e",
          bytes: 0,
          repos: new Set(),
          recent: false,
        });
      }
      const entry = langs.get(name);
      entry.bytes += edge.size;
      entry.repos.add(repo.nameWithOwner);
      if (isRecentRepo) entry.recent = true;
    }
  }
  return [...langs.values()];
}

function score(entries) {
  const maxLogBytes = Math.max(...entries.map((e) => Math.log(e.bytes + 1)), 1);
  const maxRepoCount = Math.max(...entries.map((e) => e.repos.size), 1);

  return entries
    .map((e) => {
      const normBytes = Math.log(e.bytes + 1) / maxLogBytes;
      const normRepos = e.repos.size / maxRepoCount;
      const s =
        WEIGHT_BYTES * normBytes +
        WEIGHT_REPOS * normRepos +
        (e.recent ? RECENT_BONUS : 0);
      return { ...e, repoCount: e.repos.size, score: s };
    })
    .sort((a, b) => b.score - a.score);
}

function renderSvg(ranked) {
  const width = 420;
  const rowHeight = 34;
  const paddingTop = 50;
  const height = paddingTop + ranked.length * rowHeight + 16;
  const maxScore = Math.max(...ranked.map((r) => r.score), 0.0001);
  const barMaxWidth = 230;

  const rows = ranked
    .map((r, i) => {
      const y = paddingTop + i * rowHeight;
      const barWidth = Math.max(4, (r.score / maxScore) * barMaxWidth);
      const recentBadge = r.recent
        ? `<circle cx="10" cy="${y + 10}" r="4" fill="#3fb950"><title>Usado nos últimos ${RECENT_DAYS} dias</title></circle>`
        : "";
      return `
        <g transform="translate(0, ${y})">
          ${recentBadge}
          <circle cx="${r.recent ? 26 : 10}" cy="10" r="6" fill="${r.color}" />
          <text x="${r.recent ? 40 : 24}" y="14" font-size="13" fill="#c9d1d9">${escapeXml(r.name)}</text>
          <rect x="150" y="4" width="${barMaxWidth}" height="12" rx="6" fill="#21262d" />
          <rect x="150" y="4" width="${barWidth}" height="12" rx="6" fill="${r.color}" />
          <text x="${150 + barMaxWidth + 8}" y="14" font-size="11" fill="#8b949e">${r.repoCount} repo${r.repoCount === 1 ? "" : "s"}</text>
        </g>`;
    })
    .join("\n");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" rx="6" fill="#0d1117" />
  <text x="16" y="28" font-size="16" font-weight="600" fill="#c9d1d9">Linguagens mais usadas</text>
  <text x="16" y="44" font-size="11" fill="#8b949e">bytes + nº de repos + uso nos últimos ${RECENT_DAYS} dias</text>
  ${rows}
</svg>`;
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[c]);
}

async function main() {
  const [owned, contributed, recentRepoNames] = await Promise.all([
    fetchAllRepos(OWNED_QUERY, "repositories"),
    fetchAllRepos(CONTRIBUTED_QUERY, "repositoriesContributedTo"),
    fetchRecentRepoNames(RECENT_DAYS),
  ]);

  const entries = aggregate([...owned, ...contributed], recentRepoNames);
  const ranked = score(entries).slice(0, MAX_LANGUAGES);

  if (ranked.length < MIN_LANGUAGES) {
    console.warn(
      `Aviso: só foram encontradas ${ranked.length} linguagens distintas (mínimo pedido: ${MIN_LANGUAGES}). Isso reflete os dados reais da conta, não é um bug do script.`
    );
  }

  const fs = await import("node:fs/promises");
  await fs.writeFile(OUT_SVG, renderSvg(ranked), "utf8");
  await fs.writeFile(OUT_JSON, JSON.stringify(ranked, (k, v) => (v instanceof Set ? [...v] : v), 2), "utf8");

  console.log(`OK: ${ranked.length} linguagens -> ${OUT_SVG} / ${OUT_JSON}`);
  for (const r of ranked) {
    console.log(
      `  ${r.name.padEnd(14)} score=${r.score.toFixed(3)} bytes=${r.bytes} repos=${r.repoCount} recente=${r.recent}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
