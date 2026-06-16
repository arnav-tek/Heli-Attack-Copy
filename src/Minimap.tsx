import { useEffect, useRef } from 'react';

export type RadarBlip = {
  x: number; // world-space offset from player (east/west)
  z: number; // world-space offset from player (north/south, -z is forward)
  type: number; // EnemyType ordinal
};

export type RadarData = {
  heading: number; // player yaw in radians (unused: radar is world-fixed)
  blips: RadarBlip[];
  range: number; // world units mapped to the radar edge
};

const SIZE = 150; // px, canvas render size

// Enemy type -> blip colour. Mirrors EnemyType: BASIC, SHOOTER, TANK, DRONE, BOSS.
const BLIP_COLORS = ['#ff5a5a', '#ffd23b', '#ff8c3b', '#9b6bff', '#ff2d6f'];

/**
 * World-fixed top-down radar. The player sits at the centre and forward (the
 * direction the world scrolls toward, world -Z) always points up. Enemies are
 * drawn as coloured blips. The radar deliberately does NOT rotate with the
 * helicopter's heading, because the chopper constantly turns to face the
 * cursor — rotating the map by that heading would make every blip spin.
 */
export function Minimap({ radar }: { radar: RadarData | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== SIZE * dpr) {
      canvas.width = SIZE * dpr;
      canvas.height = SIZE * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const radius = SIZE / 2 - 4;

    // Dish background.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8, 24, 40, 0.66)';
    ctx.fill();

    // Range rings.
    ctx.strokeStyle = 'rgba(127, 246, 255, 0.20)';
    ctx.lineWidth = 1;
    for (const r of [radius * 0.5, radius]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Cross hairs.
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.stroke();

    // "FWD" marker at the top so the player knows up = ahead.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = '700 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FWD', cx, cy - radius + 11);

    const range = radar?.range ?? 240;

    if (radar) {
      for (const blip of radar.blips) {
        // World-fixed mapping: east/west -> screen X, forward(-z) -> up.
        let px = cx + (blip.x / range) * radius;
        let py = cy + (blip.z / range) * radius;

        // Clamp out-of-range blips to the rim so the player still sees a bearing.
        const dx = px - cx;
        const dy = py - cy;
        const dist = Math.hypot(dx, dy);
        const edge = radius - 3;
        if (dist > edge && dist > 0) {
          px = cx + (dx / dist) * edge;
          py = cy + (dy / dist) * edge;
        }

        const isBoss = blip.type === 4;
        const color = BLIP_COLORS[blip.type] ?? '#ff5a5a';
        ctx.beginPath();
        ctx.arc(px, py, isBoss ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (isBoss) {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
      }
    }

    // Player marker: a triangle at centre pointing up (forward).
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7);
    ctx.lineTo(cx + 5, cy + 6);
    ctx.lineTo(cx, cy + 3);
    ctx.lineTo(cx - 5, cy + 6);
    ctx.closePath();
    ctx.fillStyle = '#7ff6ff';
    ctx.fill();

    // Rim.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [radar]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: SIZE, height: SIZE }}
      className="rounded-full border-2 border-white/40 shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
    />
  );
}
