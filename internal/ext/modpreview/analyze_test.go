package modpreview

import (
	"slices"
	"strings"
	"testing"
)

var served = map[string]bool{"tool.call": true, "tool.check": true, "prompt.submit": true, "turn.complete": true, "ui.render": true, "session.start": true}

func analyze(t *testing.T, src string) Preview {
	t.Helper()
	return Analyze("demo", "hooks/register.js", []byte(src), served)
}

func eventNames(p Preview) []string {
	var out []string
	for _, e := range p.Events {
		if e.Dynamic {
			out = append(out, "<dynamic>")
		} else {
			out = append(out, e.Name)
		}
	}
	slices.Sort(out)
	return out
}

func apiNames(p Preview) []string {
	var out []string
	for _, c := range p.API {
		name := c.Namespace
		if c.Method != "" {
			name += "." + c.Method
		}
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

func hasFinding(p Preview, kind string) bool {
	return slices.ContainsFunc(p.Findings, func(f Finding) bool { return f.Kind == kind })
}

func TestListsLiteralEventsAndApiCallsOfASimpleMod(t *testing.T) {
	p := analyze(t, `
export function register(on, options) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const out = await $.process.run(['git', 'status']);
    $.ui.toast('hi');
    return next(e);
  });
  on("prompt.submit", async ($, e, next) => next({ ...e, text: e.text.trim() }));
}`)
	if !p.Listed {
		t.Fatalf("not listed: %s", p.Reason)
	}
	if got := eventNames(p); !slices.Equal(got, []string{"prompt.submit", "tool.call"}) {
		t.Fatalf("events = %v", got)
	}
	if got := apiNames(p); !slices.Equal(got, []string{"process.run", "ui.toast"}) {
		t.Fatalf("api = %v", got)
	}
	if len(p.Findings) != 0 || len(p.Imports) != 0 || len(p.Unserved) != 0 {
		t.Fatalf("findings=%v imports=%v unserved=%v, want none", p.Findings, p.Imports, p.Unserved)
	}
}

func TestNamesTheEventsThisHostNeverRaises(t *testing.T) {
	p := analyze(t, `export function register(on) { on('tool.call', async ($, e, next) => next(e)); on('telemetry.log', { to: 'collector' }, async ($, e, next) => next(e)); }`)
	if !slices.Equal(p.Unserved, []string{"telemetry.log"}) {
		t.Fatalf("unserved = %v", p.Unserved)
	}
}

func TestFollowsAnAliasOfOnAndOfTheApiByIdentityNotByName(t *testing.T) {
	p := analyze(t, `
export default function register(on) {
  const hook = on;
  hook('turn.complete', async (api, e, next) => {
    const x = api;
    x.fs.read('a');
    return next(e);
  });
}`)
	if got := eventNames(p); !slices.Equal(got, []string{"turn.complete"}) {
		t.Fatalf("events = %v", got)
	}
	if got := apiNames(p); !slices.Equal(got, []string{"fs.read"}) {
		t.Fatalf("api = %v (an alias of $ must still be followed)", got)
	}
}

func TestAShadowedNameIsNotTheApi(t *testing.T) {
	p := analyze(t, `
export function register(on) {
  on('tool.call', async ($, e, next) => {
    const inner = ($) => $.process.run(['x']);
    return next(e);
  });
}`)
	if len(p.API) != 0 {
		t.Fatalf("api = %v: a $ shadowed by an inner parameter is not the mods API", apiNames(p))
	}
}

func TestFlagsEverythingThatDefeatsTheListing(t *testing.T) {
	cases := map[string]struct {
		src     string
		finding string
	}{
		"computed event":  {`export function register(on) { const n = 'tool.' + 'call'; on(n, async ($, e, next) => next(e)); }`, ""},
		"computed member": {`export function register(on) { on('tool.call', async ($, e, next) => { const ns = 'pro' + 'cess'; $[ns].run(['x']); return next(e); }); }`, FindingComputedMember},
		"api escapes":     {`function use(api) { api.process.run(['x']); } export function register(on) { on('tool.call', async ($, e, next) => { use($); return next(e); }); }`, FindingAPIEscapes},
		"destructured":    {`export function register(on) { on('tool.call', async ($, e, next) => { const { process } = $; process.run(['x']); return next(e); }); }`, FindingDestructuredAPI},
		"on escapes":      {`function reg(f) { f('tool.call', async ($, e, next) => next(e)); } export function register(on) { reg(on); }`, FindingOnEscapes},
		"eval":            {`export function register(on) { eval('on("tool.call", () => 1)'); }`, FindingEval},
		"function ctor":   {`export function register(on) { new Function('return 1')(); }`, FindingFunctionCtor},
		"function ctor 2": {`export function register(on) { Function('return 1')(); }`, FindingFunctionCtor},
		"no register":     {`export function other() {}`, FindingNoRegister},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			p := analyze(t, tc.src)
			if !p.Listed {
				t.Fatalf("not listed: %s", p.Reason)
			}
			if tc.finding == "" {
				if got := eventNames(p); !slices.Equal(got, []string{"<dynamic>"}) {
					t.Fatalf("events = %v, want one dynamic", got)
				}
				return
			}
			if !hasFinding(p, tc.finding) {
				t.Fatalf("findings = %v, want %q", p.Findings, tc.finding)
			}
		})
	}
}

