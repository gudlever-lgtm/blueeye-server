-- Visual regression baselines (V2 §8).
--
-- A baseline is "this is what this step is supposed to look like". One per
-- (test, step, environment): the same journey against staging and production
-- legitimately looks different, and one shared baseline would report that
-- difference forever.
--
-- The IMAGE lives on disk beside the run screenshots, under the same root, the
-- same retention plumbing and the same cleanup. Only the path is stored here.
-- A few hundred baselines as MySQL blobs would turn every dump into hundreds of
-- megabytes and slow every backup, to solve a problem the artifact store already
-- solves.
--
-- Opt-in per step, per the spec. Nothing is compared until somebody accepts a
-- baseline, because a baseline captured automatically on first sight is a
-- baseline of whatever the page happened to look like that day — including
-- broken.
CREATE TABLE IF NOT EXISTS service_test_baselines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  test_id INT NOT NULL,
  -- The step this is a picture of, by its position in the definition. Positions
  -- move when steps are reordered, which is why `step_label` is stored too: it
  -- is what the dashboard shows, so a baseline whose step has moved is visible
  -- as a mismatch rather than silently comparing the wrong step.
  step_index INT NOT NULL,
  step_label VARCHAR(255) DEFAULT NULL,
  -- NULL means "whatever environment the run used". A baseline per environment
  -- is the common case; a single environment-less one is allowed for a test
  -- that only ever runs in one place.
  environment_id INT DEFAULT NULL,

  -- Relative to the artifact root, like service_test_runs.screenshot_path, so
  -- the root can move without rewriting rows.
  image_path VARCHAR(512) NOT NULL,
  width INT DEFAULT NULL,
  height INT DEFAULT NULL,

  -- The rectangles the operator drew over the parts they know move — a clock, a
  -- carousel, an A/B slot. [{x,y,width,height,label}]
  ignore_regions JSON DEFAULT NULL,
  -- Per-baseline overrides of the comparison defaults. NULL = use the settings.
  tolerance INT DEFAULT NULL,
  threshold_pct DECIMAL(5,2) DEFAULT NULL,

  -- Off keeps the baseline and its ignore regions while stopping the comparison,
  -- so "we know this page is in flux this month" does not mean deleting work.
  enabled TINYINT(1) NOT NULL DEFAULT 1,

  -- Who decided this is what the page should look like, and when. A baseline
  -- nobody will admit to accepting is one nobody dares replace.
  --
  -- No foreign key to `users`, deliberately, and for two reasons. It matches
  -- every other user reference in this module (`created_by`, `updated_by`,
  -- `resolved_by` are all plain columns), and ON DELETE SET NULL would ERASE
  -- who accepted a baseline the moment that person left — losing exactly the
  -- provenance this column exists to keep.
  accepted_by INT DEFAULT NULL,
  accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The run the image was taken from, so the baseline can be traced back to the
  -- execution that produced it. SET NULL rather than CASCADE: retention deletes
  -- old runs, and a baseline must not vanish with the run it came from.
  source_run_id INT DEFAULT NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- One baseline per step per environment. Two would mean the comparison picks
  -- one arbitrarily, and which one it picked would decide the answer.
  UNIQUE KEY uq_stbase_step (test_id, step_index, environment_id),
  KEY idx_stbase_test (test_id, enabled),

  CONSTRAINT fk_stbase_test FOREIGN KEY (test_id)
    REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_stbase_env FOREIGN KEY (environment_id)
    REFERENCES service_test_environments(id) ON DELETE CASCADE,
  CONSTRAINT fk_stbase_run FOREIGN KEY (source_run_id)
    REFERENCES service_test_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The comparison outcome for a run, beside `accessibility` and for the same
-- reason: it is what THAT execution saw. A difference is a warning and never a
-- failure, so nothing here touches `status`.
--
-- [{ step_index, step_label, status, changed_pct, regions, ... }]
ALTER TABLE service_test_runs
  ADD COLUMN visual JSON DEFAULT NULL AFTER accessibility;
