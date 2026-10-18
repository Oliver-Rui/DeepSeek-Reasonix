import { fromBase64url } from "./encoding";

// The worker will POST to whatever address a subscription names, so the address
// is the one input that must not be trusted: only the push services browsers use,
// over https on the default port. The list is by host suffix; a service that is
// not on it is refused, and adding one is a change to this file.
const PUSH_SERVICES: readonly string[] = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export const MAX_ENDPOINT_LENGTH = 2048;

export function acceptablePushEndpoint(endpoint: string): URL | null {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return null;
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.endsWith(".")) return null;
  const allowed = PUSH_SERVICES.some((service) => host === service || host.endsWith(`.${service}`));
  return allowed ? url : null;
}

export interface PushKeys {
  p256dh: string;
  auth: string;
}

// The browser's two values, checked for the shape encryption needs: an
// uncompressed P-256 point and a 16-octet secret.
export function acceptablePushKeys(keys: PushKeys): { publicKey: Uint8Array; authSecret: Uint8Array } | null {
  const publicKey = fromBase64url(keys.p256dh);
  const authSecret = fromBase64url(keys.auth);
  if (!publicKey || !authSecret || publicKey.length !== 65 || publicKey[0] !== 4 || authSecret.length !== 16) return null;
  return { publicKey, authSecret };
}
