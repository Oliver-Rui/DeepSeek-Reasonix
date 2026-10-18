package boot

import (
	"sync"

	"reasonix/internal/contract/config"
	"reasonix/internal/ext/extension/sidecar"
	"reasonix/internal/ext/modhost"
)

var modhostOnce sync.Once

// ensureModHost lets the sidecar loader see Claude Code mods and tells the mod
// registry when a mod's process dies. The user's switch is read at every load.
func ensureModHost() {
	modhostOnce.Do(func() {
		sidecar.SetPackageSource(modhost.Source(func() modhost.Settings {
			cfg := config.LoadForEdit(config.UserConfigPath())
			return modhost.Settings{Enabled: cfg.ModsEnabled(), HookBudgetMS: cfg.ModsHookBudgetMS()}
		}))
		sidecar.OnCrash(func(pluginID string, _ error) {
			if modhost.Default.Known(pluginID) {
				modhost.Default.Crashed(pluginID)
			}
		})
	})
}

func reconcileMods(mgr *sidecar.Manager) {
	var up []string
	if mgr != nil {
		for _, c := range mgr.Clients() {
			up = append(up, c.PluginID())
		}
	}
	modhost.Default.Reconcile(up)
}
