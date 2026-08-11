import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DesktopBackendMessage } from './backend-protocol.js';

interface LocalRuntimeReady {
  readonly baseUrl: string;
  readonly launchUrl: string;
  readonly port: number;
  readonly stateDirectory: string;
}

interface LocalApiModule {
  readonly main: (
    argv: readonly string[],
    options: {
      readonly runtime: 'desktop';
      readonly stateDirectory: string;
      readonly panelExportRoot: string;
      readonly preferredPort: number;
      readonly onReady: (runtime: LocalRuntimeReady) => void;
      readonly shutdownSignal: AbortSignal;
      readonly onStopped: () => void;
    },
  ) => Promise<number>;
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name];
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`Configuração desktop ausente ou inválida: ${name}.`);
  }
  return value;
}

function send(message: DesktopBackendMessage): void {
  if (process.parentPort === undefined) {
    throw new Error('O backend desktop deve ser iniciado por um utility process do Electron.');
  }
  process.parentPort.postMessage(message);
}

async function run(): Promise<void> {
  const controlApiEntry = requiredAbsolutePath('VOIDFALL_DESKTOP_CONTROL_API_ENTRY');
  const stateDirectory = requiredAbsolutePath('VOIDFALL_DESKTOP_STATE_DIRECTORY');
  const panelExportRoot = requiredAbsolutePath('VOIDFALL_DESKTOP_PANEL_ROOT');
  const imported: unknown = await import(pathToFileURL(controlApiEntry).href);
  if (
    typeof imported !== 'object' ||
    imported === null ||
    typeof (imported as { readonly main?: unknown }).main !== 'function'
  ) {
    throw new Error('O bootstrap local compilado não exporta main().');
  }
  const localApi = imported as LocalApiModule;
  const parentPort = process.parentPort;
  if (parentPort === undefined) {
    throw new Error('O backend desktop deve ser iniciado por um utility process do Electron.');
  }
  const shutdown = new AbortController();
  const onParentMessage = (event: Electron.MessageEvent): void => {
    const message: unknown = event.data;
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { readonly type?: unknown }).type === 'shutdown'
    ) {
      shutdown.abort();
    }
  };
  parentPort.on('message', onParentMessage);
  const code = await localApi.main([], {
    runtime: 'desktop',
    stateDirectory,
    panelExportRoot,
    preferredPort: 0,
    onReady: ({ baseUrl, launchUrl, port }) => {
      send({ type: 'ready', baseUrl, launchUrl, port });
    },
    shutdownSignal: shutdown.signal,
    onStopped: () => {
      parentPort.off('message', onParentMessage);
      send({ type: 'stopped' });
      setImmediate(() => process.exit(0));
    },
  });
  if (code !== 0) {
    parentPort.off('message', onParentMessage);
    send({ type: 'failed', reason: `O backend local terminou com o código ${String(code)}.` });
    process.exitCode = code;
  }
}

run().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'Falha desconhecida no backend local.';
  try {
    send({ type: 'failed', reason });
  } finally {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  }
});
