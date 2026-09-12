'use strict';

const { flattenSteps } = require('../engine/validate');
const { blockField, CREDENTIAL_REF_RE } = require('../engine/dsl');
const { describeTarget } = require('../engine/targeting');
const { proposeHealing } = require('../engine/heal');
const { classify, KIND } = require('./classify');
const { audit } = require('../a11y/rules');
const { compareScreenshots, describeComparison } = require('../visual/compare');

// The step executor — PURE with respect to browsers.
//
// It walks a validated definition and calls methods on an injected `driver`.
// It never requires Playwright: driver.js does that, and the specs run against a
// fake. So the whole of "what a test means" is testable offline, and the engine
// underneath can be replaced without touching this file
// (docs/service-assurance.md §4).
//
// The driver contract:
//   open(url)                        → { status, url }
//   back() / refresh()               → { status, url }
//   click(target)                    → void
//   fill(target, value)              → void
//   clear(target)                    → void
//   select(target, value)            → void
//   setChecked(target, checked)      → void
//   upload(target, fileName)         → void
//   exists(target)                   → boolean
//   visible(target)                  → boolean
//   textOf(target)                   → string
//   currentUrl()                     → string
//   pageTitle()                      → string   (the browser tab, NOT page text)
//   waitFor(target, timeoutMs)       → void
//   sleep(ms)                        → void
//   apiRequest({method,url,body})    → { status, body }
//   consoleErrors()                  → string[]
//   networkErrors()                  → [{url,status}]
//   apiCalls()                       → [{method,url,status,duration_ms,resource_type}]
//   screenshot()                     → Buffer|null
//
// Every driver method may throw; a throw is a step failure, classified by
// classify.js and reported in plain language.

const STEP_STATUS = { PASS: 'pass', FAIL: 'fail', WARNING: 'warning', SKIPPED: 'skipped' };

// Resolves {{credential.username}} / {{credential.password}} against the
// credential the test selected. An unresolvable reference is left verbatim so it
// shows up in the UI rather than silently becoming ''.
function resolveValue(raw, credential) {
  if (typeof raw !== 'string' || !credential) return raw;
  CREDENTIAL_REF_RE.lastIndex = 0;
  return raw.replace(CREDENTIAL_REF_RE, (match, field) => {
    if (field === 'username') return credential.username ?? match;
    if (field === 'password') return credential.secret ?? match;
    return match;
  });
}

// The label an operator sees for a step in the log and the results table.
function stepLabel(step) {
  if (step.label) return step.label;
  const target = step.target ? ` ${describeTarget(step.target)}` : '';
  switch (step.type) {
    case 'open': return `Åbn ${step.url}`;
    case 'back': return 'Gå tilbage';
    case 'refresh': return 'Genindlæs siden';
    case 'click': return `Klik på${target}`;
    case 'fill': return `Indtast i${target}`;
    case 'clear': return `Ryd${target}`;
    case 'select': return `Vælg "${step.value}" i${target}`;
    case 'checkbox': return `${step.checked ? 'Sæt' : 'Fjern'} flueben i${target}`;
    case 'upload': return `Upload ${step.file} til${target}`;
    case 'assert_exists': return `Kontroller at${target} findes`;
    case 'assert_visible': return `Kontroller at${target} er synlig`;
    case 'assert_not_visible': return `Kontroller at${target} ikke er synlig`;
    case 'assert_text_contains': return `Kontroller at${target} indeholder "${step.value}"`;
    case 'assert_text_equals': return `Kontroller at${target} er "${step.value}"`;
    // Reads as a sentence, because this label IS the run log. The step it
    // replaced rendered as `Kontroller at teksten "X" indeholder "X"` — a
    // tautology that told an operator nothing about what was being checked.
    case 'assert_title_contains': return `Kontroller at siden identificeres med titlen "${step.value}"`;
    case 'assert_url_contains': return `Kontroller at adressen indeholder "${step.value}"`;
    case 'assert_url_equals': return `Kontroller at adressen er "${step.value}"`;
    case 'wait': return step.ms !== undefined ? `Vent ${step.ms} ms` : `Vent på${target}`;
    case 'condition': return `Hvis${target} findes`;
    case 'login': return 'Log ind';
    case 'logout': return 'Log ud';
    case 'api_request': return `${step.method} ${step.url}`;
    case 'assert_http_status': return `Kontroller HTTP-status ${step.status}`;
    default: return step.type;
  }
}

