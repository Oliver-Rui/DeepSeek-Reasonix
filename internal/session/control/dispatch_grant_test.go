package control

import (
	"context"
	"testing"

	"reasonix/internal/safety/permission"
)

// A dispatched session carries the sender's approval posture, with one change:
// YOLO arrives as auto, because YOLO would answer the ask rules the target
// project wrote for itself. Every other posture arrives as it was.
func TestAYoloGrantArrivesAsAutoAndEveryOtherPostureAsItWas(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{ToolApprovalYolo, ToolApprovalAuto},
		{ToolApprovalAuto, ToolApprovalAuto},
		{ToolApprovalAsk, ToolApprovalAsk},
		{ToolApprovalDontAsk, ToolApprovalDontAsk},
		{ToolApprovalReadOnly, ToolApprovalReadOnly},
	} {
		c := New(Options{})
		c.AdoptSessionGrant(SessionGrant{Approval: tc.in})
		if got := c.ToolApprovalMode(); got != tc.want {
			t.Errorf("grant %q -> posture %q, want %q", tc.in, got, tc.want)
		}
	}
	c := New(Options{})
	c.AdoptSessionGrant(SessionGrant{Plan: true})
	if !c.PlanMode() {
		t.Error("planning was not carried over")
	}
}

// At the gate: under the posture a YOLO grant becomes, the target project's ask
// rule still stops the call and its deny rule still refuses; under YOLO the ask
// rule would have been answered. A headless gate has nobody to ask, so a call it
// asks about comes back refused.
func TestUnderTheAdoptedPostureTheTargetProjectsAskAndDenyRulesStillHold(t *testing.T) {
	ask, _ := permission.ParseRule("bash(git push:*)")
	deny, _ := permission.ParseRule("bash(rm:*)")
	policy := permission.Policy{Ask: []permission.Rule{ask}, Deny: []permission.Rule{deny}}

	c := New(Options{})
	c.AdoptSessionGrant(SessionGrant{Approval: ToolApprovalYolo})
	adopted := buildHeadlessGate(policy, c.ToolApprovalMode(), nil)
	yolo := buildHeadlessGate(policy, ToolApprovalYolo, nil)

	verdict := func(g *freshHumanHeadlessGate, command string) bool {
		v, err := permission.VerdictOf(context.Background(), g, "bash", bashCall(t, command), false)
		return err == nil && v.Allow
	}
	if verdict(adopted, "git push origin main") {
		t.Error("the project's ask rule was answered under the adopted posture")
	}
	if !verdict(yolo, "git push origin main") {
		t.Fatal("the control case moved: YOLO no longer answers an ask rule, so this test proves nothing")
	}
	if verdict(adopted, "rm -rf build") {
		t.Error("the project's deny rule was lifted")
	}
	if !verdict(adopted, "ls") {
		t.Error("a call no rule names was refused under auto")
	}
}
