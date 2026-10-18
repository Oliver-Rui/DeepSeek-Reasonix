import { describe, expect, it } from "vitest";
import { MAX_PLAINTEXT, PayloadTooLarge, encrypt, generateSenderKey } from "./aes128gcm";
import { base64url, fromBase64url } from "./encoding";

const bytes = (text: string) => {
  const out = fromBase64url(text);
  if (!out) throw new Error(`bad base64url in the test: ${text}`);
  return out;
};

// RFC 8291 section 5 and Appendix A: the one worked example the standard gives.
const rfc = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("Web Push message encryption (RFC 8291)", () => {
  it("reproduces the RFC's example body exactly", async () => {
    const body = await encrypt(
      bytes(rfc.plaintext),
      { publicKey: bytes(rfc.uaPublic), authSecret: bytes(rfc.authSecret) },
      { salt: bytes(rfc.salt), sender: { privateKey: bytes(rfc.asPrivate), publicKey: bytes(rfc.asPublic) } },
    );
    expect(base64url(body)).toBe(rfc.body);
  });

  it("states its header the way RFC 8188 lays it out", async () => {
    const body = await encrypt(new TextEncoder().encode("x"), { publicKey: bytes(rfc.uaPublic), authSecret: bytes(rfc.authSecret) });
    expect(body.length).toBe(16 + 4 + 1 + 65 + 1 + 1 + 16);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4);
  });

  it("uses a fresh salt and sender key each time", async () => {
    const to = { publicKey: bytes(rfc.uaPublic), authSecret: bytes(rfc.authSecret) };
    const a = await encrypt(new TextEncoder().encode("same"), to);
    const b = await encrypt(new TextEncoder().encode("same"), to);
    expect(base64url(a.slice(0, 16))).not.toBe(base64url(b.slice(0, 16)));
    expect(base64url(a.slice(21, 86))).not.toBe(base64url(b.slice(21, 86)));
  });

  it("refuses what does not fit one record, and keys of the wrong shape", async () => {
    const to = { publicKey: bytes(rfc.uaPublic), authSecret: bytes(rfc.authSecret) };
    await expect(encrypt(new Uint8Array(MAX_PLAINTEXT + 1), to)).rejects.toBeInstanceOf(PayloadTooLarge);
    await expect(encrypt(new Uint8Array(MAX_PLAINTEXT), to)).resolves.toBeInstanceOf(Uint8Array);
    await expect(encrypt(new Uint8Array(1), { publicKey: new Uint8Array(33), authSecret: to.authSecret })).rejects.toThrow();
    await expect(encrypt(new Uint8Array(1), { publicKey: to.publicKey, authSecret: new Uint8Array(15) })).rejects.toThrow();
  });

  it("makes a usable sender key", async () => {
    const key = await generateSenderKey();
    expect(key.privateKey.length).toBe(32);
    expect(key.publicKey.length).toBe(65);
    expect(key.publicKey[0]).toBe(4);
  });
});
