package modhost

import "os"

func writeExecutable(path string) error { return os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755) }
func symlink(target, link string) error { return os.Symlink(target, link) }
