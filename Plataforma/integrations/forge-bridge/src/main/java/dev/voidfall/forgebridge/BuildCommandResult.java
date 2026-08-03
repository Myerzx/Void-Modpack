package dev.voidfall.forgebridge;

import java.util.UUID;

public record BuildCommandResult(Status status, UUID correlationId, String message) {
  public enum Status {
    ACCEPTED,
    DENIED,
    DISABLED,
    INVALID,
    REPLAY
  }
}
