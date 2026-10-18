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
	Line    int  `json:"line"`
}

// Call is one `$.<namespace>.<method>` use found in the source.
type Call struct {
	Namespace string `json:"namespace"`
	Method    string `json:"method,omitempty"`
	Dynamic   bool   `json:"dynamic,omitempty"`
	Line      int    `json:"line"`
}

// Import is code the module pulls in that the preview cannot see.
type Import struct {
	Spec string `json:"spec"`
	// Kind is "static" (import), "require" or "dynamic" (import()).
	Kind string `json:"kind"`
	Line int    `json:"line"`
}

// Finding is a construct that defeats listing: eval, new Function, a computed member of the API.
type Finding struct {
	Kind string `json:"kind"`
	Line int    `json:"line"`
}

// Preview is what the install preview shows about a mod's hooks module. It
// is an aid read from the syntax tree, not a guarantee of what the module does.
type Preview struct {
	Plugin string `json:"plugin"`
	// Module is the path inside the package; SHA256 pins the exact bytes previewed.
	Module  string   `json:"module"`
	SHA256  string   `json:"sha256"`
	Events  []Event  `json:"events"`
	API     []Call   `json:"api"`
	Imports []Import `json:"imports"`
	// Findings are the constructs that make parts of the module unlistable.
	Findings []Finding `json:"findings"`
	// Unserved are literal events this host never raises, named so the author is not surprised.
	Unserved []string `json:"unserved"`
}
