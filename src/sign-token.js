#!/usr/bin/env node
// Mint a signed agent token for use as the agent's WS bearer token.
//
//   WS_AGENT_SECRET=... node src/sign-token.js <agentId> [ttlSeconds]
//
// ttlSeconds defaults to 1 year. Prints the token to stdout.
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { signAgentToken } from './auth.js';

const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;

function main(argv) {
  const agentId = argv[0];
  const ttl = argv[1] ? parseInt(argv[1], 10) : DEFAULT_TTL_SECONDS;
  if (!agentId || !Number.isFinite(ttl) || ttl <= 0) {
    console.error('usage: WS_AGENT_SECRET=... node src/sign-token.js <agentId> [ttlSeconds]');
    return 1;
  }
  if (!config.wsAgentSecret) {
    console.error('WS_AGENT_SECRET is not set — cannot sign a token');
    return 1;
  }
  const exp = Math.floor(Date.now() / 1000) + ttl;
  process.stdout.write(`${signAgentToken(agentId, exp, config.wsAgentSecret)}\n`);
  return 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
