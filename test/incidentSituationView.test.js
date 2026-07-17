'use strict';

// Unit tests for the Incident Situation View render logic (public/clusterView.js)
// under jsdom. The dashboard has no build step; testable page assembly + panel
// rendering are factored into ClusterView (like TimelineView) so the states the
// task cares about — full data, empty timeline, advisory disabled, advisory
// failing (page still renders) — are exercised without a browser.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const CV = require('../public/clusterView');

function newDoc() { return new JSDOM('<!doctype html><body></body>').window.document; }
function click(node, doc) { node.dispatchEvent(new doc.defaultView.Event('click')); }

const DETAIL = {
  id: 7, status: 'open', confidence: 'high',
  confidenceBreakdown: { tier: 'high', score: 1, baseline: 0.4, aboveBaseline: true, contributing: [
    { signal: 'time', weight: 0.4 }, { signal: 'topology', weight: 0.35 }, { signal: 'type', weight: 0.25 },
  ] },
  suspectedRootCause: { classification: 'network-layer', reason: 'Member metrics are interface/packet-level (probe.loss).', commonCause: 'shared uplink' },
  evidenceSummary: { drivers: ['3 agents fired within the correlation window (time proximity)'], text: 'Grouped because 3 agents fired within the window; the agents share a site.' },
  firstSeen: '2026-07-01T12:00:00Z', lastSeen: '2026-07-01T12:05:00Z',
  affectedAgents: ['1', '2', '3'], advisory: null,
};

const TIMELINE = {
  clusterId: 7,
  window: { from: '2026-07-01T11:30:00Z', to: '2026-07-01T12:10:00Z', firstFindingAt: '2026-07-01T12:00:00Z', lookbackMinutes: 30 },
  affectedAgents: ['1', '2'],
  events: [
    { timestamp: '2026-07-01T12:00:00Z', source: 'finding', target: '1', type: 'probe.loss', severity: 'CRIT', summary: 'loss', ref_id: 'a' },
    { timestamp: '2026-07-01T11:50:00Z', source: 'config', target: '1', type: 'config.change', severity: 'INFO', summary: 'Configuration change captured', ref_id: 30 },
    { timestamp: '2026-07-01T11:58:00Z', source: 'agent', target: '2', type: 'agent.offline', severity: 'WARN', summary: 'Agent disconnected', ref_id: 10 },
  ],
  whatChanged: [
    { timestamp: '2026-07-01T11:58:00Z', source: 'agent', target: '2', type: 'agent.offline', severity: 'WARN', summary: 'Agent disconnected', ref_id: 10 },
    { timestamp: '2026-07-01T11:50:00Z', source: 'config', target: '1', type: 'config.change', severity: 'INFO', summary: 'Configuration change captured', ref_id: 30 },
  ],
  partial: false, failedSources: [],
};

// ---- pure models -----------------------------------------------------------

test('availableActions gates by status + write permission', () => {
  assert.deepEqual(CV.availableActions('open', true), ['ack', 'resolve']);
  assert.deepEqual(CV.availableActions('acknowledged', true), ['resolve']);
  assert.deepEqual(CV.availableActions('resolved', true), []);
  assert.deepEqual(CV.availableActions('open', false), []); // viewer sees no actions
});

test('advisoryState: ready / none / error are distinct', () => {
  assert.equal(CV.advisoryState({ advisory: 'check the uplink' }).state, 'ready');
  assert.equal(CV.advisoryState({ advisory: null }).state, 'none');
  assert.equal(CV.advisoryState({ advisory: '  ' }).state, 'none');
  assert.equal(CV.advisoryState({ advisory: 'x' }, new Error('boom')).state, 'error');
});

test('whatChangedState treats empty as first-class', () => {
  assert.equal(CV.whatChangedState({ whatChanged: [] }).state, 'empty');
  assert.equal(CV.whatChangedState({ whatChanged: [{}] }).state, 'ready');
  assert.equal(CV.whatChangedState(null).state, 'empty');
});

// ---- full-data render ------------------------------------------------------

