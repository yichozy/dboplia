package migrator

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"db_sync/config"
)

// Migrator is responsible for migrating data from source to target.
type Migrator struct {
	Config *config.Config
}

// New creates a new Migrator instance.
func New(cfg *config.Config) *Migrator {
	return &Migrator{Config: cfg}
}

// GetDatabases fetches the list of databases from the server.
func GetDatabases(driver, dsn string) ([]string, error) {
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open db: %w", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to ping db: %w", err)
	}

	var query string
	var databases []string

	switch driver {
	case "mysql":
		query = "SHOW DATABASES"
	case "postgres":
		query = "SELECT datname FROM pg_database WHERE datistemplate = false"
	default:
		return nil, fmt.Errorf("unsupported driver: %s", driver)
	}

	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query databases: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var dbName string
		if err := rows.Scan(&dbName); err != nil {
			return nil, err
		}
		databases = append(databases, dbName)
	}

	return databases, nil
}

// GetTables fetches the list of tables from the database.
func GetTables(driver, dsn string) ([]string, error) {
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open db: %w", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to ping db: %w", err)
	}

	var query string
	var tables []string

	if driver == "mysql" {
		query = "SHOW TABLES"
	} else if driver == "postgres" {
		query = "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema'"
	} else {
		return nil, fmt.Errorf("unsupported driver: %s", driver)
	}

	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query tables: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}

	return tables, nil
}

// Run performs the database migration.
func (m *Migrator) Run(ctx context.Context, selectedTables []string) error {
	max := func(a, b int) int {
		if a > b {
			return a
		}
		return b
	}

	// Mask password in DSN for safe logging
	maskDSN := func(dsn string) string {
		// A rough mask, e.g. replacing 'password=xyz ' with 'password=*** '
		// or for mysql replacing ':xyz@' with ':***@'
		// It's just for display purposes. We'll show a shortened version to confirm DB.
		return fmt.Sprintf("<DSN ends with: %s>", dsn[max(0, len(dsn)-15):])
	}

	emitLog := func(format string, args ...interface{}) {
		msg := fmt.Sprintf(format, args...)
		fmt.Println(msg)
		runtime.EventsEmit(ctx, "appLog", msg)
	}

	emitLog("Connecting to Source DB: %s %s", m.Config.Source.Driver, maskDSN(m.Config.Source.DSN))
	sourceDB, err := sql.Open(m.Config.Source.Driver, m.Config.Source.DSN)
	if err != nil {
		return fmt.Errorf("failed to open source db: %w", err)
	}
	defer sourceDB.Close()

	if err := sourceDB.PingContext(ctx); err != nil {
		return fmt.Errorf("failed to ping source db: %w", err)
	}

	emitLog("Connecting to Target DB: %s %s", m.Config.Target.Driver, maskDSN(m.Config.Target.DSN))
	targetDB, err := sql.Open(m.Config.Target.Driver, m.Config.Target.DSN)
	if err != nil {
		return fmt.Errorf("failed to open target db: %w", err)
	}
	defer targetDB.Close()

	if err := targetDB.PingContext(ctx); err != nil {
		return fmt.Errorf("failed to ping target db: %w", err)
	}

	// Forcefully close DB connections on context cancellation 
	// to prevent driver blocking on 'rows.Close()' drain.
	go func() {
		<-ctx.Done()
		emitLog("  -> Context canceled! Forcibly closing database connections to abort immediately...")
		sourceDB.Close()
		targetDB.Close()
	}()

	// Run Migration Logic
	tables := selectedTables
	if len(tables) == 0 {
		var err error
		tables, err = GetTables(m.Config.Source.Driver, m.Config.Source.DSN)
		if err != nil {
			return fmt.Errorf("failed to fetch tables from source: %w", err)
		}
	}

	for i, table := range tables {
		emitLog("Migrating table %s...", table)

		runtime.EventsEmit(ctx, "syncProgress", map[string]interface{}{
			"current": i,
			"total":   len(tables),
			"table":   table,
			"status":  fmt.Sprintf("Migrating %s (%d/%d)", table, i+1, len(tables)),
		})

		if err := m.syncTable(ctx, sourceDB, targetDB, table, m.Config.Source.Driver, m.Config.Target.Driver, emitLog); err != nil {
			return fmt.Errorf("failed migrating table %s: %w", table, err)
		}
	}

	runtime.EventsEmit(ctx, "syncProgress", map[string]interface{}{
		"current": len(tables),
		"total":   len(tables),
		"table":   "Complete",
		"status":  "Database migration completed successfully!",
	})

	emitLog("Database migration completed successfully!")
	return nil
}

