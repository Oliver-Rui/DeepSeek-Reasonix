package modhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"

	"reasonix/internal/ext/hook"
	"reasonix/internal/ext/modpreview"
	"reasonix/internal/ext/pluginpkg"
)

// Intercepts are the host points the script subscribes to, in the form the
// manifest declares them.
var Intercepts = []string{"tool.before", "permission.decision", "input.receive", "session.start", "session.end", "agent.before_start"}

// Served are the Claude events this host raises; the rest are named as unserved.
var Served = map[string]bool{"tool.call": true, "tool.check": true, "prompt.submit": true, "session.start": true, "session.end": true, "turn.start": true, "ui.render": true, "ui.press": true, "command.run": true}

// Settings are the user's switches for mods.
type Settings struct {
	Enabled bool
	// HookBudgetMS bounds one hook's own running time; zero uses the reference's 10 s.
	HookBudgetMS int
}

// Deps is what turning installed mods into runtimes needs from the host.
type Deps struct {
	Settings  Settings
	Resolver  Resolver
	StateRoot string
	Registry  *Registry
}

// Packages returns the sidecar packages for the installed mods and records what
// became of each mod. With the switch off, or no runtime, nothing is returned
// and the registry says why.
func Packages(ctx context.Context, d Deps, installed []pluginpkg.InstalledPackage) ([]pluginpkg.InstalledPackage, []string) {
	reg := d.Registry
	if reg == nil {
		reg = Default
	}
	mods, bad := Discover(installed)
	var warnings []string
	for name, err := range bad {
		reg.Set(Status{Plugin: name, State: StateInactive, Code: CodeBadModule, Detail: err.Error()})
	}
	if len(mods) == 0 {
		return nil, nil
	}
	if !d.Settings.Enabled {
		for _, m := range mods {
			reg.Set(Status{Plugin: m.Plugin, State: StateInactive, Code: CodeSwitchOff})
		}
		return nil, nil
	}
	rt, err := d.Resolver.Resolve(ctx)
	if err != nil {
		code := CodeRuntimeMissing
		if errors.Is(err, ErrRuntimeUnsupported) {
			code = CodeRuntimeUnsupport
		}
		for _, m := range mods {
			reg.Set(Status{Plugin: m.Plugin, State: StateInactive, Code: code, Detail: err.Error()})
		}
		return nil, nil
	}
	script, err := WriteScript(filepath.Join(d.StateRoot, "modhost"))
	if err != nil {
		for _, m := range mods {
			reg.Set(Status{Plugin: m.Plugin, State: StateInactive, Code: CodeStartFailed, Detail: err.Error()})
		}
		return nil, []string{"mod host script: " + err.Error()}
	}
	var out []pluginpkg.InstalledPackage
	for _, m := range mods {
		if reg.Disabled(m.Plugin) {
			continue
		}
		switch strings.ToLower(path.Ext(m.Rel)) {
		case ".jsx", ".tsx":
			reg.Set(Status{Plugin: m.Plugin, State: StateInactive, Code: CodeUnsupportedType, Detail: "JSX and TSX modules need a transform this host does not run"})
			continue
		}
		reg.Starting(m.Plugin, rt)
		out = append(out, Synthesize(d, m, rt, script))
	}
	return out, warnings
}

// Synthesize builds the runtime package for one mod: the script under the
// resolved runtime, with the module as its argument, tighten-only and killed
// when it stops answering.
func Synthesize(d Deps, m Module, rt Runtime, script string) pluginpkg.InstalledPackage {
	cfg := map[string]any{
		"stateDir":         filepath.Join(d.StateRoot, "mods", m.Plugin),
		"toolNames":        hook.ClaudeToolNames(),
		"toolInputRenames": hook.ClaudeToolInputRenames(),
	}
	if d.Settings.HookBudgetMS > 0 {
		cfg["hookMs"] = d.Settings.HookBudgetMS
	}
	raw, _ := json.Marshal(cfg)
	timeout := 15_000
	if d.Settings.HookBudgetMS > 0 {
		timeout = min(d.Settings.HookBudgetMS+5_000, 60_000)
	}
	spec := &pluginpkg.RuntimeSpec{
		Command:       rt.Path,
		Args:          []string{script, m.Abs, m.Root, m.Plugin, string(raw)},
		Env:           rt.Env,
		TightenOnly:   true,
		DynamicTools:  true,
		KillOnTimeout: true,
		TimeoutMillis: timeout,
		Intercepts:    append([]string(nil), Intercepts...),
		Capabilities:  []string{"interceptors", "ui", "tools"},
	}
	pkg := pluginpkg.Package{Root: m.Root, ManifestKind: m.Installed.ManifestKind, Manifest: pluginpkg.Manifest{Name: m.Plugin, Version: m.Installed.Version, Runtime: spec}}
	installed := m.Installed
	return pluginpkg.InstalledPackage{Installed: installed, Package: pkg}
}

// Preview lists a mod's hooks module for the install preview.
func Preview(m Module) (modpreview.Preview, error) {
	src, err := os.ReadFile(m.Abs)
	if err != nil {
		return modpreview.Preview{}, err
	}
	return modpreview.Analyze(m.Plugin, m.Rel, src, Served), nil
}
