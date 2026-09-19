import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Reads a secret-bearing file only if it is a regular, single-link file owned by
 * this user with no group or world access, and no larger than `maximumBytes`.
 * The final path component must not be a symlink.
 */
export async function readPrivateFile(path: string, maximumBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== process.getuid?.() || metadata.size > maximumBytes) {
      throw new Error("Expected a bounded, owner-only private file");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximumBytes) throw new Error("Private file exceeds size limit");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
