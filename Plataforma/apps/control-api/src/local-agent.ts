import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createOpaqueToken, hashOpaqueToken, sha256Hex } from '@voidfall/authentication';
import { createRepositories, type Database, type ServerInstance } from '@voidfall/database';
import {
  LinuxMinecraftProcessAdapter,
  MinecraftProcessController,
  NodeProcessRuntime,
  WindowsMinecraftProcessAdapter,
  createForgeArgsFileProcessPlan,
  createMinecraftProcessPlan,
  type SupportedHostPlatform,
} from '@voidfall/minecraft-process';

/**
 * The agent, in the local environment.
 *
 * Deliberately in the same process as the Control API, and measured before it
 * was decided. Two separate processes opened and wrote the same PGlite
 * directory at the same time with **no refusal of any kind** — and the absence
 * of a refusal is the danger, not the permission. PGlite has no inter-process
 * coordination: each process runs its own Postgres in WebAssembly, with its
 * own buffer cache, writing the same files. A local panel that corrupted its
 * own database on the second process would be a worse failure than not
 * starting the server at all.
 *
 * Sharing the process is not a shortcut around the architecture. `AgentRuntime`
 * takes its repositories as a dependency precisely for this, the transport is
 * still loopback HTTP to the same API, and the authority over the Minecraft
 * process stays where it has always been — in the agent, reached by a durable
 * operation that it claims, never by the API touching a child process.
 *
 * In production none of this applies: there the agent is a separate process
 * against a real PostgreSQL, which is the case it was written for.
 */

const AGENT_KEY_FILE = 'agent-key.pem';
const AGENT_ID_FILE = 'agent-id.txt';

export interface LocalAgentIdentity {
  readonly agentId: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

/**
 * Reads the agent's key, generating it on the first run.
 *
 * Generated rather than asked for, like the owner's password: a key nobody had
 * to produce is a key nobody produces badly.
 */
export async function provisionLocalAgentIdentity(
  stateDirectory: string,
): Promise<LocalAgentIdentity> {
  const keyPath = join(stateDirectory, AGENT_KEY_FILE);
  const idPath = join(stateDirectory, AGENT_ID_FILE);

  const existingKey = await readFile(keyPath, 'utf8').catch(() => undefined);
  const existingId = await readFile(idPath, 'utf8').catch(() => undefined);
  if (existingKey !== undefined && existingId !== undefined) {
    const { publicKey } = deriveKeys(existingKey);
    return { agentId: existingId.trim(), privateKeyPem: existingKey, publicKeyPem: publicKey };
  }

  const generated = generateKeyPairSync('ed25519');
  const privateKeyPem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = generated.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const agentId = randomUUID();
  await writeFile(keyPath, privateKeyPem, 'utf8');
  await writeFile(idPath, `${agentId}\n`, 'utf8');
  return { agentId, privateKeyPem, publicKeyPem };
}

function deriveKeys(privateKeyPem: string): { readonly publicKey: string } {
  return {
    publicKey: createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  };
}

/**
 * The instance the local agent serves.
 *
 * Created on first run so the operator has something to point at a directory.
 * It deliberately starts with no run directory: where a server executes is
 * read from the disk by the runtime route, never invented here.
 */
export async function provisionLocalInstance(database: Database): Promise<ServerInstance> {
  const repositories = createRepositories(database);
  const existing = await repositories.servers.list();
  const first = existing[0];
  if (first !== undefined) return first;

  return repositories.servers.create({
    id: randomUUID(),
    slug: 'local',
    displayName: 'Servidor local',
    environment: 'local',
    minecraftVersion: 'desconhecida',
    loader: 'desconhecido',
    loaderVersion: 'desconhecida',
    maxPlayers: 20,
  });
}

/**
 * Registers the agent through the real route, over loopback.
 *
 * The provisioning token is created and spent here rather than skipped. It is
 * two extra calls and it keeps the registration path the one that is actually
 * tested — a local environment that registered by writing rows would be
 * exercising a flow nothing else uses.
 */
export async function registerLocalAgent(input: {
  readonly database: Database;
  readonly identity: LocalAgentIdentity;
  readonly serverInstanceId: string;
  readonly baseUrl: string;
  readonly softwareVersion: string;
}): Promise<'registered' | 'already-registered'> {
  const repositories = createRepositories(input.database);
  if ((await repositories.agents.findById(input.identity.agentId)) !== undefined) {
    return 'already-registered';
  }

  const token = createOpaqueToken();
  await repositories.agents.createProvisioningToken({
    serverInstanceId: input.serverInstanceId,
    tokenHash: hashOpaqueToken(token),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });

  const response = await fetch(new URL('/agent/v1/register/complete', input.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provisioningToken: token,
      agentId: input.identity.agentId,
      serverInstanceId: input.serverInstanceId,
      publicKeyPem: input.identity.publicKeyPem,
      // No TLS on loopback, so there is no peer certificate to fingerprint.
      // The digest of the agent's own public key stands in: it is stable, it
      // is the agent's, and the local transport verifier accepts loopback
      // rather than pretending a certificate was presented.
      certificateFingerprint: sha256Hex(input.identity.publicKeyPem),
      softwareVersion: input.softwareVersion,
      capabilities: ['heartbeat', 'configuration.apply'],
    }),
  });
  if (!response.ok) {
    throw new Error(`local agent registration refused with HTTP ${String(response.status)}`);
  }

  // Registration writes the `agents` row; claiming work resolves a credential
  // from `agent_credentials`, which is a separate store added in Phase 9.1.
  // Without this the agent registers, announces its capabilities, and then
  // gets 401 on every claim — which is what happened here, and it looked like
  // a signing fault rather than a missing credential.
  await repositories.agentTransport.rotateCredential({
    agentId: input.identity.agentId,
    credentialId: randomUUID(),
    publicKeyPem: input.identity.publicKeyPem,
    certificateFingerprint: sha256Hex(input.identity.publicKeyPem),
    reasonCode: 'local-environment-provisioned',
    now: new Date(),
  });

  // A capability has to be **granted**, not merely announced — an agent that
  // announces one is authorized for nothing until somebody grants it, and a
  // grant can be withdrawn without touching the identity. That rule cost two
  // diagnostic rounds here: the agent registered, announced `process.control`,
  // and got 403 on every claim.
  //
  // The local operator is the person who runs the command, so the grant is
  // made on their behalf and named as such. `process.force-kill` is
  // deliberately absent: it has no handler anywhere and killing a server can
  // lose everything since the last save.
  for (const capability of ['process.control', 'console.command'] as const) {
    await repositories.agentTransport.grantCapability({
      agentId: input.identity.agentId,
      capability,
      grantedBy: { type: 'system', id: 'voidfall-local-environment' },
      reasonCode: 'local-operator-runs-this-host',
      now: new Date(),
    });
  }
  return 'registered';
}

