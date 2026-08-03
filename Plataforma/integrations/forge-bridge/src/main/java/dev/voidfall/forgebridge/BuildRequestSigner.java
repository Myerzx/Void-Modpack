package dev.voidfall.forgebridge;

public interface BuildRequestSigner {
  String keyId();

  String sign(byte[] payload);
}
