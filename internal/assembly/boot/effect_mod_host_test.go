package boot

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"reasonix/internal/contract/config"
	"reasonix/internal/contract/event"
	"reasonix/internal/contract/provider"
	"reasonix/internal/ext/installsource"
	"reasonix/internal/ext/modhost"
	"reasonix/internal/ext/pluginpkg"
	"reasonix/internal/session/control"
)

// modProvider asks for one bash call on the first request of a turn and answers
// "done" after its result, recording every request it was sent.
type modProvider struct {
	mu      sync.Mutex
	reqs    []provider.Request
	command string
}

func (p *modProvider) Name() string { return "boot-effect-mod" }

func (p *modProvider) Stream(_ context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	p.mu.Lock()
	p.reqs = append(p.reqs, req)
	p.mu.Unlock()
	ch := make(chan provider.Chunk, 3)
	last := req.Messages[len(req.Messages)-1]
	if last.Role != provider.RoleTool && p.command != "" {
		args, _ := json.Marshal(map[string]string{"command": p.command})
		ch <- provider.Chunk{Type: provider.ChunkToolCall, ToolCall: &provider.ToolCall{ID: "call-1", Name: "bash", Arguments: string(args)}}
	} else {
		ch <- provider.Chunk{Type: provider.ChunkText, Text: "done"}
	}
	ch <- provider.Chunk{Type: provider.ChunkDone}
	close(ch)
	return ch, nil
}

func (p *modProvider) requests() []provider.Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]provider.Request(nil), p.reqs...)
}

func (p *modProvider) toolResults() []string {
	var out []string
	for _, r := range p.requests() {
		for _, m := range r.Messages {
			if m.Role == provider.RoleTool {
				out = append(out, m.Content)
			}
		}
	}
	return out
}

// installMod installs a Claude Code mod through the same install flow a user
// takes and returns the isolated home.
func installMod(t *testing.T, module string) (home, workspace string, prov *modProvider) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	source := robustTempDir(t)
	for rel, body := range map[string]string{
		".claude-plugin/plugin.json": `{"name":"modtest","version":"0.1.0","description":"a test mod"}`,
		"hooks/hooks.json":           `{"modules":["./register.mjs"]}`,
		"hooks/register.mjs":         module,
	} {
		p := filepath.Join(source, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	prov = &modProvider{}
	kind := "boot-effect-mod-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	provider.Register(kind, func(provider.Config) (provider.Provider, error) { return prov, nil })
	home = isolateConfigHome(t)
	t.Setenv("REASONIX_HOME", filepath.Join(home, ".reasonix"))
	workspace = robustTempDir(t)
	t.Chdir(workspace)
	writeFile(t, workspace, "reasonix.toml", `
default_model = "test-model"

[environment]
enabled = false

[codegraph]
enabled = false

[[providers]]
name = "test-model"
kind = "`+kind+`"
model = "x"
`)
	approveWorkspace(t, workspace)
	installer := installsource.NewTool(installsource.Options{ProjectRoot: workspace, HomeDir: home, RequireApprovedPlan: true})
	request := map[string]any{"source": source, "kind": "plugin", "mode": "copy", "scope": "global"}
	for _, apply := range []bool{false, true} {
		request["apply"] = apply
		args, _ := json.Marshal(request)
		out, err := installer.Execute(t.Context(), args)
		if err != nil {
			t.Fatalf("install_source: %v", err)
		}
		var result struct {
			OK     bool   `json:"ok"`
			PlanID string `json:"planId"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal([]byte(out), &result); err != nil || !result.OK {
			t.Fatalf("install_source apply=%t: %s", apply, out)
		}
		request["planId"] = result.PlanID
	}
	return home, workspace, prov
}

func setModsSwitch(t *testing.T, on bool) {
	t.Helper()
	cfg := config.LoadForEdit(config.UserConfigPath())
	cfg.Mods.Enabled = on
	if err := cfg.SaveTo(config.UserConfigPath()); err != nil {
		t.Fatal(err)
	}
}

func runModTurn(t *testing.T, prov *modProvider, command string) {
	t.Helper()
	prov.command = command
	res, err := BuildRuntime(t.Context(), Options{Sink: event.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Controller.Close()
	res.Controller.SetToolApprovalMode(control.ToolApprovalYolo)
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	if err := res.Controller.Run(ctx, "run it"); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

const denyingMod = `
export function register(on) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.input.command.includes('FORBIDDEN')) return { deny: 'mod says: that command is not allowed here' };
    return next(e);
  });
}`

// A mod's tool.call deny stops the tool, and its reason is what the next provider
// request carries as the tool result. With the user's switch off the same
// installed mod does nothing at all.
func TestEffectAModsDenyStopsTheToolAndItsReasonReachesTheModelOnlyWhileTheSwitchIsOn(t *testing.T) {
	_, _, prov := installMod(t, denyingMod)

	setModsSwitch(t, false)
	runModTurn(t, prov, "echo FORBIDDEN-ran")
	off := strings.Join(prov.toolResults(), "\n")
	if strings.Contains(off, "mod says") || !strings.Contains(off, "FORBIDDEN-ran") {
		t.Fatalf("with the switch off the tool results were:\n%s", off)
	}
	if st := modhost.Default.Snapshot(); len(st) != 1 || st[0].State != modhost.StateInactive || st[0].Code != modhost.CodeSwitchOff {
		t.Fatalf("status with the switch off = %+v", st)
	}

	prov.mu.Lock()
	prov.reqs = nil
	prov.mu.Unlock()
	setModsSwitch(t, true)
	runModTurn(t, prov, "echo FORBIDDEN-ran")
	on := strings.Join(prov.toolResults(), "\n")
	if !strings.Contains(on, "mod says: that command is not allowed here") || strings.Contains(on, "FORBIDDEN-ran\n") {
		t.Fatalf("with the switch on the tool results were:\n%s", on)
	}
	if st := modhost.Default.Snapshot(); len(st) != 1 || st[0].State != modhost.StateRunning {
		t.Fatalf("status with the switch on = %+v", st)
	}
	if _, found, err := pluginpkg.FindInstalled(filepath.Join(os.Getenv("REASONIX_HOME")), "modtest"); err != nil || !found {
		t.Fatalf("installed = %v, %v", found, err)
	}
}

func resetProvider(prov *modProvider) {
	prov.mu.Lock()
	prov.reqs = nil
	prov.mu.Unlock()
}

// Nothing a mod does moves the bytes the provider caches: the system prompt and
// the tools of the first request are the same with the switch off and on.
func TestEffectAModLeavesTheCachedPrefixAlone(t *testing.T) {
	_, _, prov := installMod(t, denyingMod)
	capture := func() (system string, tools string) {
		runModTurn(t, prov, "")
		req := prov.requests()[0]
		raw, _ := json.Marshal(req.Tools)
		return systemMessage(req.Messages), string(raw)
	}
	setModsSwitch(t, false)
	offSystem, offTools := capture()
	resetProvider(prov)
	setModsSwitch(t, true)
	onSystem, onTools := capture()
	if offSystem != onSystem || offTools != onTools {
		t.Fatalf("the mod moved the cached prefix: system equal=%t tools equal=%t", offSystem == onSystem, offTools == onTools)
	}
}

// A mod that answers allow cannot open what the host closed: in a posture that
// refuses the call, the call is still refused and the model is told so.
func TestEffectAModsAllowDoesNotOverrideTheHostsRefusal(t *testing.T) {
	_, workspace, prov := installMod(t, `
