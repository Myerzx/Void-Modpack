package dev.voidfall.forgebridge.permissions;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/** The receipt: what happened, and the state that was read back afterwards. */
public record PermissionOperationResult(
    UUID operationId,
    Outcome outcome,
    Optional<FailureCode> failureCode,
    Optional<PermissionSnapshot> snapshot,
    Instant completedAt) {

  public enum Outcome {
    APPLIED,
    /** The provider already held this. Not a failure, and worth distinguishing. */
    NO_CHANGE,
    FAILED
  }

  public enum FailureCode {
    /** The active claim is not the one the operation was decided against. */
    CLAIM_MISMATCH,
    /** The identity holds no claim, so there is nobody to act on. */
    IDENTITY_NOT_CLAIMED,
    SERVER_MISMATCH,
    OPERATION_EXPIRED,
    PROVIDER_UNAVAILABLE,
    GROUP_NOT_FOUND,
    NODE_REJECTED,
    /** The rebind copied but could not verify, so nothing was revoked. */
    REBIND_NOT_VERIFIED,
    CAPABILITY_UNAVAILABLE,
    OPERATION_FAILED
  }

  public PermissionOperationResult {
    Objects.requireNonNull(operationId, "operationId");
    Objects.requireNonNull(outcome, "outcome");
    Objects.requireNonNull(failureCode, "failureCode");
    Objects.requireNonNull(snapshot, "snapshot");
    Objects.requireNonNull(completedAt, "completedAt");
    if ((outcome == Outcome.FAILED) != failureCode.isPresent()) {
      throw new IllegalArgumentException("A failed result names its failure, and only it.");
    }
  }
}
