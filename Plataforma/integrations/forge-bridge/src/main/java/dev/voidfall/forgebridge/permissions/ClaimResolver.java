package dev.voidfall.forgebridge.permissions;

import java.util.Optional;
import java.util.UUID;

/**
 * Resolves a VoidFall identity to the claim that is active right now.
 *
 * Deliberately the only route from an identity to a Minecraft UUID. An
 * operation names the identity and the claim it was decided against; the Bridge
 * asks this, compares, and refuses when the two disagree. That comparison is
 * what turns "the screen said this player" into "this identity, still holding
 * this account, at the moment of the effect".
 */
public interface ClaimResolver {
  Optional<ResolvedClaim> resolveActiveClaim(UUID identityId);

  /**
   * Resolves one named claim, scoped to the identity that must own it.
   *
   * The identity is a parameter rather than a courtesy. A rebind names its
   * destination by claim id, and resolving that id without checking whose it is
   * would let a rebind move an identity's permissions onto an account belonging
   * to someone else — which is the same class of mistake as trusting a UUID
   * from a screen, arriving by a different door.
   */
  Optional<ResolvedClaim> resolveClaim(UUID identityId, UUID claimId);
}
