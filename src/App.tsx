import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GameEngine } from './game';
import { applySettingsToEngine, loadSettings, saveSettings } from './settings';
import type { GameSettings } from './settings';
import { loadStats, recordRun } from './stats';
import type { PlayerStats } from './stats';
import { SettingsPanel } from './SettingsPanel';
import { Minimap } from './Minimap';
import type { RadarData } from './Minimap';

type GameMode = 'menu' | 'playing' | 'gameover';

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function readHighScore() {
  const stored = Number(window.localStorage.getItem('helistrike:highScore') ?? 0);
  return Number.isFinite(stored) ? stored : 0;
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <path d="M8 5h6v4h4V5h6v4h4v8h-4v4h-4v4h-4v4h-4v-4H8v-4H4v-4H0V9h4V5h4Z" fill="#ef233c" />
      <path d="M8 7h5v3H8v3H5v-3h3V7Z" fill="#ff7b86" opacity="0.75" />
    </svg>
  );
}

function GasIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <path d="M7 4h14v24H5V8h2V4Z" fill="#2bd66f" />
      <path d="M10 8h8v5h-8V8Z" fill="#caffdb" />
      <path d="M21 8h4l3 4v10h-4v-8l-3-2V8Z" fill="#1a9f52" />
      <path d="M8 22h10v3H8v-3Z" fill="#13783b" opacity="0.5" />
    </svg>
  );
}

function CoinIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <circle cx="16" cy="16" r="12" fill="#ffd43b" />
      <circle cx="16" cy="16" r="8" fill="#f6b800" />
      <rect x="14" y="8" width="4" height="16" fill="#fff3a3" opacity="0.8" />
    </svg>
  );
}

function BulletIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8">
      <path d="M18 3h5v5h3v16h-3v5H9v-5H6V12h12V3Z" fill="#ffe66d" />
      <path d="M9 17h14v4H9v-4Z" fill="#ff4b35" />
      <path d="M18 7h3v5h-3V7Z" fill="#fff6ad" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <circle cx="16" cy="16" r="12" fill="none" stroke="#ff3344" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="5" fill="#ff3344" />
      <rect x="15" y="2" width="2" height="6" fill="#ff3344" />
      <rect x="15" y="24" width="2" height="6" fill="#ff3344" />
      <rect x="2" y="15" width="6" height="2" fill="#ff3344" />
      <rect x="24" y="15" width="6" height="2" fill="#ff3344" />
    </svg>
  );
}

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[4px] border border-white/30 bg-white/14 px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white shadow-[0_2px_0_rgba(0,0,0,0.25)]">
      {children}
    </span>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1" />
    </svg>
  );
}

function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-4 w-28 overflow-hidden rounded-[4px] border-2 border-black/45 bg-black/35 shadow-[0_2px_0_rgba(0,0,0,0.35)] sm:w-44">
      <div className={`h-full ${color} transition-[width] duration-300`} style={{ width: `${clampPercent(value)}%` }} />
    </div>
  );
}

function MenuButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      className="pointer-events-auto h-12 min-w-44 rounded-[7px] border-2 border-white/75 bg-[#ff3344] px-6 text-lg font-black uppercase tracking-[0.16em] text-white shadow-[0_6px_0_#931521,0_12px_22px_rgba(0,0,0,0.28)] transition hover:-translate-y-0.5 hover:bg-[#ff4b59] active:translate-y-1 active:shadow-[0_3px_0_#931521,0_8px_16px_rgba(0,0,0,0.22)]"
      onClick={onClick}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      type="button"
    >
      {children}
    </button>
  );
}

