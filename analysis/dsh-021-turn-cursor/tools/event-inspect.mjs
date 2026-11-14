// 只读：导出指定 seq 事件的“结构骨架”（键名/类型/source 字段），不输出任何正文。
// 用法：node event-inspect.mjs <file.zstd> <seq> [<seq>...]
import fs from 'node:fs'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
function scanZstdFrames(buffer) {
  const frames = []; let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved header bit at ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const shape = (value, depth = 0) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})` + (value.length > 0 && depth < 2 ? `[${shape(value[0], depth + 1)}]` : '')
  if (typeof value === 'object') {
    if (depth > 2) return 'object'
    return '{' + Object.keys(value).map((key) => `${key}:${shape(value[key], depth + 1)}`).join(',') + '}'
  }
  if (typeof value === 'string') return `string(${value.length})`
  return typeof value
}

const file = process.argv[2]
const wanted = new Set(process.argv.slice(3).map(Number))
const buffer = fs.readFileSync(file)
const { frames } = scanZstdFrames(buffer)
let done = 0
for (const frame of frames) {
  const text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (typeof event?.seq !== 'number' || !wanted.has(event.seq)) continue
    console.log(`## seq=${event.seq} type=${event.type} surfaceOp=${JSON.stringify(event.surfaceOp ?? null)}`)
    console.log(`   data=${shape(event.data)}`)
    const src = event?.data?.message?.source ?? event?.data?.source
    if (src && typeof src === 'object') {
      console.log(`   source.keys=${Object.keys(src).join(',')}`)
      console.log(`   source.kind=${JSON.stringify(src.kind)} plugin=${JSON.stringify(src.plugin ?? null)} form=${JSON.stringify(src.form ?? null)} cycle=${JSON.stringify(src.cycle ?? null)}`)
    }
    done++
  }
  if (done >= wanted.size) break
}
