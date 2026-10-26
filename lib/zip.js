/**
 * DSHM 备份插件 —— 零依赖 ZIP 模块（ESM，仅使用 Node 内置模块）
 *
 * 目标运行环境：DSHM 宿主 Node v24.2.0（jitless、无 WASM）。
 *
 * 设计要点：
 *   - 写端：本地文件头（local header）使用 data descriptor（通用位 bit 3），
 *     文件名一律 UTF-8 并置 bit 11；数据通过 createDeflateRaw / 原始分块流式写入，
 *     不把大文件整包读进内存；整包 SHA-256 边写边算；先写同目录临时文件（wx），
 *     fsync 后 rename 原子提交，绝不覆盖已存在的目标文件（ZIP_TARGET_EXISTS）。
 *   - 读端：从文件尾部回扫 EOCD（最多 22+65535 字节）→ 解析中央目录 →
 *     按 local header 计算数据区偏移 → inflateRaw 流式解压；逐条校验 CRC32 / 大小 /
 *     可选 SHA-256；不整包解压到内存。
 *   - 支持 method 0(store) / 8(deflate)。不支持：ZIP64、加密、分卷（multi-disk）、
 *     符号链接条目。遇到明确抛错，错误对象带可用于中文提示映射的 code 字段。
 *   - CRC32 为自实现查表版本（不依赖 zlib.crc32），字节序全部按 ZIP 规范小端。
 *   - 所有条目名在写、读两端都做路径安全校验（防 Zip Slip：绝对路径、盘符、
 *     反斜杠、.. 段、空段、NUL/控制字符、超长名、重复名）。
 *   - 解压时先做全量预检（路径 / 重复 / method / 大小 / zip bomb 压缩比 / symlink），
 *     全部通过后才开始落盘；逐个条目解到目标目录内的临时文件，校验通过后 rename。
 *     若中途失败，已成功解出的文件会保留，由调用方负责清理 destDir
 *     （当前失败条目的临时文件会被删除）。
 *
 * 错误 code 一览：
 *   ZIP_INVALID_ARGUMENT、ZIP_PATH_UNSAFE、ZIP_DUPLICATE、ZIP_UNSUPPORTED、
 *   ZIP_BAD_FORMAT、ZIP_CRC_MISMATCH、ZIP_SIZE_MISMATCH、ZIP_HASH_MISMATCH、
 *   ZIP_LIMIT、ZIP_TARGET_EXISTS、ZIP_NOT_FOUND、ZIP_IO、
 *   ZIP_DEST_INVALID、ZIP_DEST_NOT_EMPTY
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 对外暴露的硬性上限（不变量，宿主可据此展示）。不支持 ZIP64，故都卡在 32 位以内。 */
export const ZIP_LIMIT = Object.freeze({
  maxEntries: 65534,
  maxTotalBytes: 0xffffffff - 1024,
  maxSingleEntryBytes: 0xffffffff - 1024,
});

/** 归档文件本身的字节上限（local header + 数据 + 中央目录 + EOCD 都要能在 32 位内寻址）。 */
const MAX_ARCHIVE_BYTES = 0xffffffff - 1024;
/** 条目名总字节上限。 */
const MAX_NAME_BYTES = 1024;
/** 单个路径段字节上限。 */
const MAX_SEGMENT_BYTES = 255;
/** readZipEntry 单次读取上限（manifest.json 预览用）。 */
const MAX_READ_ENTRY_BYTES = 8 * 1024 * 1024;
/** 允许一次性读入内存的中央目录大小上限（约 6.5 万条目 × 平均 150 字节远小于此值）。 */
const MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;
/** EOCD 回扫窗口：EOCD 定长 22 字节 + 最大注释 65535 字节。 */
const MAX_EOCD_SEARCH = 22 + 0xffff;
/** zip bomb：解压后超过 64 MiB 且压缩比超过 200:1 视为异常。 */
const BOMB_RATIO = 200;
const BOMB_MIN_SIZE = 64 * 1024 * 1024;
/** 流式读写分块大小。 */
const IO_CHUNK_SIZE = 256 * 1024;
/** onProgress 回调的最小字节间隔。 */
const PROGRESS_STEP_BYTES = 4 * 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
/**
 * 不支持的通用标志位：bit0 加密、bit4 增强压缩、bit5 修补数据、bit6 强加密、
 * bit13 掩码头、bit14/15 保留位。bit1/bit2（deflate 选项）、bit3（data descriptor）、
 * bit11（UTF-8）允许。
 */
const UNSUPPORTED_FLAGS =
  0x0001 | 0x0010 | 0x0020 | 0x0040 | 0x2000 | 0x4000 | 0x8000;

const EMPTY_SHA256 = createHash('sha256').digest('hex');

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 构造带 code 的 ZIP 错误。宿主按 code 映射中文提示。
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 */
function zipError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  err.zipError = true;
  if (cause !== undefined) err.cause = cause;
  return err;
}

// ---------------------------------------------------------------------------
// CRC32（自实现查表；IEEE 802.3 / ZIP 规范多项式 0xEDB88320）
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 增量 CRC32（内部约定：crc 初值传 0xFFFFFFFF，结束后再取反）。
 * @param {number} crc
 * @param {Uint8Array} buf
 * @returns {number} 无符号 32 位
 */
function crc32Update(crc, buf) {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return c >>> 0;
}

/**
 * 计算 Buffer/Uint8Array 的 CRC32（与 ZIP 字段同义）。
 * @param {Uint8Array} buf
 * @returns {number} 无符号 32 位
 */
