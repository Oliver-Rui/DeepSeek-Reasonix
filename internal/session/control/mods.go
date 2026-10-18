package control

import (
	"errors"
	"fmt"

	"reasonix/internal/base/secrets"
	"reasonix/internal/contract/config"
	"reasonix/internal/ext/modhost"
)

// ModState is where a Claude Code mod's hooks module stands in this session.
type ModState string

const (
	// ModInactive: installed, not running. Code says why (switch off, runtime missing, unsupported runtime).
	ModInactive   ModState = "inactive"
	ModStarting   ModState = "starting"
	ModRunning    ModState = "running"
	ModRestarting ModState = "restarting"
	// ModDisabled: stopped by the host after repeated crashes; Code and Detail say why.
	ModDisabled ModState = "disabled"
)

// The typed causes a mod reports. A frontend maps a code to its own words; the
// kernel never asks a frontend to read a sentence.
const (
	ModCodeSwitchOff        = "mod.switch_off"
	ModCodeRuntimeMissing   = "mod.runtime_missing"
	ModCodeRuntimeUnsupport = "mod.runtime_unsupported"
	ModCodeCrashed          = "mod.crashed"
	ModCodeHookTimeout      = "mod.hook_timeout"
	ModCodeHookThrew        = "mod.hook_threw"
	ModCodeUnsupported      = "mod.unsupported"
	ModCodeLoosens          = "mod.loosens_decision"
)

// ModRuntime is the JavaScript runtime a mod runs on.
type ModRuntime struct {
	// Kind is "electron" for Studio's own binary in Node mode, "node" for one found on PATH.
	Kind    string `json:"kind"`
	Path    string `json:"path"`
	Version string `json:"version"`
}

// ModStatus is one installed mod and what became of it.
type ModStatus struct {
	// Plugin is the installed package name, the id every other surface uses.
	Plugin string   `json:"plugin"`
	State  ModState `json:"state"`
	// Code is the typed cause when State is not running; Detail is the redacted text beside it.
	Code     string `json:"code,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Restarts int    `json:"restarts"`
	// Runtime is set once one was resolved.
	Runtime *ModRuntime `json:"runtime,omitempty"`
	// Events are the literal event names the module registered; Unserved are the
	// ones among them this host never raises (named, never silently ignored).
	Events   []string `json:"events,omitempty"`
	Unserved []string `json:"unserved,omitempty"`
}

// ModsSettings is the user file's [mods] table.
type ModsSettings struct {
	// Enabled runs the hooks module of installed Claude Code mods. Turning it on
	// is the install-time trust a code extension already has, so it is Elevated.
	Enabled bool `json:"enabled"`
	// HookBudgetMS is one hook's own running time in milliseconds, 0 for the default 10000.
	HookBudgetMS int    `json:"hook_budget_ms"`
	Path         string `json:"path"`
	// Applies says when a saved change reaches a running session.
	Applies string `json:"applies"`
}

// ModsPatch is a partial update: a nil field is left as it is.
type ModsPatch struct {
	Enabled      *bool
	HookBudgetMS *int
}

// ErrModsBudgetInvalid is a hook budget outside 0..55000.
var ErrModsBudgetInvalid = errors.New("a hook budget is 0 to 55000 milliseconds")

// ModsSettings reads the switch and the budget from the user file.
func (c *Controller) ModsSettings() ModsSettings {
	return modsSettingsFrom(config.UserMods())
}

func modsSettingsFrom(m config.ModsConfig) ModsSettings {
	return ModsSettings{Enabled: m.Enabled, HookBudgetMS: max(m.HookBudgetMS, 0), Path: config.UserConfigPath(), Applies: "next_session"}
}

// SaveModsSettings writes the patch to the user file; sessions opened afterwards
// run with it.
func (c *Controller) SaveModsSettings(patch ModsPatch) (ModsSettings, error) {
	if patch.HookBudgetMS != nil && (*patch.HookBudgetMS < 0 || *patch.HookBudgetMS > 55000) {
		return c.ModsSettings(), fmt.Errorf("%w: %d", ErrModsBudgetInvalid, *patch.HookBudgetMS)
	}
	got, err := config.UpdateUserMods(func(m *config.ModsConfig) error {
		if patch.Enabled != nil {
			m.Enabled = *patch.Enabled
		}
		if patch.HookBudgetMS != nil {
			m.HookBudgetMS = *patch.HookBudgetMS
		}
		return nil
	})
	if err != nil {
		return c.ModsSettings(), fmt.Errorf("%w: %w", ErrPeerSettingsUnwritable, err)
	}
	if patch.Enabled != nil && !*patch.Enabled {
		modhost.Default.Forget()
	}
	return modsSettingsFrom(got), nil
}

// Mods lists every installed mod and what became of it.
func (c *Controller) Mods() []ModStatus {
	snap := modhost.Default.Snapshot()
	out := make([]ModStatus, 0, len(snap))
	for _, s := range snap {
		st := ModStatus{Plugin: s.Plugin, State: ModState(s.State), Code: s.Code, Detail: secrets.RedactCredentials(s.Detail), Restarts: s.Restarts, Events: s.Events, Unserved: s.Unserved}
		if s.Runtime != nil {
			st.Runtime = &ModRuntime{Kind: s.Runtime.Kind, Path: s.Runtime.Path, Version: s.Runtime.Version}
		}
		out = append(out, st)
	}
	return out
}
