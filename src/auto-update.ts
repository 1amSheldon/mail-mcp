export interface AutoUpdateMonitorOptions {
  currentVersion: string;
  intervalMs: number;
  onUpdateAvailable: (latestVersion: string) => Promise<void> | void;
  fetchLatestVersion?: () => Promise<string>;
  onCheckError?: (error: unknown) => void;
}

export interface AutoUpdateMonitor {
  stop(): void;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease?: string;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const candidateVersion = parseVersion(candidate);
  const currentVersion = parseVersion(current);
  if (!candidateVersion || !currentVersion) return false;

  for (let index = 0; index < candidateVersion.core.length; index++) {
    if (candidateVersion.core[index] !== currentVersion.core[index]) {
      return candidateVersion.core[index] > currentVersion.core[index];
    }
  }

  if (candidateVersion.prerelease === undefined && currentVersion.prerelease !== undefined) {
    return true;
  }
  if (candidateVersion.prerelease !== undefined && currentVersion.prerelease === undefined) {
    return false;
  }
  return false;
}

export async function fetchLatestPackageVersion(): Promise<string> {
  throw new Error('This distribution uses reviewed local builds. Update the project checkout and rebuild; upstream npm updates are disabled.');
}

export function startAutoUpdateMonitor(
  options: AutoUpdateMonitorOptions
): AutoUpdateMonitor {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 60_000) {
    throw new Error('Auto-update interval must be at least 60 seconds');
  }

  // Local fork installs must never restart onto an upstream npm package.
  if (!options.fetchLatestVersion) return { stop() {} };
  const fetchLatestVersion = options.fetchLatestVersion;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(check, options.intervalMs);
    timer.unref();
  };

  const check = async () => {
    if (stopped) return;
    try {
      const latestVersion = await fetchLatestVersion();
      if (isVersionNewer(latestVersion, options.currentVersion)) {
        stopped = true;
        await options.onUpdateAvailable(latestVersion);
        return;
      }
    } catch (error) {
      options.onCheckError?.(error);
    }
    schedule();
  };

  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
