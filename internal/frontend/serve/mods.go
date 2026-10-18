package serve

import (
	"encoding/json"
	"errors"
	"net/http"

	"reasonix/internal/session/control"
)

const codeModsBadBudget = "mods.invalid_budget"

func (s *Server) registerModRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /mods", s.mods)
	mux.HandleFunc("GET /mods/settings", s.modsSettings)
	mux.HandleFunc("POST /mods/settings", s.saveModsSettings)
}

func (s *Server) mods(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, struct {
		Mods []control.ModStatus `json:"mods"`
	}{Mods: s.ctl().Mods()})
}

func (s *Server) modsSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, s.ctl().ModsSettings())
}

// saveModsSettings rides the provider-edit grant like the peer settings: turning
// mods on lets code an installed package ships run on this machine, which a
// networked client must not decide for the machine's owner.
func (s *Server) saveModsSettings(w http.ResponseWriter, r *http.Request) {
	if !s.grants.at(r).providerEdit {
		refuse(w, http.StatusForbidden, "mods.editing_disabled", "mod settings are not enabled for this client", nil)
		return
	}
	var body struct {
		Enabled      *bool `json:"enabled"`
		HookBudgetMS *int  `json:"hook_budget_ms"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || (body.Enabled == nil && body.HookBudgetMS == nil) {
		badBody(w)
		return
	}
	got, err := s.ctl().SaveModsSettings(control.ModsPatch{Enabled: body.Enabled, HookBudgetMS: body.HookBudgetMS})
	switch {
	case errors.Is(err, control.ErrModsBudgetInvalid):
		refuse(w, http.StatusBadRequest, codeModsBadBudget, "a hook budget is 0 to 55000 milliseconds", nil)
	case errors.Is(err, control.ErrPeerSettingsUnwritable):
		saveFailed(w, http.StatusInternalServerError, codePeerSettings, err)
	case err != nil:
		writeErr(w, http.StatusInternalServerError, err)
	default:
		writeJSON(w, got)
	}
}
