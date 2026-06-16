import type { GameSettings } from './settings';

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex w-full items-center justify-between rounded-[6px] border-2 border-white/30 bg-black/25 px-4 py-2.5 text-left text-sm font-black uppercase tracking-[0.12em] text-white transition hover:bg-black/35"
    >
      <span>{label}</span>
      <span
        className={`flex h-6 w-11 items-center rounded-full border-2 px-0.5 transition ${
          value ? 'border-[#35e66d] bg-[#35e66d]/30' : 'border-white/40 bg-black/40'
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition-transform ${
            value ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}

export function SettingsPanel({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (next: Partial<GameSettings>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[6px] border-2 border-white/30 bg-black/25 px-4 py-3">
        <div className="flex items-center justify-between text-sm font-black uppercase tracking-[0.12em] text-white">
          <span>Master Volume</span>
          <span className="text-[#ffe66d]">{Math.round(settings.masterVolume * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.masterVolume * 100)}
          onChange={(e) => onChange({ masterVolume: Number(e.target.value) / 100 })}
          className="mt-2 w-full accent-[#ff3344]"
          aria-label="Master volume"
        />
      </div>

      <Toggle
        label="Mute Audio"
        value={settings.muted}
        onChange={(muted) => onChange({ muted })}
      />
      <Toggle
        label="Invert Aim Y"
        value={settings.invertedY}
        onChange={(invertedY) => onChange({ invertedY })}
      />
      <Toggle
        label="High Quality (Bloom)"
        value={settings.highQuality}
        onChange={(highQuality) => onChange({ highQuality })}
      />
    </div>
  );
}
