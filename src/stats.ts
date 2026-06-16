/**
 * Lightweight player profile persisted to localStorage.
 *
 * Tracks aggregate stats across runs so the menu can show progression.
 */

export type PlayerStats = {
  gamesPlayed: number;
  bestScore: number;
  bestWave: number;
  bestCombo: number;
  totalScore: number;
  lastPlayed: number; // epoch ms
};

const STORAGE_KEY = 'helistrike:stats';

export const EMPTY_STATS: PlayerStats = {
  gamesPlayed: 0,
  bestScore: 0,
  bestWave: 0,
  bestCombo: 0,
  totalScore: 0,
  lastPlayed: 0,
};

export function loadStats(): PlayerStats {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_STATS };
    const parsed = JSON.parse(raw) as Partial<PlayerStats>;
    return {
      gamesPlayed: Number(parsed.gamesPlayed) || 0,
      bestScore: Number(parsed.bestScore) || 0,
      bestWave: Number(parsed.bestWave) || 0,
      bestCombo: Number(parsed.bestCombo) || 0,
      totalScore: Number(parsed.totalScore) || 0,
      lastPlayed: Number(parsed.lastPlayed) || 0,
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

/** Folds a finished run into the stored profile and returns the updated stats. */
export function recordRun(run: {
  score: number;
  wave: number;
  combo: number;
}): PlayerStats {
  const current = loadStats();
  const updated: PlayerStats = {
    gamesPlayed: current.gamesPlayed + 1,
    bestScore: Math.max(current.bestScore, run.score),
    bestWave: Math.max(current.bestWave, run.wave),
    bestCombo: Math.max(current.bestCombo, run.combo),
    totalScore: current.totalScore + Math.max(0, run.score),
    lastPlayed: Date.now(),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures.
  }
  return updated;
}
