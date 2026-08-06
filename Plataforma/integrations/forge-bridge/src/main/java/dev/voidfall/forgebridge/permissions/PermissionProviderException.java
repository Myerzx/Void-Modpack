package dev.voidfall.forgebridge.permissions;

/**
 * The provider could not be reached, or refused.
 *
 * Carries a code, never the provider's message: a failure that travelled back
 * to a panel with a library's text in it is a channel for host detail nobody
 * decided to open.
 */
public final class PermissionProviderException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public enum Code {
    UNAVAILABLE,
    GROUP_NOT_FOUND,
    NODE_REJECTED
  }

  private final Code code;

  public PermissionProviderException(Code code) {
    super("permission-provider:" + code);
    this.code = code;
  }

  public Code code() {
    return code;
  }
}
