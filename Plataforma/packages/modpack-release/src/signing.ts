import {
  sign as signEd25519,
  verify as verifyEd25519,
  type KeyObject,
} from 'node:crypto';
import { validateReleaseManifest, type ReleaseManifest } from '@voidfall/contracts';
import { canonicalJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import { ReleaseBuildError, type ReleaseDocumentSigner } from './types.js';

type UnsignedReleaseManifest = Omit<ReleaseManifest, 'signature'>;

function unsignedManifest(manifest: ReleaseManifest): UnsignedReleaseManifest {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

export function releaseManifestPayload(manifest: ReleaseManifest): Uint8Array {
  return canonicalJsonBytes(unsignedManifest(manifest) as CanonicalJsonValue);
}

export class Ed25519ReleaseSigner implements ReleaseDocumentSigner {
  public readonly keyId: string;
  readonly #privateKey: KeyObject;

  public constructor(input: { readonly keyId: string; readonly privateKey: KeyObject }) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.keyId) || input.privateKey.type !== 'private') {
      throw new ReleaseBuildError('invalid-options', 'options');
    }
    this.keyId = input.keyId;
    this.#privateKey = input.privateKey;
  }

  public sign(payload: Uint8Array): string {
    return signEd25519(null, payload, this.#privateKey).toString('base64url');
  }
}

export function signReleaseManifest(
  manifest: UnsignedReleaseManifest,
  signer: ReleaseDocumentSigner,
): ReleaseManifest {
  const placeholder: ReleaseManifest = {
    ...manifest,
    signature: { algorithm: 'Ed25519', keyId: signer.keyId, value: 'A'.repeat(86) },
  };
  const signed: ReleaseManifest = {
    ...manifest,
    signature: {
      algorithm: 'Ed25519',
      keyId: signer.keyId,
      value: signer.sign(releaseManifestPayload(placeholder)),
    },
  };
  const validation = validateReleaseManifest(signed);
  if (!validation.success) throw new ReleaseBuildError('invalid-plan', 'sign');
  return validation.value;
}

export function verifyReleaseManifestSignature(
  manifest: ReleaseManifest,
  publicKey: KeyObject,
): boolean {
  const validation = validateReleaseManifest(manifest);
  if (!validation.success || publicKey.type !== 'public') return false;
  try {
    return verifyEd25519(
      null,
      releaseManifestPayload(validation.value),
      publicKey,
      Buffer.from(validation.value.signature.value, 'base64url'),
    );
  } catch {
    return false;
  }
}
