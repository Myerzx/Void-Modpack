package dev.voidfall.forgebridge;

import java.time.Instant;

@FunctionalInterface
public interface NonceStore {
  boolean consume(String nonce, Instant expiresAt, Instant now);
}