export function crc32(buf) {
  if (!(buf instanceof Uint8Array)) {
    throw zipError('ZIP_INVALID_ARGUMENT', 'crc32 入参必须是 Buffer/Uint8Array');
  }
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 条目名校验（写、读两端共用）
// ---------------------------------------------------------------------------

/**
 * 校验并规范化条目名。
 *
 * 允许：普通 UTF-8 文件名、空格、中文、嵌套目录；目录条目以 "/" 结尾。
 * 拒绝：非字符串/空串、反斜杠、绝对路径、盘符（C:）、NUL/控制字符、
 *       "." / ".." / 空路径段、单段 >255 字节、总长 >1024 字节。
 *
 * @param {unknown} rawName
 * @param {string} label 用于错误信息
 * @returns {{ name: string, segments: string[], isDirectory: boolean, byteLength: number }}
 */
function validateEntryName(rawName, label) {
  if (typeof rawName !== 'string') {
    throw zipError('ZIP_PATH_UNSAFE', `${label} 必须是字符串`);
  }
  if (rawName.length === 0) {
    throw zipError('ZIP_PATH_UNSAFE', `${label} 不能为空`);
  }
  if (rawName.includes('\\')) {
    throw zipError('ZIP_PATH_UNSAFE', `${label} 含反斜杠：${JSON.stringify(rawName)}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(rawName)) {
    throw zipError('ZIP_PATH_UNSAFE', `${label} 含 NUL 或控制字符：${JSON.stringify(rawName)}`);
  }
  if (rawName.startsWith('/')) {
    throw zipError('ZIP_PATH_UNSAFE', `${label} 不能是绝对路径：${JSON.stringify(rawName)}`);
  }
  if (/^[A-Za-z]:/.test(rawName)) {
    throw zipError('ZIP_PATH_UNSAFE', `${label} 不能含盘符：${JSON.stringify(rawName)}`);
  }

  const byteLength = Buffer.byteLength(rawName, 'utf8');
  if (byteLength > MAX_NAME_BYTES) {
    throw zipError(
      'ZIP_PATH_UNSAFE',
      `${label} 超过 ${MAX_NAME_BYTES} 字节上限（实际 ${byteLength} 字节）：${JSON.stringify(rawName)}`,
    );
  }

  const isDirectory = rawName.endsWith('/');
  const body = isDirectory ? rawName.slice(0, -1) : rawName;
  if (body.length === 0) {
    throw zipError('ZIP_PATH_UNSAFE', `${label} 缺少有效文件名：${JSON.stringify(rawName)}`);
  }

  const segments = body.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw zipError('ZIP_PATH_UNSAFE', `${label} 含空路径段：${JSON.stringify(rawName)}`);
    }
    if (segment === '.' || segment === '..') {
      throw zipError('ZIP_PATH_UNSAFE', `${label} 含相对路径段 "${segment}"：${JSON.stringify(rawName)}`);
    }
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (segmentBytes > MAX_SEGMENT_BYTES) {
      throw zipError(
        'ZIP_PATH_UNSAFE',
        `${label} 路径段 "${segment}" 超过 ${MAX_SEGMENT_BYTES} 字节上限（实际 ${segmentBytes} 字节）`,
      );
    }
  }

  return { name: rawName, segments, isDirectory, byteLength };
}

/** 唯一种类键：目录条目去掉结尾 "/"，用于检测 "a" 与 "a/" 这类重复/冲突。 */
function entryKey(info) {
  return info.segments.join('/');
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * 从 FileHandle 精确读取 length 字节（read 可能短读）。
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} position
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readExactAt(fh, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    // eslint-disable-next-line no-await-in-loop
    const { bytesRead } = await fh.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) {
      throw zipError('ZIP_BAD_FORMAT', `ZIP 文件意外截断（期望读取 ${length} 字节，实际 ${read} 字节）`);
    }
    read += bytesRead;
  }
  return buffer;
}

/**
 * 判断路径是否存在（含符号链接本身）。
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * 校验额外字段（extra field）中不含 ZIP64（header id 0x0001）。
 * 其它未知 extra 字段按规范跳过。
 * @param {Buffer} extra
 * @param {string} label
 */
function assertNoZip64Extra(extra, label) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (offset + 4 + size > extra.length) {
      throw zipError('ZIP_BAD_FORMAT', `${label} 的 extra field 长度越界`);
    }
    if (headerId === 0x0001) {
      throw zipError('ZIP_UNSUPPORTED', `${label} 含 ZIP64 extra field（不支持 ZIP64）`);
    }
    offset += 4 + size;
  }
  if (offset !== extra.length) {
    throw zipError('ZIP_BAD_FORMAT', `${label} 的 extra field 尾部不完整`);
  }
}

/**
 * 把 Date 转成 ZIP 的 DOS 时间/日期（按 UTC，无本地时区依赖）。
 * DOS 时间基准为 1980-01-01，年份限制 1980..2107。
 * @param {Date|undefined} value
 * @returns {{ dosTime: number, dosDate: number }}
 */
function toDosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  let year = date.getUTCFullYear();
  if (year < 1980) year = 1980;
  if (year > 2107) year = 2107;
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2); // DOS 秒精度 2 秒
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * 解析方法：默认 deflate；目录条目强制 store。
 * @param {unknown} compress
 * @param {number} index
 * @returns {0|8}
 */
function resolveMethod(compress, index) {
  if (compress === undefined || compress === null) return 8;
  if (compress === 'deflate') return 8;
  if (compress === 'store') return 0;
  throw zipError(
    'ZIP_UNSUPPORTED',
    `entries[${index}].compress 不支持：${JSON.stringify(compress)}（仅支持 "deflate" / "store"）`,
  );
}

/**
 * 归一化写端 source。目录条目允许缺省。
 * @param {unknown} source
 * @param {number} index
 * @param {boolean} allowMissing
 * @returns {{ type: 'file', path: string } | { type: 'buffer', data: Buffer } | null}
 */
function normalizeSource(source, index, allowMissing) {
  if (source === undefined || source === null) {
    if (allowMissing) return null;
    throw zipError('ZIP_INVALID_ARGUMENT', `entries[${index}] 缺少 source`);
  }
  if (typeof source !== 'object') {
    throw zipError('ZIP_INVALID_ARGUMENT', `entries[${index}].source 必须是对象`);
  }
  if (source.type === 'file') {
    if (typeof source.path !== 'string' || source.path.trim() === '') {
      throw zipError('ZIP_INVALID_ARGUMENT', `entries[${index}].source.path 必须是非空字符串`);
    }
    return { type: 'file', path: source.path };
  }
  if (source.type === 'buffer') {
    return { type: 'buffer', data: toBuffer(source.data, index) };
  }
  throw zipError(
    'ZIP_UNSUPPORTED',
    `entries[${index}].source.type 不支持：${JSON.stringify(source.type)}（仅支持 "file" / "buffer"）`,
  );
}

/**
 * 把 Buffer/Uint8Array/ArrayBuffer 统一成 Buffer（尽量零拷贝）。
 * @param {unknown} data
 * @param {number} index
 * @returns {Buffer}
 */
function toBuffer(data, index) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  throw zipError('ZIP_INVALID_ARGUMENT', `entries[${index}].source.data 必须是 Buffer/Uint8Array`);
}

// ---------------------------------------------------------------------------
// 流式工具
// ---------------------------------------------------------------------------

/**
 * 用 stream.pipeline 串起若干流，返回最后一个流供 async iteration 消费。
 * pipeline 负责错误传播与销毁；回调里记录的错误作为兜底（迭代器通常已抛出）。
 * @param {Array<import('node:stream').Stream>} streams
 * @param {(err: Error) => void} onError
 * @returns {import('node:stream').Stream}
 */
function startPipeline(streams, onError) {
  const last = streams[streams.length - 1];
  pipeline(...streams, (err) => {
    if (err) onError(err);
  });
  return last;
}

/**
 * 统一流式解压错误：ZIP 自身抛出的错误原样返回；zlib 解码错误等包装成
 * ZIP_BAD_FORMAT（保留 cause），确保宿主总能按 code 映射中文提示。
 * @param {unknown} err
 * @param {string} name
 * @returns {Error}
 */
function wrapStreamError(err, name) {
  if (err && err.zipError) return err;
  const message = err && err.message ? err.message : String(err);
  return zipError('ZIP_BAD_FORMAT', `条目 ${name} 解压失败：${message}`, err);
}

/**
 * 把 Buffer 切成小块的同步迭代器（交给 Readable.from 流式读取）。
 * @param {Buffer} buffer
 * @returns {Generator<Buffer, void, unknown>}
 */
function* bufferChunks(buffer) {
  for (let offset = 0; offset < buffer.length; offset += IO_CHUNK_SIZE) {
    yield buffer.subarray(offset, Math.min(offset + IO_CHUNK_SIZE, buffer.length));
  }
}

/**
 * 写端 sink：顺序写入 FileHandle，边写边算整包 SHA-256，并守住归档大小上限。
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {import('node:crypto').Hash} hash
 */
function createHashingSink(fh, hash) {
  let position = 0;
  return {
    get position() {
      return position;
    },
    /**
     * @param {Buffer} chunk
     * @returns {Promise<void>}
     */
    async write(chunk) {
      if (!chunk || chunk.length === 0) return;
      if (position + chunk.length > MAX_ARCHIVE_BYTES) {
        throw zipError(
          'ZIP_LIMIT',
          `归档大小超过 ${MAX_ARCHIVE_BYTES} 字节上限（不支持 ZIP64）：${position + chunk.length}`,
        );
      }
      let written = 0;
      while (written < chunk.length) {
        // eslint-disable-next-line no-await-in-loop
        const { bytesWritten } = await fh.write(chunk, written, chunk.length - written);
        if (!bytesWritten) {
          throw zipError('ZIP_IO', '写入 ZIP 临时文件返回 0 字节');
        }
        written += bytesWritten;
      }
      hash.update(chunk);
      position += chunk.length;
    },
  };
}

/**
 * 解压端 sink：顺序写入 FileHandle，只记位置。
 * @param {import('node:fs/promises').FileHandle} fh
 */
function createPlainSink(fh) {
  let position = 0;
  return {
    get position() {
      return position;
    },
    /**
     * @param {Buffer} chunk
     * @returns {Promise<void>}
     */
    async write(chunk) {
      if (!chunk || chunk.length === 0) return;
      let written = 0;
      while (written < chunk.length) {
        // eslint-disable-next-line no-await-in-loop
        const { bytesWritten } = await fh.write(chunk, written, chunk.length - written);
        if (!bytesWritten) {
          throw zipError('ZIP_IO', '写入解压临时文件返回 0 字节');
        }
        written += bytesWritten;
      }
      position += chunk.length;
    },
  };
}

/**
 * 写 entry 数据：source → CRC 计算 → (deflateRaw) → sink。
 * CRC 与大小统计在压缩之前完成，保证写进中央目录的是原始数据 CRC。
 *
 * @param {ReturnType<typeof createHashingSink>} sink
 * @param {import('node:stream').Readable} sourceStream
 * @param {0|8} method
 * @param {{ totalBytes: number }} totals
 * @returns {Promise<{ crc32: number, uncompressedSize: number, compressedSize: number }>}
 */
async function writeEntryData(sink, sourceStream, method, totals) {
  const state = { crc: 0xffffffff, rawSize: 0 };
  const crcTransform = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (chunk.length > 0) {
          state.rawSize += chunk.length;
          if (state.rawSize > ZIP_LIMIT.maxSingleEntryBytes) {
            throw zipError(
              'ZIP_LIMIT',
              `单条目解压大小超过 ${ZIP_LIMIT.maxSingleEntryBytes} 字节上限（不支持 ZIP64）`,
            );
          }
          totals.totalBytes += chunk.length;
          if (totals.totalBytes > ZIP_LIMIT.maxTotalBytes) {
            throw zipError(
              'ZIP_LIMIT',
              `解压总大小超过 ${ZIP_LIMIT.maxTotalBytes} 字节上限（不支持 ZIP64）`,
            );
          }
          state.crc = crc32Update(state.crc, chunk);
        }
        callback(null, chunk);
      } catch (err) {
        callback(err);
      }
    },
  });

  // 顺序必须保持：source → CRC/原始大小统计 → deflate → sink。
  // 若把 deflate 放在 crcTransform 之前，CRC 与 uncompressedSize 统计的会是压缩后数据，
  // 与 ZIP 中央目录/data descriptor 的语义相反（外部真实 node 测试曾复现 13/18 失败）。
  const streams = [sourceStream, crcTransform];
  if (method === 8) {
    streams.push(createDeflateRaw({ level: 6 }));
  }

  const dataStart = sink.position;
  let pipelineError = null;
  const last = startPipeline(streams, (err) => {
    pipelineError = err;
  });
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of last) {
    // eslint-disable-next-line no-await-in-loop
    await sink.write(chunk);
  }
  if (pipelineError) throw pipelineError;

  return {
    crc32: (state.crc ^ 0xffffffff) >>> 0,
    uncompressedSize: state.rawSize,
    compressedSize: sink.position - dataStart,
  };
}

// ---------------------------------------------------------------------------
// ZIP 头构造
// ---------------------------------------------------------------------------

/**
 * 构造 30 字节 local file header（data descriptor 模式：crc/大小写 0）。
 */
function buildLocalHeader({ flags, method, dosTime, dosDate, nameLength }) {
  const buffer = Buffer.alloc(30);
  buffer.writeUInt32LE(SIG_LOCAL, 0);
  buffer.writeUInt16LE(20, 4); // version needed to extract：2.0
  buffer.writeUInt16LE(flags, 6);
  buffer.writeUInt16LE(method, 8);
  buffer.writeUInt16LE(dosTime, 10);
  buffer.writeUInt16LE(dosDate, 12);
  buffer.writeUInt32LE(0, 14); // crc32：data descriptor 中给出
  buffer.writeUInt32LE(0, 18); // compressed size：data descriptor 中给出
  buffer.writeUInt32LE(0, 22); // uncompressed size：data descriptor 中给出
  buffer.writeUInt16LE(nameLength, 26);
  buffer.writeUInt16LE(0, 28); // extra length
  return buffer;
}

/**
 * 构造 46 字节 central directory file header。
 */
function buildCentralHeader({
  flags,
  method,
  dosTime,
  dosDate,
  crc32Value,
  compressedSize,
  uncompressedSize,
  nameLength,
  externalAttrs,
  localOffset,
}) {
  const buffer = Buffer.alloc(46);
  buffer.writeUInt32LE(SIG_CENTRAL, 0);
  buffer.writeUInt16LE(0x0314, 4); // version made by：Unix(3) / 2.0
  buffer.writeUInt16LE(20, 6); // version needed
  buffer.writeUInt16LE(flags, 8);
  buffer.writeUInt16LE(method, 10);
  buffer.writeUInt16LE(dosTime, 12);
  buffer.writeUInt16LE(dosDate, 14);
  buffer.writeUInt32LE(crc32Value >>> 0, 16);
  buffer.writeUInt32LE(compressedSize >>> 0, 20);
  buffer.writeUInt32LE(uncompressedSize >>> 0, 24);
  buffer.writeUInt16LE(nameLength, 28);
  buffer.writeUInt16LE(0, 30); // extra length
  buffer.writeUInt16LE(0, 32); // comment length
  buffer.writeUInt16LE(0, 34); // disk number start
  buffer.writeUInt16LE(0, 36); // internal attributes
  buffer.writeUInt32LE(externalAttrs >>> 0, 38);
  buffer.writeUInt32LE(localOffset >>> 0, 42);
  return buffer;
}

/**
 * 构造 16 字节 data descriptor（带签名 0x08074b50）。
 */
function buildDataDescriptor({ crc32Value, compressedSize, uncompressedSize }) {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0);
  buffer.writeUInt32LE(crc32Value >>> 0, 4);
  buffer.writeUInt32LE(compressedSize >>> 0, 8);
  buffer.writeUInt32LE(uncompressedSize >>> 0, 12);
  return buffer;
}

/**
 * Unix 权限 + DOS 属性 → ZIP external attributes。
 * 高 16 位是 Unix mode（含文件类型），低 8 位是 DOS 属性。
 */
function makeExternalAttrs(isDirectory, mode) {
  const safeMode = (mode & 0o777) || (isDirectory ? 0o755 : 0o644);
  if (isDirectory) {
    return (((0o40000 | safeMode) << 16) | 0x10) >>> 0;
  }
  return ((0o100000 | safeMode) << 16) >>> 0;
}

// ---------------------------------------------------------------------------
// writeZip：流式写 ZIP
// ---------------------------------------------------------------------------

/**
 * 流式写 ZIP 文件。
 *
 * @param {string} filePath 目标 zip 路径（父目录不存在会自动创建）。
 * @param {Array<{
 *   name: string,
 *   source?: { type: 'file', path: string } | { type: 'buffer', data: Buffer },
 *   compress?: 'deflate' | 'store',
 *   mtime?: Date
 * }>} entries 条目列表；目录条目用 "/" 结尾且 source 可省略。
 * @returns {Promise<{ size: number, sha256: string, entries: number }>}
 *   返回最终 zip 的字节数与整体 SHA-256（小写十六进制）。
 */
export async function writeZip(filePath, entries) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw zipError('ZIP_INVALID_ARGUMENT', 'filePath 必须是非空字符串');
  }
  if (!Array.isArray(entries)) {
    throw zipError('ZIP_INVALID_ARGUMENT', 'entries 必须是数组');
  }
  if (entries.length > ZIP_LIMIT.maxEntries) {
    throw zipError(
      'ZIP_LIMIT',
      `条目数 ${entries.length} 超过上限 ${ZIP_LIMIT.maxEntries}（不支持 ZIP64）`,
    );
  }

  const targetPath = resolve(filePath);

  // ---- 1. 预校验全部条目：名字、来源、压缩方式、大小上限 ----------------
  const defs = [];
  let declaredTotal = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object') {
      throw zipError('ZIP_INVALID_ARGUMENT', `entries[${index}] 必须是对象`);
    }
    const info = validateEntryName(entry.name, `entries[${index}].name`);
    const source = normalizeSource(entry.source, index, info.isDirectory);
    let isDirectory = info.isDirectory;
    let method = 0;
    let size = 0;
    let mode = 0o755;
    let mtime =
      entry.mtime instanceof Date && !Number.isNaN(entry.mtime.getTime()) ? entry.mtime : new Date();
    let streamingSource = null; // { type: 'file', path } | { type: 'buffer', data }

    if (info.isDirectory) {
      // 目录条目：只允许 file 源指向真实目录（用于继承 mtime/mode），buffer 源拒绝。
      if (source) {
        if (source.type === 'buffer') {
          throw zipError('ZIP_UNSUPPORTED', `entries[${index}] 是目录条目，不能使用 buffer 源`);
        }
        let st;
        try {
          st = await lstat(source.path);
        } catch (err) {
          throw zipError(
            'ZIP_INVALID_ARGUMENT',
            `entries[${index}] 的目录源不可访问：${source.path}`,
            err,
          );
        }
        if (!st.isDirectory()) {
          throw zipError(
            'ZIP_UNSUPPORTED',
            `entries[${index}] 名字以 "/" 结尾但源不是目录：${source.path}`,
          );
        }
        mode = st.mode & 0o777;
        if (!(entry.mtime instanceof Date)) mtime = st.mtime;
      }
    } else {
      // 文件条目：必须有 source。
      if (source.type === 'file') {
        let st;
        try {
          st = await lstat(source.path);
        } catch (err) {
          throw zipError(
            'ZIP_INVALID_ARGUMENT',
            `entries[${index}] 的源文件不可访问：${source.path}`,
            err,
          );
        }
        if (st.isSymbolicLink()) {
          throw zipError('ZIP_UNSUPPORTED', `entries[${index}] 不支持符号链接源：${source.path}`);
        }
        if (st.isDirectory()) {
          // 容错：名字没带 "/" 但源是目录 → 按目录条目写入，自动补 "/"。
          info.name = `${info.name}/`;
          isDirectory = true;
          method = 0;
          mode = st.mode & 0o777;
          if (!(entry.mtime instanceof Date)) mtime = st.mtime;
        } else if (st.isFile()) {
          size = st.size;
          mode = st.mode & 0o777;
          method = resolveMethod(entry.compress, index);
          streamingSource = { type: 'file', path: resolve(source.path) };
          if (!(entry.mtime instanceof Date)) mtime = st.mtime;
        } else {
          throw zipError(
            'ZIP_UNSUPPORTED',
            `entries[${index}] 源既不是普通文件也不是目录：${source.path}`,
          );
        }
      } else {
        size = source.data.length;
        method = resolveMethod(entry.compress, index);
        streamingSource = { type: 'buffer', data: source.data };
        mode = 0o644;
      }
    }

    if (size > ZIP_LIMIT.maxSingleEntryBytes) {
      throw zipError(
        'ZIP_LIMIT',
        `entries[${index}] 大小 ${size} 超过单条目上限 ${ZIP_LIMIT.maxSingleEntryBytes}（不支持 ZIP64）`,
      );
    }
    declaredTotal += size;
    if (declaredTotal > ZIP_LIMIT.maxTotalBytes) {
      throw zipError(
        'ZIP_LIMIT',
        `总大小 ${declaredTotal} 超过上限 ${ZIP_LIMIT.maxTotalBytes}（不支持 ZIP64）`,
      );
    }

    defs.push({
      name: info.name,
      segments: info.segments,
      key: entryKey(info),
      isDirectory,
      method,
      size,
      mtime,
      mode,
      source: streamingSource,
    });
  }

  // ---- 2. 重复名 / 文件-目录路径冲突检查 -------------------------------
  const seenKeys = new Set();
  for (const def of defs) {
    if (seenKeys.has(def.key)) {
      throw zipError('ZIP_DUPLICATE', `重复条目名：${def.name}`);
    }
    seenKeys.add(def.key);
  }
  const fileKeys = new Set();
  for (const def of defs) {
    if (!def.isDirectory) fileKeys.add(def.key);
  }
  for (const def of defs) {
    for (let i = 1; i < def.segments.length; i += 1) {
      const prefix = def.segments.slice(0, i).join('/');
      if (fileKeys.has(prefix)) {
        throw zipError('ZIP_PATH_UNSAFE', `条目路径冲突：${prefix} 已是文件条目，不能作为目录`);
      }
    }
  }

  // ---- 3. 目标文件必须不存在（不覆盖已有备份） ------------------------
  if (await pathExists(targetPath)) {
    throw zipError('ZIP_TARGET_EXISTS', `目标文件已存在，拒绝覆盖：${targetPath}`);
  }
  const targetDir = dirname(targetPath);
  await mkdir(targetDir, { recursive: true });

  const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;
  let handle = null;
  let committed = false;

  try {
    // 'wx'：临时文件必须由本次创建，避免并发写互相踩。
    handle = await open(tmpPath, 'wx', 0o600);
    const hash = createHash('sha256');
    const sink = createHashingSink(handle, hash);
    const totals = { totalBytes: 0 };
    const centralBuffers = [];
    const flags = UTF8_FLAG | DATA_DESCRIPTOR_FLAG;

    // ---- 4. 逐条目写 local header → 数据 → data descriptor -----------
    for (const def of defs) {
      const nameBytes = Buffer.from(def.name, 'utf8');
      if (nameBytes.length > MAX_NAME_BYTES) {
        throw zipError('ZIP_PATH_UNSAFE', `条目名超过 ${MAX_NAME_BYTES} 字节上限：${def.name}`);
      }
      const { dosTime, dosDate } = toDosDateTime(def.mtime);
      const localOffset = sink.position; // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      await sink.write(
        buildLocalHeader({
          flags,
          method: def.method,
          dosTime,
          dosDate,
          nameLength: nameBytes.length,
        }),
      );
      // eslint-disable-next-line no-await-in-loop
      await sink.write(nameBytes);

      let crc32Value = 0;
      let uncompressedSize = 0;
      let compressedSize = 0;

      if (!def.isDirectory) {
        const sourceStream =
          def.source.type === 'buffer'
            ? Readable.from(bufferChunks(def.source.data), { objectMode: false })
            : createReadStream(def.source.path, { highWaterMark: IO_CHUNK_SIZE });
        // eslint-disable-next-line no-await-in-loop
        const written = await writeEntryData(sink, sourceStream, def.method, totals);
        crc32Value = written.crc32;
        uncompressedSize = written.uncompressedSize;
        compressedSize = written.compressedSize;
      }

      // eslint-disable-next-line no-await-in-loop
      await sink.write(buildDataDescriptor({ crc32Value, compressedSize, uncompressedSize }));

      centralBuffers.push(
        buildCentralHeader({
          flags,
          method: def.method,
          dosTime,
          dosDate,
          crc32Value,
          compressedSize,
          uncompressedSize,
          nameLength: nameBytes.length,
          externalAttrs: makeExternalAttrs(def.isDirectory, def.mode),
          localOffset,
        }),
        nameBytes,
      );
    }

    // ---- 5. 中央目录 + EOCD -----------------------------------------
    const centralOffset = sink.position;
    let centralSize = 0;
    for (const buffer of centralBuffers) {
      // eslint-disable-next-line no-await-in-loop
      await sink.write(buffer);
      centralSize += buffer.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4); // 当前磁盘号
    eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
    eocd.writeUInt16LE(defs.length, 8); // 本磁盘条目数
    eocd.writeUInt16LE(defs.length, 10); // 总条目数
    eocd.writeUInt32LE(centralSize >>> 0, 12);
    eocd.writeUInt32LE(centralOffset >>> 0, 16);
    eocd.writeUInt16LE(0, 20); // 注释长度
    // eslint-disable-next-line no-await-in-loop
    await sink.write(eocd);

    const size = sink.position;
    const sha256 = hash.digest('hex');

    // ---- 6. fsync + rename 原子提交 ---------------------------------
    await handle.sync();
    await handle.close();
    handle = null;

    // 极小概率的并发竞态：提交前再确认目标不存在，避免 rename 覆盖。
    if (await pathExists(targetPath)) {
      throw zipError('ZIP_TARGET_EXISTS', `目标文件已存在，拒绝覆盖：${targetPath}`);
    }
    await rename(tmpPath, targetPath);
    committed = true;

    return { size, sha256, entries: defs.length };
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* 忽略关闭失败 */
      }
      handle = null;
    }
    if (!committed) {
      try {
        await unlink(tmpPath);
      } catch {
        /* 临时文件可能已不存在 */
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 读端：EOCD / 中央目录解析
// ---------------------------------------------------------------------------

/**
 * 从文件尾部回扫 EOCD（最多 22+65535 字节）。
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} fileSize
 * @returns {Promise<{ totalEntries: number, centralSize: number, centralOffset: number }>}
 */
async function locateEocd(fh, fileSize) {
  if (fileSize < 22) {
    throw zipError('ZIP_BAD_FORMAT', '文件小于 22 字节，不可能是合法 ZIP');
  }
  const scanLength = Math.min(fileSize, MAX_EOCD_SEARCH);
  const scanStart = fileSize - scanLength;
  const tail = await readExactAt(fh, scanStart, scanLength);

  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    // EOCD 之后不允许有未计入注释长度的字节（严格校验，避免误命中注释里的假签名）。
    if (i + 22 + commentLength !== tail.length) continue;

    const diskNumber = tail.readUInt16LE(i + 4);
    const centralDiskNumber = tail.readUInt16LE(i + 6);
    const entriesOnDisk = tail.readUInt16LE(i + 8);
    const totalEntries = tail.readUInt16LE(i + 10);
    const centralSize = tail.readUInt32LE(i + 12);
    const centralOffset = tail.readUInt32LE(i + 16);

    if (
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw zipError('ZIP_UNSUPPORTED', '检测到 ZIP64 标记，不支持 ZIP64');
    }
    if (diskNumber !== 0 || centralDiskNumber !== 0 || entriesOnDisk !== totalEntries) {
      throw zipError('ZIP_UNSUPPORTED', '不支持分卷（multi-disk）ZIP');
    }
    if (totalEntries > ZIP_LIMIT.maxEntries) {
      throw zipError(
        'ZIP_LIMIT',
        `条目数 ${totalEntries} 超过上限 ${ZIP_LIMIT.maxEntries}（不支持 ZIP64）`,
      );
    }
    if (centralSize > MAX_CENTRAL_DIR_BYTES) {
      throw zipError(
        'ZIP_LIMIT',
        `中央目录大小 ${centralSize} 超过上限 ${MAX_CENTRAL_DIR_BYTES} 字节`,
      );
    }
    const eocdOffset = scanStart + i;
    if (centralOffset + centralSize > eocdOffset) {
      throw zipError('ZIP_BAD_FORMAT', '中央目录范围越过 EOCD');
    }
    return { totalEntries, centralSize, centralOffset };
  }

  throw zipError('ZIP_BAD_FORMAT', '未找到 EOCD（文件可能不是 ZIP 或被截断）');
}

/**
 * 解析中央目录。
 * 除结构解析外还完成：路径安全校验、重复名/路径冲突、method/flags/ZIP64 拒绝。
 *
 * @param {Buffer} centralBuffer
 * @param {number} totalEntries
 * @returns {Array<object>} entries
 */
function parseCentralDirectory(centralBuffer, totalEntries) {
  /** @type {Array<object>} */
  const entries = [];
  const seenKeys = new Set();
  let position = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (position + 46 > centralBuffer.length) {
      throw zipError('ZIP_BAD_FORMAT', `中央目录第 ${index} 条记录被截断`);
    }
    if (centralBuffer.readUInt32LE(position) !== SIG_CENTRAL) {
      throw zipError('ZIP_BAD_FORMAT', `中央目录第 ${index} 条记录签名错误`);
    }

    const flags = centralBuffer.readUInt16LE(position + 8);
    const method = centralBuffer.readUInt16LE(position + 10);
    const dosTime = centralBuffer.readUInt16LE(position + 12);
    const dosDate = centralBuffer.readUInt16LE(position + 14);
    const crc32Value = centralBuffer.readUInt32LE(position + 16) >>> 0;
    const compressedSize = centralBuffer.readUInt32LE(position + 20);
    const size = centralBuffer.readUInt32LE(position + 24);
    const nameLength = centralBuffer.readUInt16LE(position + 28);
    const extraLength = centralBuffer.readUInt16LE(position + 30);
    const commentLength = centralBuffer.readUInt16LE(position + 32);
    const diskStart = centralBuffer.readUInt16LE(position + 34);
    const externalAttrs = centralBuffer.readUInt32LE(position + 38) >>> 0;
    const localOffset = centralBuffer.readUInt32LE(position + 42);

    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > centralBuffer.length) {
      throw zipError('ZIP_BAD_FORMAT', `中央目录第 ${index} 条记录长度越界`);
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw zipError('ZIP_UNSUPPORTED', `条目 #${index} 使用 ZIP64 尺寸/偏移，不支持 ZIP64`);
    }
    if ((flags & UNSUPPORTED_FLAGS) !== 0) {
      throw zipError(
        'ZIP_UNSUPPORTED',
        `条目 #${index} 使用不支持的通用标志位 0x${flags.toString(16)}（加密/增强压缩等）`,
      );
    }
    if (diskStart !== 0) {
      throw zipError('ZIP_UNSUPPORTED', `条目 #${index} diskStart=${diskStart}，不支持分卷 ZIP`);
    }
    if (method !== 0 && method !== 8) {
      throw zipError(
        'ZIP_UNSUPPORTED',
        `条目 #${index} 使用不支持的压缩方法 ${method}（仅支持 0/store、8/deflate）`,
      );
    }
    if (nameLength === 0) {
      throw zipError('ZIP_PATH_UNSAFE', `条目 #${index} 文件名为空`);
    }

    const nameStart = position + 46;
    const nameBytes = centralBuffer.subarray(nameStart, nameStart + nameLength);
    const extra = centralBuffer.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    assertNoZip64Extra(extra, `条目 #${index}`);

    const name = nameBytes.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) {
      throw zipError('ZIP_UNSUPPORTED', `条目 #${index} 文件名不是合法 UTF-8`);
    }
    const info = validateEntryName(name, `中央目录条目 #${index}`);

    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0xf000) === 0xa000;
    const isDirectory = info.isDirectory || (externalAttrs & 0x10) !== 0;

    // 目录条目按去掉结尾 "/" 的键去重，能识别 "a" 与 "a/" 的冲突。
    const key = isDirectory ? info.segments.join('/') : info.name;
    if (seenKeys.has(key)) {
      throw zipError('ZIP_DUPLICATE', `重复条目名：${name}`);
    }
    seenKeys.add(key);

    entries.push({
      name: info.name,
      segments: info.segments,
      key,
      isDirectory,
      isSymlink,
      method,
      flags,
      crc32: crc32Value,
      size,
      compressedSize,
      externalAttrs,
      localOffset,
      dosTime,
      dosDate,
    });

    position = next;
  }

  if (position !== centralBuffer.length) {
    throw zipError('ZIP_BAD_FORMAT', '中央目录存在未解析的尾部数据');
  }

  // 文件条目不能同时作为其它条目的父目录（例如 "a" 与 "a/b"）。
  const fileKeys = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory) fileKeys.add(entry.key);
  }
  for (const entry of entries) {
    for (let i = 1; i < entry.segments.length; i += 1) {
      const prefix = entry.segments.slice(0, i).join('/');
      if (fileKeys.has(prefix)) {
        throw zipError('ZIP_PATH_UNSAFE', `条目路径冲突：${prefix} 是文件条目，不能作为目录`);
      }
    }
  }

  return entries;
}

