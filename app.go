package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"

	"db_sync/config"
	"db_sync/migrator"
)

// App struct
type App struct {
	ctx            context.Context
	syncCancelFunc context.CancelFunc
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
	a.syncCancelFunc = cancel
	defer func() {
		a.syncCancelFunc = nil
		cancel()
	}()

	if err := m.Run(ctx, selectedTables); err != nil {
		if errors.Is(err, context.Canceled) {
			return "Database migration stopped by user."
		}
		log.Printf("Migration failed: %v", err)
		return fmt.Sprintf("Error: %v", err)
	}

	return "Database migration completed successfully!"
}

// StopSync requests the active migration loop to cancel
func (a *App) StopSync() {
	if a.syncCancelFunc != nil {
		a.syncCancelFunc()
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
