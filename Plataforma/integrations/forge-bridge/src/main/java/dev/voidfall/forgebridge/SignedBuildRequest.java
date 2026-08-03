package dev.voidfall.forgebridge;

import java.time.Instant;
import java.util.UUID;

public record SignedBuildRequest(
    int schemaVersion,
    int protocolVersion,
    String kind,
    UUID requestId,
    UUID correlationId,
    UUID playerUuid,
    UUID serverInstanceId,
    String permission,
    String nonce,
    Instant issuedAt,
    Instant expiresAt,
    String keyId,
    String signature) {}
