/**
 * Zstandard session-log decoding.
 *
 * A DSH `session.vN.jsonl.zstd` artifact is a concatenation of independent,
 * checksummed Zstandard frames — one for the header line and one per durable
 * append batch. Node's one-shot API decodes exactly one frame, so the frame
 * boundaries have to be found first. This module scans the frame structure
 * (RFC 8878: frame header + block headers) and then decodes frame by frame.
 *
 * Nothing here throws to the caller: a structurally corrupt artifact returns
 * `null` with a reason, and the indexer skips that session.
 *
 * @module dsh-happycode/zstd
 */

import zlib from 'node:zlib'

/** Little-endian read of the Zstandard frame magic (`0xFD2FB528`). */
const ZSTD_MAGIC = 0xfd2fb528

/** A structurally incomplete tail is a crash artifact, not corruption. */
export class TornTailError extends Error {}

/**
 * Whether the running Node can decode Zstandard at all (>= 22.15).
 * @returns {boolean} true when `zlib.zstdDecompressSync` exists.
 */
export function zstdAvailable () {
  return typeof zlib.zstdDecompressSync === 'function'
}

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * Returns the complete frame ranges plus, when the file ends inside a frame,
 * the offset where that final frame starts. An incomplete tail is reported
 * rather than thrown: it is what an interrupted write leaves behind.
 *
 * @param {Buffer} buffer - the whole artifact as currently present on disk.
 * @returns {{ frames: Array<{ start: number, end: number }>, tornStart?: number }}
 * @throws {Error} when a complete frame is structurally invalid.
 */
export function scanFrames (buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return torn(frames, start)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return torn(frames, start)

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return torn(frames, start)
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return torn(frames, start)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      // A raw block carries `blockSize` bytes; an RLE block carries exactly one.
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return torn(frames, start)
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return torn(frames, start)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function torn (frames, start) {
  return { frames, tornStart: start }
}

/**
 * Decode every complete frame and concatenate the plaintext.
 *
 * @param {Buffer} buffer - the whole artifact.
 * @returns {{ text: string, frames: number, torn: boolean }}
 * @throws {Error} when a complete frame fails to decode or validate.
 */
export function decodeFrames (buffer) {
  if (!zstdAvailable()) throw new Error('this Node does not provide zlib zstd support')
  const { frames, tornStart } = scanFrames(buffer)
  let text = ''
  for (const frame of frames) {
    let plaintext
    try {
      plaintext = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch (error) {
      throw new Error(`frame at byte ${frame.start} failed to decode: ${error && error.message ? error.message : error}`)
    }
    // Frames hold whole rows, so a frame boundary is also a line boundary even
    // when the writer did not end the previous frame with a newline.
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    text += plaintext
  }
  return { text, frames: frames.length, torn: tornStart !== undefined }
}

/**
 * Yield parsed JSONL rows, tolerating bad lines.
 *
 * A malformed line is counted and skipped; the session keeps its other rows.
 *
 * @param {string} text - decoded JSONL text.
 * @param {(line: string, index: number) => void} [onBadLine] - receives skipped lines.
 * @returns {Generator<object>} parsed rows.
 */
export function * parseJsonl (text, onBadLine) {
  let index = 0
  for (const line of text.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed === '') { index += 1; continue }
    try {
      yield JSON.parse(trimmed)
    } catch {
      if (onBadLine) onBadLine(trimmed, index)
    }
    index += 1
  }
}
