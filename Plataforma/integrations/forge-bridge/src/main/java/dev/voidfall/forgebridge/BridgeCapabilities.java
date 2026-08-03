package dev.voidfall.forgebridge;

import java.util.Set;

public record BridgeCapabilities(Set<String> values) {
  public BridgeCapabilities {
    values = Set.copyOf(values);
  }

  public boolean permitsBuildRequest() {
    return values.contains(BuildCommandService.BUILD_CAPABILITY)
        && values.contains(BuildCommandService.CLIENT_GATE_CAPABILITY)
        && values.contains(BuildCommandService.DISTRIBUTION_GATE_CAPABILITY);
  }
}
