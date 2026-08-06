package dev.voidfall.forgebridge.permissions;

import java.util.Objects;
import java.util.UUID;

/**
 * A VoidFall identity resolved to the Minecraft account it currently holds.
 *
 * This record is the only place a Minecraft UUID may enter an operation, and it
 * is produced by the Bridge rather than supplied to it. In offline mode a UUID
 * is derived from the player's name, so a UUID that arrived from a screen is
 * only ever a claim about a name — accepting one would let anybody act on
 * anybody by choosing the right name.
 */
public record ResolvedClaim(UUID claimId, UUID minecraftUuid) {
  public ResolvedClaim {
    Objects.requireNonNull(claimId, "claimId");
    Objects.requireNonNull(minecraftUuid, "minecraftUuid");
  }
}
