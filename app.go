package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"

	"db_sync/config"
	"db_sync/migrator"

	"encoding/json"
	"net/http"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/mod/semver"
)

// Current version of the application
const AppVersion = "v0.0.11"

// UpdateInfo holds the result of a version check
type UpdateInfo struct {
	IsNewer     bool   `json:"isNewer"`
	CurrentVer  string `json:"currentVer"`
	LatestVer   string `json:"latestVer"`
	ReleaseNote string `json:"releaseNote"`
	ReleaseUrl  string `json:"releaseUrl"`
}

// App struct
type App struct {
	ctx            context.Context
	syncCancelFunc context.CancelFunc
	cancelMutex    sync.Mutex
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// GetDatabases returns the databases for a given server configuration
func (a *App) GetDatabases(driver, dsn string) ([]string, error) {
	return migrator.GetDatabases(driver, dsn)
}

// GetTables returns the tables for a given database configuration
func (a *App) GetTables(driver, dsn string) ([]string, error) {
	return migrator.GetTables(driver, dsn)
}

// BuildDSN helper function creates a database-specific connection string.
func BuildDSN(driver, baseDSN, dbName string) string {
	if dbName == "" {
		return baseDSN
	}
	if driver == "postgres" {
		if strings.Contains(baseDSN, "dbname=") {
			re := regexp.MustCompile(`dbname=[^\s]+`)
			return re.ReplaceAllString(baseDSN, "dbname="+dbName)
		}
		return baseDSN + " dbname=" + dbName
	}
	if driver == "mysql" {
		re := regexp.MustCompile(`\/[^?]*(\?|$)`)
		return re.ReplaceAllString(baseDSN, "/"+dbName+"$1")
	}
	return baseDSN
}

// SyncDatabase runs the database migration using config.json directly
func (a *App) SyncDatabase(selectedTables []string) string {
	log.Println("[SyncDatabase] Started...")
	cfg, err := config.LoadConfig("config.json")
	if err != nil {
		return fmt.Sprintf("Error loading config: %v", err)
	}

	if cfg.Source.Database == "" || cfg.Target.Database == "" {
		return "Error: Source or Target database is not selected in config. Please save settings first."
	}

	sourceDSNContext := BuildDSN(cfg.Source.Driver, cfg.Source.DSN, cfg.Source.Database)
	targetDSNContext := BuildDSN(cfg.Target.Driver, cfg.Target.DSN, cfg.Target.Database)

	cfgContext := &config.Config{
		Source: config.DatabaseConfig{Driver: cfg.Source.Driver, DSN: sourceDSNContext, Database: cfg.Source.Database},
		Target: config.DatabaseConfig{Driver: cfg.Target.Driver, DSN: targetDSNContext, Database: cfg.Target.Database},
	}
	m := migrator.New(cfgContext)

	// Context for cancellation check
	ctx, cancel := context.WithCancel(a.ctx)
	
	a.cancelMutex.Lock()
	a.syncCancelFunc = cancel
	a.cancelMutex.Unlock()
	
	defer func() {
		a.cancelMutex.Lock()
		a.syncCancelFunc = nil
		a.cancelMutex.Unlock()
		cancel()
		log.Println("[SyncDatabase] Cleaned up context.")
	}()

	log.Println("[SyncDatabase] Passing context to Migrator Run...")
	if err := m.Run(ctx, selectedTables); err != nil {
		if errors.Is(err, context.Canceled) {
			log.Println("[SyncDatabase] Returning stopped by user message.")
			return "Database migration stopped by user."
		}
		log.Printf("[SyncDatabase] Migration failed with err: %v\n", err)
		return fmt.Sprintf("Error: %v", err)
	}

	log.Println("[SyncDatabase] Finished successfully.")
	return "Database migration completed successfully!"
}

// StopSync requests the active migration loop to cancel
func (a *App) StopSync() {
	log.Println("[StopSync] Invoked!")
	a.cancelMutex.Lock()
	defer a.cancelMutex.Unlock()
	if a.syncCancelFunc != nil {
		log.Println("[StopSync] Canceling context...")
		a.syncCancelFunc()
	} else {
		log.Println("[StopSync] syncCancelFunc is nil, nothing to cancel.")
	}
}

// LoadSettings attempts to load settings from config.json.
func (a *App) LoadSettings() *config.Config {
	cfg, err := config.LoadConfig("config.json")
	if err != nil {
		// Return empty config if none exists
		return &config.Config{}
	}
	return cfg
}

// SaveSettings attempts to save current DSN and drivers to config.json.
func (a *App) SaveSettings(sourceDriver, sourceDSN, sourceDatabase, targetDriver, targetDSN, targetDatabase string) string {
	cfg := &config.Config{
		Source: config.DatabaseConfig{Driver: sourceDriver, DSN: sourceDSN, Database: sourceDatabase},
		Target: config.DatabaseConfig{Driver: targetDriver, DSN: targetDSN, Database: targetDatabase},
	}
	if err := config.SaveConfig("config.json", cfg); err != nil {
		log.Printf("Error saving config: %v", err)
		return fmt.Sprintf("Error saving settings: %v", err)
	}
	return "Settings saved successfully!"
}

// CheckVersion hits the Github API to check for updates
func (a *App) CheckVersion() *UpdateInfo {
	info := &UpdateInfo{
		CurrentVer: AppVersion,
		IsNewer:    false,
	}

	url := "https://api.github.com/repos/yichozy/dboplia/releases/latest"
	client := &http.Client{
		Timeout: 3 * time.Second,
	}
	resp, err := client.Get(url)
	if err != nil {
		log.Printf("Error checking for updates: %v", err)
		return info
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("GitHub API returned status: %d", resp.StatusCode)
		return info
	}

	var release struct {
		TagName  string `json:"tag_name"`
		HTMLURL  string `json:"html_url"`
		Body     string `json:"body"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		log.Printf("Error decoding GitHub response: %v", err)
		return info
	}

	info.LatestVer = release.TagName
	info.ReleaseUrl = release.HTMLURL
	info.ReleaseNote = release.Body

	// strict semver comparison
	if release.TagName != "" && semver.Compare(release.TagName, AppVersion) > 0 {
		info.IsNewer = true
	}

	return info
}

// OpenDownloadUrl opens the release page in user's browser
func (a *App) OpenDownloadUrl(url string) {
	runtime.BrowserOpenURL(a.ctx, url)
}
