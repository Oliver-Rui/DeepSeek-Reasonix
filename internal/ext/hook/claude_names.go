package hook

// ClaudeToolNames is the table that gives a Reasonix tool the name Claude Code
// knows it by, for a consumer that renders it outside this package.
func ClaudeToolNames() map[string]string {
	out := make(map[string]string, len(claudeToolNames))
	for k, v := range claudeToolNames {
		out[k] = v
	}
	return out
}

// ClaudeToolInputRenames is, per Reasonix tool, the argument keys Claude Code
// spells differently.
func ClaudeToolInputRenames() map[string]map[string]string {
	out := make(map[string]map[string]string, len(claudeToolInputKeyRenames))
	for tool, keys := range claudeToolInputKeyRenames {
		cp := make(map[string]string, len(keys))
		for k, v := range keys {
			cp[k] = v
		}
		out[tool] = cp
	}
	return out
}
