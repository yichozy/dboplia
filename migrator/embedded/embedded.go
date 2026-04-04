package embedded

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

//go:embed bin/*
var binFS embed.FS

// ExtractTools writes the embedded binaries for the current OS/Arch to a temporary directory.
// Returns the paths to the pg_dump and psql executables, or falls back to system ones if embedding fails.
func ExtractTools() (pgDumpPath, psqlPath string, err error) {
	osName := runtime.GOOS
	archName := runtime.GOARCH

	pgDumpName := fmt.Sprintf("pg_dump_%s_%s", osName, archName)
	psqlName := fmt.Sprintf("psql_%s_%s", osName, archName)

	if osName == "windows" {
		pgDumpName += ".exe"
		psqlName += ".exe"
	}

	tempDir := filepath.Join(os.TempDir(), "dboplia_tools")
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return "pg_dump", "psql", fmt.Errorf("failed creating temp dir: %w", err)
	}

	pgDumpDest := filepath.Join(tempDir, "pg_dump")
	psqlDest := filepath.Join(tempDir, "psql")
	if osName == "windows" {
		pgDumpDest += ".exe"
		psqlDest += ".exe"
	}

	// Try extracting pg_dump
	if pgBytes, err := fs.ReadFile(binFS, "bin/"+pgDumpName); err == nil && len(pgBytes) > 0 {
		_ = os.WriteFile(pgDumpDest, pgBytes, 0755)
		pgDumpPath = pgDumpDest
	} else {
		pgDumpPath = "pg_dump" // fallback to system path
	}

	// Try extracting psql
	if psqlBytes, err := fs.ReadFile(binFS, "bin/"+psqlName); err == nil && len(psqlBytes) > 0 {
		_ = os.WriteFile(psqlDest, psqlBytes, 0755)
		psqlPath = psqlDest
	} else {
		psqlPath = "psql" // fallback to system path
	}

	return pgDumpPath, psqlPath, nil
}
