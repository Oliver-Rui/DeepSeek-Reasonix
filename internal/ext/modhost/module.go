package modhost

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"reasonix/internal/ext/pluginpkg"
)

// HooksFile is where a mod's hooks.json lives inside its package.
const HooksFile = "hooks/hooks.json"

// Module is one installed mod: the package and the hooks module it names.
type Module struct {
	Plugin    string
	Root      string
	Installed pluginpkg.InstalledPlugin
	// Rel is the module path inside the package, slash-separated; Abs is it resolved.
	Rel string
	Abs string
}

// ErrBadModule is a package whose hooks.json names a module the host will not run.
var ErrBadModule = errors.New("the hooks module is not usable")

// Discover finds the mods among installed packages: those whose hooks.json
// declares a modules list. A package with a malformed declaration is returned in
// the second result with the reason, so it can be shown as not running.
func Discover(items []pluginpkg.InstalledPackage) (mods []Module, bad map[string]error) {
	bad = map[string]error{}
	for _, item := range items {
		root := item.Package.Root
		if root == "" {
			continue
		}
		rel, declared, err := moduleOf(root)
		if !declared {
			continue
		}
		name := item.Installed.Name
		if err != nil {
			bad[name] = err
			continue
		}
		abs, err := confine(root, rel)
		if err != nil {
			bad[name] = err
			continue
		}
		mods = append(mods, Module{Plugin: name, Root: root, Installed: item.Installed, Rel: rel, Abs: abs})
	}
	return mods, bad
}

// moduleOf reads the one module path hooks.json declares.
func moduleOf(root string) (rel string, declared bool, err error) {
	body, readErr := os.ReadFile(filepath.Join(root, filepath.FromSlash(HooksFile)))
	if readErr != nil {
		return "", false, nil
	}
	var doc struct {
		Modules json.RawMessage `json:"modules"`
	}
	if json.Unmarshal(body, &doc) != nil || len(doc.Modules) == 0 || string(doc.Modules) == "null" {
		return "", false, nil
	}
	var list []string
	if json.Unmarshal(doc.Modules, &list) != nil || len(list) != 1 || strings.TrimSpace(list[0]) == "" {
		return "", true, fmt.Errorf("%w: modules must be an array with exactly one path", ErrBadModule)
	}
	return filepath.ToSlash(filepath.Join(filepath.Dir(filepath.FromSlash(HooksFile)), filepath.FromSlash(list[0]))), true, nil
}

// confine resolves rel under root and refuses a path that leaves it, by name or
// through a link.
func confine(root, rel string) (string, error) {
	if filepath.IsAbs(rel) || strings.Contains(filepath.ToSlash(rel), "../") || strings.HasPrefix(filepath.ToSlash(rel), "..") {
		return "", fmt.Errorf("%w: %q is not inside the package", ErrBadModule, rel)
	}
	abs := filepath.Join(root, filepath.FromSlash(rel))
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrBadModule, err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("%w: %q does not exist", ErrBadModule, rel)
	}
	if r, err := filepath.Rel(realRoot, real); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: %q resolves outside the package", ErrBadModule, rel)
	}
	if st, err := os.Stat(real); err != nil || !st.Mode().IsRegular() {
		return "", fmt.Errorf("%w: %q is not a regular file", ErrBadModule, rel)
	}
	return real, nil
}
