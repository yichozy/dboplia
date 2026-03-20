# DBoplia

A cross-platform Database Synchronization GUI tool built with [Wails](https://wails.io/). DBoplia allows you to quickly and completely replace one database with another by seamlessly copying schemas and data across MySQL and PostgreSQL.

## Features

- **Intuitive GUI**: Built with React and styled with TailwindCSS for a premium, dark-mode experience.
- **Cross-Database Syncing**: Effortlessly move data between **MySQL** and **PostgreSQL** in any combination.
- **Selective Syncing**: Fetch available databases and selectively choose which tables you want to sync.
- **Real-Time Progress**: View synchronization progress live within the app interface.
- **Robust Persistence**: Server settings and credentials are automatically and securely saved into your OS user config directory.
- **In-App Updater**: Automatically checks for new releases directly from GitHub.

## Development

To run in live development mode, execute `wails dev` in the project directory. 

This will run a Vite development server that provides very fast hot-reloading for frontend changes. Wails handles binding the Go backend with the UI securely.

## Building

To build a redistributable, production mode package for your current platform, use:

```bash
wails build
```

This commands produces a single standalone `.app` bundle (on macOS) or executable (on Windows/Linux) containing the embedded React frontend and compiled Go backend.