// An assertion failure is a FAILURE, not an exception — it carries what was
// expected and what was found, which is what the operator actually needs.
function assertionFailure(expected, actual) {
  const err = new Error(`forventede ${expected}, fandt ${actual}`);
  err.assertionFailed = true;
  err.expected = expected;
  err.actual = actual;
  return err;
}

// Runs ONE step against the driver. Returns nothing on success; throws on
// failure. `ctx` carries the last observed HTTP status so assert_http_status has
// something to assert on.
async function runStep(step, { driver, credential, ctx }) {
  switch (step.type) {
    case 'open': {
      const res = await driver.open(step.url);
      if (res && res.status !== undefined) ctx.lastStatus = res.status;
      return;
    }
    case 'back': {
      const res = await driver.back();
      if (res && res.status !== undefined) ctx.lastStatus = res.status;
      return;
    }
    case 'refresh': {
      const res = await driver.refresh();
      if (res && res.status !== undefined) ctx.lastStatus = res.status;
      return;
    }
    case 'click': return void await driver.click(step.target);
    case 'fill': return void await driver.fill(step.target, resolveValue(step.value, credential));
    case 'clear': return void await driver.clear(step.target);
    case 'select': return void await driver.select(step.target, step.value);
    case 'checkbox': return void await driver.setChecked(step.target, step.checked);
    case 'upload': return void await driver.upload(step.target, step.file);

    case 'assert_exists': {
      if (!(await driver.exists(step.target))) throw assertionFailure('at elementet findes', 'det blev ikke fundet');
      return;
    }
    case 'assert_visible': {
      if (!(await driver.visible(step.target))) throw assertionFailure('at elementet er synligt', 'det er ikke synligt');
      return;
    }
    case 'assert_not_visible': {
      if (await driver.visible(step.target)) throw assertionFailure('at elementet ikke er synligt', 'det er synligt');
      return;
    }
    case 'assert_text_contains': {
      const text = String(await driver.textOf(step.target) ?? '');
      if (!text.includes(step.value)) throw assertionFailure(`teksten "${step.value}"`, `"${text.slice(0, 120)}"`);
      return;
    }
    case 'assert_text_equals': {
      const text = String(await driver.textOf(step.target) ?? '').trim();
      if (text !== step.value) throw assertionFailure(`teksten "${step.value}"`, `"${text.slice(0, 120)}"`);
      return;
    }
    // The page title is read from the document, never located on the page: a
    // `<title>` is in `<head>` and no element target can ever match it. The
    // suggested Login test used to assert one as page text and failed every run.
    case 'assert_title_contains': {
      const title = String(await titleOf(driver) ?? '');
      if (!title.includes(step.value)) {
        throw assertionFailure(`en side med titlen "${step.value}"`, title ? `titlen "${title}"` : 'ingen titel');
      }
      return;
    }
    case 'assert_url_contains': {
      const url = String(await driver.currentUrl() ?? '');
      if (!url.includes(step.value)) throw assertionFailure(`en adresse med "${step.value}"`, url);
      return;
    }
    case 'assert_url_equals': {
      const url = String(await driver.currentUrl() ?? '');
      if (url !== step.value && !url.endsWith(step.value)) throw assertionFailure(`adressen "${step.value}"`, url);
      return;
    }

    case 'wait': {
      if (step.ms !== undefined) return void await driver.sleep(step.ms);
      return void await driver.waitFor(step.target);
    }

    case 'login': {
      if (!credential || credential.secret == null) {
        const err = new Error('credential unavailable for this test');
        err.credentialMissing = true;
        throw err;
      }
      return void await driver.login(credential);
    }
    case 'logout': return void await driver.logout();

    case 'api_request': {
      const res = await driver.apiRequest({ method: step.method, url: step.url, body: step.body });
      ctx.lastStatus = res && res.status;
      return;
    }
    case 'assert_http_status': {
      if (Number(ctx.lastStatus) !== Number(step.status)) {
        throw assertionFailure(`HTTP ${step.status}`, ctx.lastStatus === undefined ? 'ingen respons' : `HTTP ${ctx.lastStatus}`);
      }
      return;
    }
    default: {
      const err = new Error(`unsupported step type "${step.type}"`);
      err.unsupported = true;
      throw err;
    }
  }
}

