import { encrypt } from "./aes128gcm";
import { acceptablePushEndpoint, acceptablePushKeys } from "./endpoint";
import { encodePayload, type PushPayload } from "./payload";
import { authorization, type VapidKeys } from "./vapid";

// A push service holds a message that long for a device that is offline. A
// notification that a decision is waiting is stale after a minute or two.
export const PUSH_TTL_SECONDS = 120;
export const PUSH_TIMEOUT_MS = 5000;

export interface PushRecipient {
  endpoint: string;
  p256dh: string;
  authSecret: string;
}

// What happened to one delivery, by the status the push service answered:
// gone means the subscription will never work again (RFC 8030: 404 and 410),
// retry means it might later, sent means the service accepted it.
export type PushOutcome = { kind: "sent" } | { kind: "gone"; status: number } | { kind: "retry"; status: number };

export async function sendPush(
  recipient: PushRecipient,
  payload: PushPayload,
  vapid: { keys: VapidKeys; subject: string },
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  if (!acceptablePushEndpoint(recipient.endpoint)) return { kind: "gone", status: 0 };
  const keys = acceptablePushKeys({ p256dh: recipient.p256dh, auth: recipient.authSecret });
  if (!keys) return { kind: "gone", status: 0 };
  const body = await encrypt(encodePayload(payload), { publicKey: keys.publicKey, authSecret: keys.authSecret });
  let response: Response;
  try {
    response = await fetchImpl(recipient.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers: {
        Authorization: await authorization(vapid.keys, recipient.endpoint, vapid.subject, Math.floor(now.getTime() / 1000)),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: "normal",
        // A newer message of the same topic replaces one still waiting, which is
        // how a burst of approvals reaches the device as one notification.
        Topic: payload.type,
      },
      body,
    });
  } catch {
    return { kind: "retry", status: 0 };
  }
  // The response is never read: a push service has nothing to say that this
  // sender would act on beyond the status.
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 200 && response.status < 300) return { kind: "sent" };
  if (response.status === 404 || response.status === 410) return { kind: "gone", status: response.status };
  return { kind: "retry", status: response.status };
}
