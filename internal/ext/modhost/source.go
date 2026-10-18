package modhost

import (
	"context"
	"path/filepath"
	"sync/atomic"

	"reasonix/internal/ext/extension/sidecar"
	"reasonix/internal/ext/pluginpkg"
)

var embedder atomic.Pointer[string]

// SetEmbedder names the application binary this host runs inside; Studio's own
// Electron runs mods as Node, so nothing extra is installed.
func SetEmbedder(path string) {
	if path == "" {
		embedder.Store(nil)
		return
	}
	embedder.Store(&path)
}

func embedderPath() string {
	if p := embedder.Load(); p != nil {
		return *p
	}
	return ""
}

// Source is the sidecar package source for mods. settings is read at every load,
// so the switch takes effect at the next build without a restart.
func Source(settings func() Settings) sidecar.PackageSource {
	return func(home, workspace string, installed []pluginpkg.InstalledPackage) ([]pluginpkg.InstalledPackage, []string) {
		d := Deps{
			Settings:  settings(),
			Resolver:  Resolver{Electron: embedderPath(), Workspace: workspace},
			StateRoot: filepath.Join(home, "mods"),
			Registry:  Default,
		}
		return Packages(context.Background(), d, installed)
	}
}

// Reconcile settles the state of every starting mod after a runtime generation
// has started: running if its client is up, not started otherwise.
func (r *Registry) Reconcile(running []string) {
	up := map[string]bool{}
	for _, name := range running {
		up[name] = true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for name, st := range r.status {
		if st.State != StateStarting && st.State != StateRestarting && st.State != StateRunning {
			continue
		}
		if up[name] {
			st.State, st.Code, st.Detail = StateRunning, "", ""
			continue
		}
		if st.State == StateStarting {
			st.State, st.Code = StateInactive, CodeStartFailed
		}
	}
}

// Known reports whether name is a mod this registry has seen.
func (r *Registry) Known(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.status[name]
	return ok
}
