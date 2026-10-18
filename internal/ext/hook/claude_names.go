package hook

import "maps"

// ClaudeToolNames is the table that gives a Reasonix tool the name Claude Code
// knows it by, for a consumer that renders it outside this package.
func ClaudeToolNames() map[string]string {
	out := make(map[string]string, len(claudeToolNames))
	maps.Copy(out, claudeToolNames)
	return out
}

// ClaudeToolInputRenames is, per Reasonix tool, the argument keys Claude Code
// spells differently.
func ClaudeToolInputRenames() map[string]map[string]string {
	out := make(map[string]map[string]string, len(claudeToolInputKeyRenames))
	for tool, keys := range claudeToolInputKeyRenames {
		out[tool] = maps.Clone(keys)
	}
	return out
}
