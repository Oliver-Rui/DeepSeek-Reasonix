import { Hono } from "hono";
import type { AppEnv } from "../env";
import { repos } from "../db";
import { authenticateHost } from "../http/hostAuth";
import { ApiError } from "../http/errors";
import { enforceRateLimit } from "../http/d1RateLimit";
import { HostPushNotifySchema, parseBody } from "../lib/validation";
import { pushPayload } from "../push/payload";
import { sendPush } from "../push/send";
import { decodeKeys } from "../push/vapid";
import { REMOTE_RATE_RULES } from "../config";

// A desktop says that something is waiting for its person. The body is a type
// code and a count (see push/payload.ts): conversation text has nowhere to go,
// so the relay and the push service learn that a decision is waiting and not
// what it is about.
const hostPush = new Hono<AppEnv>();

hostPush.post("/notify", async (c) => {
  const { userId, hostId } = await authenticateHost(c);
  const input = await parseBody(c, HostPushNotifySchema);
  await enforceRateLimit(c.env, REMOTE_RATE_RULES.pushNotify, `${hostId}:${input.type}`);
  const keys = decodeKeys(c.env.VAPID_PUBLIC_KEY ?? "", c.env.VAPID_PRIVATE_KEY ?? "");
  const subject = c.env.VAPID_SUBJECT ?? "";
  if (!keys || !subject) throw new ApiError(503, "push_unavailable", "Notifications are not available right now.");

  const { remotePush } = repos(c.env);
  const now = new Date();
  const targets = await remotePush.targets(userId, hostId, input.type, now);
  const payload = pushPayload(input.type, input.count);
  const results = await Promise.all(targets.map(async (target) => {
    const outcome = await sendPush(target, payload, { keys, subject }, now);
    if (outcome.kind === "sent") await remotePush.recordSuccess(target.controllerId, now);
    else if (outcome.kind === "gone") await remotePush.removeGone(target.controllerId);
    else await remotePush.recordFailure(target.controllerId, outcome.status, now);
    return outcome.kind;
  }));
  return c.json({
    delivered: results.filter((r) => r === "sent").length,
    failed: results.filter((r) => r === "retry").length,
    removed: results.filter((r) => r === "gone").length,
  });
});

export default hostPush;
