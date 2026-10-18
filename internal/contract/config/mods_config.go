package config

import (
	"fmt"
	"strings"
)

// ModsConfig governs Claude Code mods: plugins whose hooks module runs in this
// host. Running a module is the install-time trust a code extension already has,
// so the switch is the user's alone and a repository cannot turn it on.
type ModsConfig struct {
	// Enabled runs the hooks module of installed Claude Code mods. Off by default;
	// the user file only.
	Enabled bool `toml:"enabled"`
	// HookBudgetMS bounds one hook's own running time; 0 keeps Claude Code's 10 s.
	// User file only.
	HookBudgetMS int `toml:"hook_budget_ms"`
}

// ModsEnabled reports whether mods run.
func (c *Config) ModsEnabled() bool { return c != nil && c.Mods.Enabled }

// ModsHookBudgetMS is the user's per-hook time limit in milliseconds, 0 for the default.
func (c *Config) ModsHookBudgetMS() int {
	if c == nil {
		return 0
	}
	return max(c.Mods.HookBudgetMS, 0)
}

// narrowMods puts back the mods settings the project file touched.
func (h heldScope) narrowMods(c *Config) {
	if c.Mods.Enabled != h.mods.Enabled {
		c.ignoreProject("mods.enabled", fmt.Sprintf("%t", c.Mods.Enabled), ProjectUserOnly)
	}
	if c.Mods.HookBudgetMS != h.mods.HookBudgetMS {
		c.ignoreProject("mods.hook_budget_ms", fmt.Sprint(c.Mods.HookBudgetMS), ProjectUserOnly)
	}
	c.Mods = h.mods
}

func renderModsSection(b *strings.Builder, c *Config) {
	if !c.Mods.Enabled && c.Mods.HookBudgetMS == 0 {
		return
	}
	b.WriteString("[mods]\n")
	fmt.Fprintf(b, "enabled = %v   # run the hooks module of installed Claude Code mods; full trust, user file only\n", c.Mods.Enabled)
	if c.Mods.HookBudgetMS > 0 {
		fmt.Fprintf(b, "hook_budget_ms = %d   # one hook's own running time; 0 keeps 10000\n", c.Mods.HookBudgetMS)
	}
	b.WriteString("\n")
}
