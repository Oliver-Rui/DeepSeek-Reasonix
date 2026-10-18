package control

import "strings"

// SessionGrant is what a dispatching session passes to the session it opens: the
// model it runs on, its role preset, its tool-approval posture and whether it is
// planning. The opened session takes these as they are, so it is never given
// more than the one that asked for it; sandbox, MCP and skill switches live in
// the user's file, which every session on the machine already shares.
type SessionGrant struct {
	Model    string
	Preset   string
	Approval string
	Plan     bool
}

// DispatchGrant reads the grant this session would pass on.
func (c *Controller) DispatchGrant() SessionGrant {
	return SessionGrant{Model: c.ModelRef(), Preset: c.AgentPreset(), Approval: c.ToolApprovalMode(), Plan: c.PlanMode()}
}

// AdoptSessionGrant sets this session's posture to the grant's; an empty field is
// left alone. The grant is the sender's own, so the session never outranks it.
// YOLO arrives as auto: it would also answer the ask rules the target project
// wrote for itself, which the user never chose to waive there.
func (c *Controller) AdoptSessionGrant(g SessionGrant) {
	if mode, ok := ParseToolApprovalMode(g.Approval); ok {
		if mode == ToolApprovalYolo {
			mode = ToolApprovalAuto
		}
		c.SetToolApprovalMode(mode)
	}
	if strings.TrimSpace(g.Preset) != "" {
		c.SetAgentPreset(g.Preset)
	}
	if g.Plan {
		c.SetPlanMode(true)
	}
}
