// public/i18n.js — the dashboard's translation layer.
//
// The dashboard historically hardcoded its English strings inline in app.js.
// This module introduces the seam: NEW UI text goes through t('some.key'), the
// existing 14k lines are left alone and migrate opportunistically. So the
// catalogue below is deliberately partial — it covers what the new views need,
// not the whole app.
//
// Design notes:
//   * No build step, no dependency (repo convention) — a plain IIFE that
//     publishes window.I18n, plus module.exports so node --test can unit-test it.
//   * en is the reference locale. A key missing from the active locale falls
//     back to en; a key missing from en returns the key itself, so a typo is
//     visible in the UI instead of rendering an empty string.
//   * Interpolation is {name} placeholders filled from a params object. A
//     placeholder with no matching param is left verbatim (again: visible).
//   * Locale is per user, persisted through PUT /me/preferences ({locale}) and
//     mirrored into localStorage so the first paint after reload is correct
//     without waiting for GET /me.
//
// Dual export: window.I18n (browser <script>) + module.exports (tests).

(function (root) {
  'use strict';

  var LOCALES = ['en', 'da'];
  var DEFAULT_LOCALE = 'en';
  var STORAGE_KEY = 'blueeye.locale';

  // --- Catalogue -------------------------------------------------------------
  // Grouped by feature. Keep en and da in sync; a da key that is absent simply
  // falls back to the English string rather than breaking the view.
  var STRINGS = {
    en: {
      // Universal search (Fase 1)
      'search.title': 'Search',
      'search.placeholder': 'IP, MAC, hostname, site, agent or service…',
      'search.hint': 'Press / to search',
      'search.loading': 'Searching…',
      'search.empty': 'Nothing matched “{q}”.',
      'search.emptyHint': 'Try an IP address, a MAC, part of a hostname, or a site name.',
      'search.error': 'Search failed: {message}',
      'search.tooShort': 'Type at least {min} characters.',
      'search.close': 'Close',
      'search.resultCount': '{count} results',
      'search.source': 'Source: {source}',
      'search.lastSeen': 'Last seen {when}',
      'search.lastSeenNever': 'No last-seen recorded',
      'search.confidence.exact': 'Exact match',
      'search.confidence.high': 'Strong match',
      'search.confidence.medium': 'Likely match',
      'search.confidence.low': 'Weak match',
      'search.partial': 'Some sources could not be queried: {sources}',
      'search.group.ip': 'IP address',
      'search.group.mac': 'MAC address',
      'search.group.host': 'Hosts & agents',
      'search.group.site': 'Sites',
      'search.group.service': 'Services',
      'search.group.device': 'Discovered devices',
      'search.group.asset': 'CMDB assets',
      'search.group.user': 'Users',

      // Incident work log (Fase 3)
      'notes.title': 'Work log',
      'notes.ruledOutTitle': 'Ruled out',
      'notes.ruledOutHint': 'Already investigated and excluded — start after this.',
      'notes.empty': 'No entries yet. The first note starts the handover trail.',
      'notes.ruledOutEmpty': 'Nothing has been ruled out yet.',
      'notes.add': 'Add entry',
      'notes.text': 'What happened / what you did',
      'notes.textPlaceholder': 'Keep it short and factual — the next shift reads this first.',
      'notes.kind': 'Type',
      'notes.kind.observation': 'Observation',
      'notes.kind.action': 'Action taken',
      'notes.kind.ruled_out': 'Ruled out',
      'notes.kind.observation.help': 'Something you saw.',
      'notes.kind.action.help': 'Something you changed or ran.',
      'notes.kind.ruled_out.help': 'A cause you have excluded.',
      'notes.submit': 'Save entry',
      'notes.saving': 'Saving…',
      'notes.appendOnly': 'Entries cannot be edited or deleted.',
      'notes.byline': '{author} · {when}',
      'notes.error': 'Could not save the entry: {message}',
      'notes.loadError': 'Could not load the work log: {message}',
      'notes.readOnly': 'You have read-only access to the work log.',

      // Changes landing page (Fase 2)
      'changes.title': 'Changes',
      'changes.subtitle': 'What happened since you last looked',
      'changes.empty': 'No changes since {when}.',
      'changes.emptyHint': 'Everything that has happened is already accounted for.',
      'changes.since': 'Since {when}',
      'changes.markSeen': 'Mark as seen',
      'changes.marked': 'Marked as seen',
      'changes.window': 'Window',
      'changes.loading': 'Loading changes…',
      'changes.error': 'Could not load changes: {message}',
      'changes.more': 'Show more',
      'changes.truncated': 'Showing the first {shown} of {total} changes.',
      'changes.partial': 'Some sources could not be queried: {sources}',
      'changes.group.CRIT': 'Critical',
      'changes.group.WARN': 'Warning',
      'changes.group.INFO': 'Informational',
      'changes.kind.agent_state': 'Agent state',
      'changes.kind.interface_state': 'Interface state',
      'changes.kind.finding': 'New anomaly',
      'changes.kind.incident': 'Incident',
      'changes.kind.cluster': 'Situation',
      'changes.kind.topology': 'Topology',
      'changes.kind.playbook': 'Playbook run',
      'changes.kind.config': 'Configuration change',
      'changes.kind.agent_health': 'Agent health',
      'changes.fleetLink': 'Fleet grid',
      'changes.currentState': 'Current state, not a change in this window',

      // Baseline context component (Fase 4)
      'baseline.aboveNormal': '{pct}% above normal for a {weekday} at {hour}',
      'baseline.belowNormal': '{pct}% below normal for a {weekday} at {hour}',
      'baseline.atNormal': 'Normal for a {weekday} at {hour}',
      'baseline.ageTitle': 'Baseline from {samples} observations, updated {when}',
      'baseline.ageThin': 'Baseline is still building ({samples} observations)',
      // Weekday names for the baseline slot ("normal for a Tuesday at 14:00").
      // Here rather than formatted with toLocaleDateString because the slot is a
      // day-of-week INDEX from the baseline table, not a date — there is no Date
      // to format, and inventing one to get a name back would be silly.
      'weekday.0': 'Sunday',
      'weekday.1': 'Monday',
      'weekday.2': 'Tuesday',
      'weekday.3': 'Wednesday',
      'weekday.4': 'Thursday',
      'weekday.5': 'Friday',
      'weekday.6': 'Saturday',

      // Shared
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.never': 'never',
      'common.unknown': 'unknown',
      'common.justNow': 'just now',
      'common.minutesAgo': '{n} min ago',
      'common.hoursAgo': '{n} h ago',
      'common.daysAgo': '{n} d ago',
      'settings.language': 'Language',
      'settings.languageHelp': 'Applies to newer parts of the dashboard; older screens are still English only.',
    },

    da: {
      'search.title': 'Søg',
      'search.placeholder': 'IP, MAC, hostnavn, lokation, agent eller tjeneste…',
      'search.hint': 'Tryk / for at søge',
      'search.loading': 'Søger…',
      'search.empty': 'Intet match på “{q}”.',
      'search.emptyHint': 'Prøv en IP-adresse, en MAC, en del af et hostnavn eller et lokationsnavn.',
      'search.error': 'Søgningen fejlede: {message}',
      'search.tooShort': 'Skriv mindst {min} tegn.',
      'search.close': 'Luk',
      'search.resultCount': '{count} resultater',
      'search.source': 'Kilde: {source}',
      'search.lastSeen': 'Sidst set {when}',
      'search.lastSeenNever': 'Ingen sidst-set registreret',
      'search.confidence.exact': 'Eksakt match',
      'search.confidence.high': 'Stærkt match',
      'search.confidence.medium': 'Sandsynligt match',
      'search.confidence.low': 'Svagt match',
      'search.partial': 'Nogle kilder kunne ikke forespørges: {sources}',
      'search.group.ip': 'IP-adresse',
      'search.group.mac': 'MAC-adresse',
      'search.group.host': 'Hosts og agenter',
      'search.group.site': 'Lokationer',
      'search.group.service': 'Tjenester',
      'search.group.device': 'Fundne enheder',
      'search.group.asset': 'CMDB-assets',
      'search.group.user': 'Brugere',

      'notes.title': 'Arbejdslog',
      'notes.ruledOutTitle': 'Udelukket',
      'notes.ruledOutHint': 'Allerede undersøgt og udelukket — start efter dette.',
      'notes.empty': 'Ingen noter endnu. Den første note starter overdragelsessporet.',
      'notes.ruledOutEmpty': 'Intet er udelukket endnu.',
      'notes.add': 'Tilføj note',
      'notes.text': 'Hvad skete der / hvad gjorde du',
      'notes.textPlaceholder': 'Kort og faktuelt — næste vagt læser dette først.',
      'notes.kind': 'Type',
      'notes.kind.observation': 'Observation',
      'notes.kind.action': 'Handling',
      'notes.kind.ruled_out': 'Udelukket',
      'notes.kind.observation.help': 'Noget du så.',
      'notes.kind.action.help': 'Noget du ændrede eller kørte.',
      'notes.kind.ruled_out.help': 'En årsag du har udelukket.',
      'notes.submit': 'Gem note',
      'notes.saving': 'Gemmer…',
      'notes.appendOnly': 'Noter kan ikke redigeres eller slettes.',
      'notes.byline': '{author} · {when}',
      'notes.error': 'Noten kunne ikke gemmes: {message}',
      'notes.loadError': 'Arbejdsloggen kunne ikke hentes: {message}',
      'notes.readOnly': 'Du har kun læseadgang til arbejdsloggen.',

      'changes.title': 'Ændringer',
      'changes.subtitle': 'Hvad er sket siden du sidst kiggede',
      'changes.empty': 'Ingen ændringer siden {when}.',
      'changes.emptyHint': 'Alt hvad der er sket, er allerede gjort op.',
      'changes.since': 'Siden {when}',
      'changes.markSeen': 'Markér som set',
      'changes.marked': 'Markeret som set',
      'changes.window': 'Vindue',
      'changes.loading': 'Henter ændringer…',
      'changes.error': 'Ændringer kunne ikke hentes: {message}',
      'changes.more': 'Vis flere',
      'changes.truncated': 'Viser de første {shown} af {total} ændringer.',
      'changes.partial': 'Nogle kilder kunne ikke forespørges: {sources}',
      'changes.group.CRIT': 'Kritisk',
      'changes.group.WARN': 'Advarsel',
      'changes.group.INFO': 'Information',
      'changes.kind.agent_state': 'Agent-tilstand',
      'changes.kind.interface_state': 'Interface-tilstand',
      'changes.kind.finding': 'Ny anomali',
      'changes.kind.incident': 'Incident',
      'changes.kind.cluster': 'Situation',
      'changes.kind.topology': 'Topologi',
      'changes.kind.playbook': 'Playbook-kørsel',
      'changes.kind.config': 'Konfigurationsændring',
      'changes.kind.agent_health': 'Agent-sundhed',
      'changes.fleetLink': 'Fleet-oversigt',
      'changes.currentState': 'Nuværende tilstand, ikke en ændring i dette vindue',

      'baseline.aboveNormal': '{pct}% over normal for en {weekday} kl. {hour}',
      'baseline.belowNormal': '{pct}% under normal for en {weekday} kl. {hour}',
      'baseline.atNormal': 'Normal for en {weekday} kl. {hour}',
      'baseline.ageTitle': 'Baseline fra {samples} observationer, opdateret {when}',
      'baseline.ageThin': 'Baseline er stadig ved at bygge ({samples} observationer)',
      'weekday.0': 'søndag',
      'weekday.1': 'mandag',
      'weekday.2': 'tirsdag',
      'weekday.3': 'onsdag',
      'weekday.4': 'torsdag',
      'weekday.5': 'fredag',
      'weekday.6': 'lørdag',

      'common.retry': 'Prøv igen',
      'common.cancel': 'Annullér',
      'common.never': 'aldrig',
      'common.unknown': 'ukendt',
      'common.justNow': 'lige nu',
      'common.minutesAgo': 'for {n} min siden',
      'common.hoursAgo': 'for {n} t siden',
      'common.daysAgo': 'for {n} d siden',
      'settings.language': 'Sprog',
      'settings.languageHelp': 'Gælder de nyere dele af dashboardet; ældre skærme er stadig kun på engelsk.',
    },
  };

  // Human labels for the locale picker, in the locale's own language.
  var LOCALE_LABELS = { en: 'English', da: 'Dansk' };

  // --- State -----------------------------------------------------------------

  var current = DEFAULT_LOCALE;

  function isLocale(v) {
    return typeof v === 'string' && LOCALES.indexOf(v) !== -1;
  }

  // Picks the best supported locale from a preference, a browser language tag
  // ('da-DK' → 'da') or neither. Never throws, always returns a supported code.
  function resolveLocale(preferred, browserLang) {
    if (isLocale(preferred)) return preferred;
    var tag = typeof browserLang === 'string' ? browserLang.toLowerCase().split('-')[0] : '';
    if (isLocale(tag)) return tag;
    return DEFAULT_LOCALE;
  }

  function getLocale() { return current; }

  // Sets the active locale and reflects it on <html lang> so the browser (and
  // screen readers) agree with what we render. Ignores unsupported codes.
  function setLocale(locale) {
    if (!isLocale(locale)) return current;
    current = locale;
    try {
      if (root && root.document && root.document.documentElement) {
        root.document.documentElement.lang = locale;
      }
    } catch (e) { /* non-browser */ }
    try {
      if (root && root.localStorage) root.localStorage.setItem(STORAGE_KEY, locale);
    } catch (e) { /* storage blocked / private mode */ }
    return current;
  }

  // The locale cached from the previous session, or null. Read before GET /me
  // resolves so the first paint isn't in the wrong language.
  function storedLocale() {
    try {
      var v = root && root.localStorage ? root.localStorage.getItem(STORAGE_KEY) : null;
      return isLocale(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  // --- Lookup ----------------------------------------------------------------

  function interpolate(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, function (whole, name) {
      var v = params[name];
      // Leave an unmatched placeholder verbatim — a silent empty string hides
      // the bug, a visible {name} in the UI gets it fixed.
      if (v === undefined || v === null) return whole;
      return String(v);
    });
  }

  // Translates `key` in the active locale (or `locale`, when given). Falls back
  // to en, then to the key itself. Never throws.
  function t(key, params, locale) {
    var k = String(key == null ? '' : key);
    var loc = isLocale(locale) ? locale : current;
    var table = STRINGS[loc] || {};
    var template = Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined;
    if (template === undefined) {
      var en = STRINGS[DEFAULT_LOCALE] || {};
      template = Object.prototype.hasOwnProperty.call(en, k) ? en[k] : undefined;
    }
    if (template === undefined) return k;
    return interpolate(template, params);
  }

  // True when the key exists in the given (or active) locale — used by tests
  // and by the catalogue-parity check.
  function has(key, locale) {
    var loc = isLocale(locale) ? locale : current;
    return Object.prototype.hasOwnProperty.call(STRINGS[loc] || {}, String(key));
  }

  // Keys present in en but missing from `locale`. A non-empty list is not an
  // error (those keys fall back to English) — it is the translation backlog.
  function missingKeys(locale) {
    var en = STRINGS[DEFAULT_LOCALE] || {};
    var table = STRINGS[locale] || {};
    return Object.keys(en).filter(function (k) {
      return !Object.prototype.hasOwnProperty.call(table, k);
    });
  }

  // --- Relative time ---------------------------------------------------------
  // Search hits and change rows both need "how old is this" in words. Kept here
  // (not in app.js) so it is translated rather than hardcoded.
  function relativeTime(value, nowMs) {
    if (value === null || value === undefined || value === '') return t('common.never');
    var then = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!isFinite(then)) return t('common.unknown');
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var mins = Math.floor((now - then) / 60000);
    if (mins < 1) return t('common.justNow');
    if (mins < 60) return t('common.minutesAgo', { n: mins });
    var hours = Math.floor(mins / 60);
    if (hours < 24) return t('common.hoursAgo', { n: hours });
    return t('common.daysAgo', { n: Math.floor(hours / 24) });
  }

  var apiObj = {
    LOCALES: LOCALES,
    LOCALE_LABELS: LOCALE_LABELS,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    STORAGE_KEY: STORAGE_KEY,
    STRINGS: STRINGS,
    isLocale: isLocale,
    resolveLocale: resolveLocale,
    getLocale: getLocale,
    setLocale: setLocale,
    storedLocale: storedLocale,
    t: t,
    has: has,
    missingKeys: missingKeys,
    relativeTime: relativeTime,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.I18n = apiObj;
})(typeof window !== 'undefined' ? window : null);
