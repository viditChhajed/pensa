-- Counters, never records. See server/README.md.
--
-- Version 2: per-site prevalence. Nothing was ever deployed against version 1, so this is a
-- fresh schema rather than a migration.
--
-- The primary key IS the cohort, so a row cannot exist that is finer-grained than the design
-- allows. There is deliberately no id column, no person, no path, no timestamp beyond the day
-- bucket, and nowhere to put any of them.
create table if not exists counts (
  pattern_id       text     not null,
  detector_id      text     not null,
  funnel_stage     text     not null,
  -- The shop's registrable domain, e.g. 'shein.com'. Only ever a page that passed the
  -- extension's commerce gate, so only ever somewhere that was selling something.
  site             text     not null,
  origin_category  text     not null,
  rulepack_version text     not null,
  -- Epoch days. Multiply by 86400 for a unix timestamp at UTC midnight.
  day_bucket       integer  not null,
  quartile         integer  not null,
  -- Detections counted into this cohort.
  n                integer  not null default 0,
  -- Batches that touched this row, NOT people. No reporter identity exists to count.
  reporters        integer  not null default 0,
  primary key (pattern_id, detector_id, funnel_stage, site, origin_category,
               rulepack_version, day_bucket, quartile)
);

create index if not exists counts_by_site    on counts (site);
create index if not exists counts_by_pattern on counts (pattern_id);
create index if not exists counts_by_day     on counts (day_bucket);

-- ---------------------------------------------------------------------------------------
-- Research views. Query these rather than the table.
-- ---------------------------------------------------------------------------------------

-- Which techniques each shop has been seen using, and how often. The core per-site
-- prevalence question: "does shein.com use countdowns, and how much".
create view if not exists site_prevalence as
  select site,
         origin_category,
         pattern_id,
         sum(n)                     as detections,
         sum(reporters)             as batches,
         count(distinct day_bucket) as days_seen,
         min(day_bucket)            as first_day,
         max(day_bucket)            as last_day
  from counts
  group by site, origin_category, pattern_id;

-- How widespread each technique is: on how many distinct shops it has been observed.
create view if not exists pattern_reach as
  select pattern_id,
         count(distinct site) as sites,
         sum(n)               as detections
  from counts
  group by pattern_id;

-- Where in the funnel each technique appears. Pricing tricks at checkout are a different
-- finding from the same trick on a product page.
create view if not exists pattern_by_stage as
  select pattern_id, funnel_stage, count(distinct site) as sites, sum(n) as detections
  from counts
  group by pattern_id, funnel_stage;

-- The PUBLISHABLE cut. Anything you intend to share outside the project comes from here:
-- a (site, pattern) pair is only released once enough independent batches have reported it
-- that no single browsing session can be picked out of it. 20 is a starting point, not a
-- derived number.
create view if not exists site_prevalence_public as
  select * from site_prevalence where batches >= 20;
