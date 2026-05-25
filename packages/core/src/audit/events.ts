// Re-export the shared base helper so existing imports of base() still resolve.
export { base } from "./internal.js";

// Domain-grouped re-exports — all factories remain importable from this path
// for backward compatibility with existing call sites.
export * from "./pm-events.js";
export * from "./dashboard-events.js";
export * from "./policy-release-events.js";
