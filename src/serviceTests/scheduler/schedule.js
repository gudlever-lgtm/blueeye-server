'use strict';

// Schedule arithmetic — pure, no clock of its own, no database.
//
// The DUE decision lives in SQL (schedulesRepository.findDue), because asking the
// database "which rows are due" is one query instead of loading every schedule
// and filtering in JavaScript. What lives here is everything ABOUT a schedule
// that the UI and the tests need to reason over: the next fire time, how it reads
// in words, and whether a cadence is one we offer.

// spec §22's fixed choices. A free-form interval is deliberately not offered:
// "every 7 minutes" buys nothing and invites a per-second cron.
const INTERVALS = [
  { seconds: 60, key: 'every_1m', en: 'Every minute', da: 'Hvert minut' },
  { seconds: 300, key: 'every_5m', en: 'Every 5 minutes', da: 'Hvert 5. minut' },
  { seconds: 900, key: 'every_15m', en: 'Every 15 minutes', da: 'Hvert 15. minut' },
  { seconds: 3600, key: 'hourly', en: 'Every hour', da: 'Hver time' },
  { seconds: 86400, key: 'daily', en: 'Daily', da: 'Dagligt' },
];

const INTERVAL_SECONDS = INTERVALS.map((i) => i.seconds);

const isValidInterval = (seconds) => INTERVAL_SECONDS.includes(Number(seconds));

function describeInterval(seconds, lang = 'da') {
  const found = INTERVALS.find((i) => i.seconds === Number(seconds));
  if (found) return lang === 'en' ? found.en : found.da;
  return lang === 'en' ? `Every ${seconds} seconds` : `Hvert ${seconds}. sekund`;
}

// When does this schedule fire next? Returns a Date, or null when it never will
// (disabled).
//
// A schedule that has never run fires at start_at, or immediately when there is
// none. After that it is last_run_at + interval — NOT "now + interval", so a
// worker that was down for an hour catches up on the next tick instead of
// silently resetting the cadence.
function nextRunAt(schedule, now = new Date()) {
  if (!schedule || schedule.enabled === false) return null;
  const interval = Number(schedule.interval_sec);
  if (!Number.isFinite(interval) || interval <= 0) return null;

  const start = schedule.start_at ? new Date(schedule.start_at) : null;
  const last = schedule.last_run_at ? new Date(schedule.last_run_at) : null;

  if (!last || Number.isNaN(last.getTime())) {
    if (start && !Number.isNaN(start.getTime())) return start > now ? start : now;
    return now;
  }
  const next = new Date(last.getTime() + interval * 1000);
  if (start && !Number.isNaN(start.getTime()) && next < start) return start;
  return next;
}

function isDue(schedule, now = new Date()) {
  const next = nextRunAt(schedule, now);
  return !!next && next <= now;
}

// How overdue a schedule is, in whole intervals. A schedule that has slipped by
// several intervals is a signal the worker is not keeping up — the UI surfaces
// it rather than quietly enqueuing a backlog.
function missedIntervals(schedule, now = new Date()) {
  if (!schedule || !schedule.last_run_at) return 0;
  const interval = Number(schedule.interval_sec);
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  const last = new Date(schedule.last_run_at);
  if (Number.isNaN(last.getTime())) return 0;
  const elapsed = (now.getTime() - last.getTime()) / 1000;
  return Math.max(0, Math.floor(elapsed / interval) - 1);
}

// A schedule in a sentence, for the UI.
function describeSchedule(schedule, lang = 'da', now = new Date()) {
  if (!schedule) return '';
  if (schedule.enabled === false) return lang === 'en' ? 'Paused' : 'Sat på pause';
  const cadence = describeInterval(schedule.interval_sec, lang);
  const next = nextRunAt(schedule, now);
  if (!next) return cadence;
  const inSeconds = Math.round((next.getTime() - now.getTime()) / 1000);
  if (inSeconds <= 0) return lang === 'en' ? `${cadence} — due now` : `${cadence} — klar nu`;
  if (inSeconds < 60) return lang === 'en' ? `${cadence} — next in ${inSeconds}s` : `${cadence} — næste om ${inSeconds}s`;
  const minutes = Math.round(inSeconds / 60);
  if (minutes < 60) return lang === 'en' ? `${cadence} — next in ${minutes} min` : `${cadence} — næste om ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return lang === 'en' ? `${cadence} — next in ${hours} h` : `${cadence} — næste om ${hours} t`;
}

module.exports = {
  INTERVALS, INTERVAL_SECONDS, isValidInterval, describeInterval,
  nextRunAt, isDue, missedIntervals, describeSchedule,
};
