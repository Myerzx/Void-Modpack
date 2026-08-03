import type { KeyObject } from 'node:crypto';
import type { LauncherChannel, ReleaseManifest } from '@voidfall/contracts';
import {
  verifyLauncherChannelSignature,
  verifyReleaseManifestSignature,
} from '@voidfall/modpack-release';
import type { PortableReleaseVerifier } from './types.js';

export class PinnedReleaseKeyring implements PortableReleaseVerifier {
  readonly #keys: ReadonlyMap<string, KeyObject>;

  public constructor(keys: ReadonlyMap<string, KeyObject>) {
    const copy = new Map<string, KeyObject>();
    for (const [keyId, key] of keys) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(keyId) || key.type !== 'public') {
        throw new TypeError('Pinned release keys must use a valid key ID and public KeyObject.');
      }
      copy.set(keyId, key);
    }
    if (copy.size < 1) throw new TypeError('At least one pinned release key is required.');
    this.#keys = copy;
  }

  public verifyChannel(channel: LauncherChannel): boolean {
    const key = this.#keys.get(channel.signature.keyId);
    return key !== undefined && verifyLauncherChannelSignature(channel, key);
  }

  public verifyManifest(manifest: ReleaseManifest): boolean {
    const key = this.#keys.get(manifest.signature.keyId);
    return key !== undefined && verifyReleaseManifestSignature(manifest, key);
  }
}
