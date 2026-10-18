// Web Push message encryption: RFC 8291 over the aes128gcm content coding of
// RFC 8188, one record. A push service sees only the ciphertext.
import { base64url, concat, fromBase64url } from "./encoding";

const encoder = new TextEncoder();

export const RECORD_SIZE = 4096;
const HEADER_LENGTH = 16 + 4 + 1 + 65;
const TAG_LENGTH = 16;
// One record: the header, the delimiter octet and the tag leave this for the message.
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_LENGTH - 1 - TAG_LENGTH;

export class PayloadTooLarge extends Error {}

export interface Recipient {
  // The browser's P-256 public key, uncompressed (65 octets), and its 16-octet auth secret.
  publicKey: Uint8Array;
  authSecret: Uint8Array;
}

export interface SenderKey {
  // Ephemeral P-256 pair: private scalar (32 octets) and uncompressed public point.
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function jwkOf(publicKey: Uint8Array, privateKey?: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("a P-256 public key is 65 octets starting with 0x04");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: base64url(publicKey.slice(1, 33)), y: base64url(publicKey.slice(33, 65)), ext: true };
  if (privateKey) jwk.d = base64url(privateKey);
  return jwk;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function generateSenderKey(): Promise<SenderKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as unknown as JsonWebKey;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const privateKey = fromBase64url(jwk.d ?? "");
  if (!privateKey) throw new Error("the generated key has no private part");
  return { privateKey, publicKey };
}

// encrypt returns the request body for one push message. The salt and sender
// key are inputs only so the RFC's vector can be reproduced; a sender passes
// neither and gets fresh ones.
export async function encrypt(
  plaintext: Uint8Array,
  to: Recipient,
  options: { salt?: Uint8Array; sender?: SenderKey } = {},
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT) throw new PayloadTooLarge(`${plaintext.length} octets, at most ${MAX_PLAINTEXT}`);
  if (to.authSecret.length !== 16) throw new Error("the auth secret is 16 octets");
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("the salt is 16 octets");
  const sender = options.sender ?? (await generateSenderKey());

  const uaKey = await crypto.subtle.importKey("jwk", jwkOf(to.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asKey = await crypto.subtle.importKey("jwk", jwkOf(sender.publicKey, sender.privateKey), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asKey, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), to.publicKey, sender.publicKey);
  const ikm = await hkdf(to.authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const record = concat(plaintext, Uint8Array.of(2));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, record));

  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, size, Uint8Array.of(sender.publicKey.length), sender.publicKey, sealed);
}
