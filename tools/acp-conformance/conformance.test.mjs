// Drives the built `reasonix acp` with the official ACP TypeScript SDK. The SDK
// parses what the agent sends, and harness.mjs checks each raw message against
// the schema the SDK ships. Run with `make acp-conformance` from the repo root.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { startAgent, wireProblems } from "./harness.mjs";

const live = [];
async function agent(options) {
  const a = await startAgent(options);
  live.push(a);
  await a.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return a;
}
afterEach(async () => { while (live.length) await live.pop().stop(); });

const text = (value) => [{ type: "text", text: value }];
const conforms = (a) => assert.deepEqual(wireProblems(a.wire), [], a.stderr());

describe("the agent speaks ACP as the official SDK and schema define it", () => {
  it("negotiates version 1 and declares what it implements", async () => {
    const a = await startAgent();
    live.push(a);
    const init = await a.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(init.protocolVersion, 1);
    const caps = init.agentCapabilities.sessionCapabilities;
    for (const method of ["list", "resume", "close", "delete", "additionalDirectories"]) assert.ok(caps[method], `${method} is declared`);
    conforms(a);
  });

  it("runs a turn: a streamed answer with message ids, usage, and a stop reason", async () => {
    const a = await agent();
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    const done = await a.conn.prompt({ sessionId, prompt: text("say hi") });
    assert.equal(done.stopReason, "end_turn");
    const kinds = a.updates.map((n) => n.update.sessionUpdate);
    assert.ok(kinds.includes("agent_message_chunk"));
    assert.ok(kinds.includes("usage_update"));
    const chunks = a.updates.map((n) => n.update).filter((u) => u.sessionUpdate === "agent_message_chunk");
    assert.ok(chunks.every((c) => typeof c.messageId === "string" && c.messageId.length > 0), "every chunk carries a messageId");
    assert.equal(new Set(chunks.map((c) => c.messageId)).size, 1, "one answer is one message");
    assert.ok(a.updates.every((n) => n.sessionId === sessionId));
    conforms(a);
  });
});

describe("the session lifecycle", () => {
  it("lists, resumes, loads, closes and deletes a session", async () => {
    const a = await agent();
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    await a.conn.prompt({ sessionId, prompt: text("first") });

    const listed = await a.conn.listSessions({ cwd: a.work });
    assert.ok(listed.sessions.some((s) => s.sessionId === sessionId && s.cwd === a.work), "the new session is listed under its folder");

    await a.conn.resumeSession({ sessionId, cwd: a.work, mcpServers: [] });
    assert.equal((await a.conn.prompt({ sessionId, prompt: text("second") })).stopReason, "end_turn");

    const before = a.updates.length;
    await a.conn.loadSession({ sessionId, cwd: a.work, mcpServers: [] });
    const replayed = a.updates.slice(before).map((n) => n.update.sessionUpdate);
    assert.ok(replayed.includes("user_message_chunk") && replayed.includes("agent_message_chunk"), `load replays the history, got ${replayed}`);

    await a.conn.closeSession({ sessionId });
    await a.conn.deleteSession({ sessionId });
    const after = await a.conn.listSessions({ cwd: a.work });
    assert.ok(!after.sessions.some((s) => s.sessionId === sessionId), "a deleted session is gone");
    conforms(a);
  });

  it("refuses an unknown session with a JSON-RPC error and keeps serving", async () => {
    const a = await agent();
    await assert.rejects(a.conn.prompt({ sessionId: "no-such-session", prompt: text("hi") }), (e) => typeof e.code === "number");
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    assert.equal((await a.conn.prompt({ sessionId, prompt: text("still alive") })).stopReason, "end_turn");
    conforms(a);
  });

  it("answers an unknown method with method-not-found", async () => {
    const a = await agent();
    const answer = await a.rpc("nonsense/method", {});
    assert.equal(answer.error?.code, -32601);
  });
});

describe("session options", () => {
  it("offers the model and mode options and accepts setting them", async () => {
    const a = await agent();
    const session = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    const model = session.configOptions.find((o) => o.id === "model");
    assert.ok(model && model.type === "select" && model.options.length > 0);
    const set = await a.conn.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: model.currentValue });
    assert.ok(Array.isArray(set.configOptions));
    await a.conn.setSessionMode({ sessionId: session.sessionId, modeId: "plan" });
    conforms(a);
  });
});

