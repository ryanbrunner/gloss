/**
 * The bar, for a host to mount on a page with a transport of its own. It
 * needs a DOM; nothing here runs in Node.
 */
export { mountBar, statusText, type BarOptions, type Mode } from './bar.js';
export { BAR_HEIGHT, STATUS_HEIGHT } from './styles.js';
export {
  BINDING,
  DELIVER,
  bindingTransport,
  demoStore,
  memoryTransport,
  type Delivery,
  type DemoRound,
  type DemoTarget,
  type RpcCall,
  type RpcRequest,
  type Transport,
} from './transport.js';
