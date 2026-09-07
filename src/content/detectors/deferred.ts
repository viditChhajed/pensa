/**
 * Tier-2 page detectors — BUILT AND TESTED, NOT SHIPPED IN v1.
 *
 * The plan scopes these to v1.1 during store review (§13). They are collected here rather
 * than deleted so v1.1 is a one-line change, and kept OUT of `index.ts` so no entrypoint
 * imports them and they cannot reach a built bundle. See `src/shared/scope.ts`.
 *
 * Only tests import this file.
 */
import type { Detector } from "../types";
import { decoyDetector } from "./decoy";
import { exitIntentDetector } from "./exitIntent";
import { framingDetector } from "./framing";
import { interferenceDetector } from "./interference";
import { naggingDetector } from "./nagging";

export const DEFERRED_DETECTORS: readonly Detector[] = [
  interferenceDetector,
  decoyDetector,
  naggingDetector,
  framingDetector,
  exitIntentDetector,
];
