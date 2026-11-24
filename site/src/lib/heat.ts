// A replay of fastdl's speed test, step by step, using the engine's own rules
// (app/src-tauri/src/engine.rs):
//  - the file is cut into one piece per connection;
//  - 4 connections start at once, then one more every 150 ms;
//  - a connection that finishes its piece takes the back half of the biggest
//    piece still being downloaded, unless less than 1 MB of it is left.
// The test server allowed about 2 MB/s per connection; fastdl measured
// 250 MB in 19.0 s (13.1 MB/s), one browser-style connection 1.7 MB/s.

export const FILE_MB = 250;
const BURST = 4;
const RAMP_S = 0.15;
const MIN_SPLIT_MB = 1;

export type Mode = 'fastdl' | 'browser';

export interface Lane {
  started: boolean;
  /** Size of the piece this lane is working on, in MB. */
  size: number;
  /** MB of that piece done. */
  done: number;
  /** MB this lane finished in earlier pieces. */
  base: number;
  /** Current speed, MB/s. */
  speed: number;
  finished: boolean;
}

export interface SplitEvent {
  from: number; // lane whose piece was cut
  to: number; // lane that took the back half
}

export interface Heat {
  mode: Mode;
  lanes: Lane[];
  /** Length of a full lane in MB, a little more than the first pieces, since fast lanes swim further. */
  scale: number;
  t: number;
  received: number;
  finishedAt: number | null;
}

// Each connection's speed wanders a little around its average, the way real
// connections do. Fixed numbers keep every replay identical.
const BASE = [1.92, 1.41, 1.78, 1.36, 1.86, 1.52, 1.97, 1.47];
const PHASE = [0.3, 2.1, 4.0, 1.2, 5.3, 3.1, 0.9, 2.7];
const BROWSER_MBPS = 1.7;
// Tuned so the replay finishes in the measured 19.0 s.
const FASTDL_FACTOR = 1.025;

export function newHeat(mode: Mode): Heat {
  const n = mode === 'fastdl' ? 8 : 1;
  const size = FILE_MB / n;
  return {
    mode,
    scale: size * (mode === 'fastdl' ? 1.3 : 1.04),
    t: 0,
    received: 0,
    finishedAt: null,
    lanes: Array.from({ length: n }, () => ({ started: false, size, done: 0, base: 0, speed: 0, finished: false })),
  };
}

function laneSpeed(heat: Heat, i: number): number {
  if (heat.mode === 'browser') return BROWSER_MBPS;
  const wobble = 1 + 0.09 * Math.sin(heat.t * (0.9 + i * 0.17) + PHASE[i]);
  return BASE[i] * wobble * FASTDL_FACTOR;
}

/** Advance the heat by dt seconds. Returns any splits that happened. */
export function step(heat: Heat, dt: number): SplitEvent[] {
  const splits: SplitEvent[] = [];
  if (heat.finishedAt !== null) return splits;
  heat.t += dt;
  const { lanes } = heat;

  lanes.forEach((lane, i) => {
    if (!lane.started) {
      const startAt = i < BURST ? 0 : (i - BURST + 1) * RAMP_S;
      if (heat.t >= startAt) lane.started = true;
    }
  });

  lanes.forEach((lane, i) => {
    if (!lane.started || lane.finished) { lane.speed = 0; return; }
    lane.speed = laneSpeed(heat, i);
    const add = Math.min(lane.speed * dt, lane.size - lane.done);
    lane.done += add;
    heat.received += add;
    if (lane.done >= lane.size - 1e-9) {
      // Take the back half of the biggest piece still in progress.
      let best = -1;
      let bestLeft = 0;
      lanes.forEach((other, j) => {
        if (j === i || other.finished || !other.started) return;
        const left = other.size - other.done;
        if (left > bestLeft) { best = j; bestLeft = left; }
      });
      if (best >= 0 && bestLeft >= 2 * MIN_SPLIT_MB) {
        const half = bestLeft / 2;
        lanes[best].size -= half;
        lane.base += lane.size;
        lane.size = half;
        lane.done = 0;
        splits.push({ from: best, to: i });
      } else {
        lane.finished = true;
        lane.speed = 0;
      }
    }
  });

  if (lanes.every((l) => l.finished)) {
    heat.received = FILE_MB;
    heat.finishedAt = heat.t;
  }
  return splits;
}

export function totalSpeed(heat: Heat): number {
  return heat.lanes.reduce((sum, l) => sum + l.speed, 0);
}

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
