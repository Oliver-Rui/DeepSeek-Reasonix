import type { Env } from "./env";
import { decodeAttachment, deleteAttachments, storeAttachment } from "./feedback_attachments";
import { verifyInstall } from "./feedback_auth";
import { isBlocked } from "./feedback_blocks";
import { readCappedText } from "./feedback_body";
import { ipHash } from "./feedback_crypto";
import { ownedByCaller } from "./feedback_ownership";
import { jsonResponse, refuse } from "./feedback_http";
import { installLevel } from "./feedback_level";
import { admit, refund, replyRefusal } from "./feedback_quota";
import { UserReplyBody } from "./feedback_schema";
import { MAX_REPLIES_PER_ITEM, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, type StoredAttachment } from "./feedback_types";
import { announce, type OpsWaiter } from "./ops_emit";
import { scrubSensitiveText } from "./scrub";

// A reply without images stays within what 4 KiB of text can need.
const SMALL_REPLY_BYTES = MAX_REPLY_BYTES * 2 + 512;
const REPLYABLE = ["received", "needs_info", "answered", "recorded", "in_progress", "fixed"];
const REPLYABLE_SQL = `(${REPLYABLE.map((s) => `'${s}'`).join(",")})`;

export async function handleUserReply(request: Request, env: Env, receipt: string, ctx?: OpsWaiter): Promise<Response> {
  const who = await verifyInstall(request, env);
  if (who instanceof Response) return who;
  const secret = env.FEEDBACK_TOKEN_SECRET ?? "";
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = new Date();
  const level = await installLevel(env, who.installHash, now);
  const ipKey = await ipHash(secret, ip);
  const blocked = await isBlocked(env, [`install:${who.installHash}`, `ip:${ipKey}`], now);
  const text = await readCappedText(request, MAX_REQUEST_BYTES);
  if (text === null) return refuse("feedback.too_large", "reply too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return text.length > SMALL_REPLY_BYTES ? refuse("feedback.too_large", "reply too large") : refuse("feedback.invalid", "body is not valid JSON");
  }
  const parsed = UserReplyBody.safeParse(raw);
  if (!parsed.success) return refuse("feedback.invalid", "reply must be 1-4096 bytes of text");
  const decoded = parsed.data.attachments.map(decodeAttachment);
  for (const d of decoded) {
    if (!d.ok) {
      if (d.reason === "metadata") return refuse("feedback.image_metadata", "attachment carries metadata; re-encode the image");
      return refuse(d.reason === "too_large" ? "feedback.too_large" : "feedback.invalid", "attachment rejected");
    }
  }
  if (decoded.length > 0 && !env.TELEMETRY_RAW) return refuse("feedback.disabled", "attachments are unavailable");
  if (decoded.length === 0 && new TextEncoder().encode(text).length > SMALL_REPLY_BYTES) return refuse("feedback.too_large", "reply too large");

  const policy = { kind: "reply" as const, trusted: level.trusted, hourly: level.limits.replies, receipt, replyable: REPLYABLE };
  const admission = await admit(env, { ipKey, installHash: who.installHash }, now, policy, blocked, ip);
  if (admission.kind === "refused") return admission.response;
  // One transaction decides ownership, status and the per-item cap, stores the
  // reply and moves needs_info back to held and fixed back to recorded, so none
  // of it can land half-done.
  const at = now.toISOString();
  const owner = ownedByCaller(env, who.installHash, now);
  let res: D1Result;
  let stored: StoredAttachment[] = [];
  const discard = async () => {
    if (env.TELEMETRY_RAW) await deleteAttachments(env.TELEMETRY_RAW, stored);
  };
  try {
    for (const [i, d] of decoded.entries()) if (d.ok && env.TELEMETRY_RAW) stored.push(await storeAttachment(env.TELEMETRY_RAW, d, i));
    const json = JSON.stringify(stored);
    [res] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO feedback_replies (receipt, author, body, handled, created_at)
         SELECT receipt, 'user', ?, CASE status WHEN 'needs_info' THEN 1 WHEN 'answered' THEN 2 ELSE 0 END, ? FROM feedback
         WHERE receipt = ? AND ${owner.sql} AND status IN ${REPLYABLE_SQL}
           AND (SELECT COUNT(*) FROM feedback_replies WHERE receipt = ? AND author = 'user') < ?`,
      ).bind(scrubSensitiveText(parsed.data.body), at, receipt, ...owner.binds, receipt, MAX_REPLIES_PER_ITEM),
      env.DB.prepare(
        `UPDATE feedback SET status = CASE status WHEN 'needs_info' THEN 'held' WHEN 'fixed' THEN 'recorded' ELSE status END,
           resolved_version = CASE WHEN status = 'fixed' THEN NULL ELSE resolved_version END, updated_at = ?
         WHERE receipt = ? AND ${owner.sql} AND changes() > 0`,
      ).bind(at, receipt, ...owner.binds),
      ...imageStatements(env, receipt, stored, json, at),
    ]);
  } catch (err) {
    await discard();
    await refund(env, admission.buckets);
    throw err;
  }
  if ((res.meta?.changes ?? 0) === 0) {
    await discard();
    await refund(env, admission.buckets);
    return (await replyRefusal(env, who.installHash, policy, now)) ?? refuse("feedback.not_replyable", "this report cannot take replies");
  }
  const replyId = res.meta?.last_row_id ?? 0;
  announce(ctx, env, { t: "replied", receipt });
  return jsonResponse({ replyId }, 201);
}

// The reply row and its images land together. After the status update changes()
// is 1 only when the reply was inserted, and last_insert_rowid() is still the reply.
// Images are never published here: only a maintainer's release makes one public.
function imageStatements(env: Env, receipt: string, stored: StoredAttachment[], json: string, at: string): D1PreparedStatement[] {
  if (stored.length === 0) return [];
  return [env.DB.prepare("INSERT INTO feedback_reply_attachments (reply_id, receipt, attachments_json, created_at) SELECT last_insert_rowid(), ?, ?, ? WHERE changes() > 0").bind(receipt, json, at)];
}
