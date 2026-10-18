// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "./testkit";
import { ModPreviewBlock } from "./ModPreviewBlock";
import { Candidate } from "./AddPlugin";
import type { ModPreview, PluginAction } from "../port/plugin";

afterEach(cleanup);

const listed: ModPreview = {
  plugin: "git-guard", module: "hooks/index.js", sha256: "0123456789abcdef0123456789abcdef", listed: true,
  events: [{ name: "tool.check" }, { name: "x", dynamic: true }],
  api: [{ namespace: "process", method: "run" }, { namespace: "ui", dynamic: true }],
  imports: [{ spec: "./lib.js", kind: "static" }, { spec: "left-pad", kind: "require" }],
  findings: [{ kind: "eval" }, { kind: "computed_member" }],
  unserved: ["tool.rewrite"],
};

describe("the mod install preview", () => {
  it("states full trust, and that the listing is static and not a guarantee", () => {
    render(<ModPreviewBlock mod={listed} />);
    expect(screen.getByText("Claude Code mod · 完全信任")).toBeTruthy();
    expect(screen.getByText(/没有沙盒，不受网络出口治理.*不会被本应用观测到/)).toBeTruthy();
    expect(screen.getByText(/静态清单，不是保证.*imports 是看不见的代码.*eval、new Function/)).toBeTruthy();
  });

  it("lists events, API, hidden imports, listing-defeating constructs and events never raised", () => {
    render(<ModPreviewBlock mod={listed} />);
    expect(screen.getByText("tool.check")).toBeTruthy();
    expect(screen.getByText(/\$\.process\.run, \$\.…/)).toBeTruthy();
    expect(screen.getByText("import ./lib.js, require left-pad")).toBeTruthy();
    expect(screen.getByText("用了 eval、用计算出来的名字访问接口")).toBeTruthy();
    expect(screen.getByText("tool.rewrite")).toBeTruthy();
    expect(screen.getByText("名字无法列出的事件")).toBeTruthy();
  });

  it("calls a module it could not read not previewed, never clean", () => {
    render(<ModPreviewBlock mod={{ ...listed, listed: false, reason: "too_large", events: [], api: [], imports: [], findings: [], unserved: [] }} />);
    expect(screen.getByText("未预览")).toBeTruthy();
    expect(screen.getByText("文件太大")).toBeTruthy();
    expect(screen.getByText(/这不等于没问题/)).toBeTruthy();
    expect(screen.queryByText("它挂钩的事件")).toBeNull();
  });

  it("shows a reason it has no words for as itself rather than as nothing", () => {
    render(<ModPreviewBlock mod={{ ...listed, listed: false, reason: "brand_new_reason", events: [], api: [], imports: [], findings: [], unserved: [] }} />);
    expect(screen.getByText("brand_new_reason")).toBeTruthy();
  });

  it("pins the exact bytes and says an update asks again", () => {
    render(<ModPreviewBlock mod={listed} />);
    expect(screen.getByText("hooks/index.js · 0123456789ab").getAttribute("title")).toBe(listed.sha256);
    expect(screen.getByText(/更新会重新预览并需要重新确认/)).toBeTruthy();
  });

  it("appears under the candidate that carries a mod, and not under one without", () => {
    const withMod = { kind: "plugin", name: "git-guard", mod: listed } as unknown as PluginAction;
    const { rerender } = render(<Candidate a={withMod} />);
    expect(screen.getByLabelText("Claude Code mod 预览")).toBeTruthy();
    rerender(<Candidate a={{ kind: "plugin", name: "plain" } as unknown as PluginAction} />);
    expect(screen.queryByLabelText("Claude Code mod 预览")).toBeNull();
  });
});
