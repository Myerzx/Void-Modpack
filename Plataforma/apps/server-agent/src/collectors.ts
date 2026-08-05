import { freemem, loadavg, totalmem, uptime } from 'node:os';
import { statfs } from 'node:fs/promises';

import type { MetricName, MetricReading } from '@voidfall/contracts';
import { unavailableReading } from '@voidfall/server-telemetry';

/**
 * The basic collectors: host memory, host disk, load, and the agent process.
 *
 * What is measurable is measured and labelled `host-agent` or
 * `process-adapter`. What is not is reported as unavailable **with a reason**,
 * never omitted — an absent metric and a metric reading zero look identical on
 * a chart, and only one of them means the system is fine.
 *
 * Tick timing is the case that matters. TPS and MSPT need an approved in-game
 * provider, which needs the Forge Bridge, which is not connected. They are
 * emitted every cycle as unavailable with `no-approved-provider`, so the panel
 * has something honest to draw instead of a gap it might fill.
 */

export interface CollectorOptions {
  /** Which filesystem to report on. Absent disables the disk readings. */
  readonly diskPath: string | null;
  /**
   * The observed Minecraft process, when one is running. Absent means the
   * process readings are unavailable because the server is offline — which is
   * a different fact from a collector that failed.
   */
  readonly processObservation?: {
    readonly residentBytes: number;
    readonly uptimeSeconds: number;
  } | null;
  readonly clock?: () => Date;
}

/** Metrics no source available to this agent can produce. */
const PROVIDER_ONLY: readonly MetricName[] = Object.freeze([
  'game.tps',
  'game.mspt',
  'game.players.online',
]);

function measured(
  name: MetricName,
  value: number,
  source: 'host-agent' | 'process-adapter',
  observedAt: string,
): MetricReading {
  return Object.freeze({
    name,
    value,
    source,
    quality: 'measured' as const,
    observedAt,
    unavailableReason: null,
  });
}

/**
 * Takes one snapshot.
 *
 * Never throws. A collector that threw would take down the loop that runs it,
 * and losing every metric because one filesystem call failed is a worse outcome
 * than reporting that one reading as unavailable.
 */
export async function collectReadings(options: CollectorOptions): Promise<readonly MetricReading[]> {
  const observedAt = (options.clock ?? (() => new Date()))().toISOString();
  const readings: MetricReading[] = [];

  // --- Host memory and load. -------------------------------------------------
  try {
    readings.push(measured('host.memory.total.bytes', totalmem(), 'host-agent', observedAt));
    readings.push(measured('host.memory.available.bytes', freemem(), 'host-agent', observedAt));
  } catch {
    for (const name of ['host.memory.total.bytes', 'host.memory.available.bytes'] as const) {
      readings.push(unavailableReading({ name, observedAt, reason: 'collector-failed' }));
    }
  }

  try {
    const [oneMinute] = loadavg();
    // Windows reports zeros rather than a load average. Reporting a hard zero
    // as measured would put a flat healthy line on a chart that means nothing.
    if (oneMinute === undefined || (oneMinute === 0 && process.platform === 'win32')) {
      readings.push(
        unavailableReading({ name: 'host.load.1m', observedAt, reason: 'collector-failed' }),
      );
    } else {
      readings.push(measured('host.load.1m', oneMinute, 'host-agent', observedAt));
    }
  } catch {
    readings.push(
      unavailableReading({ name: 'host.load.1m', observedAt, reason: 'collector-failed' }),
    );
  }

  // --- Host disk. ------------------------------------------------------------
  if (options.diskPath === null) {
    for (const name of ['host.disk.total.bytes', 'host.disk.free.bytes'] as const) {
      readings.push(unavailableReading({ name, observedAt, reason: 'not-collected' }));
    }
  } else {
    try {
      const filesystem = await statfs(options.diskPath);
      readings.push(
        measured(
          'host.disk.total.bytes',
          Number(filesystem.blocks) * Number(filesystem.bsize),
          'host-agent',
          observedAt,
        ),
      );
      readings.push(
        measured(
          'host.disk.free.bytes',
          Number(filesystem.bavail) * Number(filesystem.bsize),
          'host-agent',
          observedAt,
        ),
      );
    } catch {
      for (const name of ['host.disk.total.bytes', 'host.disk.free.bytes'] as const) {
        readings.push(unavailableReading({ name, observedAt, reason: 'collector-failed' }));
      }
    }
  }

  // --- The observed server process. -----------------------------------------
  const observation = options.processObservation ?? null;
  if (observation === null) {
    // Offline is a fact about the server, not a failure of the collector, and
    // the reason says which.
    for (const name of ['process.resident.bytes', 'process.uptime.seconds'] as const) {
      readings.push(unavailableReading({ name, observedAt, reason: 'server-offline' }));
    }
  } else {
    readings.push(
      measured('process.resident.bytes', observation.residentBytes, 'process-adapter', observedAt),
    );
    readings.push(
      measured('process.uptime.seconds', observation.uptimeSeconds, 'process-adapter', observedAt),
    );
  }

  // --- The JVM. --------------------------------------------------------------
  // Reading another process's JVM needs instrumentation this agent does not
  // attach. Reported as not collected rather than guessed from RSS.
  for (const name of ['jvm.heap.used.bytes', 'jvm.heap.max.bytes', 'jvm.gc.pause.millis'] as const) {
    readings.push(unavailableReading({ name, observedAt, reason: 'not-collected' }));
  }

  // --- Anything only an approved provider can see. ---------------------------
  for (const name of PROVIDER_ONLY) {
    readings.push(unavailableReading({ name, observedAt, reason: 'no-approved-provider' }));
  }

  return Object.freeze(readings);
}

/** The agent's own uptime, for the readiness endpoint rather than the series. */
export function agentUptimeSeconds(): number {
  return Math.floor(uptime());
}
