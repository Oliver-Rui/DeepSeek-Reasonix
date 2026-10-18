package modpreview

import (
	"crypto/sha256"
	"encoding/hex"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

const (
	// MaxSourceBytes bounds what the preview will parse. A larger module is
	// reported as not previewed, never as clean.
	MaxSourceBytes = 1 << 20
	parseBudget    = 3 * time.Second
)

// FindingHookUnresolved marks a hook that is not a function the preview can
// follow (a call result, a property): what it does is unlisted.
const FindingHookUnresolved = "hook_unresolved"

// Analyze reads a hooks module and lists what it registers and calls. served
// names the events this host raises; any other literal event is reported in
// Unserved. The module is parsed, never run, and the result is an aid: it
// carries Listed=false and a Reason for a module it could not read.
func Analyze(plugin, module string, src []byte, served map[string]bool) Preview {
	sum := sha256.Sum256(src)
	out := Preview{Plugin: plugin, Module: module, SHA256: hex.EncodeToString(sum[:]),
		Events: []Event{}, API: []Call{}, Imports: []Import{}, Findings: []Finding{}, Unserved: []string{}}
	switch strings.ToLower(path.Ext(module)) {
	case ".js", ".mjs", ".cjs":
	case ".ts", ".mts", ".cts":
		out.Reason = ReasonTypeScript
		return out
	default:
		out.Reason = ReasonUnsupported
		return out
	}
	if len(src) > MaxSourceBytes {
		out.Reason = ReasonTooLarge
		return out
	}
	type result struct {
		ast *js.AST
		err error
	}
	done := make(chan result, 1)
	go func() {
		ast, err := js.Parse(parse.NewInputBytes(src), js.Options{})
		done <- result{ast, err}
	}()
	var parsed result
	select {
	case parsed = <-done:
	case <-time.After(parseBudget):
		out.Reason = ReasonTimeout
		return out
	}
	if parsed.err != nil || parsed.ast == nil {
		out.Reason = ReasonUnparseable
		return out
	}
	a := &analysis{out: &out, decls: map[string]js.INode{}, hooks: map[js.INode]bool{}}
	a.run(parsed.ast)
	out.Listed = true
	a.finish(served)
	return out
}

type analysis struct {
	out   *Preview
	decls map[string]js.INode
	hooks map[js.INode]bool
}

func (a *analysis) finding(kind string) {
	if !slices.ContainsFunc(a.out.Findings, func(f Finding) bool { return f.Kind == kind }) {
		a.out.Findings = append(a.out.Findings, Finding{Kind: kind})
	}
}

func (a *analysis) run(ast *js.AST) {
	for _, stmt := range ast.BlockStmt.List {
		a.collectDecl(stmt)
	}
	js.Walk(&moduleScan{a: a}, ast)
	register := a.findRegister(ast)
	if register == nil {
		a.finding(FindingNoRegister)
		return
	}
	a.analyzeRegister(register)
}

// collectDecl records top-level functions and function-valued variables by name,
// including those inside an export, so `export { r as register }` and a named
// handler passed to on() can be resolved.
func (a *analysis) collectDecl(stmt js.IStmt) {
	if ex, ok := stmt.(*js.ExportStmt); ok {
		if d, ok := ex.Decl.(js.IStmt); ok {
			a.collectDecl(d)
		}
		return
	}
	switch s := stmt.(type) {
	case *js.FuncDecl:
		if s.Name != nil {
			a.decls[string(s.Name.Data)] = s
		}
	case *js.VarDecl:
		for _, el := range s.List {
			if v, ok := el.Binding.(*js.Var); ok && el.Default != nil {
				a.decls[string(v.Data)] = el.Default
			}
		}
	}
}

func (a *analysis) findRegister(ast *js.AST) js.INode {
	for _, stmt := range ast.BlockStmt.List {
		ex, ok := stmt.(*js.ExportStmt)
		if !ok {
			continue
		}
		switch d := ex.Decl.(type) {
		case *js.FuncDecl:
			if ex.Default || (d.Name != nil && string(d.Name.Data) == "register") {
				return d
			}
		case *js.VarDecl:
			for _, el := range d.List {
				if v, ok := el.Binding.(*js.Var); ok && string(v.Data) == "register" && isFunc(el.Default) {
					return el.Default
				}
			}
		case *js.ArrowFunc:
			if ex.Default {
				return d
			}
		}
		for _, al := range ex.List {
			names := []string{string(al.Name), string(al.Binding)}
			if !slices.Contains(names, "register") {
				continue
			}
			for _, local := range names {
				if fn, ok := a.decls[local]; ok && local != "" && isFunc(fn) {
					return fn
				}
			}
		}
	}
	return nil
}

func isFunc(n js.INode) bool {
	switch n.(type) {
	case *js.FuncDecl, *js.ArrowFunc:
		return true
	}
	return false
}

func paramsAndBody(fn js.INode) (js.Params, js.BlockStmt) {
	switch f := fn.(type) {
	case *js.FuncDecl:
		return f.Params, f.Body
	case *js.ArrowFunc:
		return f.Params, f.Body
	}
	return js.Params{}, js.BlockStmt{}
}

// analyzeRegister follows `on` through the body of register: each call of it is an
// event registration, and any other use of it is a way the listing is lost.
func (a *analysis) analyzeRegister(fn js.INode) {
	params, body := paramsAndBody(fn)
	if len(params.List) == 0 {
		return
	}
	onVar, ok := params.List[0].Binding.(*js.Var)
	if !ok {
		a.finding(FindingOnEscapes)
		return
	}
	scan := &rootScan{roots: map[*js.Var]bool{onVar: true}, a: a, onCall: a.onCall}
	js.Walk(scan, &body)
	if scan.escapes() {
		a.finding(FindingOnEscapes)
	}
}

func (a *analysis) onCall(c *js.CallExpr) {
	args := c.Args.List
	if len(args) == 0 {
		return
	}
	if name, literal := stringValue(args[0].Value); literal {
		a.out.Events = append(a.out.Events, Event{Name: name})
	} else {
		a.out.Events = append(a.out.Events, Event{Dynamic: true})
	}
	if len(args) < 2 {
		return
	}
	switch h := args[len(args)-1].Value.(type) {
	case *js.FuncDecl:
		a.analyzeHook(h)
	case *js.ArrowFunc:
		a.analyzeHook(h)
	case *js.Var:
		if fn, ok := a.decls[string(h.Data)]; ok && isFunc(fn) {
			a.analyzeHook(fn)
			return
		}
		a.finding(FindingHookUnresolved)
	default:
		a.finding(FindingHookUnresolved)
	}
}

// analyzeHook lists the mods API calls of one hook, following `$` through the
// hook's first parameter.
func (a *analysis) analyzeHook(fn js.INode) {
	if a.hooks[fn] {
		return
	}
	a.hooks[fn] = true
	params, body := paramsAndBody(fn)
	if len(params.List) == 0 {
		return
	}
	switch b := params.List[0].Binding.(type) {
	case *js.Var:
		scan := &rootScan{roots: map[*js.Var]bool{b: true}, a: a, apiRoot: true}
		js.Walk(scan, &body)
		if scan.escapes() {
			a.finding(FindingAPIEscapes)
		}
	case *js.BindingObject:
		a.finding(FindingDestructuredAPI)
		a.destructured(b)
	default:
		a.finding(FindingAPIEscapes)
	}
}

func (a *analysis) destructured(b *js.BindingObject) {
	for _, item := range b.List {
		if item.Key != nil {
			if name := string(item.Key.Literal.Data); name != "" {
				a.addCall(Call{Namespace: name})
			}
		}
	}
}

func (a *analysis) addCall(c Call) {
	if !slices.Contains(a.out.API, c) {
		a.out.API = append(a.out.API, c)
	}
}

func (a *analysis) finish(served map[string]bool) {
	slices.SortFunc(a.out.Events, func(x, y Event) int {
		if x.Dynamic != y.Dynamic {
			if x.Dynamic {
				return 1
			}
			return -1
		}
		return strings.Compare(x.Name, y.Name)
	})
	a.out.Events = slices.CompactFunc(a.out.Events, func(x, y Event) bool { return x == y && !x.Dynamic })
	slices.SortFunc(a.out.API, func(x, y Call) int {
		return strings.Compare(x.Namespace+"."+x.Method, y.Namespace+"."+y.Method)
	})
	slices.SortFunc(a.out.Imports, func(x, y Import) int { return strings.Compare(x.Kind+x.Spec, y.Kind+y.Spec) })
	a.out.Imports = slices.Compact(a.out.Imports)
	slices.SortFunc(a.out.Findings, func(x, y Finding) int { return strings.Compare(x.Kind, y.Kind) })
	if served == nil {
		return
	}
	for _, e := range a.out.Events {
		if !e.Dynamic && !served[e.Name] && !slices.Contains(a.out.Unserved, e.Name) {
			a.out.Unserved = append(a.out.Unserved, e.Name)
		}
	}
}

// stringValue reads a literal string: a quoted string or a template without
// substitutions. Anything else is not a literal.
func stringValue(e js.IExpr) (string, bool) {
	switch v := e.(type) {
	case js.LiteralExpr:
		return stringValue(&v)
	case *js.LiteralExpr:
		if v.TokenType != js.StringToken || len(v.Data) < 2 {
			return "", false
		}
		return unquote(v.Data), true
	case *js.TemplateExpr:
		if len(v.List) != 0 || v.Tag != nil || len(v.Tail) < 2 {
			return "", false
		}
		return string(v.Tail[1 : len(v.Tail)-1]), true
	case *js.GroupExpr:
		return stringValue(v.X)
	}
	return "", false
}

func unquote(data []byte) string {
	s := string(data)
	if s[0] == '\'' {
		inner := strings.ReplaceAll(s[1:len(s)-1], `\'`, `'`)
		inner = strings.ReplaceAll(inner, `"`, `\"`)
		s = `"` + inner + `"`
	}
	if u, err := strconv.Unquote(s); err == nil {
		return u
	}
	return string(data[1 : len(data)-1])
}
