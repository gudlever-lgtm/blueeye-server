'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validatePattern, validateRoute, channelsOf } = require('../events/patterns');
const { TACTICS, SUGGESTED, navigatorLayer } = require('../events/attack');

// Event patterns — one named match, and where its events go.
//
//   GET    /api/event-patterns              viewer+  list (+ rule count + route)
//   GET    /api/event-patterns/:id          viewer+  one, with its severity rules
//   GET    /api/event-patterns/:id/matches  ADMIN    how many OPEN events it covers
//   POST   /api/event-patterns              ADMIN    create
//   PUT    /api/event-patterns/:id          ADMIN    edit / enable / disable
//   DELETE /api/event-patterns/:id          ADMIN    delete (takes its rules + route)
//   PUT    /api/event-patterns/:id/route    ADMIN    where these events alert
//   DELETE /api/event-patterns/:id/route    ADMIN    back to the default routing
//   POST   /api/event-patterns/preview      ADMIN    a DRAFT's match count
//   GET    /api/event-patterns/attack       viewer+  the ATT&CK vocabulary the
//                                                   form offers (tactics +
//                                                   suggested techniques)
//   GET    /api/event-patterns/attack/layer ADMIN    an ATT&CK Navigator layer
//
// ADMIN on every write, the same footing as severity rules: a pattern decides
// what wakes people at 3am and now also where it reaches them, across the whole
// estate and indefinitely.
//
// The match counts are reads, not dry runs — nothing here changes an event. A
// pattern applies to events from the moment a severity rule or a route uses it;
// back-filling is still the severity rule's own explicit `apply-to-open`.
function createEventPatternsRouter({
  eventPatternsRepo, severityRulesRepo, findingStore, serviceTestIncidentsRepo, auditLogger,
}) {
  const router = express.Router();
  const read = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const admin = requireRole(ROLES.ADMIN);

  const parseId = (raw) => {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 && String(n) === String(raw).trim() ? n : null;
  };

  // How many mapped patterns one layer export may count. Each is a COUNT query;
  // past this the export is a report, not a download.
  const MAX_LAYER_PATTERNS = 200;

  const withChannels = (route) => (route ? { ...route, channel_list: channelsOf(route) } : null);

  // Which store answers "how many open events" for this source. A server
  // without Service Assurance has no incidents repository, which is a 404 about
  // that source rather than an error about the pattern.
  const storeFor = (source) => (source === 'finding' ? findingStore : serviceTestIncidentsRepo);

  async function countMatches(scope) {
    const store = storeFor(scope.source);
    if (!store || typeof store.countMatchingScope !== 'function') return null;
    return store.countMatchingScope(scope);
  }

  const audit = async (req, action, target, detail) => {
    if (!auditLogger) return;
    await auditLogger.record(req, {
      category: 'event_pattern', action, target: String(target), detail: String(detail || '').slice(0, 512),
    });
  };

  router.get('/', requireAuth, read, asyncHandler(async (req, res) => {
    if (req.query.source !== undefined
      && !['finding', 'service_assurance'].includes(String(req.query.source))) {
      return res.status(400).json({ error: 'Invalid source' });
    }
    const list = await eventPatternsRepo.list({ source: req.query.source || null });
    return res.json(list.map((p) => ({ ...p, route: withChannels(p.route) })));
  }));

  // A DRAFT's match count, before Save. Nothing is written and nothing is read
  // that an admin cannot already see; it exists because a pattern matching
  // nothing is a typo in a match field far more often than it is a pattern for
  // the future, and this is where that shows.
  router.post('/preview', requireAuth, admin, asyncHandler(async (req, res) => {
    const { value, errors } = validatePattern(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const matched = await countMatches(value);
    if (matched === null) {
      return res.status(404).json({ error: 'That kind of event cannot be counted on this server' });
    }
    return res.json({ source: value.source, matched });
  }));

  // The ATT&CK vocabulary the pattern form offers: the fourteen Enterprise
  // tactics, and a short list of suggested techniques. Static — a constant from
  // src/events/attack.js, served so the dashboard does not keep a second copy
  // that can drift from the one the validator uses.
  router.get('/attack', requireAuth, read, (req, res) => {
    res.json({ tactics: TACTICS, suggested: SUGGESTED });
  });

  // An ATT&CK Navigator layer (the official, free viewer) for every mapped
  // pattern, scored by how many open events each covers right now.
  //
  // WHY AN EXPORT RATHER THAN A MATRIX HERE. The published matrix is fourteen
  // columns and some two hundred techniques; an install that maps eight renders
  // as a grey wall, which reads as "this product sees nothing" when the truth is
  // the opposite. Navigator draws it properly and a security team already has it
  // open. src/events/attack.js says the same in more detail.
  //
  // One count per mapped pattern, which is why this is a deliberate download and
  // not something a screen polls.
  router.get('/attack/layer', requireAuth, admin, asyncHandler(async (req, res) => {
    const patterns = (await eventPatternsRepo.list())
      .filter((p) => p.enabled && p.attack_technique && p.attack_tactic)
      .slice(0, MAX_LAYER_PATTERNS);
    const counts = new Map();
    for (const p of patterns) {
      // A store that cannot count this source (a server without Service
      // Assurance) leaves the technique at 0 rather than failing the export:
      // the coverage half of the layer is still worth having.
      const n = await countMatches(p).catch(() => null);
      counts.set(p.id, { count: n == null ? 0 : n, worst: null });
    }
    const layer = navigatorLayer(patterns, counts, { name: 'BlueEyes coverage' });
    res.setHeader('Content-Disposition', 'attachment; filename="blueeye-attack-layer.json"');
    return res.json(layer);
  }));

  router.get('/:id', requireAuth, read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const pattern = await eventPatternsRepo.findById(id);
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' });
    const [route, rules] = await Promise.all([
      eventPatternsRepo.findRoute(id),
      severityRulesRepo ? severityRulesRepo.list({ patternId: id }) : Promise.resolve([]),
    ]);
    return res.json({ ...pattern, route: withChannels(route), rules });
  }));

  router.get('/:id/matches', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const pattern = await eventPatternsRepo.findById(id);
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' });
    const matched = await countMatches(pattern);
    if (matched === null) {
      return res.status(404).json({ error: 'That kind of event cannot be counted on this server' });
    }
    return res.json({ pattern_id: id, source: pattern.source, matched });
  }));

  router.post('/', requireAuth, admin, asyncHandler(async (req, res) => {
    const { value, errors } = validatePattern(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    // Checked rather than left to the unique key, so the answer names the
    // conflict instead of surfacing a driver error.
    const clash = await eventPatternsRepo.findByName(value.name);
    if (clash) return res.status(409).json({ error: 'A pattern with that name already exists', details: { name: 'already taken' } });

    const created = await eventPatternsRepo.create({ ...value, created_by: (req.user && req.user.id) || null });
    await audit(req, 'event_pattern_create', created.id, `${created.name} (${created.source}): ${created.reason || ''}`);
    return res.status(201).json(created);
  }));

  router.put('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const existing = await eventPatternsRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Pattern not found' });

    // Validated as a WHOLE pattern, against the stored one merged with the
    // patch: validating the patch alone would let an edit remove the last match
    // field and widen the pattern to every event from its source — and every
    // severity rule and route hanging off it with it.
    const { value, errors } = validatePattern({ ...existing, ...req.body, source: existing.source });
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    if (value.name !== existing.name) {
      const clash = await eventPatternsRepo.findByName(value.name);
      if (clash) return res.status(409).json({ error: 'A pattern with that name already exists', details: { name: 'already taken' } });
    }

    const saved = await eventPatternsRepo.save(id, value);
    if (!saved) return res.status(404).json({ error: 'Pattern not found' });
    await audit(req, 'event_pattern_update', id, `${saved.name}, enabled=${saved.enabled}`);
    return res.json(saved);
  }));

  // Deleting a pattern deletes its severity rules and its route with it (the
  // foreign keys cascade). The counts are returned so the UI can say what went
  // with it, and the audit row records it — a pattern-backed rule left behind
  // would have no match of its own, and a rule with nothing pinned down governs
  // every event from its source.
  router.delete('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const existing = await eventPatternsRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Pattern not found' });

    const rules = severityRulesRepo ? await severityRulesRepo.list({ patternId: id }) : [];
    const route = await eventPatternsRepo.findRoute(id);
    await eventPatternsRepo.remove(id);
    await audit(req, 'event_pattern_delete', id,
      `${existing.name} (${rules.length} severity rule(s)${route ? ' + its alert route' : ''})`);
    return res.json({ deleted: true, severity_rules_deleted: rules.length, route_deleted: Boolean(route) });
  }));

  // Where this pattern's events alert. One route per pattern, so this is an
  // upsert: the question "where do these go" has one answer, and a second row
  // would be a tie with nothing to break it.
  router.put('/:id/route', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const pattern = await eventPatternsRepo.findById(id);
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' });

    const existing = await eventPatternsRepo.findRoute(id);
    const { value, errors } = validateRoute({ ...(existing || {}), ...req.body });
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const saved = await eventPatternsRepo.saveRoute(id, { ...value, created_by: (req.user && req.user.id) || null });
    await audit(req, 'alert_route_save', id, `${pattern.name} → ${saved.channels} (min ${saved.min_severity || 'per channel'})`);
    return res.json(withChannels(saved));
  }));

  router.delete('/:id/route', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const pattern = await eventPatternsRepo.findById(id);
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' });
    const existing = await eventPatternsRepo.findRoute(id);
    if (!existing) return res.status(404).json({ error: 'This pattern has no alert route' });

    await eventPatternsRepo.removeRoute(id);
    // Said plainly in the audit row: the events do not stop alerting, they go
    // back to every enabled channel and the global cooldown.
    await audit(req, 'alert_route_delete', id, `${pattern.name} → back to default routing`);
    return res.status(204).end();
  }));

  return router;
}

module.exports = { createEventPatternsRouter };
