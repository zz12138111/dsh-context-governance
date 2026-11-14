// 只读：解压多帧会话日志，输出事件骨架 + source 归属（不输出正文）。
// 用法：node session-shape3.mjs <file.zstd> [maxLines]
import fs from 'node:fs'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
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

const file = process.argv[2]
const maxLines = Number(process.argv[3] ?? 0) || Infinity
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null
const buffer = fs.readFileSync(file)
const { frames, tornStart } = scanZstdFrames(buffer)
console.error(`# frames=${frames.length} tornStart=${tornStart ?? 'none'} bytes=${buffer.length}`)

let printed = 0
let total = 0
for (const frame of frames) {
  let text
  try {
    text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  } catch (error) {
    console.error(`# frame ${frame.start}-${frame.end} decode failed: ${String(error?.message ?? error)}`)
    continue
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    total++
    if (printed >= maxLines) continue
    let event
    try { event = JSON.parse(line) } catch { console.log(`UNPARSED line=${total}`); continue }
    const data = event?.data ?? {}
    const type = event?.type ?? '?'
    if (filter && !filter.test(type)) continue
    printed++
    const src = String(data?.message?.source?.kind ?? data?.source?.kind ?? '')
    const plugin = String(data?.message?.source?.plugin ?? data?.source?.plugin ?? '')
    const form = String(data?.message?.source?.form ?? data?.source?.form ?? '')
    const op = event?.surfaceOp === undefined ? '' : (typeof event.surfaceOp === 'string' ? event.surfaceOp : 'replace')
    const turn = data?.turn === undefined ? '' : String(data.turn)
    const step = data?.step === undefined ? '' : String(data.step)
    console.log(`${event?.seq ?? total - 1}\t${type}\tturn=${turn}\tstep=${step}\top=${op}\tsrc=${src}\tplugin=${plugin}\tform=${form}`)
  }
}
console.log('---')
console.log(`total_lines=${total} printed=${printed}`)
