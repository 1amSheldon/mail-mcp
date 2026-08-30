const NPM_LATEST_URL =
  'https://registry.npmjs.org/@1amsheldon%2fmail-mcp/latest';
const UPDATE_REQUEST_TIMEOUT_MS = 10_000;

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_REQUEST_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetch(NPM_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }
    const body = await response.json() as { version?: unknown };
    if (typeof body.version !== 'string' || !parseVersion(body.version)) {
      throw new Error('npm registry returned an invalid package version');
    }
    return body.version;
  } finally {
    clearTimeout(timeout);
  }
}

export function startAutoUpdateMonitor(
  options: AutoUpdateMonitorOptions
): AutoUpdateMonitor {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 60_000) {
    throw new Error('Auto-update interval must be at least 60 seconds');
  }

  const fetchLatestVersion = options.fetchLatestVersion ?? fetchLatestPackageVersion;
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
