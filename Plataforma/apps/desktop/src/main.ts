import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, utilityProcess, type UtilityProcess } from 'electron';

import {
  isAllowedDesktopNavigation,
  parseDesktopBackendMessage,
  type DesktopBackendReady,
} from './backend-protocol.js';

const STARTUP_TIMEOUT_MS = 60_000;
const WINDOW_BACKGROUND = '#090c12';

let window: BrowserWindow | null = null;
let backend: UtilityProcess | null = null;
let quitting = false;
let backendStopped = false;
let backendStopTask: Promise<void> | null = null;

function configureUserData(): void {
  if (process.platform !== 'win32') return;
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData === undefined) return;
  const userData = resolve(localAppData, 'VoidFall');
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
}

function runtimePaths(): {
  readonly backendEntry: string;
  readonly controlApiEntry: string;
  readonly panelRoot: string;
  readonly stateDirectory: string;
} {
  const here = dirname(fileURLToPath(import.meta.url));
  if (app.isPackaged) {
    return {
      backendEntry: join(here, 'backend.js'),
      controlApiEntry: join(process.resourcesPath, 'voidfall', 'control-api', 'local.js'),
      panelRoot: join(process.resourcesPath, 'voidfall', 'panel'),
      stateDirectory: join(app.getPath('userData'), 'runtime'),
    };
  }
  return {
    backendEntry: join(here, 'backend.js'),
    controlApiEntry: resolve(here, '..', '..', 'control-api', 'dist', 'local.js'),
    panelRoot: resolve(here, '..', '..', 'panel-web', 'out'),
    stateDirectory: join(app.getPath('userData'), 'runtime-development'),
  };
}

function environmentFor(paths: ReturnType<typeof runtimePaths>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: app.isPackaged ? 'production' : 'development',
    VOIDFALL_DESKTOP_CONTROL_API_ENTRY: paths.controlApiEntry,
    VOIDFALL_DESKTOP_PANEL_ROOT: paths.panelRoot,
    VOIDFALL_DESKTOP_STATE_DIRECTORY: paths.stateDirectory,
  };
}

function startBackend(): UtilityProcess {
  const paths = runtimePaths();
  const child = utilityProcess.fork(paths.backendEntry, [], {
    cwd: app.getPath('userData'),
    env: environmentFor(paths),
    serviceName: 'VoidFall Control Plane',
    stdio: 'pipe',
  });
  child.stdout?.on('data', (chunk: Buffer | string) => {
    process.stdout.write(`[control-plane] ${String(chunk)}`);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    process.stderr.write(`[control-plane] ${String(chunk)}`);
  });
  return child;
}

function waitForBackend(child: UtilityProcess): Promise<DesktopBackendReady> {
  return new Promise<DesktopBackendReady>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('O backend local não ficou pronto dentro de 60 segundos.'));
    }, STARTUP_TIMEOUT_MS);
    const onMessage = (value: unknown): void => {
      const message = parseDesktopBackendMessage(value);
      if (message === null) return;
      if (message.type === 'failed') {
        cleanup();
        reject(new Error(message.reason));
        return;
      }
      if (message.type === 'stopped') {
        cleanup();
        reject(new Error('O backend local encerrou durante a inicialização.'));
        return;
      }
      cleanup();
      resolveReady(message);
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`O backend local encerrou durante a inicialização (código ${String(code)}).`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function guardNavigation(target: BrowserWindow, baseUrl: string): void {
  const allow = (event: Electron.Event, url: string): void => {
    if (!isAllowedDesktopNavigation(url, baseUrl)) event.preventDefault();
  };
  target.webContents.on('will-navigate', allow);
  target.webContents.on('will-redirect', allow);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

async function createWindow(runtime: DesktopBackendReady): Promise<BrowserWindow> {
  const created = new BrowserWindow({
    title: 'VoidFall',
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      partition: 'persist:voidfall',
    },
  });
  created.setMenuBarVisibility(false);
  guardNavigation(created, runtime.baseUrl);
  created.once('ready-to-show', () => created.show());
  await created.loadURL(runtime.launchUrl);
  created.on('closed', () => {
    if (window === created) window = null;
  });
  return created;
}

function stopBackend(): Promise<void> {
  const child = backend;
  if (child === null || child.pid === undefined) {
    backend = null;
    return Promise.resolve();
  }
  return new Promise<void>((resolveStopped) => {
    let settled = false;
    const complete = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (backend === child) backend = null;
      resolveStopped();
    };
    const onMessage = (value: unknown): void => {
      if (parseDesktopBackendMessage(value)?.type === 'stopped') complete();
    };
    const onExit = (): void => complete();
    const timeout = setTimeout(() => {
      child.kill();
      complete();
    }, 5_000);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.postMessage({ type: 'shutdown' });
  });
}

async function boot(): Promise<void> {
  backend = startBackend();
  backend.on('exit', (code) => {
    if (quitting) return;
    dialog.showErrorBox(
      'VoidFall foi interrompido',
      `O serviço local encerrou inesperadamente (código ${String(code)}).`,
    );
    app.quit();
  });
  const runtime = await waitForBackend(backend);
  window = await createWindow(runtime);
}

configureUserData();
app.setName('VoidFall');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('before-quit', (event) => {
    if (backendStopped || backend === null) return;
    event.preventDefault();
    if (backendStopTask !== null) return;
    quitting = true;
    backendStopTask = stopBackend().finally(() => {
      backendStopped = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(boot).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : 'Falha desconhecida ao abrir o aplicativo.';
    dialog.showErrorBox('VoidFall não iniciou', reason);
    app.quit();
  });
}
