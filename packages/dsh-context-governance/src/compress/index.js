/** 压缩治理模块出口（T3）。 */
export {
  ADAPTER_KINDS,
  AdapterContractError,
  DEFAULT_MATRIX,
  FIVE_SECTION_HEADINGS,
  PERCEPTION_LEVELS,
  applySummaryObservation,
  classifySummaryText,
  createContextZipAdapter,
  createHostBasicAdapter,
  detectAdapter,
  detectHostVersion,
  normalizeBackendVersion,
  runSelfCheck,
  validateAdapter,
} from './adapters.js';
export {
  PROTECTION_CHECKS,
  expectedSurface,
  messageOf,
  snapshotProtection,
  sourceKindOf,
  summaryTextOf,
  textOf,
  verifyProtection,
} from './protection.js';
export { CompressionGuard } from './runtime.js';
export { buildProtectionItems } from './protection-memory.js';
export { MODES, detectConflicts, selectMode } from './selection.js';