function ThreeDMenu({
  mode,
  score,
  highScore,
  wave,
  isNewBest,
  stats,
  settings,
  onSettingsChange,
  onStart,
}: {
  mode: GameMode;
  score: number;
  highScore: number;
  wave: number;
  isNewBest: boolean;
  stats: PlayerStats;
  settings: GameSettings;
  onSettingsChange: (next: Partial<GameSettings>) => void;
  onStart: () => void;
}) {
  const isGameOver = mode === 'gameover';
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-gradient-to-b from-[#9fdce8]/30 via-[#7fd9e6]/20 to-[#20417f]/35 px-4"
    >
      <div className="menu-perspective">
        <div className="menu-rig">
          <div className="menu-card">
            <div className="menu-title-slab">
              <span>{isGameOver ? 'Run Ended' : 'Heli-Strike'}</span>
            </div>

            {showSettings ? (
              <div className="mt-5">
                <SettingsPanel settings={settings} onChange={onSettingsChange} />
                <div className="mt-5 flex justify-center">
                  <MenuButton onClick={() => setShowSettings(false)}>Back</MenuButton>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                  <div className="menu-stat">
                    <span>Score</span>
                    <strong>{score.toLocaleString()}</strong>
                  </div>
                  <div className="menu-stat">
                    <span>Best</span>
                    <strong>{highScore.toLocaleString()}</strong>
                  </div>
                  <div className="menu-stat">
                    <span>Stage</span>
                    <strong>{wave || '-'}</strong>
                  </div>
                </div>

                {isNewBest && (
                  <div className="mt-3 rounded-[6px] border-2 border-[#ffe66d] bg-[#ffe66d]/25 px-4 py-2 text-center text-sm font-black uppercase tracking-[0.16em] text-white shadow-[0_3px_0_rgba(0,0,0,0.22)]">
                    New High Score
                  </div>
                )}

                <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px] font-black uppercase tracking-[0.1em] text-white/80">
                  <div className="rounded-[5px] border border-white/20 bg-black/20 px-2 py-1.5">
                    <div className="opacity-70">Runs</div>
                    <div className="mt-0.5 text-sm text-white">{stats.gamesPlayed}</div>
                  </div>
                  <div className="rounded-[5px] border border-white/20 bg-black/20 px-2 py-1.5">
                    <div className="opacity-70">Best Wave</div>
                    <div className="mt-0.5 text-sm text-white">{stats.bestWave || '-'}</div>
                  </div>
                  <div className="rounded-[5px] border border-white/20 bg-black/20 px-2 py-1.5">
                    <div className="opacity-70">Best Combo</div>
                    <div className="mt-0.5 text-sm text-white">{stats.bestCombo || '-'}</div>
                  </div>
                </div>

                <div className="mt-5 flex justify-center gap-3">
                  <MenuButton onClick={onStart}>{isGameOver ? 'Restart' : 'Start'}</MenuButton>
                  <button
                    type="button"
                    onClick={() => setShowSettings(true)}
                    className="pointer-events-auto flex h-12 items-center gap-2 rounded-[7px] border-2 border-white/75 bg-[#264fb1] px-5 text-sm font-black uppercase tracking-[0.14em] text-white shadow-[0_6px_0_#16265f] transition hover:-translate-y-0.5 hover:bg-[#315fd0] active:translate-y-1"
                  >
                    <GearIcon />
                    Settings
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-sm font-black uppercase tracking-[0.12em] text-white/95">
                  <div className="menu-chip">WASD Move</div>
                  <div className="menu-chip">Mouse Aim</div>
                  <div className="menu-chip">Space/Shift Alt</div>
                  <div className="menu-chip">L-Click Fire</div>
                  <div className="menu-chip col-span-2 text-center text-[#ff3344] bg-[#ff3344]/10 border-[#ff3344]/30 py-1.5 rounded-[5px] border">Q / R-Click Lock Salvo</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PauseMenu({
  settings,
  onSettingsChange,
  onResume,
  onQuit,
}: {
  settings: GameSettings;
  onSettingsChange: (next: Partial<GameSettings>) => void;
  onResume: () => void;
  onQuit: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-[#06112b]/70 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-[8px] border-3 border-white/70 bg-gradient-to-b from-[#2c5cbf] to-[#16265f] p-6 shadow-[0_10px_0_#0b1738,0_24px_40px_rgba(0,0,0,0.4)]">
        <h2 className="text-center text-3xl font-black uppercase tracking-[0.16em] text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.45)]">
          Paused
        </h2>
        <div className="mt-5">
          <SettingsPanel settings={settings} onChange={onSettingsChange} />
        </div>
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={onResume}
            className="h-12 rounded-[7px] border-2 border-white/75 bg-[#ff3344] text-lg font-black uppercase tracking-[0.16em] text-white shadow-[0_6px_0_#931521] transition hover:-translate-y-0.5 hover:bg-[#ff4b59] active:translate-y-1"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={onQuit}
            className="h-11 rounded-[7px] border-2 border-white/50 bg-black/25 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-black/35"
          >
            Quit to Menu
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [mode, setMode] = useState<GameMode>('menu');
  const [score, setScore] = useState(0);
  const [health, setHealth] = useState(100);
  const [fuel, setFuel] = useState(100);
  const [wave, setWave] = useState(0);
  const [waveMessage, setWaveMessage] = useState<string | null>(null);
  const [highScore, setHighScore] = useState(0);
  const [isNewBest, setIsNewBest] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings());
  const [stats, setStats] = useState<PlayerStats>(() => loadStats());
  const settingsRef = useRef(settings);
  const modeRef = useRef<GameMode>(mode);
  const [weaponInfo, setWeaponInfo] = useState<{
    name: string;
    ammo: number;
    maxAmmo: number;
    type: number;
    reloading: boolean;
    reloadTimer: number;
  } | null>(null);
  const [comboInfo, setComboInfo] = useState<{
    count: number;
    multiplier: number;
    timer: number;
  } | null>(null);
  const [statusInfo, setStatusInfo] = useState<{
    damageBoost: number;
    shield: number;
    speedBoost: number;
    threat: number;
  } | null>(null);
  const [salvoInfo, setSalvoInfo] = useState<{
    locks: number;
    cooldown: number;
    isPainting: boolean;
    ready: boolean;
  } | null>(null);
  const [radar, setRadar] = useState<RadarData | null>(null);
  const [waveProgress, setWaveProgress] = useState<{
    remaining: number;
    total: number;
    active: number;
  } | null>(null);

  useEffect(() => {
    setHighScore(readHighScore());
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Apply persisted settings to the engine once it exists and on change.
  useEffect(() => {
    applySettingsToEngine(settings);
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new GameEngine(canvasRef.current);
    engineRef.current = engine;

    // Push persisted settings into the freshly created engine.
    applySettingsToEngine(settingsRef.current);

    const handlePauseToggle = () => {
      // Only meaningful during an active run.
      if (modeRef.current !== 'playing') return;
      setIsPaused((prev) => {
        const next = !prev;
        engineRef.current?.setPaused(next);
        return next;
      });
    };

    const handleUpdate = (e: CustomEvent) => {
      const nextScore = e.detail.score;
      setScore(nextScore);
      setWave(e.detail.wave);
      setWaveMessage(e.detail.playing ? e.detail.message : null);
      setWeaponInfo(e.detail.weapon || null);
      setComboInfo(e.detail.combo || null);
      setStatusInfo(e.detail.status || null);
      setSalvoInfo(e.detail.salvo || null);
      setRadar(e.detail.radar || null);
      setWaveProgress(e.detail.waveProgress || null);

      const storedHighScore = readHighScore();
      if (nextScore > storedHighScore) {
        window.localStorage.setItem('helistrike:highScore', String(nextScore));
        setHighScore(nextScore);
      }
    };

    const handleGameOver = (e: CustomEvent) => {
      const finalScore = e.detail.score;
      setMode('gameover');
      setIsPaused(false);

      const storedHighScore = readHighScore();
      setIsNewBest(finalScore >= storedHighScore && finalScore > 0);
      if (finalScore > storedHighScore) {
        window.localStorage.setItem('helistrike:highScore', String(finalScore));
        setHighScore(finalScore);
      }

      const updated = recordRun({
        score: finalScore,
        wave: e.detail.wave ?? 0,
        combo: e.detail.maxCombo ?? 0,
      });
      setStats(updated);
    };

    const handleStats = (e: CustomEvent) => {
      setHealth(e.detail.currentHealth);
      setFuel(e.detail.currentFuel);
    };

    window.addEventListener('helistrike:update', handleUpdate as EventListener);
    window.addEventListener('helistrike:stats', handleStats as EventListener);
    window.addEventListener('helistrike:gameover', handleGameOver as EventListener);
    window.addEventListener('helistrike:pause-toggle', handlePauseToggle);

    return () => {
      window.removeEventListener('helistrike:update', handleUpdate as EventListener);
      window.removeEventListener('helistrike:stats', handleStats as EventListener);
      window.removeEventListener('helistrike:gameover', handleGameOver as EventListener);
      window.removeEventListener('helistrike:pause-toggle', handlePauseToggle);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const startRun = () => {
    if (mode === 'playing') return;
    setMode('playing');
    setIsNewBest(false);
    setIsPaused(false);
    engineRef.current?.startGame();
  };

  const returnToMainMenu = () => {
    setMode('menu');
    setIsNewBest(false);
    setIsPaused(false);
    setRadar(null);
    setWaveProgress(null);
    engineRef.current?.setPaused(true);
  };

  const handleSettingsChange = (next: Partial<GameSettings>) => {
    setSettings((prev) => ({ ...prev, ...next }));
  };

  const resumeGame = () => {
    setIsPaused(false);
    engineRef.current?.setPaused(false);
  };

  const coins = Math.floor(score / 100);
  const textShadow = { textShadow: '0 2px 0 rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.35)' };
  const hudDim = mode !== 'playing' ? 'opacity-35' : 'opacity-100';
  const dangerOpacity = mode === 'playing' ? clampPercent(35 - health) / 100 : 0;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#97dff0] font-sans text-white pointer-events-auto select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full touch-none z-0" />
      <div className="arcade-scanlines pointer-events-none absolute inset-0 z-10" />
      <div className="arcade-vignette pointer-events-none absolute inset-0 z-10" />
      <div
        className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-300"
        style={{
          opacity: dangerOpacity,
          background: 'radial-gradient(circle at center, transparent 45%, rgba(239,35,60,0.72) 100%)',
        }}
      />

      <div className={`pointer-events-none absolute inset-0 z-20 transition-opacity duration-300 ${hudDim}`}>
        <div className="arcade-marquee absolute left-1/2 top-0 hidden -translate-x-1/2 px-7 py-1 text-[11px] font-black uppercase tracking-[0.22em] text-[#ffe66d] sm:block">
          Heli-Strike Arcade Assault
        </div>

        <div className="absolute left-4 top-3 flex flex-col gap-2 sm:left-6 sm:top-5">
          <div className="flex items-center gap-2">
            <HeartIcon />
            <Meter value={health} color={health > 30 ? 'bg-[#35e66d]' : 'bg-[#ef233c]'} />
            <span className="min-w-10 text-xl font-black leading-none" style={textShadow}>{Math.round(health)}</span>
          </div>
          <div className="flex items-center gap-2">
            <GasIcon />
            <Meter value={fuel} color={fuel > 20 ? 'bg-[#2bd66f]' : 'bg-[#ff3344]'} />
            <span className="min-w-10 text-xl font-black leading-none" style={textShadow}>{Math.round(fuel)}%</span>
          </div>
        </div>

        <div className="absolute left-1/2 top-3 -translate-x-1/2 text-center sm:top-5">
          <div className="text-xs font-extrabold uppercase tracking-[0.14em] sm:text-sm sm:tracking-[0.18em]" style={textShadow}>Stage {wave === 0 ? '-' : wave}</div>
          <div className="mt-1 text-2xl font-black leading-none sm:text-3xl" style={textShadow}>{score.toLocaleString()}</div>
        </div>

        <div className="absolute right-4 top-4 flex items-center gap-2 sm:right-6 sm:top-6">
          <CoinIcon />
          <span className="text-3xl font-black leading-none" style={textShadow}>{coins.toLocaleString()}</span>
        </div>

        {mode === 'playing' && (
          <button
            type="button"
            onClick={returnToMainMenu}
            className="pointer-events-auto absolute right-4 top-14 rounded-[6px] border-2 border-white/70 bg-[#264fb1]/80 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-[0_4px_0_#16265f,0_8px_18px_rgba(0,0,0,0.24)] transition hover:-translate-y-0.5 hover:bg-[#315fd0] active:translate-y-1 active:shadow-[0_2px_0_#16265f,0_5px_12px_rgba(0,0,0,0.22)] sm:right-6 sm:top-16"
            style={textShadow}
          >
            Main Menu
          </button>
        )}

        {mode === 'playing' && !isPaused && (
          <button
            type="button"
            onClick={() => {
              setIsPaused(true);
              engineRef.current?.setPaused(true);
            }}
            className="pointer-events-auto absolute right-4 top-26 flex items-center gap-1.5 rounded-[6px] border-2 border-white/70 bg-[#264fb1]/80 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-[0_4px_0_#16265f,0_8px_18px_rgba(0,0,0,0.24)] transition hover:-translate-y-0.5 hover:bg-[#315fd0] active:translate-y-1 sm:right-6 sm:top-28"
            style={textShadow}
          >
            <GearIcon />
            Pause
          </button>
        )}

        {/* Weapon HUD */}
        {weaponInfo && mode === 'playing' && (
          <div className="pointer-events-none absolute left-4 top-20 flex flex-col gap-1 sm:left-6 sm:top-24">
            <div className="flex items-center gap-2">
              <BulletIcon />
              <span className="text-sm font-black uppercase tracking-wider" style={textShadow}>
                {weaponInfo.name}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {weaponInfo.reloading ? (
                <span className="text-sm font-black text-yellow-300" style={textShadow}>
                  RELOADING... {Math.ceil(weaponInfo.reloadTimer)}s
                </span>
              ) : (
                <span className="text-sm font-black" style={textShadow}>
                  {weaponInfo.ammo} / {weaponInfo.maxAmmo}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Salvo HUD */}
        {salvoInfo && mode === 'playing' && (
          <div className="pointer-events-none absolute left-4 top-34 flex flex-col gap-1 sm:left-6 sm:top-38">
            <div className="flex items-center gap-2">
              <TargetIcon />
              <span className="text-sm font-black uppercase tracking-wider" style={textShadow}>
                Multi-Salvo
              </span>
            </div>
            <div className="flex items-center gap-2">
              {salvoInfo.isPainting ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-red-400 animate-pulse uppercase" style={textShadow}>
                    Locking:
                  </span>
                  <div className="flex gap-0.5">
                    {[0, 1, 2, 3, 4, 5].map((idx) => {
                      const active = idx < salvoInfo.locks;
                      return (
                        <div
                          key={idx}
                          className={`h-4.5 w-3.5 border border-black/45 rounded-[2px] transition-all duration-150 ${
                            active
                              ? 'bg-[#ff3344] shadow-[0_0_8px_#ff3344] border-red-300'
                              : 'bg-black/40'
                          }`}
                        />
                      );
                    })}
                  </div>
                </div>
              ) : salvoInfo.cooldown > 0 ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-black text-white/50" style={textShadow}>
                    COOLDOWN
                  </span>
                  <div className="h-2 w-20 overflow-hidden rounded-[2px] border border-black/45 bg-black/40">
                    <div
                      className="h-full bg-red-400/50 transition-all duration-300"
                      style={{ width: `${(salvoInfo.cooldown / 5.0) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-black text-white/60" style={textShadow}>
                    {salvoInfo.cooldown}s
                  </span>
                </div>
              ) : (
                <span className="text-xs font-extrabold text-[#35e66d] animate-pulse" style={textShadow}>
                  READY (HOLD Q / R-CLICK)
                </span>
              )}
            </div>
          </div>
        )}

        {/* Combo Display */}
        {comboInfo && comboInfo.count > 1 && mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 text-center">
            <div className="text-2xl font-black text-yellow-300" style={textShadow}>
              {comboInfo.count}x COMBO
            </div>
            <div className="text-sm font-bold text-yellow-200" style={textShadow}>
              x{comboInfo.multiplier.toFixed(1)} MULTIPLIER
            </div>
          </div>
        )}

        {statusInfo && mode === 'playing' && (
          <div className="pointer-events-none absolute right-4 top-28 flex flex-col items-end gap-1 text-xs font-black uppercase tracking-[0.12em] sm:right-6 sm:top-32">
            {statusInfo.threat > 0.68 && (
              <div className="rounded-[5px] border border-[#ff3344]/70 bg-[#40101a]/70 px-3 py-1 text-[#ffd3d7]" style={textShadow}>
                Threat High
              </div>
            )}
            {statusInfo.damageBoost > 0 && (
              <div className="rounded-[5px] border border-[#ffe66d]/70 bg-[#3d2b08]/70 px-3 py-1 text-[#ffe66d]" style={textShadow}>
                Damage {Math.ceil(statusInfo.damageBoost)}s
              </div>
            )}
            {statusInfo.shield > 0 && (
              <div className="rounded-[5px] border border-[#80d8ff]/70 bg-[#092a3f]/70 px-3 py-1 text-[#bfeeff]" style={textShadow}>
                Shield {Math.ceil(statusInfo.shield)}s
              </div>
            )}
            {statusInfo.speedBoost > 0 && (
              <div className="rounded-[5px] border border-[#ff88ff]/70 bg-[#38113a]/70 px-3 py-1 text-[#ffd0ff]" style={textShadow}>
                Boost {Math.ceil(statusInfo.speedBoost)}s
              </div>
            )}
          </div>
        )}

        {mode === 'playing' && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-[6px] border border-white/30 bg-[#102447]/55 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-[0_8px_24px_rgba(0,0,0,0.2),inset_0_0_18px_rgba(255,230,109,0.12)] backdrop-blur-sm">
            <div className="flex items-center gap-1">
              <KeyCap>WASD</KeyCap>
              <span style={textShadow}>Move</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <KeyCap>Space</KeyCap>
              <KeyCap>Q</KeyCap>
              <span style={textShadow}>Alt</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <BulletIcon />
              <span style={textShadow}>Hold Fire</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <KeyCap>1-4</KeyCap>
              <span style={textShadow}>Weapons</span>
            </div>
          </div>
        )}

        {mode === 'playing' && (
          <div className="absolute bottom-4 right-4 flex flex-col items-center gap-1.5 sm:right-6">
            <Minimap radar={radar} />
            {waveProgress && (
              <div
                className="rounded-[5px] border border-white/30 bg-[#102447]/70 px-2.5 py-1 text-center text-[11px] font-black uppercase tracking-[0.12em] text-white"
                style={textShadow}
              >
                Enemies Left{' '}
                <span className="text-[#ff5a5a]">{waveProgress.remaining}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {mode === 'playing' && waveMessage && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/10">
          <h2 className="whitespace-pre-line text-center text-5xl font-black uppercase tracking-widest text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.55)] sm:text-6xl">
            {waveMessage}
          </h2>
        </div>
      )}

      {mode === 'playing' && isPaused && (
        <PauseMenu
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onResume={resumeGame}
          onQuit={returnToMainMenu}
        />
      )}

      {mode !== 'playing' && (
        <ThreeDMenu
          mode={mode}
          score={score}
          highScore={highScore}
          wave={wave}
          isNewBest={isNewBest}
          stats={stats}
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onStart={startRun}
        />
      )}
    </div>
  );
}