/**
 * 打开并解析 ZIP 的中央目录（EOCD + central directory）。
 * @param {string} filePath
 * @returns {Promise<{ fileSize: number, entries: Array<object> }>}
 */
async function parseZip(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw zipError('ZIP_INVALID_ARGUMENT', 'filePath 必须是非空字符串');
  }
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw zipError('ZIP_INVALID_ARGUMENT', `不是普通文件：${filePath}`);
    }
    const fileSize = fileStat.size;
    const eocd = await locateEocd(handle, fileSize);
    const centralBuffer =
      eocd.centralSize > 0
        ? await readExactAt(handle, eocd.centralOffset, eocd.centralSize)
        : Buffer.alloc(0);
    const entries = parseCentralDirectory(centralBuffer, eocd.totalEntries);
    return { fileSize, entries };
  } finally {
    try {
      await handle.close();
    } catch {
      /* 忽略关闭失败 */
    }
  }
}

/**
 * 读取并校验一个条目对应的 local file header，返回数据区偏移。
 * 防御：local header 名字/方法与中央目录不一致、local 头加密、ZIP64 extra、
 * 数据区越界。
 *
 * @param {string} filePath
 * @param {object} entry
 * @param {number} fileSize
 * @returns {Promise<{ dataOffset: number }>}
 */
