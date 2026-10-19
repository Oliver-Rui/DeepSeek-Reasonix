import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { describeFailure, missingReleases, readStudioSource, requireStudioSync, studioRecord, syncCatalog } from './sync-releases.mjs';
import { loadCatalog, validateCatalog, renderGitHubRelease } from './release-notes.mjs';

const published = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-30T12:00:00Z', ...extra });

test('discovery deduplicates CLI namespaces, includes published Studio previews and ignores drafts and unrelated tags', () => {
  const found = missingReleases([
    published('v1.39.3'), published('desktop-v1.39.3'), published('npm-v1.39.3'),
    published('studio-v2.24.0', { prerelease: true }), published('studio-v2.25.0', { draft: true }),
    published('v1.39.2'), published('v1.40.0-preview.1', { prerelease: true }), published('other-v3.0.0'),
  ], { releases: [{ version: '1.39.2', product: 'cli' }] });
  assert.deepEqual(found.map(({ product, version }) => [product, version]), [['cli', '1.39.3'], ['studio', '2.24.0']]);
});

const cliOnlyCatalog = async () => {
  const catalog = await loadCatalog();
  return { ...catalog, releases: catalog.releases.filter((r) => r.product !== 'studio') };
};

test('Studio preserves Chinese source verbatim and validates without CLI targeting', async () => {
  const notes = '中立版本说明。\n\n## 修复\n\n- 改善窗口布局\n';
  const release = studioRecord(published('studio-v2.24.0', { prerelease: true }), notes, 'a'.repeat(40));
  assert.equal(release.product, 'studio');
  assert.equal(release.sourceNotes.language, 'zh');
  assert.equal(release.sourceNotes.markdown, notes);
  assert.equal(release.channel, 'stable');
  assert.doesNotThrow(() => validateCatalog({ schemaVersion: 1, releases: [release] }));
  assert.equal(renderGitHubRelease(release), notes);
  const catalog = await loadCatalog();
  assert.throws(() => validateCatalog({ ...catalog, releases: [{ ...catalog.releases[0], product: 'invalid' }] }));
  assert.throws(() => validateCatalog({ schemaVersion: 1, releases: [{ ...release, sourceNotes: undefined }] }));
});

test('batch sync continues Studio backfill without a model key and reports CLI versions for retry', async () => {
  const catalog = await cliOnlyCatalog();
  const saved = [];
  const result = await syncCatalog({
    catalog, published: [published('v1.99.0'), published('studio-v2.24.0')],
    readStudio: async () => ({ sha: 'a'.repeat(40), markdown: '中立更新。\n' }),
    save: async (release) => saved.push(release), generateCLI: async () => { throw new Error('must not call'); },
    hasModelKey: false,
  });
  assert.deepEqual(saved.map((r) => r.version), ['2.24.0']);
  assert.deepEqual(result.pending, ['cli:1.99.0']);
  assert.deepEqual(result.added, ['studio:2.24.0']);
});

test('existing catalog entries are never regenerated', async () => {
  const catalog = await loadCatalog();
  const result = await syncCatalog({ catalog, published: [published('v1.39.2')], save: () => { throw new Error('unexpected write'); } });
  assert.deepEqual(result, { added: [], pending: [], failures: [] });
});

test('batch failures retry independently and never manufacture missing Studio notes', async () => {
  const result = await syncCatalog({
    catalog: await cliOnlyCatalog(), published: [published('studio-v2.23.0'), published('studio-v2.24.0')],
    readStudio: async (release) => ({ sha: 'a'.repeat(40), markdown: release.version === '2.23.0' ? '' : '中立说明。' }),
    save: async () => {},
  });
  assert.deepEqual(result.added, ['studio:2.24.0']);
  assert.deepEqual(result.pending, ['studio:2.23.0']);
  assert.match(result.failures[0].reason, /^Error: Missing Studio source/);
});

test('CLI range selection uses the earlier CLI release even with newer Studio and CLI records', async () => {
  const { previousCLIRelease } = await import('./generate-release-notes.mjs');
  assert.equal(previousCLIRelease({ releases: [
    { version: '2.24.0', product: 'studio', channel: 'stable' },
    { version: '1.39.6', product: 'cli', channel: 'stable' },
    { version: '1.39.2', channel: 'stable' },
  ] }, '1.39.3').version, '1.39.2');
});

