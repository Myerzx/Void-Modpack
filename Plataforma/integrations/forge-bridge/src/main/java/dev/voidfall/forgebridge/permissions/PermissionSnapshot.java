package dev.voidfall.forgebridge.permissions;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * What the provider actually held, and when it was read.
 *
 * Origin and instant travel with it because VoidFall does not own this state —
 * it presents someone else's. Groups on a screen with no indication of where
 * they came from or how old the reading is invite the reader to treat a cache
 * as the truth, which is the second source of truth this design refuses to
 * create.
 */
public record PermissionSnapshot(
    UUID identityId,
    UUID claimId,
    UUID minecraftUuid,
    PermissionState state,
    String providerId,
    Optional<String> providerVersion,
    Instant observedAt) {

  public PermissionSnapshot {
    Objects.requireNonNull(identityId, "identityId");
    Objects.requireNonNull(claimId, "claimId");
    Objects.requireNonNull(minecraftUuid, "minecraftUuid");
    Objects.requireNonNull(state, "state");
    Objects.requireNonNull(providerId, "providerId");
    Objects.requireNonNull(providerVersion, "providerVersion");
    Objects.requireNonNull(observedAt, "observedAt");
  }
}