export function register(on) {
  on('tool.check', async ($, e, next) => ({ decision: 'allow' }));
}`)
	setModsSwitch(t, true)
	prov.command = "touch refused-check.txt"
	res, err := BuildRuntime(t.Context(), Options{Sink: event.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Controller.Close()
	res.Controller.SetToolApprovalMode(control.ToolApprovalReadOnly)
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	if err := res.Controller.Run(ctx, "run it"); err != nil {
		t.Fatalf("Run: %v", err)
	}
	results := strings.Join(prov.toolResults(), "\n")
	if _, err := os.Stat(filepath.Join(workspace, "refused-check.txt")); err == nil || !strings.Contains(strings.ToLower(results), "blocked") {
		t.Fatalf("a read-only session ran a write a mod allowed (file exists: %t), or did not say it was blocked:\n%s", err == nil, results)
	}
}

// A mod whose process dies, or whose hook never returns, does not fail the turn:
// it is skipped, the turn completes, and the registry counts the death.
func TestEffectAModThatCrashesOrHangsDoesNotFailTheTurn(t *testing.T) {
	for name, body := range map[string]string{
		"exit": `export function register(on) { on('prompt.submit', async () => { process.exit(3); }); }`,
		"hang": `export function register(on) { on('prompt.submit', async () => { while (true) {} }); }`,
	} {
		t.Run(name, func(t *testing.T) {
			_, _, prov := installMod(t, body)
			cfg := config.LoadForEdit(config.UserConfigPath())
			cfg.Mods.Enabled, cfg.Mods.HookBudgetMS = true, 500
			if err := cfg.SaveTo(config.UserConfigPath()); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			runModTurn(t, prov, "")
			if got := len(prov.requests()); got == 0 {
				t.Fatal("the turn never reached the provider")
			}
			if time.Since(start) > 40*time.Second {
				t.Fatalf("a dead mod held the turn for %v", time.Since(start))
			}
			var restarts int
			for _, s := range modhost.Default.Snapshot() {
				restarts += s.Restarts
			}
			if restarts == 0 {
				t.Fatalf("the death was not counted: %+v", modhost.Default.Snapshot())
			}
		})
	}
}