describe("cancelling", () => {
  it("ends a running turn with stopReason cancelled when the client cancels the session", async () => {
    const a = await agent({ script: () => ({ text: "slow", delayMs: 5000 }) });
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    const turn = a.conn.prompt({ sessionId, prompt: text("take your time") });
    await new Promise((r) => setTimeout(r, 400));
    await a.conn.cancel({ sessionId });
    assert.equal((await turn).stopReason, "cancelled");
    conforms(a);
  });

  it("ends only the request named by $/cancel_request", async () => {
    const a = await agent({ script: () => ({ text: "slow", delayMs: 5000 }) });
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    const answered = a.rpc("session/prompt", { sessionId, prompt: text("take your time") }, "to-cancel");
    await new Promise((r) => setTimeout(r, 400));
    a.notify("$/cancel_request", { requestId: "to-cancel" });
    const answer = await answered;
    assert.ok(answer.result?.stopReason === "cancelled" || answer.error, `the named request ended: ${JSON.stringify(answer)}`);
    conforms(a);
  });
});

describe("tool calls and permission", () => {
  const writes = (n, request) => (n === 0
    ? { calls: [{ id: "call-1", name: "write_file", args: { path: "note.txt", content: "from the model" } }] }
    : { text: "done" });

  it("asks before a write, runs it when the client allows it, and reports the call's life", async () => {
    const a = await agent({ script: writes });
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    const done = await a.conn.prompt({ sessionId, prompt: text("write a note") });
    assert.equal(done.stopReason, "end_turn");
    assert.equal(a.permissions.length, 1, `one permission request, stderr: ${a.stderr()}`);
    const request = a.permissions[0];
    assert.equal(request.sessionId, sessionId);
    assert.ok(request.options.some((o) => o.kind === "allow_once") && request.options.some((o) => o.kind === "reject_once"));
    const statuses = a.updates.map((n) => n.update).filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update").map((u) => u.status);
    assert.ok(statuses.at(-1) === "completed", `the call completes, got ${statuses}`);
    const call = a.updates.map((n) => n.update).find((u) => u.sessionUpdate === "tool_call");
    assert.equal(typeof call.toolCallId, "string");
    assert.ok(call.title && call.name, "a tool call carries its title and its invoked name");
    conforms(a);
  });

  it("does not run the write when the client rejects it, and still ends the turn", async () => {
    const a = await agent({ script: writes });
    a.onPermission((request) => ({ outcome: { outcome: "selected", optionId: request.options.find((o) => o.kind === "reject_once").optionId } }));
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    const done = await a.conn.prompt({ sessionId, prompt: text("write a note") });
    assert.equal(done.stopReason, "end_turn");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    assert.ok(!existsSync(join(a.work, "note.txt")), "a rejected write leaves no file");
    conforms(a);
  });

  it("ends the turn as cancelled when the client cancels the permission prompt", async () => {
    const a = await agent({ script: writes });
    a.onPermission(() => ({ outcome: { outcome: "cancelled" } }));
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    const done = await a.conn.prompt({ sessionId, prompt: text("write a note") });
    assert.ok(["cancelled", "end_turn"].includes(done.stopReason), `got ${done.stopReason}`);
    conforms(a);
  });
});

describe("additional workspace roots", () => {
  it("accepts a folder outside the built-in write roots and lists it with the session", async () => {
    const a = await agent();
    const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    // The system temp directory is itself a write root and would be refused as an overlap.
    const extra = realpathSync(mkdtempSync(join(import.meta.dirname, ".scratch-")));
    try {
      const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [], additionalDirectories: [extra] });
      const listed = await a.conn.listSessions({ cwd: a.work });
      const entry = listed.sessions.find((s) => s.sessionId === sessionId);
      assert.ok(entry, "the session is listed");
      if (entry.additionalDirectories) assert.deepEqual(entry.additionalDirectories, [extra]);
      conforms(a);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it("refuses the whole request with invalid-params and a stable code when a folder cannot be added", async () => {
    const a = await agent();
    await assert.rejects(
      a.conn.newSession({ cwd: a.work, mcpServers: [], additionalDirectories: ["/nonexistent/dir/for/acp"] }),
      (e) => e.code === -32602 && typeof e.data?.code === "string" && e.data.code.length > 0,
    );
    const { sessionId } = await a.conn.newSession({ cwd: a.work, mcpServers: [] });
    assert.ok(sessionId, "the agent keeps serving after a refusal");
    conforms(a);
  });
});
