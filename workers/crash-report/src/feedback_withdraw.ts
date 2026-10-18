import type { Env } from "./env";
import { verifyInstall } from "./feedback_auth";
import { jsonResponse, refuse } from "./feedback_http";
import { ownedByCaller } from "./feedback_ownership";
import { dropAttachments } from "./feedback_triage";
import type { FeedbackRow } from "./feedback_types";
import { announce, type OpsWaiter } from "./ops_emit";

// Before an outcome the submitter may still take a report back; after one the
// report is a record of what happened and stays.
const WITHDRAWABLE = ["held", "received", "needs_info", "answered", "recorded", "in_progress"];
const WITHDRAWABLE_SQL = `(${WITHDRAWABLE.map((s) => `'${s}'`).join(",")})`;
const LIST_LIMIT = 200;

// One compare-and-set on the status decides ownership and eligibility together,
// so a report that moved to an outcome in between is refused, never overwritten,
// and the contact the reporter left goes in the same statement. A repeat for a
// report that is already withdrawn runs the side effects that may be missing
// (the images), the way a repeated reject does. An unknown receipt and another
// install's read the same: not found.
export async function handleWithdraw(request: Request, env: Env, receipt: string, ctx?: OpsWaiter): Promise<Response> {
  const who = await verifyInstall(request, env);
  if (who instanceof Response) return who;
  const now = new Date();
  const owner = ownedByCaller(env, who.installHash, now);
  const res = await env.DB.prepare(`UPDATE feedback SET status = 'withdrawn', contact = '', updated_at = ? WHERE receipt = ? AND ${owner.sql} AND status IN ${WITHDRAWABLE_SQL}`)
    .bind(now.toISOString(), receipt, ...owner.binds)
    .run();
  const first = (res.meta?.changes ?? 0) > 0;
  const row = await env.DB.prepare(`SELECT * FROM feedback WHERE receipt = ? AND ${owner.sql}`).bind(receipt, ...owner.binds).first<FeedbackRow>();
  if (!row) return refuse("feedback.not_found", "unknown receipt");
  if (!first && row.status !== "withdrawn") return refuse("feedback.not_withdrawable", "this feedback already has an outcome and can no longer be withdrawn");
  await dropAttachments(env, row);
  if (first) announce(ctx, env, { t: "status", receipt, category: row.category, status: "withdrawn" });
  return jsonResponse({ receipt, status: "withdrawn" });
}

// What the maintainer loop reads to close the mirror issues of withdrawn reports.
export async function withdrawnWithIssue(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT receipt, issue_number, issue_url FROM feedback WHERE status = 'withdrawn' AND issue_number IS NOT NULL ORDER BY updated_at DESC LIMIT ?",
  )
    .bind(LIST_LIMIT)
    .all<Pick<FeedbackRow, "receipt" | "issue_number" | "issue_url">>();
  return jsonResponse({ items: results.map((r) => ({ receipt: r.receipt, issueNumber: r.issue_number, issueUrl: r.issue_url })) });
}
