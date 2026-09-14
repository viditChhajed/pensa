-- Counters, never records. See server/README.md.
--
-- The primary key IS the cohort, so a row cannot exist that is finer-grained than the
-- anonymity design allows. There is deliberately no id column, no timestamp beyond the hour
-- bucket, and nowhere to put one.
create table if not exists counts (
  pattern_id       text     not null,
  detector_id      text     not null,
  funnel_stage     text     not null,
  origin_category  text     not null,
  rulepack_version text     not null,
  hour_bucket      integer  not null,
  quartile         integer  not null,
  n                integer  not null default 0,
  -- Batches that touched this row, NOT people. No reporter identity exists to count.
  reporters        integer  not null default 0,
  primary key (pattern_id, detector_id, funnel_stage, origin_category,
               rulepack_version, hour_bucket, quartile)
);

-- The k-anonymity floor lives in the read path too, not only in the client and the handler.
-- Query this view rather than the table: a cohort below k=20 is a fingerprint, and a view
-- that is the obvious thing to SELECT from is a better control than a rule someone has to
-- remember.
create view if not exists counts_public as
  select pattern_id, detector_id, funnel_stage, origin_category,
         rulepack_version, hour_bucket, quartile, n, reporters
  from counts
  where reporters >= 20;