test('renderPage with full data renders all five panels', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE }, { canWrite: true });

  assert.ok(root.querySelector('.inc-header'), 'header');
  assert.ok(root.querySelector('.inc-whatchanged'), 'what-changed');
  assert.ok(root.querySelector('.inc-evidence'), 'evidence');
  assert.ok(root.querySelector('.inc-timeline'), 'timeline');
  assert.ok(root.querySelector('.inc-advisory'), 'advisory');

  // Header shows the root-cause classification + agent count.
  assert.match(root.querySelector('.inc-header').textContent, /Network layer/);
  assert.match(root.querySelector('.inc-header').textContent, /3 agents/);

  // Evidence lists the plain-language drivers.
  assert.ok(root.querySelectorAll('.inc-drivers li').length >= 3);

  // What-changed shows the two pre-incident change rows.
  assert.equal(root.querySelector('.inc-whatchanged').querySelectorAll('ul.timeline li').length, 2);

  // Timeline shows all three events.
  assert.equal(root.querySelector('.inc-timeline').querySelectorAll('ul.timeline li').length, 3);
});

test('renderPage shows ack + resolve for an operator on an open cluster; a finding row deep-links', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  let acked = 0; let opened = null;
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE }, {
    canWrite: true, onAck: () => { acked += 1; }, onResolve: () => {}, onOpen: (id) => { opened = id; },
  });
  const buttons = [...root.querySelector('.inc-actions').querySelectorAll('button')].map((b) => b.textContent);
  assert.deepEqual(buttons, ['Acknowledge', 'Resolve']);
  click(root.querySelector('.inc-actions button'), doc);
  assert.equal(acked, 1);

  // A finding row (target '1') is clickable → deep-links to that agent.
  const findingRow = [...root.querySelector('.inc-timeline').querySelectorAll('li.tl')].find((li) => /loss/.test(li.textContent));
  assert.ok(findingRow.classList.contains('clickable'));
  click(findingRow, doc);
  assert.equal(opened, '1');
});

test('viewer sees no action buttons', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE }, { canWrite: false });
  assert.equal(root.querySelector('.inc-actions'), null);
});

// ---- empty timeline --------------------------------------------------------

test('renderPage with an empty timeline shows explicit empty states, still renders header + evidence', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  const emptyTimeline = { window: { lookbackMinutes: 30 }, events: [], whatChanged: [], partial: false, failedSources: [] };
  CV.renderPage(doc, root, { detail: DETAIL, timeline: emptyTimeline }, { canWrite: true });

  assert.ok(root.querySelector('.inc-header'), 'header still renders');
  assert.ok(root.querySelector('.inc-evidence'), 'evidence still renders');
  // "What changed" states the absence explicitly (absence is diagnostic).
  assert.match(root.querySelector('.inc-whatchanged').textContent, /No recorded changes in the window/);
  // Timeline shows its empty state, no rows.
  assert.equal(root.querySelector('.inc-timeline').querySelectorAll('ul.timeline li').length, 0);
  assert.match(root.querySelector('.inc-timeline').textContent, /No events in this window/);
});

// ---- advisory disabled -----------------------------------------------------

test('advisory disabled (no advisory) renders a clear "none" note, page intact', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: { ...DETAIL, advisory: null }, timeline: TIMELINE }, { canWrite: true });
  assert.match(root.querySelector('.inc-advisory').textContent, /No AI advisory/);
  assert.equal(root.querySelector('.inc-advisory .ai-badge'), null); // no AI-generated badge
  assert.ok(root.querySelector('.inc-timeline'), 'timeline still present');
});

test('advisory present renders the AI-generated block with a masking note', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: { ...DETAIL, advisory: 'Check the shared site uplink.' }, timeline: TIMELINE }, {});
  assert.ok(root.querySelector('.inc-advisory .ai-badge'));
  assert.match(root.querySelector('.inc-advisory').textContent, /Check the shared site uplink/);
  assert.match(root.querySelector('.inc-advisory').textContent, /masked, aggregated/);
});

// ---- advisory failing (independent domain) ---------------------------------

test('advisory failing does NOT break the page — every other panel still renders', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE, advisoryError: new Error('provider down') }, { canWrite: true });
  assert.match(root.querySelector('.inc-advisory').textContent, /unavailable/);
  // The rest of the page is unaffected.
  assert.ok(root.querySelector('.inc-header'));
  assert.ok(root.querySelector('.inc-whatchanged'));
  assert.ok(root.querySelector('.inc-evidence'));
  assert.ok(root.querySelector('.inc-timeline'));
});

// ---- timeline failing (independent domain) ---------------------------------

