/**
 * Persistent game settings backed by localStorage.
 *
 * Settings are stored under a single key and broadcast to the game engine via
 * the `helistrike:settings` CustomEvent that GameEngine already listens for.
 */

export type GameSettings = {
  masterVolume: number; // 0..1
  muted: boolean;
  invertedY: boolean;
  highQuality: boolean;
};

const STORAGE_KEY = 'helistrike:settings';

export const DEFAULT_SETTINGS: GameSettings = {
  masterVolume: 0.5,
  muted: false,
  invertedY: false,
  highQuality: false,
};

export function loadSettings(): GameSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return {
      masterVolume:
        typeof parsed.masterVolume === 'number'
          ? Math.max(0, Math.min(1, parsed.masterVolume))
          : DEFAULT_SETTINGS.masterVolume,
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
      invertedY:
        typeof parsed.invertedY === 'boolean' ? parsed.invertedY : DEFAULT_SETTINGS.invertedY,
      highQuality:
        typeof parsed.highQuality === 'boolean'
          ? parsed.highQuality
          : DEFAULT_SETTINGS.highQuality,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: GameSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures (private mode, quota, etc.)
  }
}

/** Pushes the current settings to the running GameEngine. */
export function applySettingsToEngine(settings: GameSettings) {
  window.dispatchEvent(new CustomEvent('helistrike:settings', { detail: settings }));
}
