package main

import (
	"context"
	"embed"
	"io"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

var assets embed.FS

var icon []byte

func init() {
	if _, err := os.Stat("config.json"); os.IsNotExist(err) {
		src := "config.json.example"
		if _, err := os.Stat("config.json.exmaple"); err == nil {
			src = "config.json.exmaple" // Handling the typo in the example file name
		}
		if sourceFile, err := os.Open(src); err == nil {
			defer sourceFile.Close()
			if destFile, err := os.Create("config.json"); err == nil {
				defer destFile.Close()
				io.Copy(destFile, sourceFile)
			}
		}
	}
}

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "DBoplia",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup: func(ctx context.Context) {
			app.startup(ctx)
		},
		HideWindowOnClose: true,
		Bind: []interface{}{
			app,
		},
		Mac: &mac.Options{
			About: &mac.AboutInfo{
				Title:   "DBoplia",
				Message: "Database Sync Tool",
				Icon:    icon,
			},
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
