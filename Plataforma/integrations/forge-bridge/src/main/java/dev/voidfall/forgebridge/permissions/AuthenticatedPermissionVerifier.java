package dev.voidfall.forgebridge.permissions;

import dev.voidfall.forgebridge.PermissionVerifier;
import java.util.Objects;
import java.util.UUID;

/**
 * Answers permission questions only after the login has completed.
 *
 * There is a reported fault in LuckPerms on Forge 1.20.1 where permission data
 * is not loaded during pre-login because the UUID at that point is not yet the
 * final one. Under offline authentication that is not an edge case, it is the
 * normal shape of things: the moment a UUID becomes trustworthy is *after* the
 * ticket has been validated and the session bound to an identity. Resolving a
 * permission before then answers for an identity that has not been established.
 *
 * So this decorator refuses rather than guesses, and refusing means denying. A
 * verifier that granted while the session was still forming would hand out
 * authority on the strength of a name.
 */
public final class AuthenticatedPermissionVerifier implements PermissionVerifier {

  /** Whether a session is authenticated and its login has finished. */
  @FunctionalInterface
  public interface SessionRegistry {
    boolean isLoginComplete(UUID minecraftUuid);
  }

  private final SessionRegistry sessions;
  private final PermissionVerifier delegate;

  public AuthenticatedPermissionVerifier(SessionRegistry sessions, PermissionVerifier delegate) {
    this.sessions = Objects.requireNonNull(sessions, "sessions");
    this.delegate = Objects.requireNonNull(delegate, "delegate");
  }

  @Override
  public boolean hasPermission(UUID playerUuid, String permission) {
    if (playerUuid == null || permission == null) return false;
    // Deny-by-default, and the default applies to "too early" as much as to
    // "not granted".
    if (!sessions.isLoginComplete(playerUuid)) return false;
    return delegate.hasPermission(playerUuid, permission);
  }
}
