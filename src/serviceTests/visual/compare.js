'use strict';

const { decodePng, PngError } = require('./png');

// Comparing a screenshot against its baseline (V2 §8).
//
// The spec's own warning is the whole design problem: it "must not turn small
// dynamic differences into false failures". Every visual regression tool that
// gets switched off is switched off for the same reason — a clock, a carousel,
// an A/B test or one pixel of antialiasing turns the build red, somebody adds
// `--ignore-visual`, and nobody looks at it again.
//
// So this is deliberately reluctant. Four defences, in order:
//
//   1. A per-pixel colour tolerance, so antialiasing and sub-pixel text
//      rendering are not differences.
//   2. Ignore regions the operator draws over the parts they know move.
//   3. A percentage threshold, so a handful of changed pixels is not a report.
//   4. A difference is a WARNING and never a failure. The run's status stays
//      about whether the service works; a moved button is not an outage.
//
// PURE: two buffers and a config in, a verdict out. No disk, no clock, no
// database — every judgement lives here where it can be argued with in a test.

// How different two pixels must be before they count. Below this is
// antialiasing, sub-pixel text rendering and JPEG-ish noise — the things that
// differ between two screenshots of an unchanged page.
const DEFAULT_TOLERANCE = 12;      // 0-255, per-channel distance
const DEFAULT_THRESHOLD_PCT = 0.5; // % of compared pixels that must differ

// Alpha below this is "not really there". A fade halfway through is a different
// picture; a 2% ghost is not.
const ALPHA_FLOOR = 8;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Normalises the rectangles an operator drew. Out-of-range and inverted ones are
// repaired rather than refused: a region drawn slightly off the edge is obviously
// meant to reach the edge, and failing the whole comparison over it would be
// pedantry with a real cost.
function normalizeRegions(regions, width, height) {
  if (!Array.isArray(regions)) return [];
  const out = [];
  for (const r of regions) {
    if (!r || typeof r !== 'object') continue;
    // Both EDGES are clamped, not the origin and then the extent. Clamping the
    // origin first turns a rectangle that lies entirely off the page into a
    // valid box at 0,0 — silently excluding a part of the page the operator
    // never selected, which is the one mistake an ignore region must not make.
    // Clamped as edges, a wholly-off-page rectangle collapses and is dropped.
    const x1 = clamp(Math.floor(Number(r.x) || 0), 0, width);
    const y1 = clamp(Math.floor(Number(r.y) || 0), 0, height);
    const x2 = clamp(Math.floor(Number(r.x) || 0) + Math.floor(Number(r.width) || 0), 0, width);
    const y2 = clamp(Math.floor(Number(r.y) || 0) + Math.floor(Number(r.height) || 0), 0, height);
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({ x1, y1, x2, y2, label: typeof r.label === 'string' ? r.label.slice(0, 80) : null });
  }
  return out;
}

// A lookup of which pixels are excluded. A per-pixel loop over every region
// would be O(pixels × regions); a bitmap makes it O(pixels), which matters at
// two million of them.
function maskFor(regions, width, height) {
  if (!regions.length) return null;
  const mask = new Uint8Array(width * height);
  for (const r of regions) {
    for (let y = r.y1; y < r.y2; y += 1) {
      mask.fill(1, y * width + r.x1, y * width + r.x2);
    }
  }
  return mask;
}

// Two pixels differ when any channel moves by more than the tolerance.
//
// Per-channel rather than a Euclidean distance on purpose: a pure hue change
// (red button turns green) moves two channels a long way and would be diluted
// by averaging into something under the threshold. The thing a person would
// obviously call "different" must not be the thing the maths smooths away.
function pixelDiffers(a, b, at, tolerance) {
  const alphaA = a[at + 3];
  const alphaB = b[at + 3];
  // Both effectively transparent: whatever colour is underneath is not visible,
  // so it is not a difference anybody can see.
  if (alphaA < ALPHA_FLOOR && alphaB < ALPHA_FLOOR) return false;
  if (Math.abs(alphaA - alphaB) > tolerance) return true;
  return Math.abs(a[at] - b[at]) > tolerance
    || Math.abs(a[at + 1] - b[at + 1]) > tolerance
    || Math.abs(a[at + 2] - b[at + 2]) > tolerance;
}

// Where the changes are, as a few boxes rather than a pixel list.
//
// A coarse grid, not connected-component labelling: the question a person asks
// is "which part of the page moved", and sixteen cells answer it. A precise
// outline of every changed pixel would be a bigger answer to a smaller question.
const GRID = 8;

