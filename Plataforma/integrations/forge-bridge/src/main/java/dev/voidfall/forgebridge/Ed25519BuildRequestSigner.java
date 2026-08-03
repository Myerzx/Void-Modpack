package dev.voidfall.forgebridge;

import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Base64;
import java.util.Objects;

public final class Ed25519BuildRequestSigner implements BuildRequestSigner {
  private final String keyId;
  private final PrivateKey privateKey;

  public Ed25519BuildRequestSigner(String keyId, PrivateKey privateKey) {
    if (keyId == null || !keyId.matches("^[a-z0-9]+(?:-[a-z0-9]+)*$")) {
      throw new IllegalArgumentException("Invalid key ID.");
    }
    this.keyId = keyId;
    this.privateKey = Objects.requireNonNull(privateKey, "privateKey");
    if (!"EdDSA".equals(privateKey.getAlgorithm())) {
      throw new IllegalArgumentException("An Ed25519 private key is required.");
    }
  }

  @Override
  public String keyId() {
    return keyId;
  }

  @Override
  public String sign(byte[] payload) {
    try {
      Signature signer = Signature.getInstance("Ed25519");
      signer.initSign(privateKey);
      signer.update(payload);
      return Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign());
    } catch (GeneralSecurityException error) {
      throw new IllegalStateException("The build request could not be signed.", error);
    }
  }
}
