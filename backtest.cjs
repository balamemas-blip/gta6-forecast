// Leave-one-out backtest of the shipped main.ts (and the house baseline).
//
// For each of the 37 past launches in the kit with a complete release-day
// curve, builds a pseudo-case: known = that launch's hour-1 print,
// comparables = the other 36 launches. Runs main.ts (this directory) and the
// kit starter on all pseudo-cases, then scores the mean pinball loss on the
// log scale against each launch's actual hours 2..24.
//
// Usage (from this directory):
//   node backtest.cjs [kit-input-dir]
// Default kit input dir:
//   ~/workspace/makefun/gta6-forecast-kit/gta6-twitch-ccu-forecast-01-kit/input
// Needs node >= 22.18 (type stripping for main.ts). Writes temp files under
// /tmp/gta-backtest-* only; nothing is submitted anywhere.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KIT_INPUT = process.argv[2] || path.join(
  process.env.HOME || '/home/hatch',
  'workspace/makefun/gta6-forecast-kit/gta6-twitch-ccu-forecast-01-kit/input',
);
const STARTER = path.join(KIT_INPUT, '..', 'starter', 'main.ts');
const MAIN_TS = path.join(__dirname, 'main.ts');
const NODE = process.execPath; // node running this script (>= 22.18)
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

function dayHours(comp) {
  const t0 = Date.parse(comp.day_start);
  const m = new Map();
  for (const p of comp.hourly) {
    const t = Date.parse(p.from);
    const dh = (t - t0) / 3600000;
    if (Number.isInteger(dh) && dh >= 0 && dh < 24 && p.viewers > 0) m.set(dh + 1, p.viewers);
  }
  return m;
}

function pinball(y, q, tau) {
  const d = Math.log(y) - Math.log(Math.max(q, 0.01));
  return 2 * Math.max(tau * d, (tau - 1) * d);
}

const c0 = JSON.parse(fs.readFileSync(path.join(KIT_INPUT, 'p00.in'), 'utf8'));
const usable = [];
for (const comp of c0.comparables) {
  const h = dayHours(comp);
  if (h.size === 24) usable.push({ comp, hours: h });
}

const base = '/tmp/gta-backtest';
const inDir = `${base}-in`, outModel = `${base}-out-model`, outBase = `${base}-out-base`;
for (const d of [inDir, outModel, outBase]) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}
usable.forEach(({ comp }, i) => {
  const others = usable.filter((_, j) => j !== i).map((x) => x.comp);
  const h = dayHours(comp);
  const kase = {
    schema: 'makefun/twitch-ccu-case/v1',
    id: `x${String(i).padStart(2, '0')}`,
    game: { name: comp.name, twitch_id: '0' },
    day_start: comp.day_start,
    checkpoint: comp.day_start,
    levels: LEVELS,
    known: [{ hour: 1, from: comp.day_start, until: comp.day_start, viewers: h.get(1), channels: 0, reads: 1 }],
    forecast: Array.from({ length: 23 }, (_, k) => ({ hour: k + 2 })),
    history: [],
    history_hourly: [],
    streams: null,
    categories_hourly: [],
    comparables: others,
    notes: 'pseudo-case for backtest',
  };
  fs.writeFileSync(`${inDir}/x${String(i).padStart(2, '0')}.in`, JSON.stringify(kase));
});

function run(prog, outDir) {
  execFileSync(NODE, [prog], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir },
    stdio: 'pipe',
  });
}
run(MAIN_TS, outModel);
run(STARTER, outBase);

function score(outDir) {
  let tot = 0, n = 0;
  const per = [];
  usable.forEach(({ comp, hours }, i) => {
    const o = JSON.parse(fs.readFileSync(`${outDir}/x${String(i).padStart(2, '0')}.out`, 'utf8'));
    let t = 0, m = 0;
    for (const row of o.hours) {
      const y = hours.get(row.hour);
      for (let j = 0; j < 5; j++) { t += pinball(y, row.q[j], LEVELS[j]); m++; }
    }
    per.push([comp.name, t / m]);
    tot += t; n += m;
  });
  return { mean: tot / n, per };
}

const m = score(outModel);
const b = score(outBase);
console.log(`pseudo-cases: ${usable.length}`);
console.log(`MODEL    mean pinball (LOO): ${m.mean.toFixed(4)}`);
console.log(`BASELINE mean pinball (LOO): ${b.mean.toFixed(4)}`);
console.log(`improvement: ${((1 - m.mean / b.mean) * 100).toFixed(1)}%`);
console.log(`model wins on ${m.per.filter((_, i) => m.per[i][1] < b.per[i][1]).length} of ${usable.length} pseudo-cases`);
for (let i = 0; i < usable.length; i++) {
  console.log(` ${usable[i].comp.name.padEnd(42)} ${m.per[i][1].toFixed(3)} ${b.per[i][1].toFixed(3)}`);
}
