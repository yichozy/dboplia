import { useState, useEffect } from 'react';
import { GetTables, GetDatabases, SyncDatabase, StopSync, LoadSettings, SaveSettings, CheckVersion, OpenDownloadUrl } from '../wailsjs/go/main/App';
import { EventsOn, EventsOff } from '../wailsjs/runtime/runtime';

function App() {
    const [activeTab, setActiveTab] = useState('sync'); // 'sync' or 'settings'

    const [sourceDriver, setSourceDriver] = useState('postgres');
    const [sourceDSN, setSourceDSN] = useState('');
    const [targetDriver, setTargetDriver] = useState('postgres');
    const [targetDSN, setTargetDSN] = useState('');
    
    // Update state
    const [updateInfo, setUpdateInfo] = useState<any>(null);

    // Credentials toggle
    const [hideCredentials, setHideCredentials] = useState(false);

    // Live Logs
    const [logs, setLogs] = useState<string[]>([]);

    useEffect(() => {
        // Check for updates
        CheckVersion().then((info: any) => {
            if (info && info.isNewer) {
                setUpdateInfo(info);
            }
        }).catch(console.error);

        // Load settings on mount
        LoadSettings().then((cfg: any) => {
            if (cfg && cfg.source && cfg.source.driver) {
                setSourceDriver(cfg.source.driver);
                setSourceDSN(cfg.source.dsn);
                setTargetDriver(cfg.target.driver);
                setTargetDSN(cfg.target.dsn);
                setStatus('Settings loaded. Auto-fetching databases...');
                setHideCredentials(true);
                
                // Auto-fetch databases
                GetDatabases(cfg.source.driver, cfg.source.dsn).then(dbs => {
                    setSourceDatabases(dbs || []);
                    if (dbs && dbs.length > 0) setSelectedSourceDb(cfg.source.database || dbs[0]);
                }).catch(console.error);
                
                GetDatabases(cfg.target.driver, cfg.target.dsn).then(dbs => {
                    setTargetDatabases(dbs || []);
                    if (dbs && dbs.length > 0) setSelectedTargetDb(cfg.target.database || dbs[0]);
                }).catch(console.error);
            }
        }).catch(console.error);

        // Listen for logs
        EventsOn('appLog', (msg: string) => {
            setLogs(prev => [...prev, msg]);
        });
        
        return () => {
            EventsOff('appLog');
        };
    }, []);

    const [sourceDatabases, setSourceDatabases] = useState<string[]>([]);
    const [selectedSourceDb, setSelectedSourceDb] = useState('');
    const [sourceTables, setSourceTables] = useState<string[]>([]);
    const [selectedSyncTables, setSelectedSyncTables] = useState<string[]>([]);

    const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
    const [selectedTargetDb, setSelectedTargetDb] = useState('');
    const [targetTables, setTargetTables] = useState<string[]>([]);
    
    const [status, setStatus] = useState('Idle. Configure servers and fetch databases.');
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState<{current: number, total: number, table: string, status: string} | null>(null);

    const [sourceSearch, setSourceSearch] = useState('');
    const [targetSearch, setTargetSearch] = useState('');

    const filteredSourceDatabases = sourceDatabases.filter(db => db.toLowerCase().includes(sourceSearch.toLowerCase()));
    const filteredTargetDatabases = targetDatabases.filter(db => db.toLowerCase().includes(targetSearch.toLowerCase()));

    // Dynamic Connection String Generator for Tables
    const getDbContextDSN = (driver: string, dsn: string, dbName: string) => {
        if (!dsn || !dbName) return dsn;
        if (driver === 'mysql') {
            return dsn.replace(/\/[^?]*(\?|$)/, `/${dbName}$1`);
        } else if (driver === 'postgres') {
            if (dsn.includes('dbname=')) {
                return dsn.replace(/dbname=[^\s]+/, `dbname=${dbName}`);
            }
            return `${dsn} dbname=${dbName}`;
        }
        return dsn;
    };

    const fetchSourceDatabases = async () => {
        try {
            setStatus('Fetching source databases...');
            const dbs = await GetDatabases(sourceDriver, sourceDSN);
            setSourceDatabases(dbs || []);
            if (dbs && dbs.length > 0) setSelectedSourceDb(dbs[0]);
            setStatus('Source databases fetched.');
        } catch (err: any) {
            setStatus(`Source Error: ${err}`);
        }
    };

    const fetchTargetDatabases = async () => {
        try {
            setStatus('Fetching target databases...');
            const dbs = await GetDatabases(targetDriver, targetDSN);
            setTargetDatabases(dbs || []);
            if (dbs && dbs.length > 0) setSelectedTargetDb(dbs[0]);
            setStatus('Target databases fetched.');
        } catch (err: any) {
            setStatus(`Target Error: ${err}`);
        }
    };

    useEffect(() => {
        if (selectedSourceDb) {
            setSelectedSyncTables([]); // clear initially selected lists
            fetchSourceTables(true);
        }
    }, [selectedSourceDb, sourceDriver, sourceDSN]);

    useEffect(() => {
        if (selectedTargetDb) {
            fetchTargetTables();
        }
    }, [selectedTargetDb, targetDriver, targetDSN]);

    const fetchSourceTables = async (isFirstFetch = false) => {
        if (!selectedSourceDb) return;
        try {
            const dsnContext = getDbContextDSN(sourceDriver, sourceDSN, selectedSourceDb);
            const tables = await GetTables(sourceDriver, dsnContext);
            const sortedTables = (tables || []).sort((a, b) => a.localeCompare(b));
            setSourceTables(sortedTables);
            if (isFirstFetch) {
                setSelectedSyncTables(sortedTables);
            }
        } catch (err: any) {
            console.error(`Source Error: ${err}`);
        }
    };

    const fetchTargetTables = async () => {
        if (!selectedTargetDb) return;
        try {
            const dsnContext = getDbContextDSN(targetDriver, targetDSN, selectedTargetDb);
            const tables = await GetTables(targetDriver, dsnContext);
            const sortedTables = (tables || []).sort((a, b) => a.localeCompare(b));
            setTargetTables(sortedTables);
        } catch (err: any) {
            console.error(`Target Error: ${err}`);
        }
    };

    const handleSync = async () => {
        if (!selectedSourceDb || !selectedTargetDb) {
            setStatus('Please select source and target databases first.');
            return;
        }

        if (selectedSyncTables.length === 0) {
            setStatus('Please select at least one table to sync.');
            return;
        }

        setIsSyncing(true);
        setSyncProgress(null);
        setStatus('Starting completely database sync...');
        
        EventsOn('syncProgress', (data: any) => {
            setSyncProgress(data);
            if (data.status) {
                setStatus(data.status);
            }
        });

        try {
            const result = await SyncDatabase(selectedSyncTables);
            setStatus(`Sync Result: ${result}`);
            
            await fetchTargetTables();
        } catch (err: any) {
            setStatus(`Sync Error: ${err}`);
        } finally {
            setIsSyncing(false);
            EventsOff('syncProgress');
        }
    };

    const handleStopSync = async () => {
        try {
            await StopSync();
            setStatus('Stopping sync...');
        } catch (err) {
            console.error(err);
        }
    };

    const handleSaveSettings = async () => {
        try {
            setStatus('Saving settings...');
            const result = await SaveSettings(sourceDriver, sourceDSN, selectedSourceDb, targetDriver, targetDSN, selectedTargetDb);
            setStatus(result);
            setHideCredentials(true);
        } catch (err: any) {
            setStatus(`Save Error: ${err}`);
        }
    };

    return (
        <div className="flex flex-col h-screen min-h-screen bg-slate-950 text-slate-200 p-6 font-sans">
            <header className="text-center mb-8 relative">
                <div className="flex justify-center items-center gap-3 mb-2">
                    <h1 className="text-4xl font-extrabold bg-gradient-to-r from-cyan-400 to-emerald-400 bg-clip-text text-transparent">
                        DBoplia
                    </h1>
                    {updateInfo && (
                        <button 
                            onClick={() => OpenDownloadUrl(updateInfo.releaseUrl)}
                            className="bg-emerald-500/20 text-emerald-400 text-xs font-semibold px-2 py-1 rounded-full border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors animate-pulse"
                            title="A new version is available. Click to download."
                        >
                            Update: {updateInfo.latestVer}
                        </button>
                    )}
                </div>
                <p className="text-slate-400 text-sm mb-6">Totally replace one database with another</p>
                
                <div className="flex justify-center space-x-6 border-b border-slate-800 pb-2">
                    <button 
                        className={`pb-2 px-2 text-sm font-medium transition-colors ${activeTab === 'sync' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                        onClick={() => setActiveTab('sync')}
                    >
                        Total Sync
                    </button>
                    <button 
                        className={`pb-2 px-2 text-sm font-medium transition-colors ${activeTab === 'settings' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                        onClick={() => setActiveTab('settings')}
                    >
                        Server Settings
                    </button>
                    <button 
                        className={`pb-2 px-2 text-sm font-medium transition-colors ${activeTab === 'logs' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                        onClick={() => setActiveTab('logs')}
                    >
                        Live Logs
                    </button>
                </div>
            </header>

            {activeTab === 'sync' && (
                <main className="flex gap-6 flex-1 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {/* SOURCE COLUMN */}
                    <div className="flex-1 bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 flex flex-col shadow-xl">
                        <h2 className="text-lg font-semibold text-slate-100 mb-6 pb-3 border-b border-slate-800">
                            Source Tables {selectedSourceDb ? <span className="text-cyan-400">({selectedSourceDb})</span> : ''}
                        </h2>

                        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                            <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    Table List 
                                    <span className="bg-slate-800 px-2 py-0.5 rounded-full text-xs text-slate-300">{selectedSyncTables.length} / {sourceTables.length}</span>
                                </div>
                                <div className="flex gap-2">
                                    <button 
                                        className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition-colors"
                                        onClick={() => setSelectedSyncTables(sourceTables)}
                                    >Select All</button>
                                    <button 
                                        className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition-colors"
                                        onClick={() => setSelectedSyncTables([])}
                                    >None</button>
                                </div>
                            </h3>
                            <ul className="flex-1 overflow-y-auto w-full bg-slate-950 border border-slate-800 rounded-xl rounded-t-lg divide-y divide-slate-800/50">
                                {sourceTables.length === 0 && (
                                    <li className="p-8 text-center text-slate-500 italic text-sm">No tables found. Please configure in Settings.</li>
                                )}
                                {sourceTables.map(t => {
                                    const isSame = targetTables.includes(t);
                                    const isSelected = selectedSyncTables.includes(t);
                                    return (
                                        <li key={t} className="px-4 py-3 text-sm text-slate-300 hover:bg-slate-900 transition-colors w-full flex justify-between items-center group">
                                            <label className="flex items-center gap-3 cursor-pointer flex-1">
                                                <input 
                                                    type="checkbox" 
                                                    checked={isSelected}
                                                    onChange={() => {
                                                        setSelectedSyncTables(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
                                                    }}
                                                    className="w-4 h-4 rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-950"
                                                />
                                                <span className={`${isSelected ? 'text-cyan-300' : 'text-slate-400 group-hover:text-cyan-400'}`}>{t}</span>
                                            </label>
                                            {isSame ? (
                                                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 group-hover:bg-emerald-500/20 transition-colors">Same</span>
                                            ) : (
                                                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 group-hover:bg-amber-500/20 transition-colors">Different</span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    </div>

                    {/* TARGET COLUMN */}
                    <div className="flex-1 bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 flex flex-col shadow-xl">
                        <h2 className="text-lg font-semibold text-slate-100 mb-6 pb-3 border-b border-slate-800">
                            Target Tables {selectedTargetDb ? <span className="text-emerald-400">({selectedTargetDb})</span> : ''}
                        </h2>

                        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                            <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center justify-between">
                                Table List 
                                <span className="bg-slate-800 px-2 py-0.5 rounded-full text-xs text-slate-300">{targetTables.length}</span>
                            </h3>
                            <ul className="flex-1 overflow-y-auto w-full bg-slate-950 border border-slate-800 rounded-xl rounded-t-lg divide-y divide-slate-800/50">
                                {targetTables.length === 0 && (
                                    <li className="p-8 text-center text-slate-500 italic text-sm">No tables found. Please configure in Settings.</li>
                                )}
                                {targetTables.map(t => {
                                    const isSame = sourceTables.includes(t);
                                    return (
                                        <li key={t} className="px-4 py-3 text-sm text-slate-300 hover:bg-slate-900 hover:text-emerald-300 transition-colors w-full cursor-default flex justify-between items-center group">
                                            <span>{t}</span>
                                            {isSame ? (
                                                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 group-hover:bg-emerald-500/20 transition-colors">Same</span>
                                            ) : (
                                                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 group-hover:bg-amber-500/20 transition-colors">Different</span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    </div>
                </main>
            )}

            {activeTab === 'settings' && (
                <main className="flex gap-6 flex-1 overflow-auto animate-in fade-in slide-in-from-bottom-2 duration-300 p-1">
                    {/* SOURCE SETTINGS */}
                    <div className="flex-1 bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col">
                        <h2 className="text-lg font-semibold text-cyan-400 mb-6 pb-3 border-b border-slate-800">
                            Source Sever Connection
                        </h2>
                        
                        <div className="space-y-6">
                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-2">Database Driver</label>
                                <select 
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all"
                                    value={sourceDriver} 
                                    onChange={e => {setSourceDriver(e.target.value); setHideCredentials(false);}}
                                >
                                    <option value="mysql">MySQL</option>
                                    <option value="postgres">PostgreSQL</option>
                                </select>
                            </div>
                            
                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-2">Connection String (DSN)</label>
                                {hideCredentials ? (
                                    <div className="relative">
                                        <div className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-500 italic break-all min-h-[5rem] flex items-center justify-center cursor-pointer hover:bg-slate-900 transition-colors" onClick={() => setHideCredentials(false)}>
                                            • • • • • • • • • • • • • • • • • • • • • • • • • • • •
                                        </div>
                                    </div>
                                ) : (
                                    <textarea 
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all min-h-[5rem] resize-y font-mono"
                                        value={sourceDSN} 
                                        onChange={e => setSourceDSN(e.target.value)}
                                        placeholder={sourceDriver === 'mysql' ? "user:pass@tcp(localhost:3306)/" : "host=localhost user=postgres password=postgres port=5432 sslmode=disable"}
                                    />
                                )}
                            </div>

                            <button 
                                className="px-4 py-2 bg-slate-800 hover:bg-cyan-900/30 text-cyan-400 text-sm font-medium rounded-lg border border-slate-700 hover:border-cyan-500/50 transition-all w-full md:w-auto"
                                onClick={fetchSourceDatabases}
                            >
                                Connect & Fetch Databases
                            </button>
                            
                            {sourceDatabases.length > 0 && (
                                <div className="animate-in fade-in slide-in-from-top-2 pt-4 border-t border-slate-800/50 mt-4">
                                    <label className="block text-sm font-medium text-slate-400 mb-2">Search & Select Database</label>
                                    <input 
                                        type="text"
                                        placeholder="Search database..."
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 mb-3 text-sm text-slate-200 focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all placeholder:text-slate-600"
                                        value={sourceSearch}
                                        onChange={e => setSourceSearch(e.target.value)}
                                    />
                                    <select 
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 focus:ring-2 focus:ring-cyan-500/50 outline-none"
                                        value={selectedSourceDb} 
                                        onChange={e => setSelectedSourceDb(e.target.value)}
                                    >
                                        <option value="" disabled>Select a database</option>
                                        {filteredSourceDatabases.map(db => (
                                            <option key={db} value={db}>{db}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* TARGET SETTINGS */}
                    <div className="flex-1 bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col">
                        <h2 className="text-lg font-semibold text-emerald-400 mb-6 pb-3 border-b border-slate-800">
                            Target Sever Connection
                        </h2>
                        
                        <div className="space-y-6">
                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-2">Database Driver</label>
                                <select 
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all"
                                    value={targetDriver} 
                                    onChange={e => {setTargetDriver(e.target.value); setHideCredentials(false);}}
                                >
                                    <option value="mysql">MySQL</option>
                                    <option value="postgres">PostgreSQL</option>
                                </select>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-2">Connection String (DSN)</label>
                                {hideCredentials ? (
                                    <div className="relative">
                                        <div className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-500 italic break-all min-h-[5rem] flex items-center justify-center cursor-pointer hover:bg-slate-900 transition-colors" onClick={() => setHideCredentials(false)}>
                                            • • • • • • • • • • • • • • • • • • • • • • • • • • • •
                                        </div>
                                    </div>
                                ) : (
                                    <textarea 
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all min-h-[5rem] resize-y font-mono"
                                        value={targetDSN} 
                                        onChange={e => setTargetDSN(e.target.value)}
                                        placeholder={targetDriver === 'mysql' ? "user:pass@tcp(localhost:3306)/" : "host=localhost user=postgres password=postgres port=5432 sslmode=disable"}
                                    />
                                )}
                            </div>

                            <button 
                                className="px-4 py-2 bg-slate-800 hover:bg-emerald-900/30 text-emerald-400 text-sm font-medium rounded-lg border border-slate-700 hover:border-emerald-500/50 transition-all w-full md:w-auto"
                                onClick={fetchTargetDatabases}
                            >
                                Connect & Fetch Databases
                            </button>
                            
                            {targetDatabases.length > 0 && (
                                <div className="animate-in fade-in slide-in-from-top-2 pt-4 border-t border-slate-800/50 mt-4">
                                    <label className="block text-sm font-medium text-slate-400 mb-2">Search & Select Database</label>
                                    <input 
                                        type="text"
                                        placeholder="Search database..."
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 mb-3 text-sm text-slate-200 focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all placeholder:text-slate-600"
                                        value={targetSearch}
                                        onChange={e => setTargetSearch(e.target.value)}
                                    />
                                    <select 
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 focus:ring-2 focus:ring-emerald-500/50 outline-none"
                                        value={selectedTargetDb} 
                                        onChange={e => setSelectedTargetDb(e.target.value)}
                                    >
                                        <option value="" disabled>Select a database</option>
                                        {filteredTargetDatabases.map(db => (
                                            <option key={db} value={db}>{db}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    </div>
                </main>
            )}

            {activeTab === 'logs' && (
                <main className="flex gap-6 flex-1 overflow-auto animate-in fade-in slide-in-from-bottom-2 duration-300 p-1">
                    <div className="flex-1 bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col font-mono text-sm overflow-hidden text-slate-300 shadow-xl">
                        <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-800">
                            <h2 className="text-lg font-semibold text-cyan-400">Live Migration Logs</h2>
                            <button 
                                className="text-xs font-semibold bg-slate-800 hover:bg-slate-700 px-3 py-1 rounded transition-colors" 
                                onClick={() => setLogs([])}
                            >
                                Clear Logs
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto w-full bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs whitespace-pre-wrap break-all custom-scrollbar">
                            {logs.length === 0 ? (
                                <p className="text-slate-600 italic">No logs available. Start a sync to see output.</p>
                            ) : (
                                logs.map((log, i) => (
                                    <div key={i} className="mb-1 break-words"><span className="text-slate-500 select-none mr-2">›</span>{log}</div>
                                ))
                            )}
                        </div>
                    </div>
                </main>
            )}

            <footer className="mt-6 bg-slate-900/80 border border-slate-800 rounded-2xl p-4 shadow-lg backdrop-blur-md flex flex-col gap-4">
                {isSyncing && syncProgress && (
                    <div className="w-full bg-slate-800 rounded-full h-1.5 mb-1 overflow-hidden">
                        <div 
                            className="bg-cyan-500 h-1.5 rounded-full transition-all duration-300" 
                            style={{ width: `${(syncProgress.current / syncProgress.total) * 100}%` }}
                        ></div>
                    </div>
                )}
                <div className="flex justify-between items-center w-full">
                    <div className="flex items-center gap-3">
                        <span className="relative flex h-3 w-3">
                            {isSyncing ? (
                                <>
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
                                </>
                            ) : (
                                <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.6)]"></span>
                            )}
                        </span>
                        <p className={`text-sm ${isSyncing ? 'text-amber-400 font-medium' : 'text-slate-300'}`}>{status}</p>
                    </div>

                    <div className="flex gap-4">
                        {activeTab === 'sync' && (
                            isSyncing ? (
                                <button 
                                    className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-lg active:scale-95 flex items-center gap-2 bg-red-500/20 text-red-500 border border-red-500/50 hover:bg-red-500/30"
                                    onClick={handleStopSync}
                                >
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                    Stop Sync
                                </button>
                            ) : (
                                <button 
                                    className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-lg shadow-cyan-900/20 active:scale-95 flex items-center gap-2 bg-gradient-to-r from-cyan-600 to-emerald-600 text-white hover:from-cyan-500 hover:to-emerald-500 border-none"
                                    onClick={handleSync}
                                >
                                    Start Total Sync
                                </button>
                            )
                        )}
                        {activeTab === 'settings' && (
                            <button 
                                className="px-6 py-2.5 bg-slate-800 text-slate-200 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-700 rounded-xl text-sm font-medium transition-all shadow-lg active:scale-95"
                                onClick={handleSaveSettings}
                            >
                                Save Settings
                            </button>
                        )}
                    </div>
                </div>
            </footer>
        </div>
    );
}

export default App;
