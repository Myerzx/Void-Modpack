package dev.voidfall.forgebridge.permissions;

import dev.voidfall.forgebridge.permissions.PermissionOperationResult.FailureCode;
import dev.voidfall.forgebridge.permissions.PermissionOperationResult.Outcome;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * The permission capability, exercised against a scripted provider.
 *
 * No Minecraft server and no LuckPerms are involved: both are interfaces, which
 * is what lets the refusals below be arranged at all. What is under test is
 * mostly what the service declines to do.
 */
public final class PermissionCommandServiceTest {

  private static final UUID SERVER = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63700");
  private static final UUID IDENTITY = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63701");
  private static final UUID CLAIM = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63702");
  private static final UUID ACCOUNT = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63703");
  private static final UUID NEW_CLAIM = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63704");
  private static final UUID NEW_ACCOUNT = UUID.fromString("018f6b8c-76a3-7d10-9f2e-1d9e52a63705");
  private static final Instant NOW = Instant.parse("2026-08-06T12:00:00Z");

  /** A provider that holds state in memory and can be told to fail. */
  static final class ScriptedProvider implements PermissionProvider {
    final Map<UUID, Set<String>> groups = new HashMap<>();
    final Map<UUID, Map<String, Boolean>> nodes = new HashMap<>();
    PermissionProviderException.Code failWith;
    /** Drops writes silently, to arrange an unverifiable rebind. */
    boolean swallowWrites;

    @Override
    public String providerId() {
      return "luckperms";
    }

    @Override
    public Optional<String> providerVersion() {
      return Optional.of("5-4-102");
    }

    private void guard() {
      if (failWith != null) throw new PermissionProviderException(failWith);
    }

    @Override
    public PermissionState read(UUID account) {
      guard();
      return new PermissionState(
          groups.getOrDefault(account, Set.of()), nodes.getOrDefault(account, Map.of()));
    }

    @Override
    public void addGroup(UUID account, String group) {
      guard();
      if (swallowWrites) return;
      groups.computeIfAbsent(account, key -> new HashSet<>()).add(group);
    }

    @Override
    public void removeGroup(UUID account, String group) {
      guard();
      if (swallowWrites) return;
      groups.computeIfAbsent(account, key -> new HashSet<>()).remove(group);
    }

    @Override
    public void setNode(UUID account, String node, boolean value) {
      guard();
      if (swallowWrites) return;
      nodes.computeIfAbsent(account, key -> new LinkedHashMap<>()).put(node, value);
    }

    @Override
    public void unsetNode(UUID account, String node) {
      guard();
      if (swallowWrites) return;
      nodes.computeIfAbsent(account, key -> new LinkedHashMap<>()).remove(node);
    }

    @Override
    public void clearAll(UUID account) {
      guard();
      groups.remove(account);
      nodes.remove(account);
    }
  }

  static final class ScriptedClaims implements ClaimResolver {
    final Map<UUID, ResolvedClaim> active = new HashMap<>();
    final Map<UUID, Map<UUID, ResolvedClaim>> byIdentity = new HashMap<>();

    @Override
    public Optional<ResolvedClaim> resolveActiveClaim(UUID identityId) {
      return Optional.ofNullable(active.get(identityId));
    }

    @Override
    public Optional<ResolvedClaim> resolveClaim(UUID identityId, UUID claimId) {
      return Optional.ofNullable(byIdentity.getOrDefault(identityId, Map.of()).get(claimId));
    }
  }

  private static PermissionOperation.Envelope envelope(UUID operationId) {
    return envelope(operationId, SERVER, CLAIM);
  }

  private static PermissionOperation.Envelope envelope(
      UUID operationId, UUID server, UUID expectedClaim) {
    return new PermissionOperation.Envelope(
        operationId,
        server,
        IDENTITY,
        expectedClaim,
        "promocao-para-moderador",
        NOW,
        NOW.plusSeconds(60));
  }

