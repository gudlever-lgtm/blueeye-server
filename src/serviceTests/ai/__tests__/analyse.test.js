'use strict';

// The AI assistance layer.
//
// Most of these are about what happens when the provider is NOT there, because
// that is the default state of every deployment and the spec's first rule: the
// system works fully without AI. A layer that only behaves when the provider is
// up is a dependency wearing an assistant's clothes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAiAnalysis, MAX_ANSWER } = require('../analyse');

const INCIDENT = {
  id: 9, subject_label: 'Customer search', subject_key: 'test:1', kind: 'http_500',
  severity: 'CRIT', status: 'open', summary: 'HTTP 500 from the customer search',
  evidence: ['GET /api/search returned 500'], occurrences: 4,
};

// A provider that answers, and records what it was asked.
const DEFAULT_ANSWER = 'The API is returning 500 for the search endpoint.';

function provider(options = {}) {
  // Read off the object rather than destructured with defaults: half these
  // specs are about what an EMPTY answer does, and `answer: undefined` would
  // sail past a default parameter into the happy path.
  const answer = 'answer' in options ? options.answer : DEFAULT_ANSWER;
  const model = options.model || 'test-model';
  const enabled = options.enabled !== false;
  const configured = options.configured !== false;
  const fail = options.fail || null;
  const delayMs = options.delayMs || 0;
  const calls = [];
  return {
    calls,
    isEnabled: () => enabled,
    status: () => ({ enabled, configured, provider: 'test-provider', model }),
    // The timer is NOT unref'd: node:test treats a promise still pending when
    // the loop drains as a failure, and it cancels the rest of the file with it.
    analyse: async (task, context) => {
      calls.push({ task, context });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw fail;
      return { answer, model };
    },
  };
}

const explain = (service) => service.explainIncident({ incident: INCIDENT, applicationName: 'Kundeportal' });

// --------------------------------------------------- it works without AI
test('a deployment with no provider says so, and still reports the rules as available', () => {
  // The spec's own picture. "AI unavailable" on its own reads as "no analysis",
  // which is the opposite of true.
  const service = createAiAnalysis();
  const status = service.status();
  assert.equal(status.rules, 'available');
  assert.equal(status.ai, 'unavailable');
  assert.match(status.reason, /no AI provider configured/);
});

test('a provider that is switched off, or has no key, each says which', () => {
  // "Unavailable" with no reason is a bug report waiting to be filed.
  const off = createAiAnalysis({ ai: provider({ enabled: false }) });
  assert.match(off.status().reason, /switched off/);

  const keyless = createAiAnalysis({ ai: provider({ configured: false }) });
  assert.match(keyless.status().reason, /no provider key/);
});

test('asking with no provider answers, rather than throwing', async () => {
  // A caller that forgets to handle the unavailable case must degrade to no
  // analysis, never to no page.
  for (const service of [
    createAiAnalysis(),
    createAiAnalysis({ ai: {} }),
    createAiAnalysis({ ai: provider({ enabled: false }) }),
    createAiAnalysis({ ai: provider({ configured: false }) }),
  ]) {
    const result = await explain(service);
    assert.equal(result.available, false);
    assert.equal(result.analysis, null);
    assert.ok(result.reason, 'unavailable with no reason');
  }
});

test('a provider that is never called cannot have been called', async () => {
  const p = provider({ enabled: false });
  await explain(createAiAnalysis({ ai: p }));
  assert.deepEqual(p.calls, [], 'a switched-off provider was contacted anyway');
});

// ------------------------------------------------------- when it does work
test('an answer comes back labelled as a suggestion, with the evidence it rested on', async () => {
  // An answer that cannot be checked is worse than none, because it will be
  // believed.
  const service = createAiAnalysis({ ai: provider() });
  const { available, analysis } = await explain(service);
  assert.equal(available, true);
  assert.match(analysis.answer, /500/);
  assert.equal(analysis.is_suggestion, true, 'an AI answer presented as fact is the thing to avoid');
  assert.equal(analysis.source, 'ai', 'so it can never be confused with the rule-based conclusion');
  assert.ok(analysis.context, 'the evidence it was given is not stored with it');
  assert.equal(analysis.context.task, 'explain_incident');
});

test('the stored evidence is the context AS IT WAS, not a pointer at today’s data', async () => {
  // "Why did it say that" has to be answerable next month, when the incident has
  // moved on.
  const service = createAiAnalysis({ ai: provider() });
  const { analysis } = await explain(service);
  assert.equal(analysis.context.incident.summary, INCIDENT.summary);
  assert.equal(analysis.context.incident.severity, 'CRIT');
});

test('what the provider is sent is the allowlisted context, never the raw incident', async () => {
  const p = provider();
  const service = createAiAnalysis({ ai: p });
  await service.explainIncident({
    incident: { ...INCIDENT, internal_note: 'CANARY-do-not-forward' },
    applicationName: 'Kundeportal',
    baseUrl: 'https://portal.kunde.dk',
  });
  const sent = JSON.stringify(p.calls[0].context);
  assert.ok(!sent.includes('CANARY-do-not-forward'));
  assert.ok(!sent.includes('portal.kunde.dk'));
  assert.ok(!sent.includes('test:1'), 'subject_key encodes a host');
});