async function readEntryDataRange(filePath, entry, fileSize) {
  const handle = await open(filePath, 'r');
  try {
    if (entry.localOffset + 30 > fileSize) {
      throw zipError('ZIP_BAD_FORMAT', `条目 ${entry.name} 的 local header 越界`);
    }
    const header = await readExactAt(handle, entry.localOffset, 30);
    if (header.readUInt32LE(0) !== SIG_LOCAL) {
      throw zipError('ZIP_BAD_FORMAT', `条目 ${entry.name} 的 local header 签名错误`);
    }
    const localFlags = header.readUInt16LE(6);
    const localMethod = header.readUInt16LE(8);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);

    if ((localFlags & 0x0001) !== 0) {
      throw zipError('ZIP_UNSUPPORTED', `条目 ${entry.name} 的 local header 标记了加密`);
    }
    if (localMethod !== entry.method) {
      throw zipError(
        'ZIP_BAD_FORMAT',
        `条目 ${entry.name} 的 local header 压缩方法与中央目录不一致`,
      );
    }

    const nameStart = entry.localOffset + 30;
    const extraStart = nameStart + nameLength;
    const dataOffset = extraStart + extraLength;
    if (dataOffset > fileSize || dataOffset + entry.compressedSize > fileSize) {
      throw zipError('ZIP_BAD_FORMAT', `条目 ${entry.name} 的数据范围超出文件大小`);
    }
    if (nameLength > MAX_NAME_BYTES * 2) {
      throw zipError('ZIP_PATH_UNSAFE', `条目 ${entry.name} 的 local header 文件名过长`);
    }
    const localNameBytes = await readExactAt(handle, nameStart, nameLength);
    if (localNameBytes.toString('utf8') !== entry.name) {
      throw zipError(
        'ZIP_BAD_FORMAT',
        `条目 ${entry.name} 的 local header 文件名与中央目录不一致`,
      );
    }
    if (extraLength > 0) {
      const extra = await readExactAt(handle, extraStart, extraLength);
      assertNoZip64Extra(extra, `条目 ${entry.name} 的 local header`);
    }
    return { dataOffset };
  } finally {
    try {
      await handle.close();
    } catch {
      /* 忽略关闭失败 */
    }
  }
}

