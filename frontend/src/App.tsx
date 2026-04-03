import { useState, useEffect, useRef } from 'react';
import { GetTables, GetDatabases, SyncDatabase, DumpAndReplaceDatabase, StopSync, LoadSettings, SaveSettings, CheckVersion, OpenDownloadUrl } from '../wailsjs/go/main/App';
import { EventsOn, EventsOff } from '../wailsjs/runtime/runtime';

function App() {
    const [activeTab, setActiveTab] = useState('sync_table'); // 'sync_db', 'sync_table', 'settings', or 'logs'

    const [sourceDriver, setSourceDriver] = useState('postgres');
    const [sourceDSN, setSourceDSN] = useState('');
    const [targetDriver, setTargetDriver] = useState('postgres');
    const [targetDSN, setTargetDSN] = useState('');
    
    // Update state
    const [updateInfo, setUpdateInfo] = useState<any>(null);

    // Credentials toggle
    const [hideCredentials, setHideCredentials] = useState(false);

    const [logs, setLogs] = useState<string[]>([]);
    const logsEndRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        if (isSyncing || logs.length > 0) {
            logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, isSyncing]);



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

    const handleDumpReplace = async () => {
        if (!selectedSourceDb || !selectedTargetDb) {
            setStatus('Please select source and target databases first.');
            return;
        }

        setIsSyncing(true);
        setSyncProgress(null);
        setStatus('Starting completely database replacement (Native Dump)...');
        
        try {
            const result = await DumpAndReplaceDatabase();
            setStatus(`Replace Result: ${result}`);
            
            await fetchTargetTables();
        } catch (err: any) {
            setStatus(`Replace Error: ${err}`);
        } finally {
            setIsSyncing(false);
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

    const handleSaveSettingsAuto = async (srcDb: string, tgtDb: string) => {
        try {
            await SaveSettings(sourceDriver, sourceDSN, srcDb, targetDriver, targetDSN, tgtDb);
        } catch (err) {
            console.error("Auto save failed:", err);
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
                        className={`pb-2 px-2 text-sm font-medium transition-colors ${activeTab === 'sync_db' ? 'text-amber-400 border-b-2 border-amber-400' : 'text-slate-500 hover:text-slate-300'}`}
                        onClick={() => setActiveTab('sync_db')}
                    >
                        SyncDB
                    </button>
                    <button 
                        className={`pb-2 px-2 text-sm font-medium transition-colors ${activeTab === 'sync_table' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                        onClick={() => setActiveTab('sync_table')}
                    >
                        SyncTable
                    </button>
                    <button 
                        className={`pb-2 px-2 text-sm font-medium transition-colors ${activeTab === 'settings' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                        onClick={() => setActiveTab('settings')}
                    >
                        Server Settings
                    </button>
                </div>
            </header>

            <main className="flex gap-6 flex-1 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300 pt-2">
                {activeTab === 'settings' ? (
                    <div className="flex gap-6 flex-1 w-full overflow-auto p-1">
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
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        {/* LEFT COLUMN: ACTIVE CONTENT */}
                        <div className={`flex flex-col gap-6 overflow-hidden transition-all duration-300 ${activeTab === 'sync_db' ? 'flex-[1.5] items-center justify-center' : 'flex-[2.5]'}`}>
                            {activeTab === 'sync_db' && (
                                <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-2xl p-10 flex flex-col items-center justify-center shadow-xl w-full max-w-2xl text-center">
                                    <div className="w-16 h-16 bg-amber-500/20 text-amber-500 rounded-full flex items-center justify-center mb-6">
                                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                                        </svg>
                                    </div>
                                    <h2 className="text-2xl font-bold text-slate-100 mb-2">Native Database Replacement</h2>
                                    <p className="text-slate-400 mb-8 text-sm">
                                        This will completely replace the target database using native database dump utilities (e.g. pg_dump and psql, or mysqldump and mysql). All schema, indices, constraints, and data will be mirrored perfectly.
                                    </p>
                                    
                                    <div className="flex items-center gap-4 w-full mb-8">
                                        <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-left">
                                            <p className="text-xs text-slate-500 mb-1">Source DB</p>
                                            {sourceDatabases.length > 0 ? (
                                                <select 
                                                    className="w-full bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-sm text-cyan-400 font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-500"
                                                    value={selectedSourceDb} 
                                                    onChange={e => {
                                                        setSelectedSourceDb(e.target.value);
                                                        handleSaveSettingsAuto(e.target.value, selectedTargetDb);
                                                    }}
                                                >
                                                    <option value="" disabled>Select Database...</option>
                                                    {sourceDatabases.map(db => <option key={db} value={db}>{db}</option>)}
                                                </select>
                                            ) : (
                                                <p className="text-sm font-semibold text-slate-500 truncate">Not Configured</p>
                                            )}
                                        </div>
                                        <svg className="w-6 h-6 text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                                        </svg>
                                        <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-left">
                                            <p className="text-xs text-slate-500 mb-1">Target DB</p>
                                            {targetDatabases.length > 0 ? (
                                                <select 
                                                    className="w-full bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-sm text-emerald-400 font-semibold focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                                    value={selectedTargetDb} 
                                                    onChange={e => {
                                                        setSelectedTargetDb(e.target.value);
                                                        handleSaveSettingsAuto(selectedSourceDb, e.target.value);
                                                    }}
                                                >
                                                    <option value="" disabled>Select Database...</option>
                                                    {targetDatabases.map(db => <option key={db} value={db}>{db}</option>)}
                                                </select>
                                            ) : (
                                                <p className="text-sm font-semibold text-slate-500 truncate">Not Configured</p>
                                            )}
                                        </div>
                                    </div>

                                    {selectedSourceDb && selectedTargetDb ? (
                                        <p className="text-amber-500 text-xs mt-2 italic font-semibold">* Warning: This action destroys and overrides all existing data directly inside the target database.</p>
                                    ) : (
                                        <p className="text-red-400/80 text-xs mt-2 italic">Please configure databases in Server Settings first.</p>
                                    )}
                                </div>
                            )}

                            {activeTab === 'sync_table' && (
                                <div className="flex gap-6 flex-1 min-h-0 w-full overflow-hidden">
                                    {/* SOURCE COLUMN */}
                                    <div className="flex-1 bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 flex flex-col shadow-xl min-w-[250px]">
                                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-800 gap-2">
                                            <div className="flex flex-col gap-1 w-full">
                                                <h2 className="text-md font-semibold text-slate-100 flex items-center gap-2">
                                                    Source
                                                    {selectedSourceDb && (
                                                        <button 
                                                            className="p-1 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded-md transition-colors flex items-center justify-center border border-slate-700/50 ml-auto"
                                                            onClick={() => fetchSourceTables()}
                                                            title="Refresh Tables"
                                                        >
                                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                                        </button>
                                                    )}
                                                </h2>
                                                {sourceDatabases.length > 0 && (
                                                    <select 
                                                        className="bg-slate-950 border border-slate-700/50 rounded-lg py-1 px-2 text-xs text-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 w-full"
                                                        value={selectedSourceDb} 
                                                        onChange={e => {
                                                            setSelectedSourceDb(e.target.value);
                                                            handleSaveSettingsAuto(e.target.value, selectedTargetDb);
                                                        }}
                                                    >
                                                        <option value="" disabled>Select Database...</option>
                                                        {sourceDatabases.map(db => <option key={db} value={db}>{db}</option>)}
                                                    </select>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                                            <h3 className="text-xs font-medium text-slate-400 mb-3 flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    Tables 
                                                    <span className="bg-slate-800 px-1.5 py-0.5 rounded-full text-[10px] text-slate-300">{selectedSyncTables.length}/{sourceTables.length}</span>
                                                </div>
                                                <div className="flex gap-1.5">
                                                    <button 
                                                        className="text-[9px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded transition-colors"
                                                        onClick={() => setSelectedSyncTables(sourceTables)}
                                                    >All</button>
                                                    <button 
                                                        className="text-[9px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded transition-colors"
                                                        onClick={() => setSelectedSyncTables([])}
                                                    >None</button>
                                                </div>
                                            </h3>
                                            <ul className="flex-1 overflow-y-auto w-full bg-slate-950 border border-slate-800 rounded-xl rounded-t-lg divide-y divide-slate-800/50 custom-scrollbar">
                                                {sourceTables.length === 0 && (
                                                    <li className="p-6 text-center text-slate-500 italic text-xs">No tables found.</li>
                                                )}
                                                {sourceTables.map(t => {
                                                    const isSame = targetTables.includes(t);
                                                    const isSelected = selectedSyncTables.includes(t);
                                                    return (
                                                        <li key={t} className="px-3 py-2.5 text-xs text-slate-300 hover:bg-slate-900 transition-colors w-full flex justify-between items-center group">
                                                            <label className="flex items-center gap-2.5 cursor-pointer flex-1 truncate pr-2">
                                                                <input 
                                                                    type="checkbox" 
                                                                    checked={isSelected}
                                                                    onChange={() => {
                                                                        setSelectedSyncTables(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
                                                                    }}
                                                                    className="w-3.5 h-3.5 rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-950 shrink-0"
                                                                />
                                                                <span className={`truncate ${isSelected ? 'text-cyan-300' : 'text-slate-400 group-hover:text-cyan-400'}`}>{t}</span>
                                                            </label>
                                                            {isSame ? (
                                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Same"></div>
                                                            ) : (
                                                                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Different"></div>
                                                            )}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </div>
                                    </div>

                                    {/* TARGET COLUMN */}
                                    <div className="flex-1 bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 flex flex-col shadow-xl min-w-[250px]">
                                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-800 gap-2">
                                            <div className="flex flex-col gap-1 w-full">
                                                <h2 className="text-md font-semibold text-slate-100 flex items-center gap-2">
                                                    Target
                                                    {selectedTargetDb && (
                                                        <button 
                                                            className="p-1 bg-slate-800 hover:bg-slate-700 text-emerald-400 rounded-md transition-colors flex items-center justify-center border border-slate-700/50 ml-auto"
                                                            onClick={() => fetchTargetTables()}
                                                            title="Refresh Tables"
                                                        >
                                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                                        </button>
                                                    )}
                                                </h2>
                                                {targetDatabases.length > 0 && (
                                                    <select 
                                                        className="bg-slate-950 border border-slate-700/50 rounded-lg py-1 px-2 text-xs text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 w-full"
                                                        value={selectedTargetDb} 
                                                        onChange={e => {
                                                            setSelectedTargetDb(e.target.value);
                                                            handleSaveSettingsAuto(selectedSourceDb, e.target.value);
                                                        }}
                                                    >
                                                        <option value="" disabled>Select Database...</option>
                                                        {targetDatabases.map(db => <option key={db} value={db}>{db}</option>)}
                                                    </select>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                                            <h3 className="text-xs font-medium text-slate-400 mb-3 flex items-center justify-between">
                                                Tables 
                                                <span className="bg-slate-800 px-1.5 py-0.5 rounded-full text-[10px] text-slate-300">{targetTables.length}</span>
                                            </h3>
                                            <ul className="flex-1 overflow-y-auto w-full bg-slate-950 border border-slate-800 rounded-xl rounded-t-lg divide-y divide-slate-800/50 custom-scrollbar">
                                                {targetTables.length === 0 && (
                                                    <li className="p-6 text-center text-slate-500 italic text-xs">No tables found.</li>
                                                )}
                                                {targetTables.map(t => {
                                                    const isSame = sourceTables.includes(t);
                                                    return (
                                                        <li key={t} className="px-3 py-2.5 text-xs text-slate-300 hover:bg-slate-900 hover:text-emerald-300 transition-colors w-full cursor-default flex justify-between items-center group">
                                                            <span className="truncate pr-2">{t}</span>
                                                            {isSame ? (
                                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Same"></div>
                                                            ) : (
                                                                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Different"></div>
                                                            )}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* RIGHT COLUMN: LIVE LOGS */}
                        <div className="flex-1 bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col font-mono text-sm overflow-hidden text-slate-300 shadow-xl max-w-sm lg:max-w-md">
                            <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-800 shrink-0">
                                <h2 className="text-lg font-semibold text-cyan-400 flex items-center gap-2">
                                    <span className="relative flex h-2 w-2">
                                        {isSyncing ? (
                                            <>
                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                                            </>
                                        ) : (
                                            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.6)]"></span>
                                        )}
                                    </span>
                                    Live Logs
                                </h2>
                                <button 
                                    className="text-[10px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition-colors" 
                                    onClick={() => setLogs([])}
                                >
                                    Clear
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto w-full bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-xs whitespace-pre-wrap break-all custom-scrollbar">
                                {logs.length === 0 ? (
                                    <p className="text-slate-600 italic">Idle. Click start below.</p>
                                ) : (
                                    logs.map((log, i) => (
                                        <div key={i} className="mb-1.5 break-words leading-relaxed text-[11px]"><span className="text-emerald-500/70 select-none mr-2 font-bold">{'>'}</span>{log}</div>
                                    ))
                                )}
                                <div ref={logsEndRef} />
                            </div>
                        </div>
                    </>
                )}
            </main>

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
                        {(activeTab === 'sync_table' || activeTab === 'sync_db') && (
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
                            ) : activeTab === 'sync_table' ? (
                                <button 
                                    className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-lg shadow-cyan-900/20 active:scale-95 flex items-center gap-2 bg-gradient-to-r from-cyan-600 to-emerald-600 text-white hover:from-cyan-500 hover:to-emerald-500 border-none"
                                    onClick={handleSync}
                                >
                                    Start Table Sync
                                </button>
                            ) : (
                                <button 
                                    className="px-6 py-2.5 bg-amber-500/10 text-amber-500 hover:text-amber-400 border border-amber-500/30 hover:border-amber-500 hover:bg-amber-500/20 rounded-xl text-sm font-medium transition-all shadow-lg active:scale-95"
                                    onClick={handleDumpReplace}
                                >
                                    Start Native Dump & Replace
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
