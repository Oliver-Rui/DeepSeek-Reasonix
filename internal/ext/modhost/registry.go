package modhost

import (
	"sort"
	"sync"
)

// State is where a mod stands.
type State string

const (
	StateInactive   State = "inactive"
	StateStarting   State = "starting"
	StateRunning    State = "running"
	StateRestarting State = "restarting"
	StateDisabled   State = "disabled"
)

// The typed causes a mod reports.
const (
	CodeSwitchOff        = "mod.switch_off"
	CodeRuntimeMissing   = "mod.runtime_missing"
	CodeRuntimeUnsupport = "mod.runtime_unsupported"
	CodeBadModule        = "mod.bad_module"
	CodeUnsupportedType  = "mod.unsupported_module"
	CodeCrashed          = "mod.crashed"
	CodeStartFailed      = "mod.start_failed"
)

// MaxCrashes is how many times a mod's process may die in one run of the app
// before the host stops starting it and says so. A mod that crashes on load
// would otherwise be restarted at every idle reload for the life of the session.
const MaxCrashes = 3

// Status is one installed mod and what became of it.
type Status struct {
	Plugin   string
	State    State
	Code     string
	Detail   string
	Restarts int
	Runtime  *Runtime
	Events   []string
	Unserved []string
}

// Registry remembers the state of every mod this process has seen. Several
// controllers read it, so it is guarded.
type Registry struct {
	mu      sync.Mutex
	status  map[string]*Status
	crashes map[string]int
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{status: map[string]*Status{}, crashes: map[string]int{}}
}

// Default is the registry the running host uses.
var Default = NewRegistry()

// Set records a mod's state, keeping its crash count.
func (r *Registry) Set(s Status) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s.Restarts = r.crashes[s.Plugin]
	r.status[s.Plugin] = &s
}

// Crashed counts one death of a mod's process and reports whether the mod has
// now used up its crashes.
func (r *Registry) Crashed(plugin string) (exhausted bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.crashes[plugin]++
	st := r.status[plugin]
	if st == nil {
		st = &Status{Plugin: plugin}
		r.status[plugin] = st
	}
	st.Restarts = r.crashes[plugin]
	if r.crashes[plugin] >= MaxCrashes {
		st.State, st.Code, st.Detail = StateDisabled, CodeCrashed, "the mod's process stopped repeatedly, so the host stopped starting it"
		return true
	}
	st.State, st.Code = StateRestarting, CodeCrashed
	return false
}

// Disabled reports whether a mod has used up its crashes.
func (r *Registry) Disabled(plugin string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.crashes[plugin] >= MaxCrashes
}

// Forget clears a mod's crash count, for when the user turns the switch off and on.
func (r *Registry) Forget() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.crashes = map[string]int{}
}

// Snapshot lists every mod by name.
func (r *Registry) Snapshot() []Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Status, 0, len(r.status))
	for _, s := range r.status {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Plugin < out[j].Plugin })
	return out
}
