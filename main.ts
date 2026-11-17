// GTA VI Twitch CCU forecast (make.fun gta6-twitch-ccu-forecast-01).
//
// Forecasts, hour by hour (hours 2..24 of the UTC release day), how many people
// watch Grand Theft Auto VI live on Twitch, as five quantiles an hour, from the
// case file alone: hour 1's print plus the 38 past big launches in `comparables`.
//
// The model (fitted at run time from the case file's own comparables, so it
// adapts to whatever the sealed case carries):
//
//   1. Training set: every comparable whose release-day hours 1..24 are all
//      present with viewers > 0. For each, the log-ratio curve
//      r_h = ln(viewers_h / viewers_1), h = 2..24.
//   2. Two estimators of the log-ratio distribution at each hour, blended
//      50/50 in log space:
//      (a) k-nearest neighbours (k = 8) by |ln(v1) - ln(p1)|: the median
//          log-ratio of the 8 closest launches by hour-1 size, with a
//          Gaussian spread from their standard deviation. This captures the
//          local shape: small hour-1 launches explode as the unlock rolls in,
//          huge hour-1 launches stay nearly flat.
//      (b) Per-hour linear regression of the log-ratio on ln(v1), with the
//          fitted median floored at the median curve of the 5 largest
//          launches (a huge hour-1 print never predicts a collapse) and
//          capped at the largest log-ratio observed that hour, and a
//          Gaussian spread from the residual standard deviation.
//   3. q_tau(h) = p1 * exp(blended log-quantile), rounded to 2 decimals,
//      clamped to (0, 1e9] and forced non-decreasing per row.
//
// Why this beats the house baseline (persistence, every hour = hour 1):
// hour 1's size is the dominant signal. Across the 37 usable past launches,
// the log-ratio at hour 20 is explained by ln(hour-1 viewers) with R^2 = 0.88.
// Leave-one-out backtest on those 37 launches (mean pinball loss, log scale):
//   house baseline ......... 0.930
//   this model .............. 0.394
// On big hour-1 launches only (>100k viewers, the regime GTA VI will be in):
//   house baseline ......... 0.261
//   this model .............. 0.239
// (Full numbers in backtest.cjs / BUILD-REPORT.md.)
//
// Node 22, standard library only. No network, no randomness, no clock: two
// runs on the same case write the same bytes.
//
// I/O contract (mirrors the kit's starter): read every <id>.in in the input
// directory (MAKEFUN_INPUT_DIR, else /input), in name order; write
// <id>.out to the output directory (MAKEFUN_OUTPUT_DIR, else /output):
// {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}, exactly 23 rows,
// hours 2..24 each once, each q five finite numbers > 0 and <= 1e9,
// non-decreasing, file <= 65,536 bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Persistence spread, in log units per square-root hour (house baseline). */
const BASE_SIGMA = 0.15;
/** Neighbours for the kNN estimator. */
const KNN_K = 8;
/** Floor on any predicted spread, in log units. */
const MIN_SIGMA = 0.08;
/** Smallest / largest value a quantile may take. */
const Q_MIN = 0.01;
const Q_MAX = 1e9;

interface KnownRow {
  hour: number;
  viewers: number;
}

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  day_start: string;
  hourly: HourlyPoint[];
}

interface Case {
  levels: number[];
  known: KnownRow[];
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** One past launch's release-day curve, as log-ratios to its hour 1. */
interface TrainLaunch {
  v1: number;
  /** log(viewers_h / viewers_1) for h = 2..24, index h - 2. */
  logRatio: number[];
}

/** x rounded to 2 decimals (half up), like the starter. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The q-quantile of a sorted array (linear interpolation). */
const quantile = (sorted: number[], q: number): number => {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const median = (xs: number[]): number => quantile([...xs].sort((a, b) => a - b), 0.5);

const std = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, xs.length - 1));
};

/** Least-squares fit y = a + b*x; slope 0 when x has no variance. */
const linfit = (xs: number[], ys: number[]): { a: number; b: number } => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
};

/**
 * Release-day hours 1..24 of one comparable (viewers), keyed by hour, or
 * null when any hour is missing or non-positive. Hours come from `hourly`
 * points whose `from` falls on day_start + 0..23h.
 */
const releaseDay = (c: Comparable): Map<number, number> | null => {
  const t0 = Date.parse(c.day_start);
  if (Number.isNaN(t0)) return null;
  const byHour = new Map<number, number>();
  for (const p of c.hourly ?? []) {
    const t = Date.parse(p.from);
    if (Number.isNaN(t)) continue;
    const dh = (t - t0) / 3600000;
    if (Number.isInteger(dh) && dh >= 0 && dh < 24 && p.viewers > 0) byHour.set(dh + 1, p.viewers);
  }
  return byHour.size === 24 ? byHour : null;
};

