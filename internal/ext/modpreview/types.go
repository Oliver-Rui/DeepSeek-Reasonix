// Package modpreview describes a Claude Code mod's hooks module from its syntax
// tree, for the install preview. It reads; it never runs the module. What it
// lists is an aid and not a guarantee: a module that imports other code, or
// builds names at run time, does things the listing cannot show, and the
// listing says so.
package modpreview

// Event is one event name found in the module's source.
type Event struct {
	Name string `json:"name"`
	// Dynamic is true when the name is not a literal: it cannot be listed.
	Dynamic bool `json:"dynamic,omitempty"`
}

// Call is one `$.<namespace>.<method>` use found in the source.
type Call struct {
	Namespace string `json:"namespace"`
	Method    string `json:"method,omitempty"`
	Dynamic   bool   `json:"dynamic,omitempty"`
}

// Import is code the module pulls in that the preview cannot see.
type Import struct {
	Spec string `json:"spec"`
	// Kind is "static" (import), "require" or "dynamic" (import()).
	Kind string `json:"kind"`
}

// Finding is a construct that defeats listing: eval, new Function, a computed member of the API.
type Finding struct {
	Kind string `json:"kind"`
}

// The kinds a Finding takes.
const (
	FindingEval            = "eval"
	FindingFunctionCtor    = "function_ctor"
	FindingComputedMember  = "computed_member"
	FindingAPIEscapes      = "api_escapes"
	FindingOnEscapes       = "on_escapes"
	FindingDestructuredAPI = "destructured_api"
	FindingNoRegister      = "no_register"
)

// The reasons a module is not listed at all. A module that could not be read is
// not a module that is safe: the frontend says "not previewed", never "clean".
const (
	ReasonTypeScript  = "typescript"
	ReasonTooLarge    = "too_large"
	ReasonUnparseable = "unparseable"
	ReasonTimeout     = "timeout"
	ReasonUnsupported = "unsupported_module"
)

// Preview is what the install preview shows about a mod's hooks module. It
// is an aid read from the syntax tree, not a guarantee of what the module does.
type Preview struct {
	Plugin string `json:"plugin"`
	// Module is the path inside the package; SHA256 pins the exact bytes previewed.
	Module string `json:"module"`
	SHA256 string `json:"sha256"`
	// Listed is false when the module could not be read; Reason says why and the
	// lists below are empty.
	Listed  bool     `json:"listed"`
	Reason  string   `json:"reason,omitempty"`
	Events  []Event  `json:"events"`
	API     []Call   `json:"api"`
	Imports []Import `json:"imports"`
	// Findings are the constructs that make parts of the module unlistable.
	Findings []Finding `json:"findings"`
	// Unserved are literal events this host never raises, named so the author is not surprised.
	Unserved []string `json:"unserved"`
}
