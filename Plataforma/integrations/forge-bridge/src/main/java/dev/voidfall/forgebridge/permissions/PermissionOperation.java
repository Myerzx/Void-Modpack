package dev.voidfall.forgebridge.permissions;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * A typed permission operation, as it crosses into the Bridge.
 *
 * Sealed, so the set of things that can be asked for is closed at compile time
 * rather than by a check somebody might forget. There is no command string in
 * any variant, and — the property everything else rests on — **no variant
 * carries a player name or a Minecraft UUID**. The account is resolved from the
 * identity's active claim, never supplied.
 */
public sealed interface PermissionOperation {

  Envelope envelope();

  /** What every operation carries regardless of kind. */
  record Envelope(
      UUID operationId,
      UUID serverInstanceId,
      UUID identityId,
      UUID expectedClaimId,
      String reason,
      Instant issuedAt,
      Instant expiresAt) {

    public Envelope {
      Objects.requireNonNull(operationId, "operationId");
      Objects.requireNonNull(serverInstanceId, "serverInstanceId");
      Objects.requireNonNull(identityId, "identityId");
      Objects.requireNonNull(expectedClaimId, "expectedClaimId");
      Objects.requireNonNull(reason, "reason");
      Objects.requireNonNull(issuedAt, "issuedAt");
      Objects.requireNonNull(expiresAt, "expiresAt");
    }
  }

  enum GroupChange {
    ADD,
    REMOVE
  }

  record GroupMembership(Envelope envelope, GroupChange change, String group)
      implements PermissionOperation {
    public GroupMembership {
      Objects.requireNonNull(envelope, "envelope");
      Objects.requireNonNull(change, "change");
      Objects.requireNonNull(group, "group");
    }
  }

  /**
   * A node set to {@code false} is a denial, not a removal. LuckPerms
   * distinguishes them and so does this: unsetting drops the node and lets
   * inheritance decide, setting it false overrules an inherited grant.
   */
  record NodeSet(Envelope envelope, String node, boolean value) implements PermissionOperation {
    public NodeSet {
      Objects.requireNonNull(envelope, "envelope");
      Objects.requireNonNull(node, "node");
    }
  }

  record NodeUnset(Envelope envelope, String node) implements PermissionOperation {
    public NodeUnset {
      Objects.requireNonNull(envelope, "envelope");
      Objects.requireNonNull(node, "node");
    }
  }

  /**
   * Rebinding an identity onto a new claim after a name change.
   *
   * One operation rather than a sequence, because as separate commands each
   * step can fail alone and leave permissions on two accounts, on neither, or a
   * claim revoked before the copy existed.
   */
  record Rebind(Envelope envelope, UUID newClaimId) implements PermissionOperation {
    public Rebind {
      Objects.requireNonNull(envelope, "envelope");
      Objects.requireNonNull(newClaimId, "newClaimId");
    }
  }
}