test('an upstream published CLI release becomes public only through the saved review draft', async () => {
  const saved = [];
  const result = await syncCatalog({
    catalog: await loadCatalog(), published: [published('v1.99.0')], hasModelKey: true,
    generateCLI: async () => ({ version: '1.99.0', product: 'cli', status: 'reviewed' }),
    save: async (release) => saved.push(release),
  });
  assert.deepEqual(result.added, ['cli:1.99.0']);
  assert.equal(saved[0].status, 'published');
});

test('failure reasons carry the error class and a message but never secrets', async () => {
  const result = await syncCatalog({
    catalog: await loadCatalog(), published: [published('v1.99.0')], hasModelKey: true,
    generateCLI: async () => { throw new TypeError('request failed with Bearer abc123token and key sk-live-999\nstack line'); },
    save: async () => {},
  });
  assert.deepEqual(result.pending, ['cli:1.99.0']);
  assert.equal(result.failures[0].reason, 'TypeError: request failed with Bearer [redacted] and key sk-[redacted]');
  assert.equal(describeFailure(new Error('boom hunter2'), ['hunter2']), 'Error: boom [redacted]');
});

test('Studio entries take their summary from the first line of the notes', () => {
  const release = studioRecord(published('studio-v2.24.0'), '本版加入反馈。\n\n## 新增\n\n- 项 (#1)\n', 'a'.repeat(40));
  assert.equal(release.summary.zh, '本版加入反馈。');
  assert.equal(release.summary.en, '本版加入反馈。');
});

test('Studio source is read from its published tag commit, never the moving product branch', async () => {
  const sha = 'b'.repeat(40);
  const source = await readStudioSource(published('studio-v2.45.0'), async (endpoint, raw) => {
    if (endpoint === 'commits/studio-v2.45.0') return JSON.stringify({ sha });
    assert.equal(endpoint, `contents/release-notes/studio/2.45.0.md?ref=${sha}`);
    assert.equal(raw, true);
    return '该版本原始说明。\n';
  });
  assert.deepEqual(source, { sha, markdown: '该版本原始说明。\n' });
});

test('build sync imports all missing Studio releases, leaves CLI alone and is idempotent', async () => {
  const catalog = { schemaVersion: 1, releases: [] };
  const releases = [published('v1.99.0'), published('studio-v2.44.0'), published('studio-v2.45.0'), published('studio-v2.46.0', { draft: true })];
  const run = () => syncCatalog({
    catalog, published: releases, studioOnly: true,
    readStudio: async (release) => ({ sha: release.version === '2.44.0' ? 'a'.repeat(40) : 'b'.repeat(40), markdown: `${release.version} 原文。\n` }),
    save: async (release) => catalog.releases.unshift(release),
  });
  const first = await run();
  assert.deepEqual(first.added, ['studio:2.44.0', 'studio:2.45.0']);
  assert.deepEqual(first.pending, []);
  assert.equal(catalog.releases[0].version, '2.45.0');
  assert.equal(catalog.releases[0].sourceNotes.sha, 'b'.repeat(40));
  assert.deepEqual((await run()).added, []);
});

test('a failed or incomplete Studio sync blocks publication of a stale catalog', () => {
  const catalog = { releases: [{ product: 'studio', version: '2.44.0' }, { version: '2.45.0', product: 'cli' }] };
  const complete = { pending: [], failures: [] };
  assert.doesNotThrow(() => requireStudioSync(complete, catalog));
  assert.doesNotThrow(() => requireStudioSync(complete, catalog, '2.44.0'));
  assert.doesNotThrow(() => requireStudioSync(complete, catalog, 'v2.44.0'));
  assert.throws(() => requireStudioSync(complete, catalog, '2.45.0'), /2\.45\.0/);
  assert.throws(() => requireStudioSync({ pending: ['studio:2.45.0'] }, catalog), /studio:2\.45\.0/);
});

test('production builds synchronize Studio before rendering and deployments require the website branch', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts.prebuild.startsWith('node scripts/releases/sync-releases.mjs --studio-only &&'));
  const workflow = await readFile(new URL('../../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:\n    inputs:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/website'/);
  assert.match(workflow, /STUDIO_RELEASE_VERSION: \$\{\{ inputs\.studio_version \}\}/);
});
