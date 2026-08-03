package dev.voidfall.forgebridge;

@FunctionalInterface
public interface AgentGateway {
  void submit(SignedBuildRequest request);
}