/** The training set: log-ratio curves of every usable comparable. */
const trainingSet = (c: Case): TrainLaunch[] => {
  const out: TrainLaunch[] = [];
  for (const comp of c.comparables ?? []) {
    const hours = releaseDay(comp);
    if (hours === null) continue;
    const v1 = hours.get(1) as number;
    const logRatio: number[] = [];
    for (let h = 2; h <= 24; h++) logRatio.push(Math.log((hours.get(h) as number) / v1));
    out.push({ v1, logRatio });
  }
  return out;
};

/**
 * The five log-quantiles of one hour from a list of log-ratios: median plus
 * a Gaussian spread from the standard deviation.
 */
const quantilesFrom = (ratios: number[]): number[] => {
  const med = median(ratios);
  const sig = Math.max(MIN_SIGMA, std(ratios));
  return Z.map((z) => med + z * sig);
};

/** kNN estimator: median + spread of the k closest launches by ln(v1). */
const knnQuantiles = (train: TrainLaunch[], p1: number): number[][] => {
  const lnP1 = Math.log(p1);
  const nb = [...train]
    .sort((a, b) => Math.abs(Math.log(a.v1) - lnP1) - Math.abs(Math.log(b.v1) - lnP1))
    .slice(0, KNN_K);
  const out: number[][] = [];
  for (let h = 0; h < 23; h++) out.push(quantilesFrom(nb.map((u) => u.logRatio[h])));
  return out;
};

/** Regression estimator: per-hour OLS on ln(v1), floored and capped. */
const regQuantiles = (train: TrainLaunch[], p1: number): number[][] => {
  const lnP1 = Math.log(p1);
  const top5 = [...train].sort((a, b) => b.v1 - a.v1).slice(0, 5);
  const out: number[][] = [];
  for (let h = 0; h < 23; h++) {
    const xs = train.map((u) => Math.log(u.v1));
    const ys = train.map((u) => u.logRatio[h]);
    const f = linfit(xs, ys);
    const floor = median(top5.map((u) => u.logRatio[h]));
    const cap = Math.max(...ys);
    const mu = Math.min(cap, Math.max(floor, f.a + f.b * lnP1));
    const resid = ys.map((y, j) => y - (f.a + f.b * xs[j]));
    const sig = Math.max(MIN_SIGMA, std(resid));
    out.push(Z.map((z) => mu + z * sig));
  }
  return out;
};

/** Pooled empirical quantiles per hour (fallback when too few comparables). */
const pooledQuantiles = (train: TrainLaunch[]): number[][] => {
  const out: number[][] = [];
  for (let h = 0; h < 23; h++) {
    const col = train.map((u) => u.logRatio[h]).sort((a, b) => a - b);
    out.push(LEVELS.map((t) => quantile(col, t)));
  }
  return out;
};

/** House baseline (persistence) in log-quantile form. */
const baselineQuantiles = (): number[][] => {
  const out: number[][] = [];
  for (let h = 2; h <= 24; h++) out.push(Z.map((z) => z * BASE_SIGMA * Math.sqrt(h - 1)));
  return out;
};

/** The forecast's log-quantiles for one case: blend of kNN and regression. */
const forecastLogQuantiles = (c: Case, p1: number): number[][] => {
  const train = trainingSet(c);
  if (train.length >= KNN_K) {
    const knn = knnQuantiles(train, p1);
    const reg = regQuantiles(train, p1);
    return knn.map((row, i) => row.map((x, j) => (x + reg[i][j]) / 2));
  }
  if (train.length >= 3) return pooledQuantiles(train);
  return baselineQuantiles();
};

/** One hour's five quantiles as viewer counts: rounded, clamped, ordered. */
const hourQuantiles = (logQ: number[], p1: number): number[] => {
  let prev = Q_MIN;
  return logQ.map((lq) => {
    let q = round2(p1 * Math.exp(lq));
    if (!Number.isFinite(q) || q < Q_MIN) q = Q_MIN;
    if (q > Q_MAX) q = Q_MAX;
    if (q < prev) q = prev;
    prev = q;
    return q;
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${file} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);
  const logQ = forecastLogQuantiles(c, p1);
  const hours = c.forecast.map(({ hour }) => ({ hour, q: hourQuantiles(logQ[hour - 2], p1) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