// syncTable handles the creation of a target table schema and the insert of data rows iteratively.
func (m *Migrator) syncTable(ctx context.Context, sourceDB, targetDB *sql.DB, tableName, sourceDriver, targetDriver string, emitLog func(string, ...interface{})) error {
	emitLog("  -> Extracting schema and rows from source...")
	// Extract raw rows
	rows, err := sourceDB.QueryContext(ctx, fmt.Sprintf("SELECT * FROM %s", tableName))
	if err != nil {
		return err
	}
	defer func() {
		emitLog("  -> Defer: Closing rows...")
		rows.Close()
		emitLog("  -> Defer: Rows closed.")
	}()

	cols, err := rows.Columns()
	if err != nil {
		return err
	}

	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return err
	}

	// Helper to safely quote identifiers for tables and columns
	quoteIdentifier := func(id, driver string) string {
		if driver == "mysql" {
			return fmt.Sprintf("`%s`", id)
		}
		return fmt.Sprintf("\"%s\"", id)
	}

	qTableName := quoteIdentifier(tableName, targetDriver)

	// 1. Create table IF NOT EXISTS (preserve schema, keys, and indexes if they pre-exist)
	emitLog("  -> Ensuring target schema for %s...", qTableName)
	createSQL := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s (", qTableName)
	for i, ct := range colTypes {
		dbType := ct.DatabaseTypeName()
		mappedType := m.mapType(dbType, targetDriver)

		createSQL += fmt.Sprintf("%s %s", quoteIdentifier(cols[i], targetDriver), mappedType)
		if i < len(colTypes)-1 {
			createSQL += ", "
		}
	}
	createSQL += ")"

	if _, err = targetDB.ExecContext(ctx, createSQL); err != nil {
		return fmt.Errorf("failed to create table: %w", err)
	}

	// 2. Start ATOMIC transaction for speed and safety
	emitLog("  -> Starting transaction and clearing old data...")
	tx, err := targetDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	// Defer rollback to catch panics or early returns. If already committed, Rollback is a no-op.
	defer tx.Rollback()

	// Clear existing elements quickly without destroying the schema
	if targetDriver == "postgres" {
		_, err = tx.ExecContext(ctx, fmt.Sprintf("TRUNCATE TABLE %s CASCADE", qTableName))
	} else {
		_, err = tx.ExecContext(ctx, fmt.Sprintf("TRUNCATE TABLE %s", qTableName)) // MySQL TRUNCATE
	}
	if err != nil {
		// Fallback to DELETE if TRUNCATE fails (e.g. permission or locking issues)
		if _, delErr := tx.ExecContext(ctx, fmt.Sprintf("DELETE FROM %s", qTableName)); delErr != nil {
			return fmt.Errorf("failed to truncate/delete table data: %w", err)
		}
	}

	// 3. Prepare generic insert parts for batching
	colNamesSQL := ""
	for i, col := range cols {
		colNamesSQL += quoteIdentifier(col, targetDriver)
		if i < len(cols)-1 {
			colNamesSQL += ", "
		}
	}

	// 4. Batch Row Insertion
	batchSize := 500
	rowCount := 0
	totalRow := 0
	
	var batchArgs []interface{}
	var placeholders []string

	// Setup pointers to raw arbitrary data array depending on column sizes
	values := make([]interface{}, len(cols))
	valuePtrs := make([]interface{}, len(cols))
	isBinaryCol := make([]bool, len(cols))
	for i, ct := range colTypes {
		dbType := strings.ToUpper(ct.DatabaseTypeName())
		isBinaryCol[i] = strings.Contains(dbType, "BLOB") || strings.Contains(dbType, "BYTEA") || strings.Contains(dbType, "BINARY")
	}

	for i := range cols {
		valuePtrs[i] = &values[i]
	}

	emitLog("  -> Streaming and batch-inserting data rows...")

	flushBatch := func() error {
		if rowCount == 0 {
			return nil
		}
		
		// Build the VALUES part of the batched INSERT
		// e.g. INSERT INTO table (a,b) VALUES ($1,$2), ($3,$4)
		insertSQL := fmt.Sprintf("INSERT INTO %s (%s) VALUES %s", qTableName, colNamesSQL, strings.Join(placeholders, ", "))
		
		_, err := tx.ExecContext(ctx, insertSQL, batchArgs...)
		if err != nil {
			return fmt.Errorf("batch insert failed at row %d: %w", totalRow, err)
		}

		batchArgs = nil
		placeholders = nil
		rowCount = 0
		return nil
	}

	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return err
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			return err
		}

		// build the positional parameters for this row: (?, ?) or ($1, $2)
		var rowPlaceholders []string
		for i, val := range values {
			// Track absolute index across the entire mapped batch for Postgres ($1, $2, $3...)
			paramIndex := rowCount*len(cols) + i + 1
			
			if targetDriver == "postgres" {
				rowPlaceholders = append(rowPlaceholders, fmt.Sprintf("$%d", paramIndex))
			} else {
				rowPlaceholders = append(rowPlaceholders, "?")
			}

			// Format strings vs binary correctly
			if b, ok := val.([]byte); ok {
				if isBinaryCol[i] {
					batchArgs = append(batchArgs, b)
				} else {
					batchArgs = append(batchArgs, string(b))
				}
			} else {
				batchArgs = append(batchArgs, val)
			}
		}

		placeholders = append(placeholders, fmt.Sprintf("(%s)", strings.Join(rowPlaceholders, ", ")))
		rowCount++
		totalRow++

		// Flush full batches
		if rowCount >= batchSize {
			if err := flushBatch(); err != nil {
				return err
			}
			emitLog("  -> Synced %d rows...", totalRow)
		}
	}

	// Flush any remaining rows
	if err := flushBatch(); err != nil {
		return err
	}

	// 5. Commit the transaction
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	emitLog("  -> Completed successfully! Batched and inserted a total of %d rows into %s.", totalRow, qTableName)

	return nil
}

