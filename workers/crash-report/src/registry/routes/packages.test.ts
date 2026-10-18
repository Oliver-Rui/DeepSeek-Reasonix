import { afterEach, expect, it, vi } from "vitest";
import registryApp from "../app";
import type { Bindings } from "../env";

afterEach(() => vi.unstubAllGlobals());

it.each(["34ba5aaad19f0cb228965c01056b0a86c8ef5dd02", "main"])(
  "refuses a direct API publication with invalid commit %s before touching the database",
  async (ref) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: { id: 7, handle: "publisher", role: "member", emailVerified: true },
    })));
    const prepare = vi.fn(() => { throw new Error("invalid sources must not reach persistence"); });
    const response = await registryApp.fetch(new Request("https://registry.reasonix.test/v1/packages", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ kind: "plugin", name: "demo", source: `https://github.com/o/r/tree/${ref}` }),
    }), {
      DB: { prepare } as unknown as D1Database,
      ACCOUNTS_ORIGIN: "https://id.reasonix.test",
      APP_ORIGIN: "https://reasonix.test",
      ALLOWED_ORIGINS: "https://reasonix.test",
    } satisfies Bindings);
    expect(response.status).toBe(422);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.message).toContain("source:");
    expect(body.error.message).toContain("40");
    expect(prepare).not.toHaveBeenCalled();
  },
);
