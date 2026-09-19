import { DEFAULT_CONNECTION_CONFIG, fetchLatestWaWebVersion, type WAVersion } from "@whiskeysockets/baileys";

export type VersionFetcher = (options: { signal: AbortSignal }) => Promise<{ version: WAVersion; isLatest: boolean }>;

export interface ResolvedWaVersion {
  version: WAVersion;
  source: "latest" | "bundled";
}

function isWaVersion(value: unknown): value is WAVersion {
  return Array.isArray(value) && value.length === 3 &&
    value.every((part) => Number.isSafeInteger(part) && part >= 0);
}

function isNewer(candidate: WAVersion, baseline: WAVersion): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index]! !== baseline[index]!) return candidate[index]! > baseline[index]!;
  }
  return false;
}

/**
 * WhatsApp refuses to link devices that report a stale WhatsApp Web version,
 * and a pinned Baileys release falls behind within weeks. Ask WhatsApp for the
 * current version at startup; keep the bundled one if the answer is missing,
 * malformed, from another major version, or older.
 */
export async function resolveWaWebVersion(
  fetcher: VersionFetcher = fetchLatestWaWebVersion,
  bundled: WAVersion = DEFAULT_CONNECTION_CONFIG.version,
  timeoutMilliseconds = 10_000,
): Promise<ResolvedWaVersion> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Race as well as abort: a fetch that ignores its signal must not stall startup.
    const result = await Promise.race([
      fetcher({ signal: AbortSignal.timeout(timeoutMilliseconds) }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMilliseconds);
      }),
    ]);
    if (result.isLatest && isWaVersion(result.version) && result.version[0] === bundled[0] &&
      !isNewer(bundled, result.version)) {
      return { version: [...result.version] as WAVersion, source: "latest" };
    }
  } catch {
    // Fall through to the bundled version.
  } finally {
    clearTimeout(timer);
  }
  return { version: bundled, source: "bundled" };
}
