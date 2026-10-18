package modhost

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

const guardMod = `
export function register(on) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.input.command.includes('rm -rf')) return { deny: 'no recursive removes here' };
    if (e.input.command.startsWith('git ')) return next({ ...e, input: { ...e.input, command: 'rtk ' + e.input.command } });
    return next(e);
  });
  on('tool.check', async ($, e, next) => {
    if (e.tool === 'Bash' && e.input.command.includes('curl')) return { decision: 'ask' };
    if (e.tool === 'Bash' && e.input.command.includes('sudo')) return { decision: 'deny' };
    if (e.tool === 'Read') return { decision: 'allow' };
    return next(e);
  });
  on('prompt.submit', async ($, e, next) => {
    if (e.text.includes('secret')) return { drop: 'do not paste secrets' };
    return next({ ...e, text: e.text.trim() + ' (checked)' });
  });
}`

func toolCfg() map[string]any {
	return map[string]any{
		"toolNames":        map[string]string{"bash": "Bash", "read_file": "Read"},
		"toolInputRenames": map[string]map[string]string{"read_file": {"path": "file_path"}},
	}
}

func TestAToolCallHookCanDenyRewriteOrPass(t *testing.T) {
	h := startHost(t, writeMod(t, "register.mjs", guardMod), toolCfg())
	if res := h.initialize(); res["error"] != nil {
		t.Fatalf("initialize: %v", res["error"])
	}
	deny := h.intercept("tool.before", map[string]any{"name": "bash", "arguments": `{"command":"rm -rf /"}`, "callId": "c1"})
	if decision(deny) != "block" || deny["reason"] != "no recursive removes here" {
		t.Fatalf("deny = %v", deny)
	}
	rewrite := h.intercept("tool.before", map[string]any{"name": "bash", "arguments": `{"command":"git status"}`, "callId": "c2"})
	if decision(rewrite) != "replace" {
		t.Fatalf("rewrite = %v", rewrite)
	}
	var rep struct{ Name, Arguments, CallID string }
	b, _ := json.Marshal(rewrite["replacement"])
	_ = json.Unmarshal(b, &rep)
	if rep.Name != "bash" || !strings.Contains(rep.Arguments, "rtk git status") || rep.CallID != "c2" {
		t.Fatalf("replacement = %+v", rep)
	}
	if got := h.intercept("tool.before", map[string]any{"name": "bash", "arguments": `{"command":"ls"}`, "callId": "c3"}); decision(got) != "continue" {
		t.Fatalf("an untouched call = %v", got)
	}
	if got := h.intercept("tool.before", map[string]any{"name": "read_file", "arguments": `{"path":"a"}`, "callId": "c4"}); decision(got) != "continue" {
		t.Fatalf("a tool the matcher does not name = %v", got)
	}
}

// A mod can ask or deny; an allow it answers never leaves the script as one.
func TestToolCheckAnswersAskAndDenyAndNeverAllow(t *testing.T) {
	h := startHost(t, writeMod(t, "register.mjs", guardMod), toolCfg())
	h.initialize()
	check := func(name, args, host string) string {
		return decision(h.intercept("permission.decision", map[string]any{"name": name, "arguments": args, "hostDecision": host}))
	}
	if got := check("bash", `{"command":"curl x"}`, "allow"); got != "ask" {
		t.Fatalf("curl = %s, want ask", got)
	}
	if got := check("bash", `{"command":"sudo ls"}`, "allow"); got != "deny" {
		t.Fatalf("sudo = %s, want deny", got)
	}
	if got := check("read_file", `{"path":"a"}`, "deny"); got != "continue" {
		t.Fatalf("a mod allow over a host deny = %s, want continue (the deny stands)", got)
	}
	if got := check("bash", `{"command":"curl x"}`, "deny"); got != "continue" {
		t.Fatalf("ask over a host deny = %s, want continue", got)
	}
}

