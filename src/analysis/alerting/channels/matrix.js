'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// Matrix channel — posts findings into a Matrix room.
//
// Why Matrix and not Slack or Teams. This product is sold on-prem, to European
// buyers, with "no US-based vendors" as a stated convention. Matrix is the chat
// protocol that fits that: the customer can run their own homeserver (Synapse,
// Conduit, Dendrite) inside the same network as BlueEyes, so an alert never
// leaves the building — and if they do use a hosted one, it is theirs to
// choose. A Slack or Teams channel would have been the other way round.
//
// It is also the one thing the three existing channels cannot do. Email is
// where alerts go to be missed, a webhook needs someone to build the receiving
// end, and syslog is for machines. A room is where the people who fix this
// already are.
//
// The wire format is the client-server API, used directly over fetch — no SDK,
// no dependency, in keeping with the rest of this directory. One call:
//
//   PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}
//   Authorization: Bearer <access token>
//   { "msgtype": "m.text", "body": "...", "format": "org.matrix.custom.html",
//     "formatted_body": "..." }
//
// PUT with a transaction id rather than POST, because it is idempotent: a retry
// after a timeout cannot post the same alert twice. The txn id is derived from
// the finding, so the same finding retried is the same transaction.

const crypto = require('crypto');

// How a severity reads in the room. Text first (every client renders it), with
// an HTML body for the ones that do formatting.
const SEVERITY_MARK = { CRIT: '🔴', WARN: '🟠', INFO: '🔵' };

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A stable transaction id for one alert. Same finding + same severity = same
// id, so a retry is de-duplicated by the homeserver rather than by us.
function txnIdFor(finding, group) {
  const isCluster = group && Array.isArray(group.memberFindingIds);
  const seed = [
    isCluster ? 'cluster' : 'finding',
    finding && finding.id,
    finding && finding.hostId,
    finding && finding.metric,
    finding && finding.kind,
    finding && finding.severity,
    finding && finding.createdAt,
  ].join('|');
  return `blueeye-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

// The two bodies. Deliberately the same information in both — the plain one is
// not a truncated version, because plenty of clients (and every notification
// preview) show only that.
function renderMessage(finding, group) {
  const isCluster = group && Array.isArray(group.memberFindingIds);
  const sev = (finding && finding.severity) || 'INFO';
  const mark = SEVERITY_MARK[sev] || '⚪';
  const host = (finding && finding.hostId) != null ? String(finding.hostId) : '–';
  const metric = (finding && finding.metric) || '–';
  const headline = isCluster
    ? `${mark} ${sev} · ${finding.memberCount || (group.memberFindingIds || []).length} related findings`
    : `${mark} ${sev} · ${metric} on host ${host}`;

  const lines = [headline];
  if (finding && finding.explanation) lines.push(finding.explanation);
  if (group && group.likelyCause) lines.push(`Likely cause: ${group.likelyCause}`);
  if (group && group.hint) lines.push(group.hint);
  if (isCluster && group.advisory) lines.push(group.advisory);

  const body = lines.join('\n');
  const formatted = [
    `<b>${escapeHtml(headline)}</b>`,
    ...lines.slice(1).map((l) => escapeHtml(l)),
  ].join('<br/>');

  return { body, formatted };
}

// encodeURIComponent leaves !'()* alone — they are unreserved in its table but
// sub-delims in a URI path, and a room id STARTS with '!'. The spec's own
// examples show %21, and a homeserver behind a proxy that normalises paths is
// exactly where the difference stops being theoretical. Encode them explicitly.
function encodePathSegment(value) {
  return encodeURIComponent(String(value == null ? '' : value))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Matrix channel. `fetchImpl` is injected so tests never touch the network.
//
// config: { homeserver, roomId, accessToken }
//   homeserver   base URL of the homeserver, e.g. https://matrix.example.dk
//   roomId       the internal room id (!abc:example.dk), not an alias — an
//                alias has to be resolved first and can be re-pointed, which is
//                not a property you want on the channel that carries alerts
//   accessToken  a bot user's access token
function createMatrixChannel({ config = {}, fetchImpl = globalThis.fetch, logger = silentLogger }) {
  function endpoint(txnId) {
    const base = String(config.homeserver || '').replace(/\/+$/, '');
    return `${base}/_matrix/client/v3/rooms/${encodePathSegment(config.roomId)}/send/m.room.message/${encodePathSegment(txnId)}`;
  }

  async function send(finding, group) {
    if (!config.homeserver) return { ok: false, detail: 'no Matrix homeserver configured' };
    if (!config.roomId) return { ok: false, detail: 'no Matrix room configured' };
    if (!config.accessToken) return { ok: false, detail: 'no Matrix access token configured' };
    if (typeof fetchImpl !== 'function') return { ok: false, detail: 'no fetch implementation' };

    const { body, formatted } = renderMessage(finding, group);
    const payload = JSON.stringify({
      msgtype: 'm.text',
      body,
      format: 'org.matrix.custom.html',
      formatted_body: formatted,
    });

    let res;
    try {
      res = await fetchImpl(endpoint(txnIdFor(finding, group)), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: payload,
        // Same reasoning as the webhook channel: a redirect must not be able to
        // carry the access token to another host.
        redirect: 'manual',
      });
    } catch (err) {
      logger.warn(`alerting: matrix send failed (${err.message})`);
      return { ok: false, detail: `request failed: ${err.message}` };
    }

    if (!res || !res.ok) {
      // The homeserver's own error code is the useful part (M_FORBIDDEN means
      // the bot is not in the room, M_UNKNOWN_TOKEN means the token expired) —
      // an operator reading "403" alone would have to go and look it up.
      let code = '';
      try {
        const detail = await res.json();
        if (detail && detail.errcode) code = ` ${detail.errcode}`;
      } catch { /* a non-JSON error body is not worth failing over */ }
      return { ok: false, detail: `homeserver returned ${res ? res.status : 'no response'}${code}` };
    }
    return { ok: true, detail: `posted to ${config.roomId}` };
  }

  // Built on Node's global fetch — no optional dependency, always available.
  function status() {
    const hasFetch = typeof fetchImpl === 'function';
    return { available: hasFetch, reason: hasFetch ? undefined : 'no fetch implementation' };
  }

  return { name: 'matrix', send, status };
}

module.exports = { createMatrixChannel, renderMessage, txnIdFor, encodePathSegment, SEVERITY_MARK };
