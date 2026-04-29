import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * Read the first `maxLines` JSON lines from a JSONL file without loading the
 * whole file into memory. Ideal for session-discovery metadata extraction
 * since Codex rollouts can exceed hundreds of MB.
 */
export async function readFirstJsonLines(
  filePath: string,
  maxLines: number,
): Promise<Array<unknown>> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: Array<unknown> = [];
    const cleanup = () => {
      rl.close();
      stream.destroy();
    };
    rl.on("line", (line: string) => {
      if (line.length === 0) return;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // skip invalid lines
      }
      if (lines.length >= maxLines) {
        cleanup();
        resolve(lines);
      }
    });
    rl.on("close", () => resolve(lines));
    rl.on("error", (error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

/**
 * Count the lines in a JSONL file (non-empty lines only).
 * Streaming so large files don't blow memory.
 */
export async function countJsonLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    rl.on("line", (line: string) => {
      if (line.length > 0) count += 1;
    });
    rl.on("close", () => resolve(count));
    rl.on("error", (error: unknown) => reject(error));
  });
}

/**
 * Read up to `maxLines` non-empty JSON lines from the tail of a file by
 * seeking from the end in chunks. Returns lines in document order (oldest
 * first). Useful for extracting late-appearing metadata such as Claude's
 * `custom-title` events without streaming the entire session file.
 */
export async function readLastJsonLines(
  filePath: string,
  maxLines: number,
): Promise<Array<unknown>> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return [];
    const chunkSize = 8192;
    let end = stat.size;
    let buffer = "";
    const collected: Array<string> = [];
    while (end > 0 && collected.length < maxLines) {
      const readSize = Math.min(chunkSize, end);
      const start = end - readSize;
      const slice = Buffer.alloc(readSize);
      await handle.read(slice, 0, readSize, start);
      buffer = slice.toString("utf8") + buffer;
      end = start;
      // Split into lines, keep the unfinished leading partial in buffer for
      // the next iteration (only if we haven't reached BOF yet).
      const lines = buffer.split("\n");
      if (end > 0) {
        buffer = lines.shift() ?? "";
      } else {
        buffer = "";
      }
      for (let i = lines.length - 1; i >= 0 && collected.length < maxLines; i -= 1) {
        const line = lines[i]?.trim();
        if (line && line.length > 0) {
          collected.push(line);
        }
      }
    }
    return collected
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((parsed): parsed is unknown => parsed !== null);
  } finally {
    await handle.close();
  }
}

/**
 * Read the last non-empty line of a file by seeking from the end in chunks.
 * Falls back to returning null if the file is empty.
 */
export async function readLastJsonLine(filePath: string): Promise<unknown | null> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return null;
    const chunkSize = 4096;
    let end = stat.size;
    let buffer = "";
    while (end > 0) {
      const readSize = Math.min(chunkSize, end);
      const start = end - readSize;
      const slice = Buffer.alloc(readSize);
      await handle.read(slice, 0, readSize, start);
      buffer = slice.toString("utf8") + buffer;
      const newlineIndex = buffer.lastIndexOf("\n", buffer.length - 2);
      if (newlineIndex !== -1) {
        const lastLine = buffer.slice(newlineIndex + 1).trim();
        if (lastLine.length > 0) {
          try {
            return JSON.parse(lastLine);
          } catch {
            return null;
          }
        }
        // strip that empty last line, continue reading backwards
        buffer = buffer.slice(0, newlineIndex);
      }
      end = start;
    }
    const trimmed = buffer.trim();
    if (trimmed.length === 0) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}