func TestAPromptHookCanRewriteOrDrop(t *testing.T) {
	h := startHost(t, writeMod(t, "register.mjs", guardMod), toolCfg())
	h.initialize()
	rewrite := h.intercept("input.receive", map[string]any{"text": "  hello  "})
	b, _ := json.Marshal(rewrite["replacement"])
	if decision(rewrite) != "replace" || !strings.Contains(string(b), "hello (checked)") {
		t.Fatalf("rewrite = %v", rewrite)
	}
	drop := h.intercept("input.receive", map[string]any{"text": "my secret key"})
	if decision(drop) != "block" || drop["reason"] != "do not paste secrets" {
		t.Fatalf("drop = %v", drop)
	}
}

func TestAHookThatThrowsOrRunsPastItsBudgetIsSkippedAndItsCatchRuns(t *testing.T) {
	mod := writeMod(t, "register.mjs", `
export function register(on) {
  on('prompt.submit', async () => { throw new Error('boom'); }).catch(async ($, e, next) => { await $.store.set('caught', next.error.kind); });
  on('prompt.submit', async () => { await new Promise(() => {}); }).catch(async ($, e, next) => { await $.store.set('caught2', next.error.kind); });
  on('prompt.submit', async ($, e, next) => next({ ...e, text: e.text + '!' }));
}`)
	h := startHost(t, mod, map[string]any{"hookMs": 300, "catchMs": 500})
	h.initialize()
	start := time.Now()
	got := h.intercept("input.receive", map[string]any{"text": "hi"})
	b, _ := json.Marshal(got["replacement"])
	if decision(got) != "replace" || !strings.Contains(string(b), "hi!") {
		t.Fatalf("a failing hook stopped the chain: %v", got)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("a stuck hook held the turn for %v", time.Since(start))
	}
	if !strings.Contains(h.stderr.String(), "mod.hook_timeout") {
		t.Fatalf("the timeout was not attributed:\n%s", h.stderr.String())
	}
}

func TestRegisteringAnEventClaudeDoesNotNameFailsTheModuleAndAServedGapIsReported(t *testing.T) {
	bad := startHost(t, writeMod(t, "bad.mjs", `export function register(on) { on('tool.cal', async ($, e, next) => next(e)); }`), nil)
	if res := bad.initialize(); res["error"] == nil {
		t.Fatalf("a misspelt event registered: %v", res)
	}
	gap := startHost(t, writeMod(t, "gap.mjs", `export function register(on) { on('telemetry.log', { to: 'collector' }, async ($, e, next) => next(e)); on('tool.call', async ($, e, next) => next(e)); }`), nil)
	if res := gap.initialize(); res["error"] != nil {
		t.Fatalf("initialize: %v", res["error"])
	}
	if !strings.Contains(gap.stderr.String(), "telemetry.log") {
		t.Fatalf("an event this host never raises was not named:\n%s", gap.stderr.String())
	}
}

func TestAnUnservedApiMemberRejectsWithATypedCodeAndConsoleStaysOffTheWire(t *testing.T) {
	mod := writeMod(t, "register.mjs", `
export function register(on) {
  console.log('this must not reach the wire');
  process.stdout.write('neither must this\n');
  on('prompt.submit', async ($, e, next) => {
    try { await $.model.complete({}); } catch (err) { await $.store.set('code', err.code); }
    const code = await $.store.get('code');
    return next({ ...e, text: e.text + ' ' + code });
  });
}`)
	h := startHost(t, mod, nil)
	h.initialize()
	got := h.intercept("input.receive", map[string]any{"text": "go"})
	b, _ := json.Marshal(got["replacement"])
	if !strings.Contains(string(b), "mod.unsupported") {
		t.Fatalf("replacement = %s, want the typed code", b)
	}
}

const toolsMod = `
export function register(on) {
  on('session.start', async ($, e, next) => {
    $.tool.register({ name: 'count_lines', description: 'Count lines', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, readOnly: true, run: async ($, input) => String(input.text.split('\n').length) });
    $.command.register({ name: 'replay', description: 'Replay edits', run: async ($, args) => ({ text: 'replayed ' + JSON.stringify(args) }) });
    return next(e);
  });
}`

