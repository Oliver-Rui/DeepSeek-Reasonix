// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { ModHost } from "./ModHost";
import { MODS_SHOWN } from "./modsgate";
import { SETTINGS } from "./prefsnav";
import { MockPort } from "../port/mock";
import { HttpError } from "../port/port";
import type { ModStatus } from "../port/port";
import type { AgentPort } from "../port/port";

afterEach(cleanup);

const row = (name: string) => screen.getByText(name, { selector: "b" }).closest("li") as HTMLElement;

describe("the Claude Code mod block", () => {
  it("draws nothing, and asks the kernel nothing, while the host is hidden", () => {
    const port = new MockPort();
    const read = vi.spyOn(port, "modsSettings");
    const { container } = render(<ModHost port={port} />);
    expect(container.innerHTML).toBe("");
    expect(read).not.toHaveBeenCalled();
  });

  it("is not offered by settings search or counted in its section while hidden", () => {
    const entry = SETTINGS.find((e) => e.anchor === "mods")!;
    expect(entry.hidden).toBe(!MODS_SHOWN);
    expect(SETTINGS.filter((e) => e.section === "ext" && !e.hidden).includes(entry)).toBe(MODS_SHOWN);
  });

  it("ships off, says what turning it on means, and every mod says why it is not running", async () => {
    render(<ModHost port={new MockPort()} shown />);
    const sw = await screen.findByRole("switch", { name: "运行 Claude Code mod" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/完全信任.*没有沙盒.*不会被本应用观测到/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("「运行 Claude Code mod」没有打开，所以没有运行任何 mod")).toHaveLength(4));
    expect(within(row("git-guard")).getByText(/未运行/)).toBeTruthy();
  });

  it("turning it on saves once, then lists each state with the words for its typed code", async () => {
    const port = new MockPort();
    const save = vi.spyOn(port, "saveModsSettings");
    render(<ModHost port={port} shown />);
    await userEvent.click(await screen.findByRole("switch", { name: "运行 Claude Code mod" }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    await waitFor(() => expect(within(row("statusline-clock")).getByText(/运行中/)).toBeTruthy());
    expect(within(row("git-guard")).getByText(/已停用/)).toBeTruthy();
    expect(within(row("git-guard")).getByText(/时间预算.*进程已被结束/)).toBeTruthy();
    expect(within(row("git-guard")).getByText("已重启 3 次")).toBeTruthy();
    expect(within(row("git-guard")).getByText(/本应用不会触发这些事件.*tool\.rewrite/)).toBeTruthy();
    expect(within(row("prompt-tweaks")).getByText(/正在重启/)).toBeTruthy();
    expect(within(row("fancy-notes")).getByText(/找不到能运行 mod 的 Node 运行时/)).toBeTruthy();
  });

  it("words a state by its code, never by what the detail says", async () => {
    const port = new MockPort();
    const lying: ModStatus[] = [{ plugin: "liar", state: "disabled", code: "mod.crashed", detail: "everything is running fine", restarts: 0 }];
    vi.spyOn(port, "mods").mockResolvedValue(lying);
    render(<ModHost port={port} shown />);
    expect(await screen.findByText(/进程崩溃了/)).toBeTruthy();
    expect(screen.queryByText("everything is running fine")).toBeNull();
  });

  it("degrades to the kernel's own text for a code it has no words for", async () => {
    const port = new MockPort();
    vi.spyOn(port, "mods").mockResolvedValue([{ plugin: "odd", state: "disabled", code: "mod.something_new", detail: "the kernel says so", restarts: 0 }]);
    render(<ModHost port={port} shown />);
    expect(await screen.findByText("the kernel says so")).toBeTruthy();
  });

  it("commits the time limit once on Enter and refuses a number out of range without writing", async () => {
    const port = new MockPort();
    const save = vi.spyOn(port, "saveModsSettings");
    render(<ModHost port={port} shown />);
    const field = await screen.findByRole("textbox", { name: "单个钩子的运行时限" });
    await userEvent.clear(field);
    await userEvent.type(field, "20000{Enter}");
    expect(save).toHaveBeenCalledExactlyOnceWith({ hook_budget_ms: 20000 });
    await userEvent.clear(field);
    await userEvent.type(field, "99999{Enter}");
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByText("请输入 0 到 55000 之间的整数。")).toBeTruthy();
  });

  it("goes read-only when this window may not edit, and says so", async () => {
    const port = new MockPort();
    vi.spyOn(port, "saveModsSettings").mockRejectedValue(new HttpError(403, "no", { code: "mods.editing_disabled", error: "off" }));
    render(<ModHost port={port} shown />);
    const sw = await screen.findByRole("switch", { name: "运行 Claude Code mod" });
    await userEvent.click(sw);
    expect(await screen.findByText("这些设置现在是只读的：这个窗口没有被授予编辑权限。")).toBeTruthy();
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "单个钩子的运行时限" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("says so when the settings cannot be read", async () => {
    const port = { modsSettings: vi.fn(async () => { throw new Error("down"); }), mods: vi.fn(async () => []) } as unknown as AgentPort;
    render(<ModHost port={port} shown />);
    expect(await screen.findByText("down")).toBeTruthy();
  });
});
