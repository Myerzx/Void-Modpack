package dev.voidfall.forgebridge;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

public final class BuildCommandService {
  public static final String COMMAND_LITERAL = "/atualizar-modpack";
  public static final String PERMISSION = "modpack.build.request";
  public static final String BUILD_CAPABILITY = "modpack-build-request";
  public static final String CLIENT_GATE_CAPABILITY = "client-base-approved";
  public static final String DISTRIBUTION_GATE_CAPABILITY = "distribution-chain-approved";
  public static final int PROTOCOL_VERSION = 1;

  private static final Duration MAXIMUM_LIFETIME = Duration.ofMinutes(2);
  private static final Duration MAXIMUM_FUTURE_SKEW = Duration.ofSeconds(30);

  private final PermissionVerifier permissions;
  private final NonceStore nonces;
  private final AgentGateway gateway;
  private final BuildRequestSigner signer;
  private final Clock clock;

  public BuildCommandService(
      PermissionVerifier permissions,
      NonceStore nonces,
      AgentGateway gateway,
      BuildRequestSigner signer,
      Clock clock) {
    this.permissions = Objects.requireNonNull(permissions, "permissions");
    this.nonces = Objects.requireNonNull(nonces, "nonces");
    this.gateway = Objects.requireNonNull(gateway, "gateway");
    this.signer = Objects.requireNonNull(signer, "signer");
    this.clock = Objects.requireNonNull(clock, "clock");
  }

  public BuildCommandResult requestBuild(
      BuildRequestIntent intent, BridgeCapabilities capabilities) {
    Objects.requireNonNull(intent, "intent");
    Objects.requireNonNull(capabilities, "capabilities");
    Instant now = clock.instant();

    if (!capabilities.permitsBuildRequest()) {
      return result(BuildCommandResult.Status.DISABLED, intent, "Atualização indisponível.");
    }
    if (!validIntent(intent, now)) {
      return result(BuildCommandResult.Status.INVALID, intent, "Solicitação inválida.");
    }
    if (!permissions.hasPermission(intent.playerUuid(), PERMISSION)) {
      return result(BuildCommandResult.Status.DENIED, intent, "Permissão insuficiente.");
    }
    if (!nonces.consume(intent.nonce(), intent.expiresAt(), now)) {
      return result(BuildCommandResult.Status.REPLAY, intent, "Solicitação já utilizada.");
    }

    byte[] payload = canonicalPayload(intent);
    SignedBuildRequest request = new SignedBuildRequest(
        1,
        intent.protocolVersion(),
        "modpack.build.request",
        intent.requestId(),
        intent.correlationId(),
        intent.playerUuid(),
        intent.serverInstanceId(),
        PERMISSION,
        intent.nonce(),
        intent.issuedAt(),
        intent.expiresAt(),
        signer.keyId(),
        signer.sign(payload));
    gateway.submit(request);
    return result(BuildCommandResult.Status.ACCEPTED, intent, "Candidato solicitado.");
  }

  private static boolean validIntent(BuildRequestIntent intent, Instant now) {
    if (intent.protocolVersion() != PROTOCOL_VERSION) return false;
    if (!intent.nonce().matches("^[A-Za-z0-9_-]{43,256}$")) return false;
    if (!intent.expiresAt().isAfter(intent.issuedAt())) return false;
    Duration lifetime = Duration.between(intent.issuedAt(), intent.expiresAt());
    if (lifetime.compareTo(MAXIMUM_LIFETIME) > 0) return false;
    if (intent.issuedAt().isAfter(now.plus(MAXIMUM_FUTURE_SKEW))) return false;
    return intent.expiresAt().isAfter(now);
  }

  public static byte[] canonicalPayload(BuildRequestIntent intent) {
    String json = "{"
        + "\"correlationId\":\"" + intent.correlationId() + "\","
        + "\"expiresAt\":\"" + intent.expiresAt() + "\","
        + "\"issuedAt\":\"" + intent.issuedAt() + "\","
        + "\"kind\":\"modpack.build.request\","
        + "\"nonce\":\"" + intent.nonce() + "\","
        + "\"permission\":\"" + PERMISSION + "\","
        + "\"playerUuid\":\"" + intent.playerUuid() + "\","
        + "\"protocolVersion\":" + intent.protocolVersion() + ","
        + "\"requestId\":\"" + intent.requestId() + "\","
        + "\"schemaVersion\":1,"
        + "\"serverInstanceId\":\"" + intent.serverInstanceId() + "\""
        + "}";
    return json.getBytes(StandardCharsets.UTF_8);
  }

  private static BuildCommandResult result(
      BuildCommandResult.Status status, BuildRequestIntent intent, String message) {
    return new BuildCommandResult(status, intent.correlationId(), message);
  }
}
