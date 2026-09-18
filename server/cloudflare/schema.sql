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

-- ---------------------------------------------------------------------------------------
-- Version 3: page-view outcomes. Additive; nothing above changes.
--
-- One row per (technique, site, stage, day, whether an add-to-cart click followed). A page
-- view contributes one '_page' baseline row plus one row per technique that was on screen
-- BEFORE the decision. Counters only, same as `counts`.
-- ---------------------------------------------------------------------------------------
create table if not exists outcomes (
  -- A taxonomy id, or '_page' for the every-view baseline.
  pattern_id       text     not null,
  -- 'browse' or 'pdp' only: the stages where adding to cart is the decision being made.
  funnel_stage     text     not null,
  site             text     not null,
  origin_category  text     not null,
  rulepack_version text     not null,
  day_bucket       integer  not null,
  -- 1 if an add-to-cart click followed on the same page view. The click, not a confirmed add.
  added_to_cart    integer  not null,
  n                integer  not null default 0,
  reporters        integer  not null default 0,
  primary key (pattern_id, funnel_stage, site, origin_category, rulepack_version,
               day_bucket, added_to_cart)
);

create index if not exists outcomes_by_site    on outcomes (site);
create index if not exists outcomes_by_pattern on outcomes (pattern_id);

-- Per technique, across all shops: page views that showed it, how many were followed by an
-- add, and the rate. The '_page' row is the baseline every other row should be read against.
--
-- READ THIS BEFORE THE NUMBERS. This is association, not effect. Pages that run a technique
-- differ from pages that do not in product, price and why the shopper is there, and all of
-- that moves the add rate. A higher rate beside a technique does not mean the technique caused
-- it. For a fairer comparison use `site_pattern_add_rate`, which holds the shop fixed.
create view if not exists pattern_add_rate as
  select pattern_id,
         sum(n)                                                    as views,
         sum(case when added_to_cart = 1 then n else 0 end)        as added,
         round(1.0 * sum(case when added_to_cart = 1 then n else 0 end) / sum(n), 4) as add_rate,
         count(distinct site)                                      as sites
  from outcomes
  group by pattern_id;

-- The same, within each shop, beside that shop's own baseline. `lift` above 1 means page views
-- showing the technique were followed by an add more often than that shop's page views overall.
-- Still association: within a shop, the pages with countdowns are usually the sale items.
create view if not exists site_pattern_add_rate as
  with per as (
    select site, pattern_id,
           sum(n) as views,
           sum(case when added_to_cart = 1 then n else 0 end) as added,
           sum(reporters) as batches
    from outcomes
    group by site, pattern_id
  ),
  base as (
    select site, views as base_views, added as base_added
    from per where pattern_id = '_page'
  )
  select per.site, per.pattern_id, per.views, per.added,
         round(1.0 * per.added / per.views, 4)                  as add_rate,
         base.base_views,
         round(1.0 * base.base_added / base.base_views, 4)      as base_add_rate,
         case when base.base_added = 0 then null
              else round((1.0 * per.added / per.views) / (1.0 * base.base_added / base.base_views), 3)
         end                                                    as lift,
         per.batches
  from per join base using (site)
  where per.pattern_id <> '_page';

-- Publishable cut, same floor as site_prevalence_public.
create view if not exists site_pattern_add_rate_public as
  select * from site_pattern_add_rate where batches >= 20;
