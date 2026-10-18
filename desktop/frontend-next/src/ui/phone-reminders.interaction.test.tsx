// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { PhoneReminders } from "./PhoneReminders";
import { AccountError } from "../port/phone_device";
import { EnableRefused } from "../port/phone_push";
import type { PhoneReminders as Port, Reminders } from "../port/phone_reminders";

afterEach(cleanup);

const none = { approval: false, input: false, error: false };
const on = (over: Partial<typeof none> = {}, failure: { n?: number; status?: number | null } = {}): Reminders => ({
  kind: "on",
  status: { categories: { ...none, ...over }, lastFailureAt: failure.n ? "t" : null, lastFailureStatus: failure.status ?? null, failureCount: failure.n ?? 0 },
});

function draw(initial: Reminders, over: Partial<Port> = {}) {
  const port: Port = {
    supported: () => true,
    load: vi.fn(async () => initial),
    enable: vi.fn(async () => on()),
    choose: vi.fn(async (categories) => ({ kind: "on", status: { categories, lastFailureAt: null, lastFailureStatus: null, failureCount: 0 } }) as Reminders),
    disable: vi.fn(async () => ({ kind: "off" }) as Reminders),
    startOver: vi.fn(async () => ({ kind: "off" }) as Reminders),
    ...over,
  };
  render(<PhoneReminders host="ab" reminders={port} />);
  return port;
}
const master = () => screen.findByRole("switch", { name: "提醒这台手机" });

describe("this phone's reminders", () => {
  it("starts off, says what is sent, and registers nothing until the switch is pressed", async () => {
    const port = draw({ kind: "off" });
    expect((await master()).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/只有“哪一类”和数量，不含会话名称、命令或对话内容/)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "模型向我提问" })).toBeNull();
    expect(port.enable).not.toHaveBeenCalled();
  });

  it("switching on shows the three occasions, all off", async () => {
    const port = draw({ kind: "off" });
    await userEvent.click(await master());
    expect(port.enable).toHaveBeenCalledTimes(1);
    for (const name of ["有操作要批准", "模型向我提问", "一轮出错结束"]) {
      expect((await screen.findByRole("switch", { name })).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("ticks one occasion at a time and keeps the others as they were", async () => {
    const port = draw(on({ approval: true }));
    await userEvent.click(await screen.findByRole("switch", { name: "一轮出错结束" }));
    await waitFor(() => expect(port.choose).toHaveBeenCalledWith({ approval: true, input: false, error: true }));
    await userEvent.click(screen.getByRole("switch", { name: "有操作要批准" }));
    await waitFor(() => expect(port.choose).toHaveBeenLastCalledWith({ approval: false, input: false, error: true }));
  });

  it("switching off goes through disable and hides the occasions", async () => {
    const port = draw(on());
    await userEvent.click(await master());
    await waitFor(() => expect(port.disable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("switch", { name: "模型向我提问" })).toBeNull());
  });

  it("a phone waiting for the computer says where to approve it and can try again", async () => {
    const port = draw({ kind: "waiting" });
    expect(await screen.findByText(/设置 → 远程 → 手机通知/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "再试一次" }));
    expect(port.enable).toHaveBeenCalledTimes(1);
  });

  it("a phone the computer removed offers to register again, and only then", async () => {
    const port = draw({ kind: "removed" });
    await userEvent.click(await screen.findByRole("button", { name: "重新登记" }));
    expect(port.startOver).toHaveBeenCalledTimes(1);
    expect(port.enable).not.toHaveBeenCalled();
  });

  it("shows a failing address with the push service's answer, and not when all is well", async () => {
    draw(on({}, { n: 3, status: 410 }));
    expect(await screen.findByText(/上一次提醒没有送达（推送服务回应 410）/)).toBeTruthy();
    cleanup();
    draw(on());
    await master();
    expect(screen.queryByText(/没有送达/)).toBeNull();
  });

  it("says why a browser without push cannot switch on", async () => {
    draw({ kind: "off" }, { supported: () => false });
    expect(await screen.findByText(/添加到主屏幕/)).toBeTruthy();
    expect((await master() as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a refused permission and stays off", async () => {
    draw({ kind: "off" }, { enable: vi.fn(async () => { throw new EnableRefused("denied"); }) });
    await userEvent.click(await master());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("没有允许通知"));
    expect((await master()).getAttribute("aria-checked")).toBe("false");
  });

  it("says the browser could not reach its push service, not that the account is down", async () => {
    draw({ kind: "off" }, { enable: vi.fn(async () => { throw new EnableRefused("push_service"); }) });
    await userEvent.click(await master());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("推送服务");
    expect(alert.textContent).not.toContain("账号服务");
  });

  it("asks for a new sign-in when the account no longer knows this session", async () => {
    draw({ kind: "off" }, { enable: vi.fn(async () => { throw new AccountError(401, "unauthorized"); }) });
    await userEvent.click(await master());
    expect(await screen.findByText("需要重新登录账号后再试。")).toBeTruthy();
  });

  it("keeps the switch usable after an unreadable state, instead of locking it", async () => {
    draw({ kind: "off" }, { load: vi.fn(async () => { throw new AccountError(503, "unavailable"); }) });
    expect(await screen.findByText("账号服务暂时不可用，请稍后再试。")).toBeTruthy();
    expect((await master() as HTMLButtonElement).disabled).toBe(false);
  });
});
