// public/clusterView.js — pure + injected-DOM helpers for the Incident Situation
// View (Fase 2): the per-cluster page ("ét fælles billede"). Follows the same
// convention as timelineView.js — no build step, dual-exported to
// window.ClusterView (browser, loaded as a plain <script>) and module.exports
// (Node tests) — so the page's assembly, state resolution and render output are
// unit-testable under node --test + jsdom, while app.js wires fetch + navigation.
//
// The page renders five panels top-to-bottom: header (status/confidence/root
// cause/agents + ack/resolve actions), "What changed" (pre-incident changes),
// Evidence (confidence breakdown, plain language), the merged timeline
// (filterable by source), and an optional AI advisory. Each panel is an
// INDEPENDENT failure domain — a missing/failed advisory or timeline never stops
// the others rendering.

(function (root) {
  'use strict';

  // TimelineView is loaded before this script in the browser; required in Node.
  var TV = (typeof require === 'function') ? require('./timelineView')
    : (root && root.TimelineView);

  var STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved', closed: 'Closed' };
  var CONF_LABEL = { low: 'Low', medium: 'Medium', high: 'High' };
  var ROOT_CAUSE_LABEL = {
    'network-layer': 'Network layer',
    'application-layer': 'Application layer',
    undetermined: 'Undetermined',
  };

  function statusLabel(s) { return STATUS_LABEL[s] || String(s == null ? '—' : s); }
  function confLabel(c) { return CONF_LABEL[c] || String(c == null ? '—' : c); }
  function rootCauseLabel(c) { return ROOT_CAUSE_LABEL[c] || 'Undetermined'; }

  // --- pure models -----------------------------------------------------------

  // Which lifecycle actions to offer, given the status + write permission. An
  // open cluster can be acknowledged and/or resolved; an acknowledged one can be
  // resolved; resolved/closed offer nothing.
  function availableActions(status, canWrite) {
    if (!canWrite) return [];
    if (status === 'open') return ['ack', 'resolve'];
    if (status === 'acknowledged') return ['resolve'];
    return [];
  }

  // "What changed" state: empty is first-class (absence of change is itself
  // diagnostic — say so explicitly rather than showing nothing).
  function whatChangedState(timeline) {
    var events = timeline && Array.isArray(timeline.whatChanged) ? timeline.whatChanged : [];
    return { state: events.length ? 'ready' : 'empty', events: events };
  }

  // Advisory state: an INDEPENDENT domain. `error` (advisory fetch/render failed)
  // → 'error'; a present advisory → 'ready'; absent (Mistral off / none generated)
  // → 'none'. Never throws, so the rest of the page always renders.
  function advisoryState(detail, error) {
    if (error) return { state: 'error' };
    var text = detail && typeof detail.advisory === 'string' ? detail.advisory.trim() : '';
    if (text) return { state: 'ready', text: text };
    return { state: 'none' };
  }

  // Plain-language lines describing which signals drove the grouping, from the
  // Fase-1 confidence breakdown + evidence summary. No black-box score alone.
  function confidenceDrivers(detail) {
    var out = [];
    var bd = detail && detail.confidenceBreakdown;
    if (bd && Array.isArray(bd.contributing)) {
      bd.contributing.forEach(function (c) {
        out.push(signalPhrase(c.signal) + ' (weight ' + c.weight + ')');
      });
    }
    var summary = detail && detail.evidenceSummary;
    if (summary && Array.isArray(summary.drivers)) {
      summary.drivers.forEach(function (d) { if (out.indexOf(d) === -1) out.push(d); });
    }
    return out;
  }

  function signalPhrase(signal) {
    if (signal === 'time') return 'Time proximity — findings fired together';
    if (signal === 'topology') return 'Shared site — the agents are co-located';
    if (signal === 'type') return 'Same finding-type across agents';
    return String(signal);
  }

  // --- DOM helpers (injected document, so testable under jsdom) ---------------

  function elem(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function badge(doc, cls, text) { return elem(doc, 'span', 'badge ' + cls, text); }

  function fmt(opts, iso) {
    return (opts && typeof opts.formatTime === 'function') ? opts.formatTime(iso) : (iso == null ? '' : String(iso));
  }

  // Panel 1 — header. status, confidence, root-cause classification, affected
  // agents count, first/last seen, and (RBAC-aware) ack/resolve buttons.
  function renderHeader(doc, detail, opts) {
    opts = opts || {};
    var head = elem(doc, 'div', 'inc-header');
    var left = elem(doc, 'div');
    left.appendChild(elem(doc, 'h2', null, 'Incident #' + detail.id));

    var meta = elem(doc, 'div', 'inc-meta');
    meta.appendChild(badge(doc, 'inc-status-' + detail.status, statusLabel(detail.status)));
    meta.appendChild(doc.createTextNode(' '));
    meta.appendChild(badge(doc, 'conf-' + detail.confidence, confLabel(detail.confidence) + ' confidence'));
    var rc = detail.suspectedRootCause || {};
    meta.appendChild(doc.createTextNode(' '));
    meta.appendChild(badge(doc, 'rc-' + (rc.classification || 'undetermined'), rootCauseLabel(rc.classification)));
    var agents = Array.isArray(detail.affectedAgents) ? detail.affectedAgents.length : 0;
    meta.appendChild(elem(doc, 'span', 'muted',
      ' · ' + agents + ' agent' + (agents === 1 ? '' : 's')
      + ' · first seen ' + fmt(opts, detail.firstSeen)
      + ' · last activity ' + fmt(opts, detail.lastSeen)));
    left.appendChild(meta);
    head.appendChild(left);

    if (opts.back) head.appendChild(opts.back);

    var actions = availableActions(detail.status, !!opts.canWrite);
    if (actions.length) {
      var bar = elem(doc, 'div', 'inc-actions');
      if (actions.indexOf('ack') !== -1) {
        var ackBtn = elem(doc, 'button', 'small', 'Acknowledge');
        if (typeof opts.onAck === 'function') ackBtn.addEventListener('click', opts.onAck);
        bar.appendChild(ackBtn);
      }
      if (actions.indexOf('resolve') !== -1) {
        var resBtn = elem(doc, 'button', 'small', 'Resolve');
        if (typeof opts.onResolve === 'function') resBtn.addEventListener('click', opts.onResolve);
        bar.appendChild(resBtn);
      }
      head.appendChild(bar);
    }
    return head;
  }

  // Panel 2 — "What changed" (Hvad ændrede sig). Prominent; empty is explicit.
  function renderWhatChanged(doc, timeline, opts) {
    opts = opts || {};
    var card = elem(doc, 'div', 'card inc-whatchanged');
    card.appendChild(elem(doc, 'h3', null, 'What changed just before'));
    card.appendChild(elem(doc, 'p', 'muted',
      'Config changes, playbook runs and agent events in the ' + lookbackText(timeline) + ' before the first finding.'));
    var body = elem(doc, 'div', 'wc-body');
    var st = whatChangedState(timeline);
    var view = { state: st.state === 'empty' ? 'empty' : 'ready', events: st.events, partial: false, failedSources: [] };
    TV.renderInto(doc, body, view, Object.assign({}, opts, {
      emptyText: 'No recorded changes in the window — the incident did not follow a tracked change.',
    }));
    card.appendChild(body);
    return card;
  }

  function lookbackText(timeline) {
    var m = timeline && timeline.window && timeline.window.lookbackMinutes;
    return m ? (m + ' min' + (m === 1 ? '' : '')) : 'lookback window';
  }

  // Panel 3 — Evidence: confidence breakdown, in plain language.
  function renderEvidence(doc, detail) {
    var card = elem(doc, 'div', 'card inc-evidence');
    card.appendChild(elem(doc, 'h3', null, 'Evidence — why these were grouped'));
    var bd = detail.confidenceBreakdown || {};
    var head = elem(doc, 'p');
    head.appendChild(badge(doc, 'conf-' + detail.confidence, confLabel(detail.confidence)));
    head.appendChild(doc.createTextNode(' '));
    head.appendChild(elem(doc, 'span', 'muted',
      'score ' + (bd.score != null ? bd.score : '—') + ' vs single-signal baseline ' + (bd.baseline != null ? bd.baseline : '—')));
    card.appendChild(head);

    var drivers = confidenceDrivers(detail);
    if (drivers.length) {
      var ul = elem(doc, 'ul', 'inc-drivers');
      drivers.forEach(function (d) { ul.appendChild(elem(doc, 'li', null, d)); });
      card.appendChild(ul);
    } else {
      card.appendChild(elem(doc, 'p', 'muted', 'No signal breakdown available.'));
    }

    var summary = detail.evidenceSummary;
    if (summary && summary.text) card.appendChild(elem(doc, 'p', null, summary.text));
    var rc = detail.suspectedRootCause || {};
    if (rc.reason) card.appendChild(elem(doc, 'p', 'muted', 'Suspected root cause (' + rootCauseLabel(rc.classification) + '): ' + rc.reason));
    return card;
  }

  // --- tiny, safe markdown renderer -----------------------------------------
  // The dashboard ships no markdown library and no HTML sanitizer beyond escaping,
  // so this builds DOM NODES (never innerHTML) from a small, safe subset:
  // #/##/### headings, - / * bullet lists, ``` fenced code, blank-line paragraphs,
  // and inline **bold**, `code` and [text](http(s)://…) links. Anything else is
  // rendered as plain, inert text — no script/raw-HTML path exists.
  function appendInline(doc, parent, text) {
    var re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
    var last = 0; var m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(doc.createTextNode(text.slice(last, m.index)));
      if (m[2] != null) parent.appendChild(elem(doc, 'strong', null, m[2]));
      else if (m[3] != null) parent.appendChild(elem(doc, 'code', null, m[3]));
      else if (m[4] != null) {
        var a = elem(doc, 'a', null, m[4]);
        a.setAttribute('href', m[5]); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
        parent.appendChild(a);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
  }

  function renderMarkdown(doc, text) {
    var root = elem(doc, 'div', 'md');
    var lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
    var i = 0; var para = null; var list = null;
    var flushPara = function () { if (para) { root.appendChild(para); para = null; } };
    var flushList = function () { if (list) { root.appendChild(list); list = null; } };
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {                       // fenced code block
        flushPara(); flushList();
        var buf = []; i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        root.appendChild(elem(doc, 'pre', 'md-code', buf.join('\n')));
        i += 1; continue;
      }
      var h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { flushPara(); flushList(); var tag = h[1].length === 1 ? 'h4' : (h[1].length === 2 ? 'h5' : 'h6'); var hn = elem(doc, tag); appendInline(doc, hn, h[2]); root.appendChild(hn); i += 1; continue; }
      var li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) { flushPara(); if (!list) list = elem(doc, 'ul', 'md-list'); var liEl = elem(doc, 'li'); appendInline(doc, liEl, li[1]); list.appendChild(liEl); i += 1; continue; }
      if (line.trim() === '') { flushPara(); flushList(); i += 1; continue; }
      flushList();
      if (!para) para = elem(doc, 'p');
      else para.appendChild(doc.createElement('br'));
      appendInline(doc, para, line);
      i += 1;
    }
    flushPara(); flushList();
    return root;
  }

  // Panel — Recommended actions: runbooks matching the cluster's dominant
  // finding-types (static mapping first), each with rendered markdown and, when a
  // runbook links a playbook, an operator+ "Run playbook" button. Its own failure
  // domain. The AI advisory is rendered as a separate panel directly below.
  function renderRecommendedActions(doc, actions, opts) {
    opts = opts || {};
    var card = elem(doc, 'div', 'card inc-recactions');
    card.appendChild(elem(doc, 'h3', null, 'Recommended actions'));

    if (opts.error) { card.appendChild(elem(doc, 'p', 'muted', 'Could not load recommended actions — the rest of this page is unaffected.')); return card; }
    var a = actions || {};
    var runbooks = Array.isArray(a.runbooks) ? a.runbooks : [];
    var types = Array.isArray(a.findingTypes) ? a.findingTypes : [];

    if (!runbooks.length) {
      card.appendChild(elem(doc, 'p', 'muted',
        types.length
          ? 'No runbook matches this incident’s finding types (' + types.join(', ') + '). Add one in Settings → Runbooks.'
          : 'No recommended actions — this incident has no finding-types to match.'));
      return card;
    }

    runbooks.forEach(function (rb) {
      var block = elem(doc, 'div', 'recaction');
      var head = elem(doc, 'div', 'recaction-head');
      head.appendChild(elem(doc, 'strong', null, rb.title));
      head.appendChild(badge(doc, 'rc-type', rb.findingType));
      block.appendChild(head);
      block.appendChild(renderMarkdown(doc, rb.bodyMarkdown));
      if (rb.linkedPlaybookId != null) {
        if (opts.canWrite && typeof opts.onRunPlaybook === 'function') {
          var btn = elem(doc, 'button', 'small', 'Run playbook' + (rb.linkedPlaybookName ? ': ' + rb.linkedPlaybookName : ''));
          btn.addEventListener('click', function () { opts.onRunPlaybook(rb); });
          block.appendChild(btn);
        } else {
          block.appendChild(elem(doc, 'p', 'muted', 'A playbook is linked — operator/admin can run it.'));
        }
      }
      card.appendChild(block);
    });
    return card;
  }

  // Panel 4 — merged timeline, filterable by source. Reuses TimelineView rows;
  // each event deep-links to its own target's device page.
  function renderTimeline(doc, timeline, opts) {
    opts = opts || {};
    var card = elem(doc, 'div', 'card inc-timeline');
    card.appendChild(elem(doc, 'h3', null, 'Timeline'));

    var events = timeline && Array.isArray(timeline.events) ? timeline.events : [];
    var body = elem(doc, 'div', 'tl-body');

    var current = '';
    function draw() {
      var filtered = TV.filterBySource(events, current);
      var view = {
        state: filtered.length ? 'ready' : 'empty', events: filtered,
        partial: !!(timeline && timeline.partial), failedSources: (timeline && timeline.failedSources) || [],
      };
      TV.renderInto(doc, body, view, Object.assign({}, opts, { emptyText: 'No events in this window.' }));
    }

    var sources = TV.distinctSources(events);
    if (sources.length > 1) {
      var sel = elem(doc, 'select', 'tl-src-filter');
      var all = elem(doc, 'option', null, 'All sources'); all.value = ''; sel.appendChild(all);
      sources.forEach(function (s) {
        var o = elem(doc, 'option', null, TV.sourceLabel(s)); o.value = s; sel.appendChild(o);
      });
      sel.addEventListener('change', function () { current = sel.value; draw(); });
      var tb = elem(doc, 'div', 'toolbar'); tb.appendChild(sel); card.appendChild(tb);
    }
    card.appendChild(body);
    draw();
    return card;
  }

  // Panel 5 — optional AI advisory (independent failure domain).
  function renderAdvisory(doc, detail, opts) {
    opts = opts || {};
    var card = elem(doc, 'div', 'card inc-advisory');
    card.appendChild(elem(doc, 'h3', null, 'AI advisory'));
    var st = advisoryState(detail, opts.error);
    if (st.state === 'error') {
      card.appendChild(elem(doc, 'p', 'muted', 'AI advisory unavailable right now — the rest of this page is unaffected.'));
      return card;
    }
    if (st.state === 'none') {
      card.appendChild(elem(doc, 'p', 'muted',
        'No AI advisory for this incident (the opt-in EU AI assistant is off, or none was generated).'));
      return card;
    }
    card.appendChild(elem(doc, 'div', 'ai-badge', '⚠ AI-generated'));
    card.appendChild(elem(doc, 'div', null, st.text));
    card.appendChild(elem(doc, 'p', 'assistant-meta muted',
      'Generated from masked, aggregated member evidence — no raw config or secrets are sent.'));
    return card;
  }

  // Assemble the whole page into `container`. `data` = { detail, timeline,
  // timelineError, advisoryError }. Panels render independently: a null timeline
  // or a failed advisory never stops the header/evidence rendering.
  function renderPage(doc, container, data, opts) {
    opts = opts || {};
    data = data || {};
    while (container.firstChild) container.removeChild(container.firstChild);
    var detail = data.detail;
    if (!detail) { container.appendChild(elem(doc, 'div', 'empty error', data.error || 'Incident not found.')); return container; }

    container.appendChild(renderHeader(doc, detail, opts));

    // Timeline may have failed to load independently of the detail.
    var timeline = data.timeline || null;
    container.appendChild(renderWhatChanged(doc, timeline || { whatChanged: [] }, opts));
    container.appendChild(renderEvidence(doc, detail));

    // Recommended actions (static runbooks first) + the AI advisory directly below.
    container.appendChild(renderRecommendedActions(doc, data.actions, {
      error: data.actionsError, canWrite: opts.canWrite, onRunPlaybook: opts.onRunPlaybook,
    }));
    container.appendChild(renderAdvisory(doc, detail, { error: data.advisoryError }));

    if (data.timelineError) {
      var tlCard = elem(doc, 'div', 'card inc-timeline');
      tlCard.appendChild(elem(doc, 'h3', null, 'Timeline'));
      tlCard.appendChild(elem(doc, 'p', 'error', 'Could not load the timeline.'));
      container.appendChild(tlCard);
    } else {
      container.appendChild(renderTimeline(doc, timeline, opts));
    }
    return container;
  }

  var apiObj = {
    STATUS_LABEL: STATUS_LABEL,
    statusLabel: statusLabel,
    confLabel: confLabel,
    rootCauseLabel: rootCauseLabel,
    availableActions: availableActions,
    whatChangedState: whatChangedState,
    advisoryState: advisoryState,
    confidenceDrivers: confidenceDrivers,
    renderHeader: renderHeader,
    renderWhatChanged: renderWhatChanged,
    renderEvidence: renderEvidence,
    renderRecommendedActions: renderRecommendedActions,
    renderMarkdown: renderMarkdown,
    renderTimeline: renderTimeline,
    renderAdvisory: renderAdvisory,
    renderPage: renderPage,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.ClusterView = apiObj;
})(typeof window !== 'undefined' ? window : null);
