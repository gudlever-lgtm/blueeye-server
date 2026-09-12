-- Accessibility checks (V2 §9).
--
-- The findings live on the RUN, beside `api_calls` and for the same reason: they
-- are what that execution observed, at that moment, against that version of the
-- page. Putting them in their own table would invite them to be queried as an
-- estate-wide score, which is exactly the reading the spec forbids — an
-- accessibility finding is not an incident and must never be summed with one.
--
-- Nothing here can fail a run. `status` is untouched by this column, and the API
-- and the dashboard read it into a separate panel. An image missing alt text is
-- not the service being down, and a report that can turn a build red is a report
-- people switch off.
--
-- { findings: [...], counts: {serious,moderate,minor,total}, truncated, checked }
-- MySQL 8.4: a JSON column takes no default, so it is NULL until a run collects
-- one — which is also how "this run predates the feature" stays distinguishable
-- from "this run found nothing".
ALTER TABLE service_test_runs
  ADD COLUMN accessibility JSON DEFAULT NULL AFTER api_calls;