test('timeline failing shows a timeline error but keeps header/evidence/advisory', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: null, timelineError: true }, { canWrite: true });
  assert.match(root.querySelector('.inc-timeline').textContent, /Could not load the timeline/);
  assert.ok(root.querySelector('.inc-header'));
  assert.ok(root.querySelector('.inc-evidence'));
  assert.ok(root.querySelector('.inc-advisory'));
  // what-changed degrades to its empty state rather than throwing.
  assert.match(root.querySelector('.inc-whatchanged').textContent, /No recorded changes/);
});

// ---- source filtering ------------------------------------------------------

test('timeline source filter narrows the rows', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE }, {});
  const sel = root.querySelector('.tl-src-filter');
  assert.ok(sel, 'a source filter is shown when >1 source present');
  sel.value = 'config';
  sel.dispatchEvent(new doc.defaultView.Event('change'));
  const rows = root.querySelector('.inc-timeline').querySelectorAll('ul.timeline li');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Configuration change/);
});

// ---- Recommended actions panel (Fase 3) ------------------------------------

const ACTIONS = {
  findingTypes: ['cpu', 'mem'],
  hasRunbooks: true,
  runbooks: [
    { id: 1, findingType: 'cpu', title: 'Tame CPU', bodyMarkdown: '# Steps\n- restart **svc**\n- check `top`', linkedPlaybookId: 5, linkedPlaybookName: 'Restart svc' },
    { id: 2, findingType: 'mem', title: 'Free memory', bodyMarkdown: 'Reclaim caches.', linkedPlaybookId: null, linkedPlaybookName: null },
  ],
  advisory: null, advisoryEnabled: false,
};

test('renderPage shows the recommended-actions panel with rendered markdown + a run button for operators', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  let ran = null;
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE, actions: ACTIONS }, {
    canWrite: true, onRunPlaybook: (rb) => { ran = rb.id; },
  });
  const panel = root.querySelector('.inc-recactions');
  assert.ok(panel, 'recommended-actions panel present');
  assert.match(panel.textContent, /Tame CPU/);
  // markdown rendered to nodes (heading + list + bold + inline code)
  assert.ok(panel.querySelector('.md h4'));
  assert.ok(panel.querySelector('.md-list li'));
  assert.ok(panel.querySelector('.md strong'));
  assert.ok(panel.querySelector('.md code'));
  // the linked runbook has a Run playbook button; clicking calls back
  const runBtn = [...panel.querySelectorAll('button')].find((b) => /Run playbook/.test(b.textContent));
  assert.ok(runBtn);
  click(runBtn, doc);
  assert.equal(ran, 1);
});

test('recommended-actions: viewer sees no run button but a "operator can run it" note', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE, actions: ACTIONS }, { canWrite: false });
  const panel = root.querySelector('.inc-recactions');
  assert.equal([...panel.querySelectorAll('button')].filter((b) => /Run playbook/.test(b.textContent)).length, 0);
  assert.match(panel.textContent, /operator\/admin can run it/);
});

test('recommended-actions: no matching runbook → explicit empty state', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE, actions: { findingTypes: ['cpu'], hasRunbooks: false, runbooks: [] } }, { canWrite: true });
  assert.match(root.querySelector('.inc-recactions').textContent, /No runbook matches/);
});

test('recommended-actions: a fetch failure renders its own error, page still renders', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: DETAIL, timeline: TIMELINE, actionsError: new Error('boom') }, { canWrite: true });
  assert.match(root.querySelector('.inc-recactions').textContent, /Could not load recommended actions/);
  assert.ok(root.querySelector('.inc-header'));
  assert.ok(root.querySelector('.inc-timeline'));
});

test('advisory panel renders directly after recommended actions (below runbooks)', () => {
  const doc = newDoc();
  const root = doc.createElement('div');
  CV.renderPage(doc, root, { detail: { ...DETAIL, advisory: 'Check the uplink.' }, timeline: TIMELINE, actions: ACTIONS }, {});
  const cards = [...root.children];
  const recIdx = cards.findIndex((c) => c.classList.contains('inc-recactions'));
  const advIdx = cards.findIndex((c) => c.classList.contains('inc-advisory'));
  assert.ok(recIdx >= 0 && advIdx === recIdx + 1, 'advisory is immediately below recommended actions');
});

test('renderMarkdown escapes and never uses innerHTML (no injection)', () => {
  const doc = newDoc();
  const node = CV.renderMarkdown(doc, 'plain <img src=x onerror=alert(1)> text');
  // The angle-bracket content is inert text, not an element.
  assert.equal(node.querySelector('img'), null);
  assert.match(node.textContent, /<img src=x onerror=alert\(1\)>/);
});
