/**
 * Signal analysis for captured time series.
 *
 * Exists because "the bob feels terrible" is not actionable and screenshots of
 * a moving camera are not evidence. A capture turns a subsystem into numbers;
 * this turns the numbers into the handful of facts that decide what to change:
 * how big it is, how fast it repeats, how CLEANLY it repeats, whether one axis
 * runs at twice another, and whether the motion is smooth or jerky.
 *
 * Deliberately plain maths: a direct DFT is O(n*k), and a capture is a few
 * hundred samples, so an FFT would add a dependency to save microseconds.
 */

export interface ChannelStats {
  name: string;
  n: number;
  min: number;
  max: number;
  mean: number;
  /** Peak-to-peak. The number that answers "how big is this, really". */
  range: number;
  /** RMS about the mean: amplitude with the DC offset removed. */
  rms: number;
  /** Strongest frequency in Hz, or null when the channel is flat/too short. */
  dominantHz: number | null;
  /** Energy at 2*f0 relative to f0. ~1 means the axis runs at double rate. */
  secondHarmonicRatio: number | null;
  /**
   * Normalised autocorrelation at one dominant period, in [-1, 1]. Near 1 is a
   * metronome; near 0 means it never really repeats.
   */
  periodicity: number | null;
  /**
   * RMS of the second difference over RMS of the signal, per sample. Low is
   * smooth, high is jerky. Scale-free, so channels are comparable.
   */
  roughness: number;
  /** True when the channel never moves: a dead input, usually a wiring bug. */
  constant: boolean;
}

export interface PairStats {
  a: string;
  b: string;
  /** Pearson correlation over the whole window. */
  correlation: number;
  /** Phase of b minus phase of a at the shared dominant frequency, degrees. */
  phaseDeg: number | null;
}

export interface SignalReport {
  sampleCount: number;
  durationSec: number;
  sampleHz: number;
  channels: ChannelStats[];
  pairs: PairStats[];
  notes: string[];
}

const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / (x.length || 1);

function rms(x: number[]): number {
  if (!x.length) return 0;
  return Math.sqrt(x.reduce((a, b) => a + b * b, 0) / x.length);
}

/** Magnitude and phase of `x` at `hz`, by direct correlation with a complex sinusoid. */
function goertzel(x: number[], dt: number, hz: number): { mag: number; phase: number } {
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i += 1) {
    const w = 2 * Math.PI * hz * i * dt;
    re += x[i] * Math.cos(w);
    im -= x[i] * Math.sin(w);
  }
  const norm = 2 / x.length;
  re *= norm;
  im *= norm;
  return { mag: Math.hypot(re, im), phase: Math.atan2(im, re) };
}

/**
 * Strongest frequency, searched over whole-cycle bins only.
 *
 * Starting at k=1 (one full cycle in the window) rather than k=0 keeps a DC
 * offset or a slow drift from swamping the real oscillation, which is exactly
 * what a camera bob riding a moving character looks like.
 */
function dominantFrequency(detrended: number[], dt: number): { hz: number; mag: number } | null {
  const n = detrended.length;
  if (n < 8) return null;
  const maxK = Math.floor(n / 2) - 1;
  if (maxK < 1) return null;
  let bestK = 0;
  let bestMag = 0;
  for (let k = 1; k <= maxK; k += 1) {
    const hz = k / (n * dt);
    const { mag } = goertzel(detrended, dt, hz);
    if (mag > bestMag) {
      bestMag = mag;
      bestK = k;
    }
  }
  if (bestK === 0) return null;
  return { hz: bestK / (n * dt), mag: bestMag };
}

function autocorrAtLag(x: number[], lag: number): number | null {
  const n = x.length;
  if (lag < 1 || lag >= n) return null;
  let num = 0;
  let den = 0;
  for (let i = 0; i + lag < n; i += 1) num += x[i] * x[i + lag];
  for (let i = 0; i < n; i += 1) den += x[i] * x[i];
  if (den === 0) return null;
  return num / den;
}

