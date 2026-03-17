package config

import (
	"encoding/json"
	"os"
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

func LoadConfig(path string) (*Config, error) {
	file, err := os.Open(path)
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

func SaveConfig(path string, cfg *Config) error {
	file, err := os.Create(path)
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
