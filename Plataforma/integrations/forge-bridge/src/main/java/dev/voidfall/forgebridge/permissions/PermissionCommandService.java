package dev.voidfall.forgebridge.permissions;

import dev.voidfall.forgebridge.permissions.PermissionOperationResult.FailureCode;
import dev.voidfall.forgebridge.permissions.PermissionOperationResult.Outcome;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * Applies typed permission operations against the provider.
 *
 * Three rules shape everything here:
 *
 * <ul>
 *   <li><b>The account is resolved, never supplied.</b> An operation names a
 *       VoidFall identity and the claim it was decided against. This service
 *       asks the resolver for the active claim and refuses when it differs.
 *       Without that, an offline UUID from a screen would be enough to act on
 *       anybody, because an offline UUID is derived from the name.
 *   <li><b>The receipt reports what was read back.</b> Every applied operation
 *       re-reads the provider and returns that. Returning the requested state
 *       would report a mutation that may not have landed.
 *   <li><b>A rebind is one operation, ordered so interruption is safe.</b>
 *       Copy, verify, then clear the old account — the revocation is last, and
 *       until it happens the previous claim is still the valid one.
 * </ul>
 */
public final class PermissionCommandService {

  /** How many settled operations to remember for replay. */
  private static final int DEFAULT_REMEMBERED = 256;

  private final ClaimResolver claims;
  private final PermissionProvider provider;
  private final UUID serverInstanceId;
  private final Supplier<PermissionCapabilityState> capability;
  private final Clock clock;
  private final int maximumRemembered;
  private final Map<UUID, PermissionOperationResult> remembered = new LinkedHashMap<>();

  public PermissionCommandService(
      ClaimResolver claims,
      PermissionProvider provider,
      UUID serverInstanceId,
      Supplier<PermissionCapabilityState> capability,
      Clock clock) {
    this(claims, provider, serverInstanceId, capability, clock, DEFAULT_REMEMBERED);
  }

  public PermissionCommandService(
      ClaimResolver claims,
      PermissionProvider provider,
      UUID serverInstanceId,
      Supplier<PermissionCapabilityState> capability,
      Clock clock,
      int maximumRemembered) {
    this.claims = Objects.requireNonNull(claims, "claims");
    this.provider = Objects.requireNonNull(provider, "provider");
    this.serverInstanceId = Objects.requireNonNull(serverInstanceId, "serverInstanceId");
    this.capability = Objects.requireNonNull(capability, "capability");
    this.clock = Objects.requireNonNull(clock, "clock");
    if (maximumRemembered < 1) {
      throw new IllegalArgumentException("maximumRemembered must be positive.");
    }
    this.maximumRemembered = maximumRemembered;
  }

  public PermissionOperationResult apply(PermissionOperation operation) {
    Objects.requireNonNull(operation, "operation");
    PermissionOperation.Envelope envelope = operation.envelope();

    // An honest replay finds the original outcome rather than a second effect.
    PermissionOperationResult previous = remembered.get(envelope.operationId());
    if (previous != null) return previous;

    Instant now = clock.instant();
    Optional<PermissionCapabilityState.UnavailableReason> unavailable =
        capability.get().unavailableReason();
    if (unavailable.isPresent()) {
      return settle(envelope, failed(envelope, FailureCode.CAPABILITY_UNAVAILABLE, now));
    }
    if (!serverInstanceId.equals(envelope.serverInstanceId())) {
      return settle(envelope, failed(envelope, FailureCode.SERVER_MISMATCH, now));
    }
    if (!now.isBefore(envelope.expiresAt())) {
      // Decided against a world that has since moved on.
      return settle(envelope, failed(envelope, FailureCode.OPERATION_EXPIRED, now));
    }

    Optional<ResolvedClaim> active = claims.resolveActiveClaim(envelope.identityId());
    if (active.isEmpty()) {
      return settle(envelope, failed(envelope, FailureCode.IDENTITY_NOT_CLAIMED, now));
    }
    ResolvedClaim claim = active.get();
    if (!claim.claimId().equals(envelope.expectedClaimId())) {
      // The claim moved between the decision and the effect. Applying anyway
      // would act on whoever holds the account now.
      return settle(envelope, failed(envelope, FailureCode.CLAIM_MISMATCH, now));
    }

    try {
      return settle(
          envelope,
          operation instanceof PermissionOperation.Rebind rebind
              ? rebind(rebind, claim, now)
              : mutate(operation, claim, now));
    } catch (PermissionProviderException error) {
      return settle(envelope, failed(envelope, translate(error), clock.instant()));
    }
  }

  /** Reads the provider without changing anything. */
  public Optional<PermissionSnapshot> read(UUID identityId) {
    Objects.requireNonNull(identityId, "identityId");
    if (!capability.get().available()) return Optional.empty();
    Optional<ResolvedClaim> active = claims.resolveActiveClaim(identityId);
    if (active.isEmpty()) return Optional.empty();
    try {
      return Optional.of(snapshot(identityId, active.get(), clock.instant()));
    } catch (PermissionProviderException error) {
      // Unavailable is reported as absence, never as an empty state: "no
      // groups" and "could not ask" are different facts and only one of them
      // means the player has no groups.
      return Optional.empty();
    }
  }

