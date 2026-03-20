package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type DatabaseConfig struct {
	Driver   string `json:"driver"`
	DSN      string `json:"dsn"`
	Database string `json:"database"`
}

type Config struct {
	Source DatabaseConfig `json:"source"`
	Target DatabaseConfig `json:"target"`
}

func GetConfigPath() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		configDir = "."
	}
	appConfigDir := filepath.Join(configDir, "dboplia")
	if err := os.MkdirAll(appConfigDir, 0755); err != nil {
		return "config.json"
	}
	return filepath.Join(appConfigDir, "config.json")
}

func LoadConfig() (*Config, error) {
	file, err := os.Open(GetConfigPath())
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var cfg Config
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func SaveConfig(cfg *Config) error {
	file, err := os.Create(GetConfigPath())
	if err != nil {
		return err
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(cfg); err != nil {
		return err
	}
	return nil
}
