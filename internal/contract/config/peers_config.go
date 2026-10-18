package config

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
)

// PeersConfig governs messages between sessions of one user on one machine.
type PeersConfig struct {
	// Enabled publishes this session to its peers and reads its own spool. Off
	// by default; the user file only, so a cloned repo cannot open the door.
	Enabled bool `toml:"enabled"`
	// Dispatch gives the model a tool that hands a task to a session in another of
	// the user's projects. Needs Enabled; off by default; the user file only.
	Dispatch bool `toml:"dispatch"`
	// ReleaseProjects lists projects whose sessions take a message from the user's
	// other sessions without the approval card. Only the asking is skipped: what
	// the message starts runs under that session's own approvals. User file only.
	ReleaseProjects []string `toml:"release_projects"`
}

// PeersEnabled reports whether this session takes part in messages between
// sessions.
func (c *Config) PeersEnabled() bool { return c != nil && c.Peers.Enabled }

// PeersDispatch reports whether the model may dispatch a task to another project.
func (c *Config) PeersDispatch() bool { return c.PeersEnabled() && c.Peers.Dispatch }

// PeersReleasedProject reports whether root is a project the user lets take
// messages from their other sessions without a card.
func (c *Config) PeersReleasedProject(root string) bool {
	if c == nil || root == "" {
		return false
	}
	want := cleanProjectPath(root)
	return slices.ContainsFunc(c.Peers.ReleaseProjects, func(p string) bool { return cleanProjectPath(p) == want })
}

func cleanProjectPath(p string) string {
	p = filepath.Clean(p)
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	}
	return p
}

func renderServeAndPeers(b *strings.Builder, c *Config) {
	renderServeSection(b, c)
	renderPeersSection(b, c)
	renderModsSection(b, c)
}

// renderPeersSection writes [peers] only once something in it is set, so a user
// who never touched messages between sessions keeps a file without the table.
func renderPeersSection(b *strings.Builder, c *Config) {
	p := c.Peers
	if !p.Enabled && !p.Dispatch && len(p.ReleaseProjects) == 0 {
		return
	}
	b.WriteString("[peers]\n")
	fmt.Fprintf(b, "enabled = %v   # messages between your sessions on this machine; user file only\n", p.Enabled)
	if p.Dispatch {
		b.WriteString("dispatch = true   # the model may hand a task to a session in another of your projects; needs enabled\n")
	}
	if len(p.ReleaseProjects) > 0 {
		fmt.Fprintf(b, "release_projects = %s   # projects that take messages from your other sessions without a card\n", renderStringArray(p.ReleaseProjects))
	}
	b.WriteString("\n")
}
