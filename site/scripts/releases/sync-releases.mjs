#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStudioNotes } from '../../src/lib/studio-notes.mjs';
import { compareVersionsDesc, loadCatalog, upsertRelease, validateCatalog } from './release-notes.mjs';

const repository = 'esengine/DeepSeek-Reasonix';

export function missingReleases(published, catalog, { studioOnly = false } = {}) {
  const existing = new Set(catalog.releases.map((r) => `${r.product || 'cli'}:${r.version}`));
  // The archive starts after the earliest GitHub tags. Do not require source
  // catalogs from releases that predate the website's supported history.
  const oldestCLI = catalog.releases.filter((r) => r.product !== 'studio' && r.channel === 'stable')
    .map((r) => r.version).sort(compareVersionsDesc).at(-1);
  const missing = new Map();
  for (const release of published) {
    if (release.draft || !release.published_at) continue;
    const studio = release.tag_name.match(/^studio-v(2\.\d+\.\d+)$/);
    const cli = release.tag_name.match(/^(?:desktop-|npm-)?v(1\.\d+\.\d+)$/);
    if (!studio && (!cli || release.prerelease)) continue;
    const product = studio ? 'studio' : 'cli';
    if (studioOnly && product !== 'studio') continue;
    const version = (studio || cli)[1];
    if (product === 'cli' && oldestCLI && compareVersionsDesc(version, oldestCLI) > 0) continue;
    const key = `${product}:${version}`;
    if (existing.has(key)) continue;
    // Prefer the canonical CLI release over duplicate desktop/package tags.
    if (!missing.has(key) || release.tag_name === `v${version}`) {
      missing.set(key, { ...release, product, version });
    }
  }
  return [...missing.values()].sort((a, b) => -compareVersionsDesc(a.version, b.version));
}

export function studioRecord(release, markdown, sha) {
  if (!markdown?.trim()) throw new Error(`Missing Studio source for ${release.tag_name}`);
  const version = release.version || release.tag_name.replace(/^studio-v/, '');
  const title = { en: `Reasonix Studio v${version}`, zh: `Reasonix Studio v${version}` };
  const line = parseStudioNotes(markdown).summary || `Reasonix Studio v${version}`;
  const summary = { en: line, zh: line };
  return {
    product: 'studio', version, date: release.published_at.slice(0, 10),
    channel: 'stable',
    sourceNotes: { language: 'zh', markdown, sha, path: `release-notes/studio/${version}.md` },
    title, summary, surfaces: ['desktop'], guides: [],
    highlights: [{ kind: 'improved', title, body: summary }],
    changes: { new: [], improved: [], fixed: [] }, upgrade: [], risks: [], contributors: [],
    links: {
      github: `https://github.com/${repository}/releases/tag/studio-v${version}`,
      compare: `https://github.com/${repository}/blob/${sha}/release-notes/studio/${version}.md`,
      download: 'https://reasonix.io/#start',
    },
  };
}

export function describeFailure(error, secrets = [process.env.DEEPSEEK_API_KEY, process.env.GH_TOKEN, process.env.GITHUB_TOKEN]) {
  let text = String(error?.message ?? error).split('\n')[0];
  for (const secret of secrets) if (secret && secret.length > 3) text = text.split(secret).join('[redacted]');
  text = text.replace(/(Bearer\s+|sk-|ghp_|gho_|ghs_|github_pat_)\S+/g, '$1[redacted]').slice(0, 200);
  return `${error?.name || 'Error'}: ${text}`;
}

export async function readStudioSource(release, api) {
  const { sha } = JSON.parse(await api(`commits/${release.tag_name}`));
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid source commit for ${release.tag_name}`);
  const version = release.version || release.tag_name.replace(/^studio-v/, '');
  const markdown = await api(`contents/release-notes/studio/${version}.md?ref=${sha}`, true);
  return { sha, markdown };
}

export async function readCLISource(release, api) {
  const { sha } = JSON.parse(await api(`commits/${release.tag_name}`));
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid source commit for ${release.tag_name}`);
  const catalog = JSON.parse(await api(`contents/release-notes/releases.json?ref=${sha}`, true));
  const record = catalog.releases?.find((r) => r.version === release.version && r.product !== 'studio');
  if (!record) throw new Error(`Missing CLI source for ${release.tag_name}`);
  validateCatalog({ schemaVersion: catalog.schemaVersion, releases: [record] });
  // Keep reviewed records gated by fetch-publications.mjs and its all-surface
  // marker. A GitHub release alone must not promote them to published.
  return record;
}

export function requireSync(result) {
  if (result.pending.length) throw new Error(`Changelog sync incomplete: ${result.pending.join(', ')}`);
}

export function requireStudioSync(result, catalog, expectedVersion) {
  if (result.pending.length) throw new Error(`Studio changelog sync incomplete: ${result.pending.join(', ')}`);
  const version = expectedVersion?.replace(/^v/, '');
  if (version && !catalog.releases.some((r) => r.product === 'studio' && r.version === version)) {
    throw new Error(`Studio changelog is missing requested release ${expectedVersion}`);
  }
}

export async function syncCatalog({ catalog, published, studioOnly = false, readStudio, readCLI, save }) {
  const added = [], pending = [], failures = [];
  for (const release of missingReleases(published, catalog, { studioOnly })) {
    const key = `${release.product}:${release.version}`;
    try {
      if (release.product === 'studio') {
        const { markdown, sha } = await readStudio(release);
        await save(studioRecord(release, markdown, sha));
      } else {
        await save(await readCLI(release));
      }
      added.push(key);
    } catch (error) {
      pending.push(key);
      failures.push({ key, reason: describeFailure(error) });
    }
  }
  return { added, pending, failures };
}

async function main() {
  const studioOnly = process.argv.includes('--studio-only');
  const api = (endpoint, raw = false, paginate = false) => execFileSync('gh', [
    'api', '--hostname', 'github.com', ...(paginate ? ['--paginate', '--slurp'] : []),
    ...(raw ? ['-H', 'Accept: application/vnd.github.raw+json'] : []), `repos/${repository}/${endpoint}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const published = JSON.parse(api('releases?per_page=100', false, true)).flat();
  const result = await syncCatalog({
    catalog: await loadCatalog(), published, studioOnly,
    readStudio: (release) => readStudioSource(release, api),
    save: (release) => upsertRelease(release),
    readCLI: (release) => readCLISource(release, api),
  });
  const summary = `## Website changelog sync\n\nAdded: ${result.added.join(', ') || 'none'}\n\nPending (retried next run): ${result.pending.join(', ') || 'none'}\n${result.failures.map((f) => `\n- ${f.key}: ${f.reason}`).join('')}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  requireSync(result);
  requireStudioSync(result, await loadCatalog(), process.env.STUDIO_RELEASE_VERSION);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
