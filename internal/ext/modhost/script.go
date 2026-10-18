package modhost

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed host/host.mjs
var hostScript []byte

// ScriptName is the content-addressed file name the embedded script is written
// under: a changed script is a different file, and a file whose bytes no longer
// match its name is never run.
func ScriptName() string {
	sum := sha256.Sum256(hostScript)
	return "modhost-" + hex.EncodeToString(sum[:8]) + ".mjs"
}

// WriteScript writes the host script under dir (0600, atomically) and returns its
// path. An existing file is kept only if its bytes are exactly the embedded ones.
func WriteScript(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, ScriptName())
	if got, err := os.ReadFile(path); err == nil && string(got) == string(hostScript) {
		return path, nil
	}
	tmp, err := os.CreateTemp(dir, ".modhost-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(hostScript); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", fmt.Errorf("install the mod host script: %w", err)
	}
	return path, nil
}
