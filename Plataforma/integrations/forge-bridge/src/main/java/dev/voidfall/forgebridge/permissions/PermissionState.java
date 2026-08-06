package dev.voidfall.forgebridge.permissions;

import java.util.Collections;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * What the provider holds for one account, as read.
 *
 * Sorted and copied on construction, so two reads of the same state compare
 * equal regardless of the order the provider returned them. The rebind
 * verification depends on that equality being meaningful.
 */
public record PermissionState(Set<String> groups, Map<String, Boolean> nodes) {
  public PermissionState {
    Objects.requireNonNull(groups, "groups");
    Objects.requireNonNull(nodes, "nodes");
    groups = Collections.unmodifiableSet(new TreeSet<>(groups));
    nodes = Collections.unmodifiableMap(new TreeMap<>(nodes));
  }

  public static PermissionState empty() {
    return new PermissionState(Set.of(), Map.of());
  }
}
