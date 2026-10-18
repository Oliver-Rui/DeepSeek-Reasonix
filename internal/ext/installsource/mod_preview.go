package installsource

import (
	"reasonix/internal/ext/modhost"
	"reasonix/internal/ext/modpreview"
	"reasonix/internal/ext/pluginpkg"
)

// modPreview lists the mod's hooks module for the plan, or says why it could not.
func modPreview(pkg pluginpkg.Package) *modpreview.Preview {
	mods, _ := modhost.Discover([]pluginpkg.InstalledPackage{{Installed: pluginpkg.InstalledPlugin{Name: pkg.Manifest.Name}, Package: pkg}})
	if len(mods) != 1 {
		p := modpreview.Preview{Plugin: pkg.Manifest.Name, Reason: modpreview.ReasonUnsupported, Events: []modpreview.Event{}, API: []modpreview.Call{}, Imports: []modpreview.Import{}, Findings: []modpreview.Finding{}, Unserved: []string{}}
		return &p
	}
	p, err := modhost.Preview(mods[0])
	if err != nil {
		p = modpreview.Preview{Plugin: pkg.Manifest.Name, Module: mods[0].Rel, Reason: modpreview.ReasonUnparseable, Events: []modpreview.Event{}, API: []modpreview.Call{}, Imports: []modpreview.Import{}, Findings: []modpreview.Finding{}, Unserved: []string{}}
	}
	return &p
}
