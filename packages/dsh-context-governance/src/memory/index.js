/**
 * 记忆模块公共出口。
 *
 * 外部只需要 `MemoryStore` + 契约常量；文件格式与原子写属于实现细节，
 * 但为了测试与审计也一并导出（无副作用）。
 */

export {
  ENTRY_STATUSES,
  ENTRY_TYPES,
  ID_PATTERN,
  MEMORY_LIMITS,
  MemoryContractError,
  RISKS,
  STATUS_LABELS,
  WRITERS,
  assertStatusTransition,
  detectSensitive,
  formatPointer,
  localDateId,
  nextEntryId,
  normalizeDraft,
  normalizePatch,
} from './contract.js';
export {
  META_KEYS,
  MemoryFormatError,
  parseTopicFile,
  renderIndex,
  serializeEntryBlock,
  serializeTopicFile,
} from './entry-format.js';
export { atomicWriteFile, fileStamp, hashFile, hashText, readTextIfExists } from './atomic.js';
export { LOCK_FILE_NAME, acquireWriterLock, isPidAlive, readWriterLock } from './lock.js';
export {
  DEFAULT_MEMORY_DIR,
  ExternalModificationError,
  INDEX_FILE_NAME,
  MemoryReadOnlyError,
  MemoryStore,
  MemoryStoreError,
  TOPICS_DIR_NAME,
} from './store.js';