export function analyzeChannel(name: string, raw: number[], dt: number): ChannelStats {
  const n = raw.length;
  const mu = mean(raw);
  const detr = raw.map((v) => v - mu);
  const min = Math.min(...raw);
  const max = Math.max(...raw);
  const sigRms = rms(detr);
  const constant = max - min < 1e-12;

  let dominantHz: number | null = null;
  let secondHarmonicRatio: number | null = null;
  let periodicity: number | null = null;

  if (!constant) {
    const dom = dominantFrequency(detr, dt);
    if (dom && dom.mag > 0) {
      dominantHz = dom.hz;
      const second = goertzel(detr, dt, dom.hz * 2);
      secondHarmonicRatio = second.mag / dom.mag;
      const lag = Math.round(1 / (dom.hz * dt));
      periodicity = autocorrAtLag(detr, lag);
    }
  }

  // Second difference: curvature per sample. Normalising by signal RMS makes a
  // 0.01-stud channel and a 5-degree channel directly comparable.
  let d2: number[] = [];
  for (let i = 2; i < n; i += 1) d2.push(raw[i] - 2 * raw[i - 1] + raw[i - 2]);
  const roughness = sigRms > 0 ? rms(d2) / sigRms : 0;

  return {
    name,
    n,
    min,
    max,
    mean: mu,
    range: max - min,
    rms: sigRms,
    dominantHz,
    secondHarmonicRatio,
    periodicity,
    roughness,
    constant,
  };
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** Wrap to (-180, 180] so a lag reads as the smaller of the two directions. */
function wrapDeg(d: number): number {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

export function analyzeSignals(
  channels: Record<string, number[]>,
  t?: number[],
  opts: { maxPairs?: number } = {},
): SignalReport {
  const names = Object.keys(channels);
  const notes: string[] = [];
  const lengths = names.map((k) => channels[k].length);
  const n = lengths.length ? Math.min(...lengths) : 0;

  let dt = 1 / 60;
  let duration = n * dt;
  if (t && t.length >= 2) {
    duration = t[t.length - 1] - t[0];
    dt = duration / Math.max(1, t.length - 1);
  }
  if (!(dt > 0) || !Number.isFinite(dt)) {
    dt = 1 / 60;
    notes.push("sample spacing was unusable; assumed 60Hz");
  }

  const stats = names.map((k) => analyzeChannel(k, channels[k].slice(0, n), dt));

  for (const s of stats) {
    if (s.constant) notes.push(`${s.name} never changes — check it is actually wired to something`);
  }

  // Pair against the channel with the most energy: phase only means something
  // relative to a reference, and the loudest channel is the honest one.
  const pairs: PairStats[] = [];
  const ranked = [...stats].filter((s) => !s.constant).sort((a, b) => b.rms - a.rms);
  const ref = ranked[0];
  if (ref && ref.dominantHz) {
    const refSeries = channels[ref.name].slice(0, n);
    const refPhase = goertzel(refSeries.map((v) => v - ref.mean), dt, ref.dominantHz).phase;
    const limit = opts.maxPairs ?? 12;
    for (const s of ranked.slice(1, 1 + limit)) {
      const series = channels[s.name].slice(0, n);
      const ph = goertzel(series.map((v) => v - s.mean), dt, ref.dominantHz).phase;
      pairs.push({
        a: ref.name,
        b: s.name,
        correlation: correlation(refSeries, series),
        phaseDeg: wrapDeg(((ph - refPhase) * 180) / Math.PI),
      });
    }
    notes.push(`phase and correlation are relative to '${ref.name}' at ${ref.dominantHz.toFixed(3)} Hz`);
  }

  return {
    sampleCount: n,
    durationSec: duration,
    sampleHz: 1 / dt,
    channels: stats,
    pairs,
    notes,
  };
}