/**
 * 流式计算单个条目明文的 SHA-256（不落盘、不在内存里聚合内容），
 * 同时校验声明大小与 CRC32。数据损坏/不支持时抛错。
 *
 * @param {string} filePath
 * @param {number} fileSize
 * @param {object} entry
 * @returns {Promise<string>} 小写十六进制 SHA-256
 */
async function computeEntrySha256(filePath, fileSize, entry) {
  const { name } = entry;
  const { dataOffset } = await readEntryDataRange(filePath, entry, fileSize);

  if (entry.compressedSize === 0) {
    if (entry.size !== 0) {
      throw zipError('ZIP_SIZE_MISMATCH', `条目 ${name} 没有数据但声明大小 ${entry.size}`);
    }
    if (entry.crc32 !== 0) {
      throw zipError('ZIP_CRC_MISMATCH', `空条目 ${name} 的 CRC32 应为 0`);
    }
    return EMPTY_SHA256;
  }

  const state = { crc: 0xffffffff, size: 0, hasher: createHash('sha256') };
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (chunk.length === 0) {
          callback();
          return;
        }
        state.size += chunk.length;
        if (state.size > entry.size) {
          throw zipError(
            'ZIP_SIZE_MISMATCH',
            `条目 ${name} 解压数据超过声明大小 ${entry.size}（疑似 zip bomb）`,
          );
        }
        state.crc = crc32Update(state.crc, chunk);
        state.hasher.update(chunk);
        callback(null, chunk);
      } catch (err) {
        callback(err);
      }
    },
  });

  const source = createReadStream(filePath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
    highWaterMark: IO_CHUNK_SIZE,
  });
  const streams = [source];
  if (entry.method === 8) streams.push(createInflateRaw());
  streams.push(validator);

  let pipelineError = null;
  const last = startPipeline(streams, (err) => {
    pipelineError = err;
  });
  // 消费并丢弃解压后的数据（每块已在 validator 中计入 SHA-256），只驱动流前进。
  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of last) {
      void chunk;
    }
  } catch (err) {
    throw wrapStreamError(err, name);
  }
  if (pipelineError) throw wrapStreamError(pipelineError, name);

  if (state.size !== entry.size) {
    throw zipError(
      'ZIP_SIZE_MISMATCH',
      `条目 ${name} 解压后 ${state.size} 字节，与声明 ${entry.size} 字节不一致`,
    );
  }
  const actualCrc = (state.crc ^ 0xffffffff) >>> 0;
  if (actualCrc !== entry.crc32) {
    throw zipError(
      'ZIP_CRC_MISMATCH',
      `条目 ${name} CRC32 校验失败（预期 ${entry.crc32}，实际 ${actualCrc}）`,
    );
  }
  return state.hasher.digest('hex');
}

