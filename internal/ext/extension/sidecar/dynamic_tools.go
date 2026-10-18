package sidecar

import (
	"fmt"

	"reasonix/internal/ext/extension/protocol"
	"reasonix/internal/ext/pluginpkg"
)

// validateDynamicTools holds the tools a dynamic runtime described at the
// handshake to the checks a manifest tool gets. A runtime that is not dynamic
// may not describe any.
func (c *Client) validateDynamicTools(result protocol.InitializeResult) error {
	if len(result.ToolSpecs) == 0 {
		return nil
	}
	if !c.rt.DynamicTools {
		return &protocol.ProtocolError{Reason: protocol.ErrCapabilityNotDeclared, Message: fmt.Sprintf("extension %s described tools without the dynamicTools manifest flag", c.pluginID)}
	}
	seen := map[string]bool{}
	for _, spec := range result.ToolSpecs {
		tool := pluginpkg.RuntimeTool{Name: spec.Name, Description: spec.Description, InputSchema: spec.InputSchema, ReadOnly: spec.ReadOnly}
		if err := pluginpkg.ValidateRuntimeTool(tool); err != nil {
			return &protocol.ProtocolError{Reason: protocol.ErrCapabilityNotDeclared, Message: fmt.Sprintf("extension %s tool: %v", c.pluginID, err)}
		}
		if seen[spec.Name] {
			return &protocol.ProtocolError{Reason: protocol.ErrCapabilityNotDeclared, Message: fmt.Sprintf("extension %s described tool %q twice", c.pluginID, spec.Name)}
		}
		seen[spec.Name] = true
	}
	return nil
}
