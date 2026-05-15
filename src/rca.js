import config from './config.js';
import { recentResultsForAgent } from './db/queries.js';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function forwardToRca(result) {
  if (!config.rcaEnabled) {
    return;
  }

  const recent = recentResultsForAgent(result.agentId, 10).map((r) => ({
    id: r.id,
    testId: r.test_id,
    type: r.type,
    target: r.target,
    status: r.status,
    result: parseJson(r.result, {}),
    error: r.error,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }));

  const payload = {
    agentId: result.agentId,
    testId: result.testId,
    type: result.type,
    target: result.target,
    result: result.result ?? {},
    recentResults: recent,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${config.rcaUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[rca] Forward failed: HTTP ${res.status}`);
      return;
    }
    console.log(`[rca] Forwarded result for test ${result.testId}`);
  } catch (err) {
    console.error(`[rca] Forward failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}
