package dev.voidfall.forgebridge;

import java.util.UUID;

@FunctionalInterface
public interface PermissionVerifier {
  boolean hasPermission(UUID playerUuid, String permission);
}
