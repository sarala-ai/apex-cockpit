// Correlation-spine → OpenTelemetry environment injection (EMITTER side).
//
// The implementation lives in `@paperclipai/adapter-utils/observe-spine-env`
// because the real coding-agent spawn point (acpx-engine/execute.ts) is in that
// package, which sits BELOW `server` in the dependency graph and cannot import
// this file. It is re-exported here at the location the observe layer expects.
//
// The attribute keys in the helper mirror the durable `Spine` contract in
// ./contract.ts. The static assertion below fails typechecking if the two ever
// drift, keeping contract.ts the single conceptual source of truth.

import { Spine } from "./contract.js";
import {
  SPINE_ATTRIBUTE_KEYS,
  buildResourceAttributes,
  mergeResourceAttributes,
  otelEnv,
  type RunSpine,
} from "@paperclipai/adapter-utils/observe-spine-env";

export { buildResourceAttributes, mergeResourceAttributes, otelEnv, SPINE_ATTRIBUTE_KEYS };
export type { RunSpine };

// ── Drift guard: the helper's keys MUST equal contract.ts `Spine`, exactly. ──
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
// Both directions: same field set, same string-literal value per field.
const _spineKeysMatchContract: AssertEqual<typeof SPINE_ATTRIBUTE_KEYS, typeof Spine> = true;
void _spineKeysMatchContract;