func TestToolsAndCommandsRegisteredAtSessionStartAreDescribedInTheHandshakeAndServed(t *testing.T) {
	h := startHost(t, writeMod(t, "register.mjs", toolsMod), nil)
	res := h.initialize()
	if res["error"] != nil {
		t.Fatalf("initialize: %v", res["error"])
	}
	result := res["result"].(map[string]any)
	specs, _ := result["toolSpecs"].([]any)
	if len(specs) != 1 || specs[0].(map[string]any)["name"] != "count_lines" || specs[0].(map[string]any)["readOnly"] != true {
		t.Fatalf("toolSpecs = %v", result["toolSpecs"])
	}
	var actions []string
	for _, a := range result["uiActions"].([]any) {
		actions = append(actions, a.(map[string]any)["actionId"].(string))
	}
	if !contains(actions, "replay") || !contains(actions, "press.0") {
		t.Fatalf("uiActions = %v", actions)
	}
	call := h.call("extension/tool/call", map[string]any{"name": "count_lines", "arguments": map[string]any{"text": "a\nb\nc"}, "timeoutMillis": 5000}, 10*time.Second)
	if call["result"].(map[string]any)["content"] != "3" {
		t.Fatalf("tool result = %v", call)
	}
	cmd := h.call("extension/ui/action", map[string]any{"actionId": "replay", "sessionId": "s1", "generation": 1, "args": map[string]any{"n": "2"}}, 10*time.Second)
	if msg := cmd["result"].(map[string]any)["message"]; msg != `replayed {"n":"2"}` {
		t.Fatalf("command result = %v", cmd)
	}
	// session.start ran once, in the handshake: the host's own does not run it again.
	if got := h.intercept("session.start", map[string]any{"phase": "start"}); decision(got) != "continue" {
		t.Fatalf("session.start = %v", got)
	}
}

func contains(list []string, want string) bool { return slices.Contains(list, want) }

func TestTheBandIsPublishedAsAViewAndAButtonPressRedrawsIt(t *testing.T) {
	mod := writeMod(t, "register.mjs", `
import { atom, read, update } from 'claude-code';
const count = atom({ plugin: 'demo', key: 'count' }, 0);
export function register(on) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const n = await read($, count);
    return Box({ flexDirection: 'row', children: [Text({ color: 'green', children: ['Count: ' + n] }), Button({ key: 'more', label: 'Add', onPress: () => update($, count, (v) => v + 1) })] });
  });
}`)
	h := startHost(t, mod, nil)
	h.initialize()
	first := waitPublish(t, h)
	body := first["payload"].(map[string]any)
	if first["kind"] != "view" || body["slot"] != "above_prompt" {
		t.Fatalf("published = %v", first)
	}
	row := body["body"].([]any)[0].(map[string]any)
	if row["kind"] != "row" {
		t.Fatalf("root = %v", row)
	}
	kids := row["children"].([]any)
	if kids[0].(map[string]any)["value"] != "Count: 0" || kids[0].(map[string]any)["tone"] != "ok" || kids[1].(map[string]any)["actionId"] != "press.0" {
		t.Fatalf("children = %v", kids)
	}
	pressed := h.call("extension/ui/action", map[string]any{"actionId": "press.0", "sessionId": "s1", "generation": 1}, 10*time.Second)
	if pressed["result"].(map[string]any)["accepted"] != true {
		t.Fatalf("press = %v", pressed)
	}
	second := waitPublish(t, h)
	again := second["payload"].(map[string]any)["body"].([]any)[0].(map[string]any)["children"].([]any)
	if again[0].(map[string]any)["value"] != "Count: 1" {
		t.Fatalf("after the press: %v", again)
	}
}

func waitPublish(t *testing.T, h *fakeHost) map[string]any {
	t.Helper()
	select {
	case m := <-h.published:
		return m
	case <-time.After(10 * time.Second):
		t.Fatalf("nothing was published; stderr:\n%s", h.stderr.String())
		return nil
	}
}