/**
 * 不落盘地重新读取 ZIP，逐条目流式计算明文 SHA-256（用于备份写完后校验）。
 * 目录条目会被跳过（其 SHA-256 无意义）；符号链接等不支持的条目直接抛错。
 * 每个条目只流式经过一次，不会整包/整条读入内存。
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   entries: Array<{ name: string, size: number, sha256: string }>,
 *   totalSize: number
 * }>}
 */
export async function hashZipEntries(filePath) {
  const { fileSize, entries } = await parseZip(filePath);
  /** @type {Array<{ name: string, size: number, sha256: string }>} */
  const result = [];
  let totalSize = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue; // 目录条目没有可校验的明文内容
    if (entry.isSymlink) {
      throw zipError('ZIP_UNSUPPORTED', `不支持符号链接条目：${entry.name}`);
    }
    if (entry.method === 0 && entry.compressedSize !== entry.size) {
      throw zipError('ZIP_SIZE_MISMATCH', `store 条目 ${entry.name} 的压缩/解压大小不一致`);
    }
    // eslint-disable-next-line no-await-in-loop
    const sha256 = await computeEntrySha256(filePath, fileSize, entry);
    totalSize += entry.size;
    result.push({ name: entry.name, size: entry.size, sha256 });
  }

  return { entries: result, totalSize };
}

// ---------------------------------------------------------------------------
// listZip
// ---------------------------------------------------------------------------

/**
 * 列出 ZIP 条目（只读 EOCD/中央目录，不解压数据）。
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   entries: Array<{
 *     name: string,
 *     size: number,
 *     compressedSize: number,
 *     crc32: number,
 *     method: number,
 *     isDirectory: boolean,
 *     isSymlink: boolean
 *   }>,
 *   totalSize: number
 * }>}
 */
export async function listZip(filePath) {
  const { entries } = await parseZip(filePath);
  let totalSize = 0;
  const result = entries.map((entry) => {
    totalSize += entry.size;
    return {
      name: entry.name,
      size: entry.size,
      compressedSize: entry.compressedSize,
      crc32: entry.crc32,
      method: entry.method,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
    };
  });
  return { entries: result, totalSize };
}

// ---------------------------------------------------------------------------
// readZipEntry
// ---------------------------------------------------------------------------

/**
 * 读取单个条目的完整内容（用于 manifest.json 预览）。
 * 上限 8 MiB，超限抛 ZIP_LIMIT；CRC/大小校验失败抛对应错误。
 *
 * @param {string} filePath
 * @param {string} name
 * @returns {Promise<Buffer>}
 */
