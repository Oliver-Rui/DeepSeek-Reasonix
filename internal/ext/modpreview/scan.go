package modpreview

import (
	"github.com/tdewolff/parse/v2/js"
)

// moduleScan finds the constructs that pull in code the preview cannot see or
// build code at run time, wherever they sit in the module.
type moduleScan struct{ a *analysis }

func (m *moduleScan) Exit(js.INode) {}

func (m *moduleScan) Enter(n js.INode) js.IVisitor {
	switch v := n.(type) {
	case *js.ImportStmt:
		m.a.out.Imports = append(m.a.out.Imports, Import{Spec: specOf(v.Module), Kind: "static"})
	case *js.ExportStmt:
		if v.Module != nil {
			m.a.out.Imports = append(m.a.out.Imports, Import{Spec: specOf(v.Module), Kind: "static"})
		}
	case *js.CallExpr:
		m.call(v)
	case *js.NewExpr:
		if isNamed(v.X, "Function") {
			m.a.finding(FindingFunctionCtor)
		}
	}
	return m
}

func (m *moduleScan) call(c *js.CallExpr) {
	switch {
	case isNamed(c.X, "eval"):
		m.a.finding(FindingEval)
	case isNamed(c.X, "Function"):
		m.a.finding(FindingFunctionCtor)
	case isNamed(c.X, "require"):
		m.a.out.Imports = append(m.a.out.Imports, Import{Spec: firstString(c.Args), Kind: "require"})
	case isNamed(c.X, "import"):
		m.a.out.Imports = append(m.a.out.Imports, Import{Spec: firstString(c.Args), Kind: "dynamic"})
	}
}

// isNamed reports a name used directly or as a property of anything
// (globalThis.eval, window.Function).
func isNamed(e js.IExpr, name string) bool {
	switch v := e.(type) {
	case *js.Var:
		return string(v.Data) == name
	case *js.DotExpr:
		return isNamed(v.Y, name)
	case *js.LiteralExpr:
		return string(v.Data) == name
	case js.LiteralExpr:
		return string(v.Data) == name
	case *js.GroupExpr:
		return isNamed(v.X, name)
	}
	return false
}

func firstString(args js.Args) string {
	if len(args.List) > 0 {
		if s, ok := stringValue(args.List[0].Value); ok {
			return s
		}
	}
	return "(computed)"
}

func specOf(module []byte) string {
	if len(module) >= 2 {
		return unquote(module)
	}
	return "(computed)"
}
