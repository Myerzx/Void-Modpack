export interface DesktopBackendReady {
  readonly type: 'ready';
  readonly baseUrl: string;
  readonly launchUrl: string;
  readonly port: number;
}

export interface DesktopBackendFailed {
  readonly type: 'failed';
  readonly reason: string;
}

export interface DesktopBackendStopped {
  readonly type: 'stopped';
}

export type DesktopBackendMessage =
  | DesktopBackendReady
  | DesktopBackendFailed
  | DesktopBackendStopped;

function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function parseDesktopBackendMessage(value: unknown): DesktopBackendMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['type'] === 'stopped') return { type: 'stopped' };
  if (candidate['type'] === 'failed' && typeof candidate['reason'] === 'string') {
    return { type: 'failed', reason: candidate['reason'] };
  }
  if (
    candidate['type'] === 'ready' &&
    isLoopbackHttpUrl(candidate['baseUrl']) &&
    isLoopbackHttpUrl(candidate['launchUrl']) &&
    Number.isInteger(candidate['port']) &&
    Number(candidate['port']) > 0 &&
    Number(candidate['port']) <= 65_535
  ) {
    const baseUrl = candidate['baseUrl'];
    const launchUrl = candidate['launchUrl'];
    const port = Number(candidate['port']);
    if (new URL(baseUrl).port !== String(port) || new URL(launchUrl).origin !== new URL(baseUrl).origin) {
      return null;
    }
    return { type: 'ready', baseUrl, launchUrl, port };
  }
  return null;
}

export function isAllowedDesktopNavigation(target: string, baseUrl: string): boolean {
  try {
    const allowed = new URL(baseUrl);
    const destination = new URL(target);
    return (
      allowed.protocol === 'http:' &&
      allowed.hostname === '127.0.0.1' &&
      destination.origin === allowed.origin
    );
  } catch {
    return false;
  }
}
