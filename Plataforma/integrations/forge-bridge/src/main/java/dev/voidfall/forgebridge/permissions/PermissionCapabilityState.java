package dev.voidfall.forgebridge.permissions;

import java.util.Optional;

/**
 * Whether the permission capability may be served, and why not when it may not.
 *
 * The same rule the agent's readiness follows: a capability is offered only
 * when every dependency it needs exists, and every refusal carries a reason.
 * "Unavailable" with no cause is indistinguishable from a defect, and an
 * operator has nothing to act on.
 *
 * {@code expectedHandlerActive} is checked at boot rather than assumed. Any mod
 * may register its own Forge permission handler; if one did, the compatibility
 * interface would answer differently with nothing in the logs to say so.
 */
public record PermissionCapabilityState(
    boolean bridgeReady,
    boolean providerReady,
    boolean expectedHandlerActive,
    boolean authenticationReady) {

  public enum UnavailableReason {
    BRIDGE_NOT_READY,
    PROVIDER_UNAVAILABLE,
    UNEXPECTED_PERMISSION_HANDLER,
    AUTHENTICATION_NOT_READY
  }

  /** Empty exactly when the capability may be served. */
  public Optional<UnavailableReason> unavailableReason() {
    if (!bridgeReady) return Optional.of(UnavailableReason.BRIDGE_NOT_READY);
    if (!providerReady) return Optional.of(UnavailableReason.PROVIDER_UNAVAILABLE);
    // Ordered before authentication deliberately: a foreign handler is a
    // misconfiguration of the host, and reporting "authentication not ready"
    // would send an operator to fix the wrong thing.
    if (!expectedHandlerActive) return Optional.of(UnavailableReason.UNEXPECTED_PERMISSION_HANDLER);
    if (!authenticationReady) return Optional.of(UnavailableReason.AUTHENTICATION_NOT_READY);
    return Optional.empty();
  }

  public boolean available() {
    return unavailableReason().isEmpty();
  }
}
