package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// AutoUpdate checks for the latest release, downloads the asset for the current OS,
// replaces the current app, and restarts it.
func (a *App) AutoUpdate() string {
	a.Log("[AutoUpdate] Checking for newest version...")
	
	// 1. Fetch latest release from GitHub
	url := "https://api.github.com/repos/yichozy/dboplia/releases/latest"
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Sprintf("Failed checking updates: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("GitHub API returned status %d", resp.StatusCode)
	}

	var release struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return fmt.Sprintf("Failed decoding GitHub response: %v", err)
	}

	// Determine expected asset name prefix for current OS
	var expectedAsset string
	switch runtime.GOOS {
	case "windows":
		expectedAsset = "DBoplia-windows.exe"
	case "darwin":
		expectedAsset = "DBoplia-macos.tar.gz"
	case "linux":
		expectedAsset = "DBoplia-linux.tar.gz"
	default:
		return fmt.Sprintf("Unsupported OS for auto update: %s", runtime.GOOS)
	}

	var downloadUrl string
	for _, asset := range release.Assets {
		if asset.Name == expectedAsset {
			downloadUrl = asset.BrowserDownloadURL
			break
		}
	}

	if downloadUrl == "" {
		return fmt.Sprintf("Could not find release asset %s for tag %s", expectedAsset, release.TagName)
	}

	a.Logf("[AutoUpdate] Found matching asset. Downloading from %s", downloadUrl)

	// 2. Download the file
	tempDir := os.TempDir()
	downloadPath := filepath.Join(tempDir, expectedAsset)

	dlResp, err := http.Get(downloadUrl)
	if err != nil {
		return fmt.Sprintf("Failed downloading update: %v", err)
	}
	defer dlResp.Body.Close()

	out, err := os.Create(downloadPath)
	if err != nil {
		return fmt.Sprintf("Failed creating temporary update file: %v", err)
	}
	_, err = io.Copy(out, dlResp.Body)
	out.Close()
	if err != nil {
		return fmt.Sprintf("Failed writing update file: %v", err)
	}

	a.Log("[AutoUpdate] Download complete. Attempting to replace running executable...")

	// 3. Perform OS-specific replacement
	currentExe, err := os.Executable()
	if err != nil {
		return fmt.Sprintf("Could not determine current executable path: %v", err)
	}

	switch runtime.GOOS {
	case "windows":
		// Windows locks running exes, but allows renaming them.
		backupExe := currentExe + ".old"
		os.Remove(backupExe) // Remove old backup if it exists
		if err := os.Rename(currentExe, backupExe); err != nil {
			return fmt.Sprintf("Failed renaming current executable: %v", err)
		}
		if err := os.Rename(downloadPath, currentExe); err != nil {
			// Try to recover
			os.Rename(backupExe, currentExe)
			return fmt.Sprintf("Failed replacing executable: %v", err)
		}

		// Relaunch and exit
		cmd := exec.Command(currentExe)
		cmd.Start()
		os.Exit(0)

	case "darwin":
		// currentExe is usually /Applications/DBoplia.app/Contents/MacOS/DBoplia
		// We need to replace the entire .app bundle
		if !strings.Contains(currentExe, ".app/Contents/MacOS/") {
			return "App is not running from a standard macOS .app bundle. Cannot auto-update."
		}

		appBundlePath := currentExe[:strings.Index(currentExe, ".app/")+4] // e.g. /Applications/DBoplia.app
		
		// Extract tar.gz
		extractedAppPath := filepath.Join(tempDir, "DBoplia.app")
		os.RemoveAll(extractedAppPath)
		if err := extractTarGz(downloadPath, tempDir); err != nil {
			return fmt.Sprintf("Failed extracting macOS update: %v", err)
		}

		backupApp := appBundlePath + ".old"
		os.RemoveAll(backupApp)
		
		if err := os.Rename(appBundlePath, backupApp); err != nil {
			return fmt.Sprintf("Failed renaming current app bundle: %v", err)
		}
		if err := os.Rename(extractedAppPath, appBundlePath); err != nil {
			os.Rename(backupApp, appBundlePath)
			return fmt.Sprintf("Failed moving new app bundle into place: %v", err)
		}

		// MacOS open command will correctly launch the new bundle
		cmd := exec.Command("open", appBundlePath)
		cmd.Start()
		os.Exit(0)

	case "linux":
		// Extract local tar.gz
		extractFolder := filepath.Join(tempDir, "dboplia_linux_update")
		os.RemoveAll(extractFolder)
		os.MkdirAll(extractFolder, 0755)

		if err := extractTarGz(downloadPath, extractFolder); err != nil {
			return fmt.Sprintf("Failed extracting Linux update: %v", err)
		}

		// Find the extracted DBoplia binary
		newExe := filepath.Join(extractFolder, "DBoplia")
		
		backupExe := currentExe + ".old"
		os.Remove(backupExe)
		
		if err := os.Rename(currentExe, backupExe); err != nil {
			return fmt.Sprintf("Failed renaming current executable: %v", err)
		}
		if err := os.Rename(newExe, currentExe); err != nil {
			os.Rename(backupExe, currentExe)
			return fmt.Sprintf("Failed replacing executable: %v", err)
		}

		cmd := exec.Command(currentExe)
		cmd.Start()
		os.Exit(0)
	}

	return "Auto update attempted."
}

func extractTarGz(gzipStream string, target string) error {
	f, err := os.Open(gzipStream)
	if err != nil {
		return err
	}
	defer f.Close()

	uncompressedStream, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer uncompressedStream.Close()

	tarReader := tar.NewReader(uncompressedStream)

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		// Ensure no path traversal
		targetPath := filepath.Join(target, header.Name)
		if !strings.HasPrefix(targetPath, filepath.Clean(target)+string(os.PathSeparator)) && targetPath != filepath.Clean(target) {
			continue // Skip malicious inputs
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetPath, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				return err
			}
			outFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_RDWR, os.FileMode(header.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return err
			}
			outFile.Close()
		}
	}
	return nil
}
