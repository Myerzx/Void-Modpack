package dev.voidfall.forgebridge;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

public final class BuildCommandServiceTest {
  private static final Instant NOW = Instant.parse("2026-08-03T16:00:00Z");
  private static final UUID REQUEST = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63701");
  private static final UUID CORRELATION = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63702");
  private static final UUID PLAYER = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63703");
  private static final UUID SERVER = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63704");
  private static final String NONCE = "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn";

  private BuildCommandServiceTest() {}

  public static void main(String[] args) throws Exception {
    acceptsAndSignsOneAuthorizedRequest();
    deniesWhenAnyCapabilityIsMissing();
    rejectsPermissionExpiryAndReplay();
    System.out.println("Forge Bridge tests passed: 3");
  }

  private static BuildRequestIntent intent(String nonce) {
    return new BuildRequestIntent(
        1, REQUEST, CORRELATION, PLAYER, SERVER, nonce, NOW.minusSeconds(5), NOW.plusSeconds(55));
  }

  private static BridgeCapabilities enabledCapabilities() {
    return new BridgeCapabilities(Set.of(
        BuildCommandService.BUILD_CAPABILITY,
        BuildCommandService.CLIENT_GATE_CAPABILITY,
        BuildCommandService.DISTRIBUTION_GATE_CAPABILITY));
  }

  private static void acceptsAndSignsOneAuthorizedRequest() throws Exception {
    KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    Set<String> consumed = new HashSet<>();
    AtomicReference<SignedBuildRequest> submitted = new AtomicReference<>();
    BuildCommandService service = new BuildCommandService(
        (player, permission) -> player.equals(PLAYER) && permission.equals(BuildCommandService.PERMISSION),
        (nonce, expiresAt, now) -> consumed.add(nonce),
        submitted::set,
        new Ed25519BuildRequestSigner("forge-bridge-test-01", pair.getPrivate()),
        Clock.fixed(NOW, ZoneOffset.UTC));

    BuildCommandResult result = service.requestBuild(intent(NONCE), enabledCapabilities());
    assertEquals(BuildCommandResult.Status.ACCEPTED, result.status());
    SignedBuildRequest request = submitted.get();
    if (request == null) throw new AssertionError("Gateway did not receive the signed request.");
    Signature verifier = Signature.getInstance("Ed25519");
    verifier.initVerify(pair.getPublic());
    verifier.update(BuildCommandService.canonicalPayload(intent(NONCE)));
    if (!verifier.verify(Base64.getUrlDecoder().decode(request.signature()))) {
      throw new AssertionError("The Ed25519 signature is invalid.");
    }
    assertEquals("modpack.build.request", request.kind());
  }

  private static void deniesWhenAnyCapabilityIsMissing() throws Exception {
    KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    AtomicReference<SignedBuildRequest> submitted = new AtomicReference<>();
    BuildCommandService service = new BuildCommandService(
        (player, permission) -> true,
        (nonce, expiresAt, now) -> true,
        submitted::set,
        new Ed25519BuildRequestSigner("forge-bridge-test-01", pair.getPrivate()),
        Clock.fixed(NOW, ZoneOffset.UTC));
    BuildCommandResult result = service.requestBuild(
        intent(NONCE),
        new BridgeCapabilities(Set.of(BuildCommandService.BUILD_CAPABILITY)));
    assertEquals(BuildCommandResult.Status.DISABLED, result.status());
    if (submitted.get() != null) throw new AssertionError("Disabled command reached the gateway.");
  }

  private static void rejectsPermissionExpiryAndReplay() throws Exception {
    KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    Set<String> consumed = new HashSet<>();
    BuildCommandService denied = new BuildCommandService(
        (player, permission) -> false,
        (nonce, expiresAt, now) -> consumed.add(nonce),
        request -> { throw new AssertionError("Denied request reached the gateway."); },
        new Ed25519BuildRequestSigner("forge-bridge-test-01", pair.getPrivate()),
        Clock.fixed(NOW, ZoneOffset.UTC));
    assertEquals(
        BuildCommandResult.Status.DENIED,
        denied.requestBuild(intent(NONCE), enabledCapabilities()).status());

    BuildRequestIntent expired = new BuildRequestIntent(
        1, REQUEST, CORRELATION, PLAYER, SERVER, NONCE, NOW.minusSeconds(120), NOW.minusSeconds(1));
    assertEquals(
        BuildCommandResult.Status.INVALID,
        denied.requestBuild(expired, enabledCapabilities()).status());

    AtomicReference<SignedBuildRequest> submitted = new AtomicReference<>();
    BuildCommandService replay = new BuildCommandService(
        (player, permission) -> true,
        (nonce, expiresAt, now) -> consumed.add(nonce),
        submitted::set,
        new Ed25519BuildRequestSigner("forge-bridge-test-01", pair.getPrivate()),
        Clock.fixed(NOW, ZoneOffset.UTC));
    assertEquals(
        BuildCommandResult.Status.ACCEPTED,
        replay.requestBuild(intent("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), enabledCapabilities()).status());
    assertEquals(
        BuildCommandResult.Status.REPLAY,
        replay.requestBuild(intent("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), enabledCapabilities()).status());
  }

  private static void assertEquals(Object expected, Object actual) {
    if (!expected.equals(actual)) {
      throw new AssertionError("Expected " + expected + " but received " + actual + ".");
    }
  }
}