export async function readZipEntry(filePath, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw zipError('ZIP_INVALID_ARGUMENT', 'name 必须是非空字符串');
  }
  const { fileSize, entries } = await parseZip(filePath);

  let entry = entries.find((item) => item.name === name);
  if (!entry) {
    const directoryEntry = entries.find((item) => item.name === `${name}/`);
    if (directoryEntry && directoryEntry.isDirectory) entry = directoryEntry;
  }
  if (!entry) {
    throw zipError('ZIP_NOT_FOUND', `ZIP 中不存在条目：${name}`);
  }
  if (entry.isSymlink) {
    throw zipError('ZIP_UNSUPPORTED', `不支持读取符号链接条目：${name}`);
  }
  if (entry.isDirectory) return Buffer.alloc(0);
  if (entry.size > MAX_READ_ENTRY_BYTES) {
    throw zipError(
      'ZIP_LIMIT',
      `条目 ${name} 解压后 ${entry.size} 字节，超过单条目读取上限 ${MAX_READ_ENTRY_BYTES} 字节`,
    );
  }
  if (entry.method === 0 && entry.compressedSize !== entry.size) {
    throw zipError('ZIP_SIZE_MISMATCH', `store 条目 ${name} 的压缩/解压大小不一致`);
  }

  const { dataOffset } = await readEntryDataRange(filePath, entry, fileSize);

  if (entry.compressedSize === 0) {
    if (entry.size !== 0) {
      throw zipError('ZIP_SIZE_MISMATCH', `条目 ${name} 没有数据但声明大小 ${entry.size}`);
    }
    if (entry.crc32 !== 0) {
      throw zipError('ZIP_CRC_MISMATCH', `空条目 ${name} 的 CRC32 应为 0`);
    }
    return Buffer.alloc(0);
  }

  const state = { crc: 0xffffffff, size: 0 };
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (chunk.length === 0) {
          callback();
          return;
        }
        state.size += chunk.length;
        if (state.size > entry.size) {
          throw zipError('ZIP_SIZE_MISMATCH', `条目 ${name} 解压数据超过声明大小 ${entry.size}`);
        }
        if (state.size > MAX_READ_ENTRY_BYTES) {
          throw zipError('ZIP_LIMIT', `条目 ${name} 解压数据超过读取上限`);
        }
        state.crc = crc32Update(state.crc, chunk);
        callback(null, chunk);
      } catch (err) {
        callback(err);
      }
    },
  });

  const source = createReadStream(filePath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
    highWaterMark: IO_CHUNK_SIZE,
  });
  const streams = [source];
  if (entry.method === 8) streams.push(createInflateRaw());
  streams.push(validator);

  let pipelineError = null;
  const chunks = [];
  const last = startPipeline(streams, (err) => {
    pipelineError = err;
  });
  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of last) {
      chunks.push(chunk);
    }
  } catch (err) {
    throw wrapStreamError(err, name);
  }
  if (pipelineError) throw wrapStreamError(pipelineError, name);

  if (state.size !== entry.size) {
    throw zipError(
      'ZIP_SIZE_MISMATCH',
      `条目 ${name} 解压后 ${state.size} 字节，与声明 ${entry.size} 字节不一致`,
    );
  }
  const actualCrc = (state.crc ^ 0xffffffff) >>> 0;
  if (actualCrc !== entry.crc32) {
    throw zipError(
      'ZIP_CRC_MISMATCH',
      `条目 ${name} CRC32 校验失败（预期 ${entry.crc32}，实际 ${actualCrc}）`,
    );
  }
  return Buffer.concat(chunks, state.size);
}

// ---------------------------------------------------------------------------
// extractZip
// ---------------------------------------------------------------------------

/**
 * 把 decode 后的条目数据流式写入 sink，并校验大小 / CRC / SHA-256。
 *
 * @param {string} filePath
 * @param {number} fileSize
 * @param {object} entry
 * @param {ReturnType<typeof createPlainSink>} sink
 * @param {{ maxTotalBytes: number, maxFileBytes: number }} limits
 * @param {{ done: number }} progressState
 * @param {(done: number, force: boolean) => void} report
 * @returns {Promise<{ size: number, sha256: string }>}
 */
async function extractEntryToSink(filePath, fileSize, entry, sink, limits, progressState, report) {
  const { name } = entry;
  const { dataOffset } = await readEntryDataRange(filePath, entry, fileSize);

  if (entry.compressedSize === 0) {
    if (entry.size !== 0) {
      throw zipError('ZIP_SIZE_MISMATCH', `条目 ${name} 没有数据但声明大小 ${entry.size}`);
    }
    if (entry.crc32 !== 0) {
      throw zipError('ZIP_CRC_MISMATCH', `空条目 ${name} 的 CRC32 应为 0`);
    }
    return { size: 0, sha256: EMPTY_SHA256 };
  }

  const state = { crc: 0xffffffff, size: 0, hasher: createHash('sha256') };
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (chunk.length === 0) {
          callback();
          return;
        }
        state.size += chunk.length;
        if (state.size > entry.size) {
          throw zipError(
            'ZIP_SIZE_MISMATCH',
            `条目 ${name} 解压数据超过声明大小 ${entry.size}（疑似 zip bomb）`,
          );
        }
        if (state.size > limits.maxFileBytes) {
          throw zipError(
            'ZIP_LIMIT',
            `条目 ${name} 大小 ${state.size} 超过本次解压上限 ${limits.maxFileBytes}`,
          );
        }
        progressState.done += chunk.length;
        if (progressState.done > limits.maxTotalBytes) {
          throw zipError(
            'ZIP_LIMIT',
            `解压总量超过本次上限 ${limits.maxTotalBytes}`,
          );
        }
        state.crc = crc32Update(state.crc, chunk);
        state.hasher.update(chunk);
        report(progressState.done, false);
        callback(null, chunk);
      } catch (err) {
        callback(err);
      }
    },
  });

  const source = createReadStream(filePath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
    highWaterMark: IO_CHUNK_SIZE,
  });
  const streams = [source];
  if (entry.method === 8) streams.push(createInflateRaw());
  streams.push(validator);

  let pipelineError = null;
  const last = startPipeline(streams, (err) => {
    pipelineError = err;
  });
  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of last) {
      // eslint-disable-next-line no-await-in-loop
      await sink.write(chunk);
    }
  } catch (err) {
    throw wrapStreamError(err, name);
  }
  if (pipelineError) throw wrapStreamError(pipelineError, name);

  if (state.size !== entry.size) {
    throw zipError(
      'ZIP_SIZE_MISMATCH',
      `条目 ${name} 解压后 ${state.size} 字节，与声明 ${entry.size} 字节不一致`,
    );
  }
  const actualCrc = (state.crc ^ 0xffffffff) >>> 0;
  if (actualCrc !== entry.crc32) {
    throw zipError(
      'ZIP_CRC_MISMATCH',
      `条目 ${name} CRC32 校验失败（预期 ${entry.crc32}，实际 ${actualCrc}）`,
    );
  }
  return { size: state.size, sha256: state.hasher.digest('hex') };
}

/**
 * zip bomb 压缩比检查：解压后 > 64 MiB 且压缩比 > 200:1 拒绝。
 * @param {object} entry
 */
function checkBombRatio(entry) {
  if (entry.isDirectory) return;
  if (entry.size === 0) return;
  if (entry.compressedSize === 0) {
    throw zipError('ZIP_SIZE_MISMATCH', `条目 ${entry.name} 压缩数据为空但声明大小 ${entry.size}`);
  }
  if (entry.size > BOMB_MIN_SIZE && entry.size / entry.compressedSize > BOMB_RATIO) {
    throw zipError(
      'ZIP_LIMIT',
      `条目 ${entry.name} 压缩比异常（${entry.size}/${entry.compressedSize}），疑似 zip bomb`,
    );
  }
}

/**
 * 归一化用户传入的大小上限（只允许收紧硬上限）。
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} label
 * @returns {number}
 */
function normalizeLimit(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw zipError('ZIP_INVALID_ARGUMENT', `${label} 必须是正整数`);
  }
  return Math.min(value, fallback);
}

/**
 * 组装解压进度回调（同步调用，节流 4 MiB；回调抛错不影响解压）。
 * @param {((done: number, total: number) => void) | undefined} onProgress
 * @param {number} total
 * @returns {(done: number, force: boolean) => void}
 */
function createProgressReporter(onProgress, total) {
  let lastReported = 0;
  return function report(done, force) {
    if (typeof onProgress !== 'function') return;
    if (!force && done - lastReported < PROGRESS_STEP_BYTES) return;
    lastReported = done;
    try {
      onProgress(done, total);
    } catch {
      /* 进度回调异常不应破坏解压流程 */
    }
  };
}