// mapType provides an extremely basic translation of database type variants.
// Used only for the generic DB migration capability.
func (m *Migrator) mapType(sourceType, targetDriver string) string {
	t := strings.ToUpper(sourceType)

	if targetDriver == "postgres" {
		switch {
		case strings.Contains(t, "BLOB"), strings.Contains(t, "BYTEA"), strings.Contains(t, "BINARY"):
			return "BYTEA"
		case strings.Contains(t, "INT"):
			return "BIGINT"
		case strings.Contains(t, "CHAR"), strings.Contains(t, "TEXT"):
			return "TEXT"
		case strings.Contains(t, "BOOL"):
			return "BOOLEAN"
		case strings.Contains(t, "FLOAT"), strings.Contains(t, "DOUBLE"), strings.Contains(t, "DECIMAL"), strings.Contains(t, "NUMERIC"):
			return "DECIMAL"
		case strings.Contains(t, "TIME"), strings.Contains(t, "DATE"):
			return "TIMESTAMP"
		case strings.Contains(t, "JSON"):
			return "JSONB"
		default:
			return "TEXT"
		}
	}

	if targetDriver == "mysql" {
		switch {
		case strings.Contains(t, "BLOB"), strings.Contains(t, "BYTEA"), strings.Contains(t, "BINARY"):
			return "LONGBLOB"
		case strings.Contains(t, "INT"):
			return "BIGINT"
		case strings.Contains(t, "CHAR"), strings.Contains(t, "TEXT"):
			return "TEXT"
		case strings.Contains(t, "BOOL"):
			return "BOOLEAN"
		case strings.Contains(t, "FLOAT"), strings.Contains(t, "DOUBLE"), strings.Contains(t, "DECIMAL"), strings.Contains(t, "NUMERIC"):
			return "DECIMAL(10,2)"
		case strings.Contains(t, "TIME"), strings.Contains(t, "DATE"):
			return "DATETIME"
		default:
			return "TEXT"
		}
	}

	return "TEXT"
}
