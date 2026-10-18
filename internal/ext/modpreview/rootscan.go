package modpreview

import (
	"slices"

	"github.com/tdewolff/parse/v2/js"
)

// rootScan follows one value (`on` in register, or `$` in a hook) through a
// function body. Roots are the parser's resolved variables, not spellings: an
// alias is followed, a shadowing parameter is not. A use that is not understood
// is an escape, and the listing says so.
type rootScan struct {
	a        *analysis
	roots    map[*js.Var]bool
	onCall   func(*js.CallExpr) // set when the root is `on`
	apiRoot  bool               // set when the root is `$`
	total    int
	handled  int
	consumed map[js.INode]bool
}

func (s *rootScan) escapes() bool { return s.total > s.handled }

func (s *rootScan) Exit(js.INode) {}

func (s *rootScan) Enter(n js.INode) js.IVisitor {
	switch v := n.(type) {
	case *js.Var:
		if s.roots[v] {
			s.total++
		}
	case *js.VarDecl:
		s.declaration(v)
	case *js.CallExpr:
		if s.onCall != nil {
			if callee, ok := v.X.(*js.Var); ok && s.roots[callee] {
				s.handled++
				s.onCall(v)
			}
		}
	case *js.DotExpr:
		s.member(v, v)
	case *js.IndexExpr:
		s.member(v, v)
	}
	return s
}

// declaration follows `const alias = <root>` and flags destructuring of the root.
func (s *rootScan) declaration(d *js.VarDecl) {
	for _, el := range d.List {
		src, ok := el.Default.(*js.Var)
		if !ok || !s.roots[src] {
			continue
		}
		switch b := el.Binding.(type) {
		case *js.Var:
			s.roots[b] = true
			s.handled += 2 // the right-hand side and the new name
		case *js.BindingObject:
			s.handled++
			if s.apiRoot {
				s.a.finding(FindingDestructuredAPI)
				s.a.destructured(b)
			} else {
				s.a.finding(FindingOnEscapes)
			}
		}
	}
}

type segment struct {
	name    string
	dynamic bool
}

// member reads a chain such as $.process.run or $['fs'].read from its outermost
// node, once.
func (s *rootScan) member(top js.IExpr, node js.INode) {
	if !s.apiRoot {
		return
	}
	if s.consumed == nil {
		s.consumed = map[js.INode]bool{}
	}
	if s.consumed[node] {
		return
	}
	root, segs, nodes := chainOf(top)
	if root == nil || !s.roots[root] {
		return
	}
	for _, n := range nodes {
		s.consumed[n] = true
	}
	s.handled++
	call := Call{}
	for i, seg := range segs {
		if seg.dynamic {
			s.a.finding(FindingComputedMember)
			call.Dynamic = true
			break
		}
		switch i {
		case 0:
			call.Namespace = seg.name
		case 1:
			call.Method = seg.name
		}
	}
	if call.Namespace != "" || call.Dynamic {
		s.a.addCall(call)
	}
}

// chainOf unwraps a member chain down to the variable it starts at.
func chainOf(e js.IExpr) (*js.Var, []segment, []js.INode) {
	var segs []segment
	var nodes []js.INode
	for {
		switch n := e.(type) {
		case *js.DotExpr:
			nodes = append(nodes, n)
			segs = append(segs, segment{name: nameOf(n.Y)})
			e = n.X
		case *js.IndexExpr:
			nodes = append(nodes, n)
			if name, ok := stringValue(n.Y); ok {
				segs = append(segs, segment{name: name})
			} else {
				segs = append(segs, segment{dynamic: true})
			}
			e = n.X
		case *js.GroupExpr:
			e = n.X
		case *js.Var:
			slices.Reverse(segs)
			return n, segs, nodes
		default:
			return nil, nil, nil
		}
	}
}

func nameOf(e js.IExpr) string {
	switch v := e.(type) {
	case *js.Var:
		return string(v.Data)
	case *js.LiteralExpr:
		return string(v.Data)
	case js.LiteralExpr:
		return string(v.Data)
	}
	return ""
}
