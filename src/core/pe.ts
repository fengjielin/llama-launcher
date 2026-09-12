/**
 * 极简 PE 导入表读取器（只做一件事：列出某个 DLL/EXE 依赖哪些 DLL）。
 *
 * 为什么需要它：要判断「这份 llama.cpp 构建需要哪个版本的 CUDA 运行时」，
 * 唯一可靠的离线依据就是 `ggml-cuda.dll` 的导入表 —— CUDA 12 构建链的是
 * `cudart64_12.dll` / `cublas64_12.dll`，CUDA 13 构建链的是 `..._13.dll`。
 * 实测（b10488 CUDA 12.4 构建）：
 *   ggml-base.dll, cudart64_12.dll, cublas64_12.dll, nvcuda.dll, KERNEL32.dll, ...
 *
 * 实现约束：
 * - **绝不整读文件**：`ggml-cuda.dll` 有 513 MB，只按偏移读 DOS/PE 头、节表与导入目录
 * - 只解析 PE32 与 PE32+（x86 / x64），不处理 ARM64 之外的冷门格式
 * - **永不抛异常**：任何解析不出来的情况都返回 `{ error }`，因为"读不出来"本身就是要展示给用户的信息
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** 导入表读取结果 */
export interface PeImports {
  /** 依赖的 DLL 名（保持 PE 里的原始大小写），按导入表顺序 */
  imports: string[];
  /** 文件大小（字节） */
  size: number;
  /** 是否 64 位 */
  is64: boolean;
  /** 解析失败的原因；成功时为 `undefined` */
  error?: string;
}

/** 节表里一项的关键字段（RVA → 文件偏移要用它做映射） */
interface Section {
  virtualSize: number;
  virtualAddress: number;
  rawSize: number;
  rawPointer: number;
}

/** DOS 头里 `MZ` 魔数 */
const DOS_MAGIC = 0x5a4d;
/** PE 签名 `PE\0\0` */
const PE_SIGNATURE = 0x00004550;
/** PE32+ 的 optional header 魔数 */
const OPTIONAL_MAGIC_PE32_PLUS = 0x20b;
/** 导入目录在数据目录数组里的下标 */
const IMPORT_DIRECTORY_INDEX = 1;
/** 导入描述符数组的硬上限，防止损坏的文件把我们引到无尽循环里 */
const MAX_IMPORT_DESCRIPTORS = 256;
/** 单个 DLL 名的最大长度（PE 里不会更长） */
const MAX_DLL_NAME = 260;

/**
 * 从文件指定偏移读取若干字节。
 *
 * @param fd 已打开的文件描述符
 * @param offset 起始偏移
 * @param length 期望读取的字节数
 * @returns 实际读到的字节（文件尾部不足时会更短）
 */
function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, offset);
  return buffer.subarray(0, read);
}

/**
 * 把 RVA（相对虚拟地址）换算成文件偏移。
 *
 * 做法是拿节表逐个比对：RVA 落在哪个节的虚拟区间里，就减去该节的基址再加上它在文件中的位置。
 *
 * @param sections 节表
 * @param rva 要换算的 RVA
 * @returns 对应的文件偏移；不属于任何节时返回 `null`
 */
function rvaToOffset(sections: readonly Section[], rva: number): number | null {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.rawPointer + (rva - section.virtualAddress);
    }
  }
  return null;
}

/**
 * 读出一个 PE 文件（DLL 或 EXE）的导入表。
 *
 * @param path PE 文件路径
 * @returns 依赖的 DLL 名与文件基本信息，见 {@link PeImports}；失败时 `error` 有说明
 */
export function readPeImports(path: string): PeImports {
  let size = 0;
  let fd: number | null = null;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");

    const dos = readAt(fd, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== DOS_MAGIC) {
      return { imports: [], size, is64: false, error: "不是有效的 PE 文件（缺少 MZ 头）" };
    }

    const peOffset = dos.readUInt32LE(0x3c);
    const pe = readAt(fd, peOffset, 24);
    if (pe.length < 24 || pe.readUInt32LE(0) !== PE_SIGNATURE) {
      return { imports: [], size, is64: false, error: "不是有效的 PE 文件（缺少 PE 签名）" };
    }

    const numberOfSections = pe.readUInt16LE(6);
    const sizeOfOptional = pe.readUInt16LE(20);
    const optional = readAt(fd, peOffset + 24, sizeOfOptional);
    if (optional.length < 2) {
      return { imports: [], size, is64: false, error: "PE 头不完整" };
    }

    const magic = optional.readUInt16LE(0);
    const is64 = magic === OPTIONAL_MAGIC_PE32_PLUS;
    // PE32 与 PE32+ 的数据目录起始偏移不同，导入目录又是第 1 项（每项 8 字节：RVA + Size）
    const dataDirectoryOffset = is64 ? 112 : 96;
    if (optional.length < dataDirectoryOffset + 16) {
      return { imports: [], size, is64, error: "PE 数据目录不完整" };
    }
    const importRva = optional.readUInt32LE(dataDirectoryOffset + IMPORT_DIRECTORY_INDEX * 8);

    const sectionTableOffset = peOffset + 24 + sizeOfOptional;
    const sections: Section[] = [];
    for (let i = 0; i < numberOfSections; i += 1) {
      const header = readAt(fd, sectionTableOffset + i * 40, 40);
      if (header.length < 40) break;
      sections.push({
        virtualSize: header.readUInt32LE(8),
        virtualAddress: header.readUInt32LE(12),
        rawSize: header.readUInt32LE(16),
        rawPointer: header.readUInt32LE(20),
      });
    }

    if (importRva === 0) {
      return { imports: [], size, is64, error: undefined };
    }
    const importOffset = rvaToOffset(sections, importRva);
    if (importOffset === null) {
      return { imports: [], size, is64, error: "导入表地址映射不到文件偏移" };
    }

    const imports: string[] = [];
    for (let i = 0; i < MAX_IMPORT_DESCRIPTORS; i += 1) {
      const descriptor = readAt(fd, importOffset + i * 20, 20);
      if (descriptor.length < 20) break;
      const nameRva = descriptor.readUInt32LE(12);
      const originalFirstThunk = descriptor.readUInt32LE(0);
      const timestamp = descriptor.readUInt32LE(4);
      // 三个字段全 0 的那个描述符是数组结束标志
      if (nameRva === 0 && originalFirstThunk === 0 && timestamp === 0) break;

      const nameOffset = rvaToOffset(sections, nameRva);
      if (nameOffset === null) continue;
      const raw = readAt(fd, nameOffset, MAX_DLL_NAME);
      const terminator = raw.indexOf(0);
      const name = raw.subarray(0, terminator === -1 ? raw.length : terminator).toString("latin1").trim();
      if (name !== "") imports.push(name);
    }

    return { imports, size, is64 };
  } catch (err) {
    return {
      imports: [],
      size,
      is64: false,
      error: `读取失败：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不影响结果
      }
    }
  }
}
