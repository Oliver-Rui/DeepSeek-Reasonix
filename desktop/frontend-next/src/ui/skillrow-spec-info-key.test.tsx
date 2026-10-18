// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "./testkit";
import { boot, STORAGE } from "../i18n";
import type { SkillEntry } from "../port/port";
import { SkillSpecInfo } from "./SkillSpecInfo";

beforeEach(() => {
  localStorage.setItem(STORAGE, "zh");
  boot();
});
afterEach(cleanup);

// The metadata rows are an array, so every rendered item needs its own key.
// The shorthand fragment cannot carry one, and React warns about it at mount.
// This guard lives in its own file because React reports that warning once per
// component: sharing a worker with another metadata render would leave the spy
// silent even when the key is missing.
it("keys each metadata row, so React does not warn about the list", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const sk: SkillEntry = {
      name: "pdf-processing", slashName: "pdf-processing", enabled: true,
      metadata: { author: "example-org", version: "1.0" },
    };
    render(<SkillSpecInfo sk={sk} />);
    const keyWarnings = error.mock.calls.filter(
      ([first]) => typeof first === "string" && first.includes('unique "key" prop'),
    );
    expect(keyWarnings).toEqual([]);
  } finally {
    error.mockRestore();
  }
});
