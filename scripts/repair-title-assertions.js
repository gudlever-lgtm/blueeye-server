#!/usr/bin/env node
'use strict';

// Repairs saved Service Assurance tests that carry a title assertion which can
// never pass.
//
//   npm run repair-title-assertions            # dry run — lists what it would change
//   npm run repair-title-assertions -- --apply # writes
//
// Discovery used to suggest a Login (and Availability) test ending in
// `assert_text_contains` against the page TITLE, which lives in `<head>` and can
// therefore never be found on the page. The rules were fixed in 0.123.6, but a
// test an operator already accepted still holds the broken step and still fails
// every run after the full step timeout. This turns those steps into the
// `assert_title_contains` they meant to be.
//
// Every write goes through the repository's own save(), so the previous
// definition is snapshotted into service_test_test_versions and the version is
// bumped — the repair is auditable and revertable like any other edit.
//
// Safe to run repeatedly: a repaired test no longer matches, so a second run
// reports nothing to do.

require('dotenv').config();

const { createDb } = require('../src/db');
const { createLogger } = require('../src/logger');
const { dbConfig } = require('../src/lib/coreEnv');
const { createTestsRepository } = require('../src/serviceTests/storage/testsRepository');
const { repairDefinition } = require('../src/serviceTests/engine/repair');

const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
  const apply = process.argv.includes('--apply');
  const db = createDb({ db: dbConfig() });
  const tests = createTestsRepository({ db });

  try {
    const all = await tests.list({});
    const pending = [];
    for (const test of all) {
      const { definition, changed } = repairDefinition(test.definition);
      if (changed) pending.push({ test, definition, changed });
    }

    if (!pending.length) {
      logger.info('repair-title-assertions: nothing to repair — no saved test asserts a page title as page text.');
      return;
    }

    for (const { test, changed } of pending) {
      logger.info(`  #${test.id} "${test.name}" — ${changed} step(s)`);
    }

    if (!apply) {
      logger.info(`repair-title-assertions: ${pending.length} test(s) would be repaired. Re-run with --apply to write.`);
      return;
    }

    let repaired = 0;
    for (const { test, definition } of pending) {
      // eslint-disable-next-line no-await-in-loop
      await tests.save(test.id, { definition });
      repaired += 1;
    }
    logger.info(`repair-title-assertions: repaired ${repaired} test(s). The previous definition is kept as a version.`);
  } finally {
    try { await db.close(); } catch { /* the repair is already committed */ }
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(`repair-title-assertions failed: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
