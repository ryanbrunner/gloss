/**
 * What any host of a review needs, with no DOM and no HTTP server: the store
 * a round lives in, the verdict the agent reads, and the checks a call from
 * the bar goes through. The bar is `@glossdev/core/bar`; the agent's HTTP API
 * is `@glossdev/core/server`.
 */
export * from './store.js';
export * from './store-data.js';
export * from './verdict.js';
export * from './rpc.js';
export { firstLine } from './util.js';