// Executes a whole definition.
//
// Stops at the first failure — a test is a journey, and every step after a
// broken one would fail for the same reason and bury the real cause. The
// remaining steps are recorded as `skipped` so the results table shows the whole
// test, not a truncated one.
//
// `redact` masks credential values in every string that leaves here.
async function executeDefinition(definition, {
  driver,
  credential = null,
  redact = null,
  now = () => Date.now(),
  onStep = null,
  // Defaults ON. The spec calls these basic checks, they cost one read-only
  // evaluate at the end of a run, and a check nobody turns on finds nothing.
  // The setting exists so a customer with a page it chokes on can switch it off
  // without losing the test.
  accessibilityEnabled = true,
  // The step positions that have a baseline, and what to compare each shot
  // against. Empty means nothing is photographed — visual checking costs a
  // screenshot per step and is never paid for a test nobody opted in.
  visualBaselines = [],
  // How to fetch a baseline's bytes. Injected rather than imported: nothing
  // under src/serviceTests/runner may reach the artifact store directly, and a
  // test wires a function that returns a buffer.
  readBaseline = async () => { throw new Error('no baseline reader was wired'); },
} = {}) {
  const mask = redact && typeof redact.text === 'function' ? redact.text : (s) => s;
  const maskDeep = redact && typeof redact.deep === 'function' ? redact.deep : (v) => v;
  const flat = flattenSteps(definition);
  const results = [];
  const ctx = { lastStatus: undefined };
  const startedAt = now();

  // Visual regression (V2 §8), indexed by step position.
  const baselineByStep = new Map(
    (Array.isArray(visualBaselines) ? visualBaselines : [])
      .filter((b) => b && Number.isInteger(Number(b.step_index)))
      .map((b) => [Number(b.step_index), b])
  );
  const visualSteps = new Set(baselineByStep.keys());
  const visualResults = [];

  // Photographs one step and compares it with its baseline.
  //
  // Never throws and never touches the run. A screenshot that could not be
  // taken, a baseline that could not be read, a PNG that could not be decoded —
  // each is reported as what it is, because "could not be compared" is a real
  // answer and a very different one from "nothing changed". Reporting an
  // unreadable baseline as a match would mean a step silently stops being
  // watched.
  async function captureFor(position, label) {
    const baseline = baselineByStep.get(position);
    if (!baseline || typeof driver.screenshot !== 'function') return;
    let shot = null;
    try {
      // PNG, always. A JPEG baseline would make every comparison fight its own
      // compression artefacts.
      shot = await driver.screenshot({ type: 'png', fullPage: false });
    } catch (e) {
      visualResults.push({
        step_index: position, step_label: label, baseline_id: baseline.id ?? null,
        status: 'uncomparable', reason: `the screenshot could not be taken: ${e.message}`,
      });
      return;
    }
    let previous = null;
    try {
      previous = await readBaseline(baseline);
    } catch (e) {
      visualResults.push({
        step_index: position, step_label: label, baseline_id: baseline.id ?? null,
        status: 'uncomparable', reason: `the baseline image could not be read: ${e.message}`,
      });
      return;
    }
    const result = compareScreenshots(previous, shot, {
      tolerance: baseline.tolerance ?? undefined,
      thresholdPct: baseline.threshold_pct ?? undefined,
      ignoreRegions: baseline.ignore_regions || [],
    });
    visualResults.push({
      step_index: position,
      step_label: label,
      baseline_id: baseline.id ?? null,
      ...result,
      explanation: describeComparison(result),
      // Kept only when there is something to look at, and handed to the caller
      // rather than stored here: the buffer is the worker's to persist or drop.
      image: result.status === 'changed' || result.status === 'resized' ? shot : null,
    });
  }

  let failed = null;
  // Positions whose condition did not match — their nested steps are skipped.
  const skippedBlocks = new Set();

  for (let i = 0; i < flat.length; i += 1) {
    const { step, position, path, depth, conditional } = flat[i];
    const label = mask(stepLabel(step));
    const base = { position, path, depth, step_type: step.type, label };

    if (failed) {
      results.push({ ...base, status: STEP_STATUS.SKIPPED, duration_ms: 0, message: 'Sprunget over, fordi et tidligere trin fejlede' });
      continue;
    }
    if (step.enabled === false) {
      results.push({ ...base, status: STEP_STATUS.SKIPPED, duration_ms: 0, message: 'Slået fra' });
      continue;
    }
    if (conditional && skippedBlocks.has(position)) {
      results.push({ ...base, status: STEP_STATUS.SKIPPED, duration_ms: 0, message: 'Betingelsen var ikke opfyldt' });
      continue;
    }

    const stepStart = now();
    try {
      // A `condition` evaluates its target and decides whether the nested block
      // runs. It never fails the test: "the banner was not there" is a normal
      // outcome, which is the entire reason the step type exists.
      if (blockField(step.type)) {
        const present = await driver.exists(step.target);
        if (!present) skippedBlocks.add(position);
        results.push({
          ...base,
          status: STEP_STATUS.PASS,
          duration_ms: now() - stepStart,
          message: present ? 'Til stede — kører trinnene indeni' : 'Ikke til stede — springer trinnene indeni over',
        });
        continue;
      }

      await runStep(step, { driver, credential, ctx });
      results.push({ ...base, status: STEP_STATUS.PASS, duration_ms: now() - stepStart });
      // Visual regression (V2 §8). A screenshot only where somebody accepted a
      // baseline — opt-in per step, per the spec — and only after the step
      // PASSED. Photographing a page mid-failure would compare the error state
      // against the working one and call it a visual change, which is a second
      // wrong answer on top of the real failure.
      if (visualSteps.has(position)) await captureFor(position, label);
    } catch (err) {
      const consoleErrors = await safeCall(driver.consoleErrors, driver, []);
      const networkErrors = await safeCall(driver.networkErrors, driver, []);
      const url = await safeCall(driver.currentUrl, driver, null);
      const classification = classify({
        error: { message: err && err.message },
        httpStatus: err && err.credentialMissing ? null : ctx.lastStatus,
        consoleErrors,
        networkErrors,
        url,
        assertionFailed: !!(err && err.assertionFailed),
      });
      const message = mask(err && err.message ? err.message : 'ukendt fejl');
      results.push({
        ...base,
        status: STEP_STATUS.FAIL,
        duration_ms: now() - stepStart,
        message: `${classification.summary} ${message}`.trim(),
        detail: redact && redact.deep
          ? redact.deep({ classification, technical: message, url })
          : { classification, technical: message, url },
      });
      // Self-healing (V2 §5). The element was not found, and the driver brought
      // back what IS on the page — so propose the one the operator probably
      // meant. PROPOSE: nothing here changes the test, and the whole feature is
      // that rule (engine/heal.js explains why).
      let healing = null;
      if (err && err.notFound && step && step.target) {
        try {
          healing = proposeHealing(step.target, err.candidates || []);
        } catch { /* a heuristic must never turn a failure into a crash */ }
      }

      failed = {
        position,
        label,
        message,
        classification,
        healing: healing ? { ...healing, step_path: path, step_type: step.type } : null,
        consoleErrors: (consoleErrors || []).map(mask),
        // Through the redactor like everything else that leaves here.
        //
        // These went out RAW while the console errors beside them and the
        // api_calls below them were both masked — and a network error carries a
        // URL, which is exactly where a credential ends up when an application
        // puts one in a query string. The value then landed in
        // service_test_runs.network_errors and, since V3, in
        // service_observations as well.
        //
        // `deep` rather than `mask`: these are objects, not strings, and the
        // secret can be in the url, the error text or a field a driver adds
        // later.
        networkErrors: maskDeep(networkErrors || []),
      };
    }

    if (typeof onStep === 'function') {
      try { onStep(results[results.length - 1]); } catch { /* a reporter must never break a run */ }
    }
  }

  const durationMs = now() - startedAt;
  const status = failed ? 'fail' : (results.length ? 'pass' : 'skipped');

  // Collected for EVERY run, not only a failing one. A test that passes while a
  // background call answers 503 is a service that is half-broken, and the run
  // that proves it is the one nobody would think to open.
  const apiCalls = await safeCall(driver.apiCalls, driver, []);

  // The accessibility check (V2 §9), on the page the run ended on.
  //
  // It CANNOT change the outcome. `status` was decided above and nothing below
  // this line touches it — an image with no alt text is not the service being
  // down, and a check that can turn a build red is one people switch off, which
  // protects nobody.
  //
  // Null when it was not collected (an older driver, a page that would not
  // evaluate, the check turned off). Null is not the same as "clean", and the
  // report keeps them apart rather than showing a reassuring empty list.
  const accessibility = accessibilityEnabled ? await auditPage(driver) : null;

  return {
    status,
    duration_ms: durationMs,
    steps: results,
    failed_step: failed ? failed.position : null,
    error_message: failed ? failed.message : null,
    failure_kind: failed ? failed.classification.kind : null,
    // A proposal, never an applied change. The worker records it; an operator
    // decides. Null whenever the failure was not "the element is gone", or when
    // nothing on the page was a confident enough match — silence beats a
    // plausible-but-wrong heal, which would turn the test green while the
    // service stays broken.
    healing: failed ? failed.healing || null : null,
    classification: failed ? failed.classification : null,
    console_errors: failed ? failed.consoleErrors : [],
    network_errors: failed ? failed.networkErrors : [],
    api_calls: (apiCalls || []).map((c) => ({ ...c, url: mask(c.url) })),
    accessibility,
    // Null when nothing was opted in, so "no baselines" stays distinguishable
    // from "everything matched" — an empty array would read as the latter.
    visual: visualResults.length ? visualResults : null,
  };
}

