import { describe, expect, it } from "vitest";
import { authorization, decodeKeys, encodeKeys, generateVapidKeys, pushAudience } from "./vapid";
import { base64url, fromBase64url } from "./encoding";

const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk";

async function verify(token: string, publicKey: Uint8Array): Promise<boolean> {
  const [header, claims, signature] = token.split(".");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: base64url(publicKey.slice(1, 33)), y: base64url(publicKey.slice(33, 65)) },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature ?? "") as Uint8Array, new TextEncoder().encode(`${header}.${claims}`));
}

describe("VAPID (RFC 8292)", () => {
  it("signs a token the public key verifies, naming the push service and the sender", async () => {
    const keys = await generateVapidKeys();
    const header = await authorization(keys, endpoint, "mailto:ops@reasonix.io", 1_800_000_000);
    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [token, k] = [match![1] as string, match![2] as string];
    expect(k).toBe(base64url(keys.publicKey));
    expect(await verify(token, keys.publicKey)).toBe(true);
    const parts = token.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])!))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])!))).toEqual({
      aud: "https://updates.push.services.mozilla.com",
      exp: 1_800_000_000 + 12 * 60 * 60,
      sub: "mailto:ops@reasonix.io",
    });
    expect(fromBase64url(parts[2])!.length).toBe(64);
  });

  it("does not verify under another key or after the claims change", async () => {
    const keys = await generateVapidKeys();
    const other = await generateVapidKeys();
    const header = await authorization(keys, endpoint, "https://reasonix.io/contact", 1_800_000_000);
    const token = /t=([\w-]+\.[\w-]+\.[\w-]+)/.exec(header)![1] as string;
    expect(await verify(token, other.publicKey)).toBe(false);
    const [h, , s] = token.split(".") as [string, string, string];
    const forged = base64url(new TextEncoder().encode(JSON.stringify({ aud: "https://evil.example", exp: 1_800_000_000, sub: "mailto:x@y.z" })));
    expect(await verify(`${h}.${forged}.${s}`, keys.publicKey)).toBe(false);
  });

  it("refuses an endpoint that is not https, a subject that is no contact and a lifetime over 12 hours", async () => {
    const keys = await generateVapidKeys();
    await expect(authorization(keys, "http://push.example/x", "mailto:a@b.c", 1)).rejects.toThrow();
    await expect(authorization(keys, endpoint, "tel:123", 1)).rejects.toThrow();
    await expect(authorization(keys, endpoint, "mailto:a@b.c", 1, 12 * 60 * 60 + 1)).rejects.toThrow();
    await expect(authorization(keys, endpoint, "mailto:a@b.c", 1, 0)).rejects.toThrow();
    expect(() => pushAudience("https://push.example:8443/a/b")).not.toThrow();
    expect(pushAudience("https://push.example:8443/a/b")).toBe("https://push.example:8443");
  });

  it("round-trips the stored keys and refuses ones of the wrong shape", async () => {
    const keys = await generateVapidKeys();
    const stored = encodeKeys(keys);
    expect(decodeKeys(stored.publicKey, stored.privateKey)).toEqual(keys);
    expect(decodeKeys(stored.publicKey, "short")).toBeNull();
    expect(decodeKeys("AAAA", stored.privateKey)).toBeNull();
    expect(decodeKeys("not base64!", stored.privateKey)).toBeNull();
  });
});
