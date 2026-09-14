/**
 * Cloudflare Worker entry point for the telemetry sink.
 *
 * Thin by design: `handle()` in ../handler.ts holds every rule about what may be accepted,
 * and this file holds only the things that are specific to running on Cloudflare. Keeping
 * them apart is what lets the rules be unit-tested without a Worker runtime, and what makes
 * a move to another host a change to this file alone.
 */
import { type CountRow, handle, type Store } from "../handler";

export interface Env {
  DB: D1Database;
}

/**
 * D1-backed counters. No rows, only totals.
 *
 * A store of individual records can be correlated after the fact — by hour, by category, by
 * anyone who later gains access to it. A store of counters cannot, and the aggregate is the
 * only thing this project ever wanted.
 *
 * `reporters` counts BATCHES that touched the row, never people. There is no reporter id and
 * no way to construct one, which is the strongest form of the k-floor available without
 * introducing exactly the identifier the design exists to avoid.
 */
function d1Store(env: Env): Store {
  return {
    async increment(rows: CountRow[]): Promise<void> {
      const statement = env.DB.prepare(
        `insert into counts (pattern_id, detector_id, funnel_stage, origin_category,
                             rulepack_version, hour_bucket, quartile, n, reporters)
         values (?, ?, ?, ?, ?, ?, ?, 1, 1)
         on conflict (pattern_id, detector_id, funnel_stage, origin_category,
                      rulepack_version, hour_bucket, quartile)
         do update set n = n + 1, reporters = reporters + 1`,
      );

      // One batch, so a partial write cannot leave the aggregate inconsistent.
      await env.DB.batch(
        rows.map((r) =>
          statement.bind(
            r.patternId,
            r.detectorId,
            r.funnelStage,
            r.originCategory,
            r.rulepackVersion,
            r.hourBucket,
            r.quartile,
          ),
        ),
      );
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    /**
     * CORS preflight. The extension posts from a `chrome-extension://` origin, which is
     * opaque and cannot be allowlisted by name.
     *
     * `*` is correct here and is not a weakening: there is nothing to protect. The endpoint
     * accepts anonymous counters, holds no session, sets no cookie, returns no body, and
     * reads nothing back. A same-origin policy defends a user's authenticated state, and
     * there is none — the request carries `credentials: "omit"` from the client precisely so
     * that stays true.
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname !== "/counts") return new Response(null, { status: 404 });

    const response = await handle(request, d1Store(env));
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", "*");
    return new Response(response.body, { status: response.status, headers });
  },
};

/** Minimal D1 surface, so this compiles without pulling in @cloudflare/workers-types. */
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
}