// Collects and audits, or answers null. Never throws: an accessibility report is
// the last thing that should be able to take a run down with it.
async function auditPage(driver) {
  if (typeof driver.accessibilitySnapshot !== 'function') return null;
  try {
    const snapshot = await driver.accessibilitySnapshot();
    if (!snapshot) return null;
    const result = audit(snapshot);
    return {
      ...result,
      // Which page this is about. A run visits several, and a finding with no
      // address is one nobody can go and look at.
      url: (snapshot.document && snapshot.document.url) || null,
      // Surfaced rather than swallowed: a collection that hit its own ceiling
      // did not see the whole page, and a reader has to be able to tell.
      collection_truncated: Boolean(snapshot.truncated),
    };
  } catch {
    return null;
  }
}

// The page title, from a driver that may predate the method (an older worker
// against a newer definition). Reported as "no title" rather than crashing with
// "driver.pageTitle is not a function", which would classify as `unknown` and
// tell the operator nothing.
async function titleOf(driver) {
  if (typeof driver.pageTitle !== 'function') return '';
  return driver.pageTitle();
}

// Calls an optional driver method, swallowing a failure — collecting context for
// an error report must never itself throw and mask the original failure.
async function safeCall(fn, thisArg, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return await fn.call(thisArg); } catch { return fallback; }
}

module.exports = { executeDefinition, runStep, resolveValue, stepLabel, STEP_STATUS, KIND };