  private static void assertThat(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    appliesAGroupAndReportsWhatWasReadBack();
    reportsNoChangeWhenTheProviderAlreadyHeldIt();
    refusesWhenTheClaimMovedSinceTheDecision();
    refusesAnIdentityWithNoClaim();
    refusesAnotherServersOperation();
    refusesAnExpiredOperation();
    refusesWhileTheCapabilityIsUnavailable();
    replayFindsTheOriginalOutcome();
    translatesProviderFailuresWithoutInventingSuccess();
    rebindCopiesVerifiesAndOnlyThenClears();
    rebindLeavesTheOldAccountIntactWhenItCannotVerify();
    rebindRefusesAClaimThatIsNotThisIdentitys();
    readReportsAbsenceRatherThanAnEmptyState();
    verifierDeniesUntilLoginCompletes();
    readinessNamesTheFirstMissingDependency();
    System.out.println("PermissionCommandServiceTest passed");
  }

  private static PermissionCommandService service(
      ScriptedClaims claims, ScriptedProvider provider, PermissionCapabilityState state) {
    return new PermissionCommandService(
        claims, provider, SERVER, () -> state, Clock.fixed(NOW, ZoneOffset.UTC));
  }

  private static PermissionCapabilityState ready() {
    return new PermissionCapabilityState(true, true, true, true);
  }

  private static ScriptedClaims claimsWithActive() {
    ScriptedClaims claims = new ScriptedClaims();
    claims.active.put(IDENTITY, new ResolvedClaim(CLAIM, ACCOUNT));
    claims.byIdentity.put(
        IDENTITY,
        new HashMap<>(
            Map.of(CLAIM, new ResolvedClaim(CLAIM, ACCOUNT),
                NEW_CLAIM, new ResolvedClaim(NEW_CLAIM, NEW_ACCOUNT))));
    return claims;
  }

  static void appliesAGroupAndReportsWhatWasReadBack() {
    ScriptedProvider provider = new ScriptedProvider();
    PermissionCommandService service = service(claimsWithActive(), provider, ready());

    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.GroupMembership(
                envelope(UUID.randomUUID()), PermissionOperation.GroupChange.ADD, "moderator"));