  private PermissionOperationResult mutate(
      PermissionOperation operation, ResolvedClaim claim, Instant now) {
    UUID account = claim.minecraftUuid();
    PermissionState before = provider.read(account);
    boolean changed;

    if (operation instanceof PermissionOperation.GroupMembership group) {
      boolean present = before.groups().contains(group.group());
      changed = present != (group.change() == PermissionOperation.GroupChange.ADD);
      if (changed) {
        if (group.change() == PermissionOperation.GroupChange.ADD) {
          provider.addGroup(account, group.group());
        } else {
          provider.removeGroup(account, group.group());
        }
      }
    } else if (operation instanceof PermissionOperation.NodeSet node) {
      Boolean current = before.nodes().get(node.node());
      changed = current == null || current != node.value();
      if (changed) provider.setNode(account, node.node(), node.value());
    } else if (operation instanceof PermissionOperation.NodeUnset node) {
      changed = before.nodes().containsKey(node.node());
      if (changed) provider.unsetNode(account, node.node());
    } else {
      throw new IllegalStateException("Unreachable: every operation kind is handled.");
    }

    // Re-read even when nothing changed. The screen should show what the
    // provider holds now, not what this service believed a moment ago.
    PermissionSnapshot after = snapshot(operation.envelope().identityId(), claim, clock.instant());
    return new PermissionOperationResult(
        operation.envelope().operationId(),
        changed ? Outcome.APPLIED : Outcome.NO_CHANGE,
        Optional.empty(),
        Optional.of(after),
        now);
  }

  /**
   * Copy, verify, clear, in that order.
   *
   * Every interruption leaves the old account intact and still authoritative.
   * The caller revokes the previous claim only after this returns applied — a
   * claim revoked before the copy was verified would strand the identity with
   * no account holding its permissions.
   */
  private PermissionOperationResult rebind(
      PermissionOperation.Rebind operation, ResolvedClaim from, Instant now) {
    // The destination is resolved by id **scoped to this identity**. Resolving
    // it globally would let a rebind move one identity's permissions onto an
    // account belonging to somebody else.
    Optional<ResolvedClaim> destination =
        claims.resolveClaim(operation.envelope().identityId(), operation.newClaimId());
    if (destination.isEmpty()) {
      return failed(operation.envelope(), FailureCode.IDENTITY_NOT_CLAIMED, now);
    }
    ResolvedClaim to = destination.get();

    PermissionState source = provider.read(from.minecraftUuid());
    for (String group : source.groups()) {
      provider.addGroup(to.minecraftUuid(), group);
    }
    for (Map.Entry<String, Boolean> node : source.nodes().entrySet()) {
      provider.setNode(to.minecraftUuid(), node.getKey(), node.getValue());
    }

    // Verification compares what the destination actually holds against what
    // the source held. Trusting the writes to have worked is how a rebind
    // silently loses privileges nobody notices until they are needed.
    PermissionState copied = provider.read(to.minecraftUuid());
    if (!copied.groups().containsAll(source.groups())
        || !copied.nodes().entrySet().containsAll(source.nodes().entrySet())) {
      return failed(operation.envelope(), FailureCode.REBIND_NOT_VERIFIED, clock.instant());
    }

    provider.clearAll(from.minecraftUuid());
    PermissionSnapshot after =
        snapshot(operation.envelope().identityId(), to, clock.instant());
    return new PermissionOperationResult(
        operation.envelope().operationId(),
        Outcome.APPLIED,
        Optional.empty(),
        Optional.of(after),
        now);
  }

  private PermissionSnapshot snapshot(UUID identityId, ResolvedClaim claim, Instant observedAt) {
    return new PermissionSnapshot(
        identityId,
        claim.claimId(),
        claim.minecraftUuid(),
        provider.read(claim.minecraftUuid()),
        provider.providerId(),
        provider.providerVersion(),
        observedAt);
  }

  private static FailureCode translate(PermissionProviderException error) {
    return switch (error.code()) {
      case GROUP_NOT_FOUND -> FailureCode.GROUP_NOT_FOUND;
      case NODE_REJECTED -> FailureCode.NODE_REJECTED;
      case UNAVAILABLE -> FailureCode.PROVIDER_UNAVAILABLE;
    };
  }

  private static PermissionOperationResult failed(
      PermissionOperation.Envelope envelope, FailureCode code, Instant now) {
    return new PermissionOperationResult(
        envelope.operationId(), Outcome.FAILED, Optional.of(code), Optional.empty(), now);
  }

  private PermissionOperationResult settle(
      PermissionOperation.Envelope envelope, PermissionOperationResult result) {
    remembered.put(envelope.operationId(), result);
    if (remembered.size() > maximumRemembered) {
      var oldest = remembered.keySet().iterator();
      if (oldest.hasNext()) {
        oldest.next();
        oldest.remove();
      }
    }
    return result;
  }
}
