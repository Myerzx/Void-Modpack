import { verify as verifyEd25519, type KeyObject } from 'node:crypto';
import { validateLauncherChannel, type LauncherChannel } from '@voidfall/contracts';
import { canonicalJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import {
  ReleaseRepositoryError,
  type ReleaseDocumentSigner,
} from './types.js';

export type UnsignedLauncherChannel = Omit<LauncherChannel, 'signature'>;

function unsignedChannel(channel: LauncherChannel): UnsignedLauncherChannel {
  const { signature: _signature, ...unsigned } = channel;
  return unsigned;
}

export function launcherChannelPayload(channel: LauncherChannel): Uint8Array {
  return canonicalJsonBytes(unsignedChannel(channel) as CanonicalJsonValue);
}

export function signLauncherChannel(
  channel: UnsignedLauncherChannel,
  signer: ReleaseDocumentSigner,
): LauncherChannel {
  const placeholder: LauncherChannel = {
    ...channel,
    signature: { algorithm: 'Ed25519', keyId: signer.keyId, value: 'A'.repeat(86) },
  };
  const signed: LauncherChannel = {
    ...channel,
    signature: {
      algorithm: 'Ed25519',
      keyId: signer.keyId,
      value: signer.sign(launcherChannelPayload(placeholder)),
    },
  };
  const validation = validateLauncherChannel(signed);
  if (!validation.success) throw new ReleaseRepositoryError('invalid-document', 'channel');
  return validation.value;
}

export function verifyLauncherChannelSignature(
  channel: LauncherChannel,
  publicKey: KeyObject,
): boolean {
  const validation = validateLauncherChannel(channel);
  if (!validation.success || publicKey.type !== 'public') return false;
  try {
    return verifyEd25519(
      null,
      launcherChannelPayload(validation.value),
      publicKey,
      Buffer.from(validation.value.signature.value, 'base64url'),
    );
  } catch {
    return false;
  }
}
