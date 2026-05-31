import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GameEngine } from './game';

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

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[4px] border border-white/30 bg-white/14 px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white shadow-[0_2px_0_rgba(0,0,0,0.25)]">
      {children}
    </span>
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
  onStart,
}: {
  mode: GameMode;
  score: number;
  highScore: number;
  wave: number;
  isNewBest: boolean;
  onStart: () => void;
}) {
  const isGameOver = mode === 'gameover';

  return (
    <div
      className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-gradient-to-b from-[#9fdce8]/30 via-[#7fd9e6]/20 to-[#20417f]/35 px-4"
      onPointerDown={onStart}
    >
      <div className="menu-perspective">
        <div className="menu-rig">
          <div className="menu-card">
            <div className="menu-title-slab">
              <span>{isGameOver ? 'Run Ended' : 'Heli-Strike'}</span>
            </div>

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

            <div className="mt-5 flex justify-center">
              <MenuButton onClick={onStart}>{isGameOver ? 'Restart' : 'Start'}</MenuButton>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-sm font-black uppercase tracking-[0.12em] text-white/95">
              <div className="menu-chip">WASD Move</div>
              <div className="menu-chip">Mouse Aim</div>
              <div className="menu-chip">Space/Q Alt</div>
              <div className="menu-chip">Click Fire</div>
            </div>
          </div>
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

  useEffect(() => {
    setHighScore(readHighScore());
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new GameEngine(canvasRef.current);
    engineRef.current = engine;

    const handleUpdate = (e: CustomEvent) => {
      const nextScore = e.detail.score;
      setScore(nextScore);
      setWave(e.detail.wave);
      setWaveMessage(e.detail.playing ? e.detail.message : null);
      setWeaponInfo(e.detail.weapon || null);
      setComboInfo(e.detail.combo || null);
      setHighScore((prev) => {
        if (nextScore <= prev) return prev;
        window.localStorage.setItem('helistrike:highScore', String(nextScore));
        return nextScore;
      });
    };

    const handleGameOver = (e: CustomEvent) => {
      const finalScore = e.detail.score;
      setMode('gameover');
      setIsNewBest(finalScore >= readHighScore() && finalScore > 0);
      setHighScore((prev) => Math.max(prev, finalScore));
    };

    const handleStats = (e: CustomEvent) => {
      setHealth(e.detail.currentHealth);
      setFuel(e.detail.currentFuel);
    };

    window.addEventListener('helistrike:update', handleUpdate as EventListener);
    window.addEventListener('helistrike:stats', handleStats as EventListener);
    window.addEventListener('helistrike:gameover', handleGameOver as EventListener);

    return () => {
      window.removeEventListener('helistrike:update', handleUpdate as EventListener);
      window.removeEventListener('helistrike:stats', handleStats as EventListener);
      window.removeEventListener('helistrike:gameover', handleGameOver as EventListener);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const startRun = () => {
    setMode('playing');
    setIsNewBest(false);
    engineRef.current?.startGame();
  };

  const returnToMainMenu = () => {
    setMode('menu');
    setIsNewBest(false);
    engineRef.current?.setPaused(true);
  };

  const coins = Math.floor(score / 100);
  const textShadow = { textShadow: '0 2px 0 rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.35)' };
  const hudDim = mode !== 'playing' ? 'opacity-35' : 'opacity-100';

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#9fdce8] font-sans text-white pointer-events-auto select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full touch-none" />
      <div className="arcade-scanlines pointer-events-none absolute inset-0" />
      <div className="arcade-vignette pointer-events-none absolute inset-0" />

      <div className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${hudDim}`}>
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
      </div>

      {mode === 'playing' && waveMessage && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10">
          <h2 className="whitespace-pre-line text-center text-5xl font-black uppercase tracking-widest text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.55)] sm:text-6xl">
            {waveMessage}
          </h2>
        </div>
      )}

      {mode !== 'playing' && (
        <ThreeDMenu mode={mode} score={score} highScore={highScore} wave={wave} isNewBest={isNewBest} onStart={startRun} />
      )}
    </div>
  );
}
