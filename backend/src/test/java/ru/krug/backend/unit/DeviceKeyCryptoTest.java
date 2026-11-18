package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HexFormat;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.domain.service.DeviceKeyCrypto;

/**
 * Known-answer tests from {@code docs/E2EE-TEST-VECTORS.json}: the server-side public
 * checks must match the vectors byte-for-byte (domains, lengths, field order).
 */
class DeviceKeyCryptoTest {

    private static final HexFormat HEX = HexFormat.of();

    @Test
    void verifiesSpkSignatureVectorB3() {
        byte[] identitySigningKey =
                HEX.parseHex("8a549d51a052bfc392b184ea23f5da317eafaa54f6635658733d05e538dcddce");
        byte[] spkPublic =
                HEX.parseHex("080e29b891608b82b926c8bb49a18ed5d2bddbdc87c4a509e8ddaec5193b0e7a");
        byte[] signature = HEX.parseHex(
                "c23934f40bd2c801ef70420d41c9225aae28d49a33926f642f2c715151753eda"
                        + "15420992c4e8cf53cac863f49ad24c2077168fc25ea94c01aeb027fdd3f59d0f");
        assertThat(DeviceKeyCrypto.verifySignedPrekey(identitySigningKey, "spk-1", spkPublic,
                signature)).isTrue();

        byte[] tampered = signature.clone();
        tampered[0] ^= 0x01;
        assertThat(DeviceKeyCrypto.verifySignedPrekey(identitySigningKey, "spk-1", spkPublic,
                tampered)).isFalse();
        assertThat(DeviceKeyCrypto.verifySignedPrekey(identitySigningKey, "spk-2", spkPublic,
                signature)).isFalse();
    }

    @Test
    void verifiesIdentityBindingVectorsB5() {
        byte[] aliceSig =
                HEX.parseHex("763436fc7d751213e1a09f528f2d40d79800c1157b00bb1b096ca3193ed82e62");
        byte[] aliceDh =
                HEX.parseHex("9ff74850ae2ef0365738a9f4bd06eadfa38ac24a3a6a1f65fda931642145713e");
        byte[] aliceBinding = HEX.parseHex(
                "7c845f5d5c855a4efa5c8b9812a25f6a6605bc157bbeaa621ef1de19c0f682c5"
                        + "165c71f5e234be32933609e87b1def98cdb873bece57668d51a0e67c98724209");
        assertThat(DeviceKeyCrypto.verifyIdentityBinding(aliceSig, aliceDh, aliceBinding))
                .isTrue();

        byte[] bobSig =
                HEX.parseHex("8a549d51a052bfc392b184ea23f5da317eafaa54f6635658733d05e538dcddce");
        byte[] bobDh =
                HEX.parseHex("80d41ac0f5eb914c91e8a7a4abd44010703d982922fb40fd421c2e3a666ba404");
        byte[] bobBinding = HEX.parseHex(
                "6af4ea3aee3ab5d2bac87789383c349ba985b5780f4625d6b4d4994fe00c0a55"
                        + "9eadfa346d6c2b15b8760d2df9b9e57aff3eb5862c7b2cf71b8e7e2d98a49d05");
        assertThat(DeviceKeyCrypto.verifyIdentityBinding(bobSig, bobDh, bobBinding)).isTrue();
        assertThat(DeviceKeyCrypto.verifyIdentityBinding(bobSig, aliceDh, bobBinding))
                .isFalse();
    }

    @Test
    void computesFingerprintVectorsG1() {
        byte[] aliceSig =
                HEX.parseHex("763436fc7d751213e1a09f528f2d40d79800c1157b00bb1b096ca3193ed82e62");
        byte[] aliceDh =
                HEX.parseHex("9ff74850ae2ef0365738a9f4bd06eadfa38ac24a3a6a1f65fda931642145713e");
        assertThat(HEX.formatHex(DeviceKeyCrypto.fingerprint(aliceSig, aliceDh)))
                .isEqualTo("271774bc3354744005136603dd073b25fee8c6c013d431ee47198f39f0042071");

        byte[] bobSig =
                HEX.parseHex("8a549d51a052bfc392b184ea23f5da317eafaa54f6635658733d05e538dcddce");
        byte[] bobDh =
                HEX.parseHex("80d41ac0f5eb914c91e8a7a4abd44010703d982922fb40fd421c2e3a666ba404");
        assertThat(HEX.formatHex(DeviceKeyCrypto.fingerprint(bobSig, bobDh)))
                .isEqualTo("42a869331f9baacb3929fc44f4e8343d97296f0cf3d10bdae697ab8fa1b59668");
    }
}