/**
 * 在 destReal 内解析条目目标路径，并做包含性检查（防 Zip Slip）。
 * @param {string} destReal
 * @param {string[]} segments
 * @returns {string}
 */
function resolveInside(destReal, segments) {
  const target = join(destReal, ...segments);
  const rel = relative(destReal, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw zipError('ZIP_PATH_UNSAFE', `条目路径逃逸出目标目录：${segments.join('/')}`);
  }
  return target;
}

/**
 * 校验目标父目录的 realpath 仍在 destReal 内（防符号链接逃逸）。
 * @param {string} destReal
 * @param {string} parentDir
 */
async function assertRealParentInside(destReal, parentDir) {
  const parentReal = await realpath(parentDir);
  const rel = relative(destReal, parentReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw zipError('ZIP_PATH_UNSAFE', `解压路径逃逸出目标目录：${parentDir}`);
  }
}

/**
 * 解压 ZIP 到目录。
 *
 * 行为约定：
 *   - destDir 不存在则自动创建；存在则必须是空目录，否则 ZIP_DEST_NOT_EMPTY。
 *   - 先完成全部条目的安全/大小/压缩比预检，再开始落盘。
 *   - 逐条目流式 inflateRaw 到同目录临时文件 → 校验大小/CRC/可选 SHA-256 →
 *     rename 到最终路径；失败时当前临时文件被删除，已成功解出的文件保留
 *     （由调用方决定是否清理 destDir）。
 *   - 不支持符号链接条目（ZIP_UNSUPPORTED），所有路径的 realpath 必须位于
 *     destDir 内。
 *   - onProgress(done, total)：done/total 均为解压后的明文字节数，按 4 MiB 节流；
 *     进度回调抛出的异常会被忽略，不影响解压结果。
 *
 * @param {string} filePath
 * @param {string} destDir
 * @param {{
 *   maxTotalBytes?: number,
 *   maxFileBytes?: number,
 *   onProgress?: (done: number, total: number) => void,
 *   expectedHashes?: Record<string, string>
 * }} [options]
 * @returns {Promise<{
 *   files: Array<{ name: string, size: number, sha256: string, crc32Ok: boolean }>,
 *   totalSize: number
 * }>}
 */
export async function extractZip(filePath, destDir, options = {}) {
  if (typeof destDir !== 'string' || destDir.trim() === '') {
    throw zipError('ZIP_INVALID_ARGUMENT', 'destDir 必须是非空字符串');
  }
  const opts = options || {};
  if (opts.onProgress !== undefined && typeof opts.onProgress !== 'function') {
    throw zipError('ZIP_INVALID_ARGUMENT', 'options.onProgress 必须是函数');
  }
  const maxTotalBytes = normalizeLimit(opts.maxTotalBytes, ZIP_LIMIT.maxTotalBytes, 'options.maxTotalBytes');
  const maxFileBytes = normalizeLimit(
    opts.maxFileBytes,
    ZIP_LIMIT.maxSingleEntryBytes,
    'options.maxFileBytes',
  );
  const limits = { maxTotalBytes, maxFileBytes };

  /** @type {Map<string, string>} */
  const expectedHashes = new Map();
  if (opts.expectedHashes !== undefined && opts.expectedHashes !== null) {
    if (typeof opts.expectedHashes !== 'object' || Array.isArray(opts.expectedHashes)) {
      throw zipError('ZIP_INVALID_ARGUMENT', 'options.expectedHashes 必须是 { [name]: sha256 } 对象');
    }
    for (const [hashName, hashValue] of Object.entries(opts.expectedHashes)) {
      if (typeof hashValue !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hashValue)) {
        throw zipError(
          'ZIP_INVALID_ARGUMENT',
          `options.expectedHashes[${hashName}] 不是合法的 SHA-256 十六进制串`,
        );
      }
      expectedHashes.set(hashName, hashValue.toLowerCase());
    }
  }

  // ---- 1. 解析中央目录（含路径安全 / 重复 / method / ZIP64 校验） ------
  const { fileSize, entries } = await parseZip(filePath);

  // ---- 2. 全量预检：symlink / 目录载荷 / 大小 / 压缩比 / 总量 ----------
  let totalSize = 0;
  for (const entry of entries) {
    if (entry.isSymlink) {
      throw zipError('ZIP_UNSUPPORTED', `不支持符号链接条目：${entry.name}`);
    }
    if (entry.isDirectory) {
      if (entry.size !== 0 || entry.compressedSize !== 0) {
        throw zipError('ZIP_UNSUPPORTED', `目录条目不应携带数据：${entry.name}`);
      }
      continue;
    }
    if (entry.method === 0 && entry.compressedSize !== entry.size) {
      throw zipError('ZIP_SIZE_MISMATCH', `store 条目 ${entry.name} 的压缩/解压大小不一致`);
    }
    if (entry.size > maxFileBytes) {
      throw zipError(
        'ZIP_LIMIT',
        `条目 ${entry.name} 大小 ${entry.size} 超过本次上限 ${maxFileBytes}`,
      );
    }
    checkBombRatio(entry);
    totalSize += entry.size;
    if (totalSize > maxTotalBytes) {
      throw zipError('ZIP_LIMIT', `解压总大小 ${totalSize} 超过本次上限 ${maxTotalBytes}`);
    }
  }

  // ---- 3. 准备 destDir（必须不存在或为空目录） ------------------------
  const destPath = resolve(destDir);
  let destStat = null;
  try {
    destStat = await stat(destPath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (destStat && !destStat.isDirectory()) {
    throw zipError('ZIP_DEST_INVALID', `destDir 不是目录：${destPath}`);
  }
  await mkdir(destPath, { recursive: true });
  const destReal = await realpath(destPath);
  const existing = await readdir(destReal);
  if (existing.length > 0) {
    throw zipError('ZIP_DEST_NOT_EMPTY', `destDir 必须为空目录：${destReal}`);
  }

  const report = createProgressReporter(opts.onProgress, totalSize);
  const progressState = { done: 0 };
  const files = [];

  // ---- 4. 逐条目落盘 -------------------------------------------------
  for (const entry of entries) {
    if (entry.isDirectory) {
      const directoryTarget = resolveInside(destReal, entry.segments);
      // eslint-disable-next-line no-await-in-loop
      await mkdir(directoryTarget, { recursive: true });
      continue;
    }

    const target = resolveInside(destReal, entry.segments);
    const parentDir = dirname(target);
    // eslint-disable-next-line no-await-in-loop
    await mkdir(parentDir, { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await assertRealParentInside(destReal, parentDir);
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(target)) {
      throw zipError('ZIP_DUPLICATE', `解压目标已存在（重复名或大小写冲突）：${entry.name}`);
    }

    const tmpPath = join(parentDir, `.dshm-zip-tmp-${randomBytes(8).toString('hex')}`);
    let handle = null;
    let committed = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      handle = await open(tmpPath, 'wx', 0o600);
      const sink = createPlainSink(handle);
      // eslint-disable-next-line no-await-in-loop
      const result = await extractEntryToSink(
        filePath,
        fileSize,
        entry,
        sink,
        limits,
        progressState,
        report,
      );
      // eslint-disable-next-line no-await-in-loop
      await handle.sync();
      // eslint-disable-next-line no-await-in-loop
      await handle.close();
      handle = null;

      const expected = expectedHashes.get(entry.name);
      if (expected !== undefined && expected !== result.sha256) {
        throw zipError(
          'ZIP_HASH_MISMATCH',
          `条目 ${entry.name} SHA-256 校验失败（预期 ${expected}，实际 ${result.sha256}）`,
        );
      }

      // eslint-disable-next-line no-await-in-loop
      await rename(tmpPath, target);
      committed = true;
      files.push({
        name: entry.name,
        size: result.size,
        sha256: result.sha256,
        crc32Ok: true,
      });
      report(progressState.done, true);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* 忽略关闭失败 */
        }
      }
      if (!committed) {
        try {
          await unlink(tmpPath);
        } catch {
          /* 临时文件可能已不存在 */
        }
      }
    }
  }

  report(progressState.done, true);
  return { files, totalSize };
}
