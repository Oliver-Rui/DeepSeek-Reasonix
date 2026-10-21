# Reasonix Website

This branch contains only the public Reasonix website and documentation portal.

- Website source: `site/`
- Website validation: `.github/workflows/site-ci.yml`
- Production publication: `.github/workflows/pages.yml`

Product clients live on `main-v2` and `studio`. Shared APIs, identity, telemetry,
and registry services live on `platform`.

## Local development

```sh
cd site
npm ci
npm test
npm run dev
```

Production publication runs on pushes to `website` or manual dispatch from that branch.

Production builds synchronize both CLI 1.x and Studio 2.x changelogs from
published GitHub tags. CLI notes come from the tag's reviewed
`release-notes/releases.json`; Studio notes come from its versioned Markdown.
Synchronization needs GitHub read access (`gh auth login` locally or
`GITHUB_TOKEN` in CI), not a model API key. Missing source notes fail the build.
The existing CLI publication-marker check still controls public visibility.

生产构建会从已发布的 GitHub 标签同步 CLI 1.x 和 Studio 2.x 更新日志。
CLI 读取标签中已审核的 `release-notes/releases.json`，Studio 读取对应版本的
Markdown。同步只需要 GitHub 读取权限（本地使用 `gh auth login`，CI 使用
`GITHUB_TOKEN`），不需要模型 API 密钥。缺失源日志时构建失败；CLI 是否公开
仍由原有的发布完成标记校验决定。