func TestListsEveryWayOfPullingInCodeThePreviewCannotSee(t *testing.T) {
	p := analyze(t, `
import fs from 'node:fs';
import { helper } from './helper.js';
const dyn = (n) => import(n);
const lazy = () => import('./lazy.js');
const r = require('./legacy.cjs');
export function register(on) { on('tool.call', async ($, e, next) => next(e)); }`)
	got := map[string]string{}
	for _, i := range p.Imports {
		got[i.Spec] = i.Kind
	}
	want := map[string]string{"node:fs": "static", "./helper.js": "static", "./lazy.js": "dynamic", "./legacy.cjs": "require", "(computed)": "dynamic"}
	for spec, kind := range want {
		if got[spec] != kind {
			t.Fatalf("imports = %v, want %s as %s", p.Imports, spec, kind)
		}
	}
}

func TestFindsRegisterThroughEveryExportForm(t *testing.T) {
	for name, src := range map[string]string{
		"export function":    `export function register(on) { on('tool.call', async ($, e, next) => next(e)); }`,
		"export default":     `export default function (on) { on('tool.call', async ($, e, next) => next(e)); }`,
		"export const arrow": `export const register = (on) => { on('tool.call', async ($, e, next) => next(e)); };`,
		"export list":        `function register(on) { on('tool.call', async ($, e, next) => next(e)); } export { register };`,
		"export list alias":  `function r(on) { on('tool.call', async ($, e, next) => next(e)); } export { r as register };`,
		"named handler":      `async function h($, e, next) { return next(e); } export function register(on) { on('tool.call', h); }`,
		"template literal":   "export function register(on) { on(`tool.call`, async ($, e, next) => next(e)); }",
	} {
		t.Run(name, func(t *testing.T) {
			p := analyze(t, src)
			if got := eventNames(p); !slices.Equal(got, []string{"tool.call"}) {
				t.Fatalf("events = %v, findings = %v", got, p.Findings)
			}
		})
	}
}

func TestAModuleThatCannotBeReadIsNotListedAndNeverReadsAsClean(t *testing.T) {
	huge := strings.Repeat("// pad\n", MaxSourceBytes/7+10)
	for name, tc := range map[string]struct {
		src    string
		reason string
	}{
		"syntax error": {`export function register(on) { on('a', ; }`, ReasonUnparseable},
		"too large":    {huge, ReasonTooLarge},
	} {
		t.Run(name, func(t *testing.T) {
			p := analyze(t, tc.src)
			if p.Listed || p.Reason != tc.reason || len(p.Events) != 0 || len(p.API) != 0 {
				t.Fatalf("preview = %+v, want not listed (%s)", p, tc.reason)
			}
		})
	}
}

func TestATypeScriptOrJsxModuleIsNamedAsNotPreviewed(t *testing.T) {
	for module, reason := range map[string]string{"hooks/register.ts": ReasonTypeScript, "hooks/register.mts": ReasonTypeScript, "hooks/register.cts": ReasonTypeScript, "hooks/register.tsx": ReasonUnsupported, "hooks/register.jsx": ReasonUnsupported} {
		p := Analyze("demo", module, []byte(`export function register(on) {}`), served)
		if p.Listed || p.Reason != reason {
			t.Fatalf("%s: preview = %+v, want not listed (%s)", module, p, reason)
		}
	}
}

func TestThePreviewPinsTheBytesItRead(t *testing.T) {
	a := analyze(t, `export function register(on) {}`)
	b := analyze(t, `export function register(on) { }`)
	if a.SHA256 == "" || a.SHA256 == b.SHA256 {
		t.Fatalf("hashes %q and %q: the hash must change with the bytes", a.SHA256, b.SHA256)
	}
}