function regionsOfChange(changed, width, height) {
  const cellW = Math.max(1, Math.ceil(width / GRID));
  const cellH = Math.max(1, Math.ceil(height / GRID));
  const cells = new Map();
  for (const index of changed) {
    const x = index % width;
    const y = (index - x) / width;
    const key = `${Math.floor(y / cellH)}:${Math.floor(x / cellW)}`;
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  return [...cells.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => {
      const [row, col] = key.split(':').map(Number);
      return {
        x: col * cellW,
        y: row * cellH,
        width: Math.min(cellW, width - col * cellW),
        height: Math.min(cellH, height - row * cellH),
        pixels: count,
      };
    });
}

// Compares a screenshot against its baseline.
//
//   compareScreenshots(baselineBuf, currentBuf, {
//     tolerance, thresholdPct, ignoreRegions: [{x,y,width,height,label}]
//   })
//
// -> { status, changed_pixels, compared_pixels, changed_pct, regions, ... }
//
// `status` is one of:
//   'match'        — the same page, within tolerance
//   'changed'      — enough of it moved to be worth a person looking
//   'resized'      — a DIFFERENT SHAPE of page, which is not a percentage
//   'uncomparable' — one of them could not be read at all
//
// Note what is NOT in that list: 'fail'. A visual difference is reported and
// never decides the run.
function compareScreenshots(baselineBuffer, currentBuffer, {
  tolerance = DEFAULT_TOLERANCE,
  thresholdPct = DEFAULT_THRESHOLD_PCT,
  ignoreRegions = [],
} = {}) {
  const tol = clamp(Number(tolerance) || 0, 0, 255);
  const threshold = clamp(Number(thresholdPct) || 0, 0, 100);

  let baseline;
  let current;
  try {
    baseline = decodePng(baselineBuffer);
    current = decodePng(currentBuffer);
  } catch (e) {
    // Said plainly, not swallowed. "Could not be compared" is a real answer and
    // a very different one from "nothing changed" — reporting it as a match
    // would mean a broken baseline silently stops watching the page.
    return {
      status: 'uncomparable',
      reason: e instanceof PngError ? e.message : 'the screenshots could not be read',
      changed_pixels: 0, compared_pixels: 0, changed_pct: 0,
      ignored_pixels: 0, regions: [], threshold_pct: threshold, tolerance: tol,
    };
  }

  // A page that changed SIZE is not "3.4% different" — it is a different shape,
  // and a percentage computed over the overlap would be an answer to a question
  // nobody asked. Reported as its own fact, with both sizes, so the operator can
  // see at once whether a section appeared or the viewport changed.
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      status: 'resized',
      reason: `the page is a different size: ${baseline.width}×${baseline.height} → ${current.width}×${current.height}`,
      baseline_size: { width: baseline.width, height: baseline.height },
      current_size: { width: current.width, height: current.height },
      changed_pixels: 0, compared_pixels: 0, changed_pct: 0,
      ignored_pixels: 0, regions: [], threshold_pct: threshold, tolerance: tol,
    };
  }

  const { width, height } = baseline;
  const regions = normalizeRegions(ignoreRegions, width, height);
  const mask = maskFor(regions, width, height);
  const total = width * height;

  const changed = [];
  let ignored = 0;
  for (let px = 0; px < total; px += 1) {
    if (mask && mask[px]) { ignored += 1; continue; }
    if (pixelDiffers(baseline.data, current.data, px * 4, tol)) changed.push(px);
  }

  const compared = total - ignored;
  const pct = compared ? (changed.length / compared) * 100 : 0;

  return {
    // Below the threshold is a MATCH, stated as such. "0.2% different" invites
    // somebody to treat a clean comparison as a small problem.
    status: pct > threshold ? 'changed' : 'match',
    changed_pixels: changed.length,
    compared_pixels: compared,
    // Two decimals: 0.004% and 0.4% are different answers and rounding to a
    // whole number makes both of them "0".
    changed_pct: Math.round(pct * 100) / 100,
    ignored_pixels: ignored,
    // Only when there is something to point at. Boxes over a matching page
    // would be noise.
    regions: pct > threshold ? regionsOfChange(changed, width, height) : [],
    size: { width, height },
    threshold_pct: threshold,
    tolerance: tol,
    ignore_regions: regions.length,
  };
}

// One sentence for the screen, in the operator's words.
function describeComparison(result) {
  if (!result) return null;
  if (result.status === 'uncomparable') return result.reason;
  if (result.status === 'resized') return result.reason;
  if (result.status === 'match') {
    return result.ignored_pixels
      ? `Looks the same (${result.ignore_regions} ignored area${result.ignore_regions === 1 ? '' : 's'}).`
      : 'Looks the same.';
  }
  return `${result.changed_pct}% of the page looks different (over ${result.threshold_pct}%).`;
}

module.exports = {
  compareScreenshots, describeComparison, normalizeRegions,
  DEFAULT_TOLERANCE, DEFAULT_THRESHOLD_PCT, ALPHA_FLOOR,
};
