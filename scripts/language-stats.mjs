#!/usr/bin/env node
/**
 * language-stats.mjs
 * ---------------------------------------------------------------
 * Generates a weighted "most used languages" ranking based on:
 *   - code volume (bytes reported by the GitHub API, log-scaled)
 *   - number of distinct repositories using the language
 *   - a bonus if the language was used in a commit in the last N days
 *
 * Covers owned repos, organization repos (ownerAffiliations) and
 * third-party repos the user contributed to (repositoriesContributedTo)
 * — all through GraphQL, no cloning involved, so it runs in seconds
 * instead of minutes.
 *
 * The output SVG is styled to visually match lowlighter/metrics'
 * classic template card (same dark background, same width), so it
 * can be stacked directly under github-metrics.svg in the README.
 *
 * Env vars:
 *   GH_TOKEN          (required) token with repo/read:org scope
 *   GH_LOGIN          (required) target user, e.g. MikiDevAHM
 *   RECENT_DAYS       (default 15)
 *   MIN_LANGUAGES     (default 5)   informational only
 *   MAX_LANGUAGES     (default 8)
 *   WEIGHT_BYTES      (default 0.5)
 *   WEIGHT_REPOS      (default 0.3)
 *   RECENT_BONUS      (default 0.3)
 *   IGNORED_LANGUAGES (default "")  e.g. "html,css"
 *   CARD_WIDTH        (default 480) should match github-metrics.svg width
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
const CARD_WIDTH = Number(process.env.CARD_WIDTH ?? 480);
const OUT_SVG = process.env.OUT_SVG ?? "language-stats.svg";
const OUT_JSON = process.env.OUT_JSON ?? "language-stats.json";

if (!GH_TOKEN || !GH_LOGIN) {
  console.error("Error: set GH_TOKEN and GH_LOGIN env vars.");
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
  // dedup by nameWithOwner (a repo can come from both queries)
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
  const width = CARD_WIDTH;
  const rowHeight = 34;
  const paddingTop = 50;
  const height = paddingTop + ranked.length * rowHeight + 16;
  const maxScore = Math.max(...ranked.map((r) => r.score), 0.0001);
  const barMaxWidth = width - 190;

  const rows = ranked
    .map((r, i) => {
      const y = paddingTop + i * rowHeight;
      const barWidth = Math.max(4, (r.score / maxScore) * barMaxWidth);
      const recentBadge = r.recent
        ? `<circle cx="10" cy="${y + 10}" r="4" fill="#3fb950"><title>Used in the last ${RECENT_DAYS} days</title></circle>`
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

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif">
  <rect width="${width}" height="${height}" rx="6" fill="#0d1117" stroke="#30363d" />
  <text x="16" y="28" font-size="16" font-weight="600" fill="#c9d1d9">🈷️ Most used languages</text>
  <text x="16" y="44" font-size="11" fill="#8b949e">bytes + repo count + used in the last ${RECENT_DAYS} days</text>
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
      `Warning: only ${ranked.length} distinct languages found (requested minimum: ${MIN_LANGUAGES}). This reflects the account's real data, not a script bug.`
    );
  }

  const fs = await import("node:fs/promises");
  await fs.writeFile(OUT_SVG, renderSvg(ranked), "utf8");
  await fs.writeFile(OUT_JSON, JSON.stringify(ranked, (k, v) => (v instanceof Set ? [...v] : v), 2), "utf8");

  console.log(`OK: ${ranked.length} languages -> ${OUT_SVG} / ${OUT_JSON}`);
  for (const r of ranked) {
    console.log(
      `  ${r.name.padEnd(14)} score=${r.score.toFixed(3)} bytes=${r.bytes} repos=${r.repoCount} recent=${r.recent}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