test('the answer is capped, so a runaway response cannot fill the database', async () => {
  const service = createAiAnalysis({ ai: provider({ answer: 'x'.repeat(MAX_ANSWER * 3) }) });
  const { analysis } = await explain(service);
  assert.ok(analysis.answer.length <= MAX_ANSWER + 1);
});

// ------------------------------------------------------ when it goes wrong
test('a provider that throws produces an unavailable analysis, with the provider’s own reason', async () => {
  // "The key is invalid" and "the provider is down" are different problems for
  // whoever has to fix it, so the message is shown rather than flattened.
  const service = createAiAnalysis({ ai: provider({ fail: new Error('401 invalid api key') }) });
  const result = await explain(service);
  assert.equal(result.available, false);
  assert.match(result.reason, /401 invalid api key/);
  assert.equal(result.analysis, null);
});

test('a provider that answers with nothing is a failure, not an empty analysis', async () => {
  for (const answer of ['', '   ', null, undefined]) {
    const service = createAiAnalysis({ ai: provider({ answer }) });
    // eslint-disable-next-line no-await-in-loop
    const result = await explain(service);
    assert.equal(result.available, false, `answer ${JSON.stringify(answer)}`);
    assert.match(result.reason, /answered with nothing/);
  }
});

test('a provider that hangs is given up on, rather than holding the page', async () => {
  // The provider still answers, 300 ms later — the service must not wait for it.
  const service = createAiAnalysis({ ai: provider({ delayMs: 300 }), timeoutMs: 50 });
  const started = Date.now();
  const result = await explain(service);
  assert.equal(result.available, false);
  assert.match(result.reason, /did not answer within/);
  assert.ok(Date.now() - started < 250, 'it waited for the provider anyway');
});

test('a status() that throws does not take the whole layer down with it', async () => {
  const service = createAiAnalysis({
    ai: { isEnabled: () => true, status: () => { throw new Error('config is unreadable'); }, analyse: async () => ({ answer: 'a' }) },
  });
  assert.doesNotThrow(() => service.status());
  const result = await explain(service);
  assert.equal(result.available, true, 'an unreadable status is not a reason to refuse to answer');
});

// ------------------------------------------------------------- the store
test('an analysis is kept, so it is not asked for twice', async () => {
  const recorded = [];
  const service = createAiAnalysis({
    ai: provider(),
    store: { record: async (row) => { recorded.push(row); return { id: 7 }; } },
  });
  const { analysis } = await explain(service);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].incident_id, 9);
  assert.equal(analysis.id, 7);
});

test('a store that fails loses the row, never the answer', async () => {
  const service = createAiAnalysis({
    ai: provider(),
    store: { record: async () => { throw new Error('the table is full'); } },
  });
  const { available, analysis } = await explain(service);
  assert.equal(available, true);
  assert.ok(analysis.answer, 'the answer went with the row');
});

test('no store at all is a working deployment, not an error', async () => {
  const service = createAiAnalysis({ ai: provider() });
  assert.equal((await explain(service)).available, true);
});

// ------------------------------------------------------ nothing to explain
test('an incident with nothing recorded produces no analysis and no provider call', async () => {
  const p = provider();
  const service = createAiAnalysis({ ai: p });
  const result = await service.explainIncident({ incident: {} });
  assert.equal(result.available, false);
  assert.match(result.reason, /nothing recorded/);
  assert.deepEqual(p.calls, [], 'the provider was asked to explain an empty object');
});

test('it never throws, whatever it is handed', async () => {
  const service = createAiAnalysis({ ai: provider() });
  for (const input of [null, undefined, 'nope', 42, true, [], {}, { incident: null }]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.doesNotReject(() => service.explainIncident(input), String(JSON.stringify(input)).slice(0, 40));
    // eslint-disable-next-line no-await-in-loop
    await assert.doesNotReject(() => service.suggestTests(input));
  }
  assert.doesNotThrow(() => createAiAnalysis(null));
  assert.doesNotThrow(() => createAiAnalysis(undefined).status());
});

// ----------------------------------------------------------- suggestions
test('a test suggestion is prose and nothing else — there is no path to a test', async () => {
  // The user approves before anything is created. A function that could create
  // one is a function somebody will eventually call automatically.
  const service = createAiAnalysis({ ai: provider({ answer: 'Consider a journey for the refund flow.' }) });
  const { analysis } = await service.suggestTests({ applicationName: 'Kundeportal', journeys: [] });
  assert.equal(analysis.kind, 'suggest_tests');
  assert.equal(analysis.is_suggestion, true);
  assert.equal(typeof analysis.answer, 'string');
  // Nothing on the result is a handle on a test. `created_at` is a timestamp,
  // which is why this names the keys rather than pattern-matching them.
  for (const key of ['test_id', 'definition', 'steps', 'create', 'apply', 'accept']) {
    assert.ok(!(key in analysis), `a suggestion carries \`${key}\` — that is a path to creating one`);
  }
  // And the module itself has no function that could.
  assert.deepEqual(Object.keys(service).filter((k) => /create|accept|apply|write|save/i.test(k)), []);
});

test('the module names no provider', () => {
  // Mistral, a local model and an enterprise LLM are configuration. A file that
  // knows which it is talking to is one that will grow a special case.
  const source = require('fs').readFileSync(require.resolve('../analyse'), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const name of ['mistral', 'openai', 'anthropic', 'ollama', 'scaleway', 'gpt-', 'claude-']) {
    assert.ok(!new RegExp(name, 'i').test(source), `analyse.js names ${name}`);
  }
});
