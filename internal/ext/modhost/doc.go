// Package modhost runs a Claude Code mod's hooks module as an extension
// sidecar. A mod is an installed plugin whose hooks/hooks.json names one ES
// module exporting register(on, options); the host script this package embeds
// loads it, speaks the Extension Protocol on its behalf and serves the subset of
// the mods API the host implements. Everything else about a mod's install,
// trust and supervision is the ordinary extension machinery.
package modhost
