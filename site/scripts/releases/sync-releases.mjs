#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStudioNotes } from '../../src/lib/studio-notes.mjs';
import { compareVersionsDesc, loadCatalog, upsertRelease } from './release-notes.mjs';

const repository = 'esengine/DeepSeek-Reasonix';
const root = resolve(import.meta.dirname, '../../..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

export function missingReleases(published, catalog, { studioOnly = false } = {}) {
  const existing = new Set(catalog.releases.map((r) => `${r.product || 'cli'}:${r.version}`));
  const missing = new Map();
  for (const release of published) {
    if (release.draft || !release.published_at) continue;
    const studio = release.tag_name.match(/^studio-v(2\.\d+\.\d+)$/);
    const cli = release.tag_name.match(/^(?:desktop-|npm-)?v(1\.\d+\.\d+)$/);
    if (!studio && (!cli || release.prerelease)) continue;
    const product = studio ? 'studio' : 'cli';
    if (studioOnly && product !== 'studio') continue;
    const version = (studio || cli)[1];
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

export function requireStudioSync(result, catalog, expectedVersion) {
  if (result.pending.length) throw new Error(`Studio changelog sync incomplete: ${result.pending.join(', ')}`);
  const version = expectedVersion?.replace(/^v/, '');
  if (version && !catalog.releases.some((r) => r.product === 'studio' && r.version === version)) {
    throw new Error(`Studio changelog is missing requested release ${expectedVersion}`);
  }
}

export async function syncCatalog({ catalog, published, studioOnly = false, readStudio, save, generateCLI, hasModelKey }) {
  const added = [], pending = [], failures = [];
  for (const release of missingReleases(published, catalog, { studioOnly })) {
    const key = `${release.product}:${release.version}`;
    try {
      if (release.product === 'studio') {
        const { markdown, sha } = await readStudio(release);
        await save(studioRecord(release, markdown, sha));
      } else {
        if (!hasModelKey) { pending.push(key); failures.push({ key, reason: 'no model key configured' }); continue; }
        const generated = await generateCLI(release);
        await save({ ...generated, status: 'published' });
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
    save: (release) => upsertRelease(release), hasModelKey: Boolean(process.env.DEEPSEEK_API_KEY),
    generateCLI: async (release) => {
      const releaseTag = git('rev-parse', '--verify', `refs/tags/${release.tag_name}^{commit}`);
      // Each range ends at the published tag, never today's product branch tip.
      execFileSync(process.execPath, ['site/scripts/releases/generate-release-notes.mjs', '--version', release.version, '--to', releaseTag, '--tag', release.tag_name, '--date', release.published_at.slice(0, 10)], { cwd: root, stdio: 'inherit' });
      return (await loadCatalog()).releases.find((r) => r.version === release.version && r.product !== 'studio');
    },
  });
  const summary = `## Website changelog sync\n\nAdded: ${result.added.join(', ') || 'none'}\n\nPending (retried next run): ${result.pending.join(', ') || 'none'}\n${result.failures.map((f) => `\n- ${f.key}: ${f.reason}`).join('')}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (studioOnly) requireStudioSync(result, await loadCatalog(), process.env.STUDIO_RELEASE_VERSION);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
