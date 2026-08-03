package dev.voidfall.forgebridge;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

public record BuildRequestIntent(
    int protocolVersion,
    UUID requestId,
    UUID correlationId,
    UUID playerUuid,
    UUID serverInstanceId,
    String nonce,
    Instant issuedAt,
    Instant expiresAt) {

  public BuildRequestIntent {
    Objects.requireNonNull(requestId, "requestId");
    Objects.requireNonNull(correlationId, "correlationId");
    Objects.requireNonNull(playerUuid, "playerUuid");
    Objects.requireNonNull(serverInstanceId, "serverInstanceId");
    Objects.requireNonNull(nonce, "nonce");
    Objects.requireNonNull(issuedAt, "issuedAt");
    Objects.requireNonNull(expiresAt, "expiresAt");
  }
}
