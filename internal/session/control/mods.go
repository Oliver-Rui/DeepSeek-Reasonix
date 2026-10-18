package control

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

// ModHookStats counts what the host has seen the mod's hooks do this session.
type ModHookStats struct {
	Calls    int `json:"calls"`
	Timeouts int `json:"timeouts"`
	Threw    int `json:"threw"`
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
	Events   []string     `json:"events,omitempty"`
	Unserved []string     `json:"unserved,omitempty"`
	Hooks    ModHookStats `json:"hooks"`
}
