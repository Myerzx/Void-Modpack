package dev.voidfall.forgebridge.permissions;

import java.util.Optional;
import java.util.UUID;

/**
 * The permission provider, as an interface.
 *
 * The Bridge core is plain Java 17 compiled by javac with nothing on the
 * classpath, so LuckPerms cannot appear here — the concrete binding to its API
 * lives in the mod layer, exactly as {@code PermissionVerifier} already works.
 * That is not only a build constraint: it is what lets every rule below be
 * tested without a running server.
 *
 * Implementations throw {@link PermissionProviderException} when the provider
 * is unreachable or refuses. They must not invent a result.
 */
public interface PermissionProvider {
  /** Identifies whose state a snapshot came from. */
  String providerId();

  Optional<String> providerVersion();

  PermissionState read(UUID minecraftUuid);

  void addGroup(UUID minecraftUuid, String group);

  void removeGroup(UUID minecraftUuid, String group);

  void setNode(UUID minecraftUuid, String node, boolean value);

  void unsetNode(UUID minecraftUuid, String node);

  /** Drops everything held for an account. Used only as the rebind's last step. */
  void clearAll(UUID minecraftUuid);
}