export interface LocalProcessRuntime {
  readonly controller: MinecraftProcessController;
  readonly adapter: WindowsMinecraftProcessAdapter | LinuxMinecraftProcessAdapter;
  readonly family: string;
}

/**
 * Builds the controller for an instance that has been pointed at a directory.
 *
 * Returns nothing when it has not been, which is an ordinary state and the one
 * readiness already models: the agent comes up, says
 * `no-process-controller-configured`, and does not announce a capability it
 * cannot serve.
 */
export function buildLocalProcessRuntime(
  instance: ServerInstance,
  javaExecutable: string,
): LocalProcessRuntime | null {
  if (instance.runDirectory === null || instance.runtime === null) return null;
  if (process.platform !== 'win32' && process.platform !== 'linux') return null;
  const platform: SupportedHostPlatform = process.platform;

  const launchPlan =
    instance.runtime.shape === 'args-file'
      ? createForgeArgsFileProcessPlan({
          platform,
          javaExecutable,
          serverDirectory: instance.runDirectory,
          argsFile: instance.runtime.entry,
          initialMemoryMiB: 2_048,
          maximumMemoryMiB: 8_192,
        })
      : createMinecraftProcessPlan({
          platform,
          javaExecutable,
          serverDirectory: instance.runDirectory,
          serverJar: instance.runtime.entry,
          initialMemoryMiB: 2_048,
          maximumMemoryMiB: 8_192,
        });

  const runtime = new NodeProcessRuntime();
  // One adapter is process, console and metrics adapter at once. It owns the
  // child handle, and two of them would each believe they did.
  const adapter =
    platform === 'win32'
      ? new WindowsMinecraftProcessAdapter({ runtime })
      : new LinuxMinecraftProcessAdapter({ runtime });

  return {
    controller: new MinecraftProcessController({ adapter, launchPlan }),
    adapter,
    family: instance.runtime.family,
  };
}
