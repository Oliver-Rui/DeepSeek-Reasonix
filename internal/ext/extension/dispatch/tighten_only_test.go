package dispatch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"reasonix/internal/ext/extension"
	"reasonix/internal/ext/extension/protocol"
)

func tightenOnlyDispatcher(plugin string, answer protocol.InterceptResult, warns *warnRecorder) *Dispatcher {
	point := extension.PointPermissionDecision
	fake := &fakeClient{interceptFn: func(protocol.InterceptEvent, json.RawMessage) (protocol.InterceptResult, error) { return answer, nil }}
	clients := func(id string) Client {
		if id == plugin {
			return fake
		}
		return nil
	}
	return New(map[extension.InterceptorPoint][]extension.Contribution{point: {interceptor(plugin, point, 0)}}, nil, clients, nil,
		Options{Warn: warns.warn, TightenOnly: map[string]bool{plugin: true}})
}

// A runtime marked tighten-only can make a decision stricter and nothing else.
// Its process can write any frame, so the host refuses the loosening ruling
// itself rather than trusting the code on the other side to hold back.
func TestATightenOnlyRuntimeCannotAllowOrRewriteAPermissionDecision(t *testing.T) {
	point := extension.PointPermissionDecision
	for name, answer := range map[string]protocol.InterceptResult{
		"allow":   {Decision: protocol.DecisionAllow},
		"replace": {Decision: protocol.DecisionReplace, Replacement: json.RawMessage(`{"name":"bash","arguments":"{}","hostDecision":"deny"}`)},
	} {
		t.Run(name, func(t *testing.T) {
			warns := &warnRecorder{}
			d := tightenOnlyDispatcher("mod-x", answer, warns)
			payload := &PermissionPayload{Name: "bash", Arguments: `{"cmd":"rm -rf x"}`, HostDecision: "deny"}
			result, err := d.Intercept(context.Background(), point, payload)
			if err != nil {
				t.Fatalf("Intercept: %v", err)
			}
			if result.Permission != nil || len(result.Applied) != 0 {
				t.Fatalf("a tighten-only %s took effect: permission=%v applied=%v", name, result.Permission, result.Applied)
			}
			if payload.HostDecision != "deny" {
				t.Fatalf("the host deny was rewritten to %q", payload.HostDecision)
			}
			if warns.count() != 1 || !warns.contains("mod-x") || !warns.contains("tighten") {
				t.Fatalf("want one warning naming mod-x and tighten-only, got %d", warns.count())
			}
		})
	}
}

func TestATightenOnlyRuntimeStillDeniesAndBlocks(t *testing.T) {
	point := extension.PointPermissionDecision
	deny := tightenOnlyDispatcher("mod-x", protocol.InterceptResult{Decision: protocol.DecisionDeny}, &warnRecorder{})
	result, err := deny.Intercept(context.Background(), point, &PermissionPayload{Name: "bash", HostDecision: "allow"})
	if err != nil || result.Permission == nil || *result.Permission {
		t.Fatalf("deny = %+v, %v; want a terminal deny", result, err)
	}
	block := tightenOnlyDispatcher("mod-x", protocol.InterceptResult{Decision: protocol.DecisionBlock, Reason: "no"}, &warnRecorder{})
	result, err = block.Intercept(context.Background(), point, &PermissionPayload{Name: "bash", HostDecision: "allow"})
	if err != nil || !result.Blocked {
		t.Fatalf("block = %+v, %v; want blocked", result, err)
	}
}

// The restriction is per plugin: another extension on the same chain keeps the
// full-trust rulings the protocol gives it.
func TestTheRestrictionDoesNotReachOtherExtensions(t *testing.T) {
	point := extension.PointPermissionDecision
	fake := &fakeClient{interceptFn: func(protocol.InterceptEvent, json.RawMessage) (protocol.InterceptResult, error) {
		return protocol.InterceptResult{Decision: protocol.DecisionAllow}, nil
	}}
	d := New(map[extension.InterceptorPoint][]extension.Contribution{point: {interceptor("other", point, 0)}}, nil,
		func(string) Client { return fake }, nil, Options{TightenOnly: map[string]bool{"mod-x": true}})
	result, err := d.Intercept(context.Background(), point, &PermissionPayload{Name: "bash", HostDecision: "deny"})
	if err != nil || result.Permission == nil || !*result.Permission {
		t.Fatalf("result = %+v, %v; want the other extension's allow to stand", result, err)
	}
}

// A required tighten-only runtime that tries to loosen fails the operation like
// any required extension that breaks the contract, and the cause is typed.
func TestARequiredTightenOnlyRuntimeThatLoosensFailsTheOperationWithATypedCause(t *testing.T) {
	point := extension.PointPermissionDecision
	fake := &fakeClient{interceptFn: func(protocol.InterceptEvent, json.RawMessage) (protocol.InterceptResult, error) {
		return protocol.InterceptResult{Decision: protocol.DecisionAllow}, nil
	}}
	d := New(map[extension.InterceptorPoint][]extension.Contribution{point: {interceptor("mod-x", point, 0)}}, nil,
		func(string) Client { return fake }, map[string]bool{"mod-x": true}, Options{TightenOnly: map[string]bool{"mod-x": true}})
	_, err := d.Intercept(context.Background(), point, &PermissionPayload{Name: "bash", HostDecision: "deny"})
	var violation *ViolationError
	if !errors.As(err, &violation) || !errors.Is(err, ErrLoosensDecision) {
		t.Fatalf("err = %v, want a ViolationError wrapping ErrLoosensDecision", err)
	}
}

func TestAnAskFromATightenOnlyRuntimeIsRecordedAndNotMistakenForAnAllow(t *testing.T) {
	point := extension.PointPermissionDecision
	d := tightenOnlyDispatcher("mod-x", protocol.InterceptResult{Decision: protocol.DecisionAsk}, &warnRecorder{})
	result, err := d.Intercept(context.Background(), point, &PermissionPayload{Name: "bash", HostDecision: "allow"})
	if err != nil || !result.Ask || result.Permission != nil {
		t.Fatalf("result = %+v, %v; want Ask set and no allow/deny", result, err)
	}
}

// ask is the tighten-only runtimes' own ruling; another runtime, or any other
// point, answering it breaks the dispatch rules.
func TestAnAskFromAnyoneElseOrAnywhereElseIsAViolation(t *testing.T) {
	ask := &fakeClient{interceptFn: func(protocol.InterceptEvent, json.RawMessage) (protocol.InterceptResult, error) {
		return protocol.InterceptResult{Decision: protocol.DecisionAsk}, nil
	}}
	for name, tc := range map[string]struct {
		point extension.InterceptorPoint
		tight map[string]bool
		pay   any
	}{
		"not tighten-only": {extension.PointPermissionDecision, nil, &PermissionPayload{Name: "bash", HostDecision: "allow"}},
		"other point":      {extension.PointToolBefore, map[string]bool{"mod-x": true}, &ToolBeforePayload{Name: "bash", Arguments: "{}"}},
	} {
		t.Run(name, func(t *testing.T) {
			warns := &warnRecorder{}
			d := New(map[extension.InterceptorPoint][]extension.Contribution{tc.point: {interceptor("mod-x", tc.point, 0)}}, nil,
				func(string) Client { return ask }, nil, Options{Warn: warns.warn, TightenOnly: tc.tight})
			result, err := d.Intercept(context.Background(), tc.point, tc.pay)
			if err != nil || result.Ask || warns.count() != 1 {
				t.Fatalf("result = %+v, %v, warnings %d; want the ask refused with one warning", result, err, warns.count())
			}
		})
	}
}
