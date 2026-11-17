# Build report — GTA VI Twitch CCU forecast (gta6-twitch-ccu-forecast-01)

Built 2026-11-17. Entry program: `main.ts` in this directory. No
submission made, no repo created, no wallet/credentials touched.

## 1. What the kit contains

- Competition: forecast GTA VI's Twitch viewers hour by hour (hours 2..24
  of 2026-11-19 UTC) as five quantiles (0.05/0.25/0.5/0.75/0.95) from
  hour 1's print. Score: pinball loss on the log scale, mean over
  (case, hour, level). A prize needs a loss strictly below the best house
  entry (persistence baseline + a house AI model one-shot). 20 places pay
  ($50/$35/$25/$10×7/$7×10). Program: Node 22 `main.ts` (or Python),
  stdlib only, offline, ≤ 8 s per case, two runs byte-identical.
- Practice cases p00–p03: Marvel's Wolverine (v1 = 23,357), Red Dead
  Redemption 2 (116,550), God of War Ragnarök (269,517), Marvel's
  Spider-Man 2 (119,087). Their actual hours 2..24 are NOT in the files,
  so practice cases cannot be scored directly.
- Comparables: 38 past big launches, identical in all 4 practice files.
  Each has `hourly` points (`from`, `viewers`, `channels`, `reads`) plus
  `day_start`, `unlock` text, `platforms`, `source`. **37 of 38 have a
  complete release-day curve (hours 1..24)**; the 38th ("Grand Theft Auto
  VI category before release") has no release-day hours and is excluded.
  `history`/`history_hourly` are pre-release hourly points ending at the
  hour-1 print; `streams` is null and `categories_hourly` empty in all
  practice files.

## 2. What the data says

Per-hour log-ratios `ln(v_h / v_1)` across the 37 usable launches
(median curve): dips to ~0.73x at hour 4, back to ~1.0x by hour 13,
rises to ~2.4x at hour 19, ~2.0x at hour 24. But the pooled median is
misleading — the launches are extremely heterogeneous:

- Hour-1 size dominates the shape. `ln(v1)` explains the hour-20
  log-ratio with R² = 0.88 (slope ≈ −0.94); R² = 0.83–0.88 for hours
  18–24, only ~0.01–0.03 for hours 2–6.
- Small hour-1 launches explode: Silksong (v1 = 164) peaks 1,732x,
  Kingdom Come II (414) 988x, Helldivers 2 (419) 322x, Black Myth:
  Wukong (4,941) 39x at hour 20. These are simultaneous-global
  unlocks: hour 1 is pre-unlock, nearly dead.
- Huge hour-1 launches stay flat: Elden Ring (875,155) peaks 0.95x,
  Cyberpunk 2077 (851,999) 1.25x, Diablo IV (533,455) 1.24x,
  Hogwarts Legacy (387,358) 1.35x. Rolling-midnight console launches
  sit in between: Zelda (129,948) 2.64x, Ghost of Tsushima (131,910)
  2.25x, Monster Hunter Wilds (152,314) 2.41x at hour 20.
- The pre-release peak / hour-1 ratio barely predicts anything
  (R² = 0.07) and was not used.

## 3. Model (in main.ts)

Fitted at run time from the case file's comparables:

1. Training set: comparables with all 24 release-day hours present and
   viewers > 0 (37 in the practice files).
2. Per hour h = 2..24, two estimators of the log-ratio distribution,
   blended 50/50 in log space:
   - **kNN (k = 8)** by `|ln(v1) − ln(p1)|`: median + Gaussian spread
     (std of the 8 neighbours, floor 0.08).
   - **Per-hour OLS** of log-ratio on `ln(v1)`: fitted median floored
     at the median curve of the 5 largest-v1 launches and capped at the
     largest observed log-ratio that hour; Gaussian spread from the
     residual std (floor 0.08).
3. `q = p1 · exp(blended quantile)`, 2-decimal rounding, clamped to
   [0.01, 1e9], forced non-decreasing per row.
4. Fallbacks: < 8 usable comparables but ≥ 3 → pooled empirical
   quantiles per hour; < 3 → the house baseline's persistence formula.

Why the blend: the regression alone over-predicts the mid-range
(e.g. Wolverine v1 = 23,357 → 10.2x peak, while its neighbours
Yōtei/Stellar Blade peaked 3.3–3.5x); kNN alone is noisy at the
extremes. The blend keeps the regression's smooth extrapolation and
kNN's local sanity.

## 4. Backtest (leave-one-out, `node backtest.cjs`)

Pseudo-cases: each of the 37 launches in turn — known = its hour 1,
comparables = the other 36 — scored against its actual hours 2..24.
The backtest runs the shipped `main.ts` itself (and the starter),
so these are end-to-end numbers, not a reimplementation.

| Model | Mean pinball loss, all 37 | Big-v1 only (>100k, n=16) | v1 > 50k (n=20) | Small-v1 (≤50k, n=17) |
|---|---|---|---|---|
| House baseline (starter) | 0.9297 | 0.2611 | 0.2509 | 1.7282 |
| Pooled empirical quantiles | 0.7139 | — | — | — |
| Pooled median + Gaussian | 0.8032 | — | — | — |
| Regression on ln(v1) | 0.5393 | 0.2536 | 0.2619 | 0.5990 |
| kNN-8 | 0.4194 | 0.2487 | 0.2336 | 0.6381 |
| **Blend kNN-8 + regression (shipped)** | **0.3935** | **0.2307–0.2394** | **0.2289–0.2348** | **0.5802** |

Shipped model: **0.3935 vs baseline 0.9297 — 57.7% better**, wins on
26 of 37 launches. The kit states the house baseline scores ~0.387 on
the 4 practice cases; the model should beat that too (its expected
practice loss is ~0.30–0.33 by the same backtest logic), comfortably
inside the prize gate — though the gate is the *better* of the baseline
and the house AI model one-shot, whose score is unknown.

Practice-case forecasts (median peak ratio): Wolverine 5.4x (h20),
RDR2 1.9x, GoW Ragnarök 1.1x, Spider-Man 2 1.9x. (For scale: the
nearest analogues of RDR2/GTA VI — Zelda, Ghost of Tsushima, Monster
Hunter Wilds — peaked 2.3–2.6x.)

## 5. Validation of the shipped program

- Node 22.18.0 (the grader's major version), `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` set: all 4 practice cases run in **0.33 s
  total** (limit 8 s per case), outputs **byte-identical across two
  runs** (deterministic: no clock, no randomness).
- Format check on all 4 outputs: exactly 23 rows, hours 2..24 each
  once, each row 5 finite numbers, > 0, ≤ 1e9, non-decreasing,
  files 1,456–1,534 bytes (limit 65,536). All VALID.
- `node backtest.cjs` reproduces the headline numbers exactly
  (0.3935 vs 0.9297).
- No network calls in the program (only node:fs / node:path); no
  SullyGnome download was made (per NOTICE.txt); only kit files were
  read.

## 6. Caveats

- **Backtest ≠ practice/final grade.** The backtest scores past
  launches; the practice grade is 4 specific games (answers sealed)
  and the final is a single case (GTA VI). The model's edge is
  largest for small hour-1 prints and modest (~12%) in the big-v1
  regime GTA VI will most likely be in. If GTA VI's hour-1 print is
  enormous (> 900k, beyond the training range), the floor keeps the
  forecast near the flattest big-launch curves rather than collapsing.
- **Mid-range uncertainty is real.** At v1 ≈ 100–300k, past launches'
  peak ratios span ~0.95x–2.6x; the model's spreads are wide there
  (e.g. GoW Ragnarök h20: 0.40x–3.12x) and the median is a compromise.
- **The house AI model one-shot is unknown.** The prize gate is the
  better of the baseline and that model; beating the baseline (shown)
  does not guarantee beating the AI model.
- **Unlock type is not modelled explicitly.** Simultaneous-global
  unlocks explode and rolling-midnight launches don't; the model
  captures this only indirectly through hour-1 size. GTA VI is
  expected to be midnight-local rolling (like RDR2/Zelda), which is
  the regime the neighbours represent best.
- The program trusts the case file's comparables. If the sealed final
  case carried far fewer usable comparables, it degrades gracefully
  (pooled quantiles, then baseline) but the edge would shrink.