    assertThat(result.outcome() == Outcome.APPLIED, "the group should have been added");
    // The receipt carries the state the provider held afterwards, not the intent.
    PermissionSnapshot snapshot = result.snapshot().orElseThrow();
    assertThat(snapshot.state().groups().contains("moderator"), "snapshot should show the group");
    assertThat(snapshot.minecraftUuid().equals(ACCOUNT), "snapshot names the resolved account");
    assertThat(snapshot.providerId().equals("luckperms"), "snapshot names its origin");
    assertThat(snapshot.observedAt().equals(NOW), "snapshot names when it was read");
  }

  static void reportsNoChangeWhenTheProviderAlreadyHeldIt() {
    ScriptedProvider provider = new ScriptedProvider();
    provider.groups.put(ACCOUNT, new HashSet<>(Set.of("moderator")));
    PermissionCommandService service = service(claimsWithActive(), provider, ready());

    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.GroupMembership(
                envelope(UUID.randomUUID()), PermissionOperation.GroupChange.ADD, "moderator"));

    // Distinguished from applied: "nothing to do" is not the same event as "done".
    assertThat(result.outcome() == Outcome.NO_CHANGE, "should report no change");
    assertThat(result.snapshot().isPresent(), "no-change still reads the provider back");
  }

  static void refusesWhenTheClaimMovedSinceTheDecision() {
    ScriptedClaims claims = claimsWithActive();
    // Somebody else holds the account now.
    claims.active.put(IDENTITY, new ResolvedClaim(NEW_CLAIM, NEW_ACCOUNT));
    ScriptedProvider provider = new ScriptedProvider();
    PermissionCommandService service = service(claims, provider, ready());

    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.GroupMembership(
                envelope(UUID.randomUUID()), PermissionOperation.GroupChange.ADD, "moderator"));

    assertThat(result.outcome() == Outcome.FAILED, "a moved claim must not be applied");
    assertThat(
        result.failureCode().orElseThrow() == FailureCode.CLAIM_MISMATCH, "should name the mismatch");
    // And nothing was written to either account.
    assertThat(provider.groups.isEmpty(), "no account should have been touched");
  }

  static void refusesAnIdentityWithNoClaim() {
    PermissionCommandService service = service(new ScriptedClaims(), new ScriptedProvider(), ready());
    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.NodeSet(envelope(UUID.randomUUID()), "voidfall.build", true));
    assertThat(
        result.failureCode().orElseThrow() == FailureCode.IDENTITY_NOT_CLAIMED,
        "an unclaimed identity has nobody to act on");
  }

  static void refusesAnotherServersOperation() {
    PermissionCommandService service = service(claimsWithActive(), new ScriptedProvider(), ready());
    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.NodeUnset(
                envelope(UUID.randomUUID(), UUID.randomUUID(), CLAIM), "voidfall.build"));
    assertThat(
        result.failureCode().orElseThrow() == FailureCode.SERVER_MISMATCH,
        "one instance's operation is not another's");
  }

  static void refusesAnExpiredOperation() {
    ScriptedProvider provider = new ScriptedProvider();
    PermissionCommandService service =
        new PermissionCommandService(
            claimsWithActive(),
            provider,
            SERVER,
            PermissionCommandServiceTest::ready,
            Clock.fixed(NOW.plusSeconds(3_600), ZoneOffset.UTC));

    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.GroupMembership(
                envelope(UUID.randomUUID()), PermissionOperation.GroupChange.ADD, "moderator"));

    assertThat(
        result.failureCode().orElseThrow() == FailureCode.OPERATION_EXPIRED,
        "an hour-old decision must not be applied now");
    assertThat(provider.groups.isEmpty(), "nothing should have been written");
  }

  static void refusesWhileTheCapabilityIsUnavailable() {
    ScriptedProvider provider = new ScriptedProvider();
    // A foreign permission handler took over. Acting anyway would write through
    // a path nobody reviewed.
    PermissionCommandService service =
        service(claimsWithActive(), provider, new PermissionCapabilityState(true, true, false, true));

    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.GroupMembership(
                envelope(UUID.randomUUID()), PermissionOperation.GroupChange.ADD, "moderator"));

    assertThat(
        result.failureCode().orElseThrow() == FailureCode.CAPABILITY_UNAVAILABLE,
        "an unavailable capability refuses");
    assertThat(provider.groups.isEmpty(), "nothing should have been written");
  }

  static void replayFindsTheOriginalOutcome() {
    ScriptedProvider provider = new ScriptedProvider();
    PermissionCommandService service = service(claimsWithActive(), provider, ready());
    UUID operationId = UUID.randomUUID();
    PermissionOperation operation =
        new PermissionOperation.GroupMembership(
            envelope(operationId), PermissionOperation.GroupChange.ADD, "moderator");

    PermissionOperationResult first = service.apply(operation);
    PermissionOperationResult second = service.apply(operation);

    assertThat(first.outcome() == Outcome.APPLIED, "the first call applies");
    // Not re-evaluated into NO_CHANGE: a replay reports what happened the first
    // time, so a caller retrying after a lost response sees one consistent story.
    assertThat(second.outcome() == Outcome.APPLIED, "a replay returns the original outcome");
    assertThat(second == first, "a replay returns the original result object");
  }

  static void translatesProviderFailuresWithoutInventingSuccess() {
    ScriptedProvider provider = new ScriptedProvider();
    provider.failWith = PermissionProviderException.Code.UNAVAILABLE;
    PermissionCommandService service = service(claimsWithActive(), provider, ready());

    PermissionOperationResult result =
        service.apply(
            new PermissionOperation.GroupMembership(
                envelope(UUID.randomUUID()), PermissionOperation.GroupChange.ADD, "moderator"));

    assertThat(
        result.failureCode().orElseThrow() == FailureCode.PROVIDER_UNAVAILABLE,
        "an unreachable provider is reported, not guessed around");
    assertThat(result.snapshot().isEmpty(), "there is nothing to show when nothing could be read");
  }

  static void rebindCopiesVerifiesAndOnlyThenClears() {
    ScriptedProvider provider = new ScriptedProvider();
    provider.groups.put(ACCOUNT, new HashSet<>(Set.of("moderator", "builder")));
    provider.nodes.put(ACCOUNT, new LinkedHashMap<>(Map.of("voidfall.build", true)));
    PermissionCommandService service = service(claimsWithActive(), provider, ready());

    PermissionOperationResult result =
        service.apply(new PermissionOperation.Rebind(envelope(UUID.randomUUID()), NEW_CLAIM));

    assertThat(result.outcome() == Outcome.APPLIED, "the rebind should apply");
    assertThat(
        provider.groups.getOrDefault(NEW_ACCOUNT, Set.of()).containsAll(Set.of("moderator", "builder")),
        "groups should have moved");
    assertThat(
        Boolean.TRUE.equals(provider.nodes.getOrDefault(NEW_ACCOUNT, Map.of()).get("voidfall.build")),
        "nodes should have moved");
    // Cleared last, and only after the copy was verified.
    assertThat(!provider.groups.containsKey(ACCOUNT), "the old account should hold nothing");
    assertThat(result.snapshot().orElseThrow().minecraftUuid().equals(NEW_ACCOUNT),
        "the snapshot should describe the new account");
  }

  static void rebindLeavesTheOldAccountIntactWhenItCannotVerify() {
    ScriptedProvider provider = new ScriptedProvider();
    provider.groups.put(ACCOUNT, new HashSet<>(Set.of("moderator")));
    provider.swallowWrites = true;
    PermissionCommandService service = service(claimsWithActive(), provider, ready());

    PermissionOperationResult result =
        service.apply(new PermissionOperation.Rebind(envelope(UUID.randomUUID()), NEW_CLAIM));

    assertThat(
        result.failureCode().orElseThrow() == FailureCode.REBIND_NOT_VERIFIED,
        "an unverified copy must not be called a rebind");
    // The whole point of the ordering: an interruption leaves the previous
    // account authoritative rather than stranding the identity with nothing.
    assertThat(
        provider.groups.getOrDefault(ACCOUNT, Set.of()).contains("moderator"),
        "the old account must keep its permissions");
  }

  static void rebindRefusesAClaimThatIsNotThisIdentitys() {
    ScriptedClaims claims = claimsWithActive();
    // The destination claim belongs to somebody else.
    claims.byIdentity.get(IDENTITY).remove(NEW_CLAIM);
    ScriptedProvider provider = new ScriptedProvider();
    provider.groups.put(ACCOUNT, new HashSet<>(Set.of("moderator")));
    PermissionCommandService service = service(claims, provider, ready());

    PermissionOperationResult result =
        service.apply(new PermissionOperation.Rebind(envelope(UUID.randomUUID()), NEW_CLAIM));

    assertThat(result.outcome() == Outcome.FAILED, "a foreign claim is not a destination");
    assertThat(
        provider.groups.getOrDefault(ACCOUNT, Set.of()).contains("moderator"),
        "nothing should have moved");
    assertThat(!provider.groups.containsKey(NEW_ACCOUNT), "the other account is untouched");
  }

  static void readReportsAbsenceRatherThanAnEmptyState() {
    ScriptedProvider provider = new ScriptedProvider();
    provider.failWith = PermissionProviderException.Code.UNAVAILABLE;
    PermissionCommandService service = service(claimsWithActive(), provider, ready());
    // "No groups" and "could not ask" are different facts, and only one of them
    // means the player has no groups.
    assertThat(service.read(IDENTITY).isEmpty(), "an unreadable provider yields no snapshot");
  }

  static void verifierDeniesUntilLoginCompletes() {
    Set<UUID> loggedIn = new HashSet<>();
    AuthenticatedPermissionVerifier verifier =
        new AuthenticatedPermissionVerifier(loggedIn::contains, (uuid, permission) -> true);

    assertThat(!verifier.hasPermission(ACCOUNT, "voidfall.build"), "pre-login must deny");
    loggedIn.add(ACCOUNT);
    assertThat(verifier.hasPermission(ACCOUNT, "voidfall.build"), "after login it may answer");
    assertThat(!verifier.hasPermission(null, "voidfall.build"), "no player, no permission");
  }

  static void readinessNamesTheFirstMissingDependency() {
    assertThat(
        new PermissionCapabilityState(false, true, true, true).unavailableReason().orElseThrow()
            == PermissionCapabilityState.UnavailableReason.BRIDGE_NOT_READY,
        "a missing bridge is named");
    assertThat(
        new PermissionCapabilityState(true, false, true, true).unavailableReason().orElseThrow()
            == PermissionCapabilityState.UnavailableReason.PROVIDER_UNAVAILABLE,
        "a missing provider is named");
    // Ordered before authentication: a foreign handler is a host
    // misconfiguration, and naming authentication would send the operator to
    // fix the wrong thing.
    assertThat(
        new PermissionCapabilityState(true, true, false, false).unavailableReason().orElseThrow()
            == PermissionCapabilityState.UnavailableReason.UNEXPECTED_PERMISSION_HANDLER,
        "a foreign handler outranks authentication");
    assertThat(new PermissionCapabilityState(true, true, true, true).available(), "all ready");
  }
}
