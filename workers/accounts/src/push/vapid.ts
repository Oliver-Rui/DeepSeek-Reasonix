// Voluntary Application Server Identification (RFC 8292): a short-lived ES256
// token naming the push service the request is for and who is sending it.
import { base64url, fromBase64url } from "./encoding";

const encoder = new TextEncoder();

export interface VapidKeys {
  // The application server key: uncompressed P-256 public point (65 octets) and private scalar (32).
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

// A push service accepts a token that expires within 24 hours.
export const VAPID_MAX_LIFETIME_SECONDS = 12 * 60 * 60;

export function pushAudience(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("a push endpoint is an https address");
  return url.origin;
}

async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: base64url(keys.publicKey.slice(1, 33)),
    y: base64url(keys.publicKey.slice(33, 65)),
    d: base64url(keys.privateKey),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// authorization is the Authorization header for one push request. subject is a
// contact the push service can reach: a mailto: or https: address.
export async function authorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  nowSeconds: number,
  lifetimeSeconds = VAPID_MAX_LIFETIME_SECONDS,
): Promise<string> {
  if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error("the VAPID subject is a mailto: or https: address");
  if (lifetimeSeconds <= 0 || lifetimeSeconds > VAPID_MAX_LIFETIME_SECONDS) throw new Error("the token lifetime is up to 12 hours");
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(encoder.encode(JSON.stringify({ aud: pushAudience(endpoint), exp: nowSeconds + lifetimeSeconds, sub: subject })));
  const signed = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(keys), encoder.encode(signed)));
  return `vapid t=${signed}.${base64url(signature)}, k=${base64url(keys.publicKey)}`;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as unknown as JsonWebKey;
  const d = fromBase64url(jwk.d ?? "");
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  if (!d) throw new Error("the generated key has no private part");
  return { publicKey, privateKey: d };
}

// The two halves as the values a deployment stores: the private scalar is a
// secret, the public point is served to the page.
export function encodeKeys(keys: VapidKeys): { publicKey: string; privateKey: string } {
  return { publicKey: base64url(keys.publicKey), privateKey: base64url(keys.privateKey) };
}

export function decodeKeys(publicKey: string, privateKey: string): VapidKeys | null {
  const pub = fromBase64url(publicKey);
  const priv = fromBase64url(privateKey);
  if (!pub || !priv || pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return null;
  return { publicKey: pub, privateKey: priv };
}
