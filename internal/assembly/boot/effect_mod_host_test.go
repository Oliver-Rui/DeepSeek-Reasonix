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
func installMod(t *testing.T, module string) (home, workspace string) {
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
kind = "boot-effect-mod"
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
	return home, workspace
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
	_, _ = installMod(t, denyingMod)
	prov := &modProvider{}
	provider.Register("boot-effect-mod", func(provider.Config) (provider.Provider, error) { return prov, nil })

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
