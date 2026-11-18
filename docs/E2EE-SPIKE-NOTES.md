# E2EE crypto spike — рабочие заметки (E7-S)

> **Статус:** DONE (spike), **редакция S2** (remediation по [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>)). Нормативная часть — [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>); векторы — [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) (`vector_set_version=2`: 34 вектора, 13 секций, 189 проверок).
> **Зона:** изменены только `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, `docs/E2EE-SPIKE-NOTES.md`; создан `docs/E2EE-S2-CHANGELOG.md`. `backend/**`, `frontend/**`, `contracts/**`, `design/**`, существующие `docs/TASKS*.md` не изменялись.
> **Production-код не запускался.** Все вычисления — в `/tmp` на Python/Node.
> **Актуальный генератор/верификатор — §9.** §2–§3 сохранены как историческая редакция v1; запускать их для текущих векторов нельзя (G4/VH v2 не совпадёт).

## 1. Что прочитано и что обнаружено

| Источник | Что взято | Факт |
|---|---|---|
| `docs/TASKS-E7.md` | scope, AC, риски | E7-S — сначала спека/векторы, код после review; 3–5 дней spike, 3–4 недели реализация |
| `docs/SYSTEM-ANALYSIS.md` §11 | границы, угрозы, non-goals | X3DH+DR, AES-256-GCM, HKDF-SHA-256, Ed25519; ≤5 устройств; safety number hash |
| §6.8 | ключи/устройства | «до 5», SPK 30 дней, OPK <20 replenish, новое устройство без истории |
| §7.2 API-04..08, 26, 34, 35, 37 | wire | `POST /devices` без ключей; `POST /keys/claim` без `chat_id`; `GET /chats/{id}/keys`; `PUT verification`; `envelopes[]` |
| §6.4 | DDL | `auth.devices.identity_public_key`, `auth.device_prekeys`, `message.message_envelopes`, `message.message_payloads` |
| §8.2 | sequence | claim → X3DH/DR → POST envelopes → WS → receipt; размер ≤256 КБ |
| §9.6 | state machine | PENDING/ACTIVE/REVOKED; prekey consumed/expired; `key_generation++` |
| ADR-04/05/06 | решения | свой X3DH+DR; sender keys с эпохами; ≤5 устройств, конверт на устройство |
| `docs/CONCEPT.md` §8 | контекст | Ed25519 identity; X3DH; DR; safety numbers; non-goals |
| `contracts/openapi.yaml` | текущий контракт | `DeviceRegistration` = name/platform/app_version; `Device` = id/platform/created_at; `MessageCreate` = text/sticker/attachments; `Message` без `crypto`/`client_message_id`; `/devices` только POST; нет `/keys/claim`, `/chats/{id}/keys`, `/keys/verification`, `/workspaces/{id}/chats` |
| `contracts/ws-protocol.md` | WS v1 | `message.created` — managed text; §8 прямо говорит «E2EE envelopes/payload — отдельный срез» |
| `backend/src/.../DeviceRegistrationService.java` | факт | `MAX_ACTIVE_DEVICES=5`; natural key `(user_id,name,platform,app_version)`; ключей нет |
| `backend/.../V2__identity_and_workspace.sql` | факт | `identity_public_key bytea` nullable, `key_generation` default 1; закомментировано «E2EE keys out of scope for B-01» |
| `backend/.../ErrorCode.java` | факт | нет `KEY_CHANGED`, `UNKNOWN_DEVICE`, `NO_PREKEYS`, `E2EE_*`; есть `MODE_NOT_SUPPORTED`, `DEVICE_LIMIT_REACHED` |
| `frontend/src/auth`, `api`, `mocks` | факт | device id хранится после регистрации; crypto-модуля нет; `registerDevice` отправляет только name/platform/app_version |
| `backend/.../chat`, `workspace` | факт | `security_mode` E2EE уже существует на workspace/chat; E2EE-сообщений нет |

**Вывод:** инфраструктура (устройства, лимит 5, `security_mode`, WS, outbox, идемпотентность) уже есть, но E2EE-слой отсутствует полностью: нет ключей, prekeys, claim, envelopes, verification, crypto в контракте и на клиенте.

## 2. Генератор векторов (полный исходник)

Сохранить как `gen_e2ee_vectors.py` в корне репозитория (или рядом с `docs/`) и запустить `python3 gen_e2ee_vectors.py` — перезапишет `docs/E2EE-TEST-VECTORS.json`. Требуется Python 3.11+ и `cryptography` (проверено на 49.0.0).

```python
import base64, hashlib, hmac, json, struct, uuid
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# ---------- helpers ----------
def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()

def hkdf(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)

Z32 = b"\x00" * 32
F = b"\xff" * 32

def u8(v): return struct.pack(">B", v)
def u16(v): return struct.pack(">H", v)
def u32(v): return struct.pack(">I", v)
def u64(v): return struct.pack(">Q", v)

def lp16(b: bytes) -> bytes:
    return u16(len(b)) + b

def uuidb(s: str) -> bytes:
    return uuid.UUID(s).bytes

# X25519
def xpub(seed: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)

def dh(priv: bytes, pub: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(priv).exchange(
        X25519PublicKey.from_public_bytes(pub))

# Ed25519
def edpub(seed: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)

def edsign(seed: bytes, msg: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).sign(msg)

def edverify(pub: bytes, msg: bytes, sig: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg)
        return True
    except Exception:
        return False

# ---------- domains ----------
D_X3DH   = b"Krug/E2EE/v1/x3dh"
D_SID    = b"Krug/E2EE/v1/session-id"
D_RK     = b"Krug/E2EE/v1/dr-root"
D_AEADK  = b"Krug/E2EE/v1/aead-key"
D_AEADN  = b"Krug/E2EE/v1/aead-nonce"
D_AD     = b"Krug/E2EE/v1/ad"
D_PRE    = b"Krug/E2EE/v1/prekey"
D_PRESIG = b"Krug/E2EE/v1/prekey-signature"
D_SPKSIG = b"Krug/E2EE/v1/spk-signature"
D_FP     = b"Krug/E2EE/v1/fingerprint"
D_SN     = b"Krug/E2EE/v1/safety-number"
D_VER    = b"Krug/E2EE/v1/verification"
D_PAY    = b"Krug/E2EE/v1/payload"

def kdf_rk(rk: bytes, dh_out: bytes):
    okm = hkdf(dh_out, rk, D_RK, 64)
    return okm[:32], okm[32:]

def kdf_ck(ck: bytes):
    return hmac.new(ck, b"\x01", hashlib.sha256).digest(), hmac.new(ck, b"\x02", hashlib.sha256).digest()

def aead_params(mk: bytes):
    return hkdf(mk, Z32, D_AEADK, 32), hkdf(mk, Z32, D_AEADN, 12)

def header_bytes(h):
    return u8(1) + u8(0) + u32(h["pn"]) + u32(h["n"]) + h["dh"]

def ad_bytes(*, chat_id, sender_device_id, sender_kg, recipient_device_id, recipient_kg,
             session_id, preamble_hash, header, prekey: bool):
    return (D_AD + u8(1) + u8(1 if prekey else 0) + chat_id + sender_device_id +
            u32(sender_kg) + recipient_device_id + u32(recipient_kg) + session_id +
            preamble_hash + header_bytes(header))

def pad_plaintext(body: bytes) -> bytes:
    raw = D_PAY + u8(1) + u8(1) + u32(len(body)) + body
    pad = (-len(raw)) % 256
    return raw + b"\x00" * pad

def x3dh(ik_a_dh_priv, ek_a_priv, ik_b_dh_pub, spk_b_pub, opk_b_pub=None):
    dh1 = dh(ik_a_dh_priv, spk_b_pub)
    dh2 = dh(ek_a_priv, ik_b_dh_pub)
    dh3 = dh(ek_a_priv, spk_b_pub)
    parts = [dh1, dh2, dh3]
    if opk_b_pub is not None:
        parts.append(dh(ek_a_priv, opk_b_pub))
    ikm = F + b"".join(parts)
    sk = hkdf(ikm, Z32, D_X3DH, 32)
    sid = hkdf(sk, Z32, D_SID, 16)
    return {"dh1": dh1, "dh2": dh2, "dh3": dh3,
            "dh4": parts[3] if len(parts) == 4 else None,
            "ikm": ikm, "sk": sk, "session_id": sid}

def preamble(*, chat_id, sender_device_id, recipient_device_id, ik_sig_pub, ik_dh_pub, ek_pub,
             recipient_ik_dh_pub, recipient_ik_sig_pub, spk_id, spk_pub, opk_id, opk_pub, session_id) -> bytes:
    out = D_PRE + u8(1) + chat_id + sender_device_id + recipient_device_id
    out += ik_sig_pub + ik_dh_pub + ek_pub + recipient_ik_dh_pub + recipient_ik_sig_pub
    out += lp16(spk_id.encode()) + spk_pub
    if opk_pub is None:
        out += u8(0) + lp16(b"") + b"\x00" * 32
    else:
        out += u8(1) + lp16(opk_id.encode()) + opk_pub
    out += session_id
    return out

def fingerprint(ik_sig_pub, ik_dh_pub):
    return sha256(D_FP + ik_sig_pub + ik_dh_pub)

def safety_number(pairs):
    # pairs: list of (user_id_bytes, device_id_bytes, fingerprint_bytes), exactly two for 1:1 pair
    entries = sorted((u + d + f for (u, d, f) in pairs))
    data = D_SN + u8(1) + u32(len(entries)) + b"".join(entries)
    digest = hashlib.sha512(data).digest()
    digits = str(int.from_bytes(digest, "big") % (10 ** 60)).zfill(60)
    return digest, digits, " ".join(digits[i:i+5] for i in range(0, 60, 5))

def verification_hash(chat_id, verifier_user_id, target_device_id, target_kg, digits):
    return sha256(D_VER + u8(1) + chat_id + verifier_user_id + target_device_id +
                  u32(target_kg) + digits.encode())

def spk_signed_message(key_id: str, spk_pub: bytes) -> bytes:
    return D_SPKSIG + u8(1) + lp16(key_id.encode()) + spk_pub

def prekey_sig_message(p: bytes) -> bytes:
    return D_PRESIG + p

def fp_hex(f): return f.hex()

# ---------- identities ----------
def seed(label: str) -> bytes:
    return sha256(("krug-e2ee-vector-v1:" + label).encode())

ALICE_USER = uuidb("00000000-0000-4000-8000-000000000001")
ALICE_DEV  = uuidb("00000000-0000-4000-8000-000000000011")
BOB_USER   = uuidb("00000000-0000-4000-8000-000000000002")
BOB_DEV    = uuidb("00000000-0000-4000-8000-000000000021")
CHAT       = uuidb("00000000-0000-4000-8000-000000000100")
ALICE_USER_S = str(uuid.UUID(bytes=ALICE_USER))
ALICE_DEV_S  = str(uuid.UUID(bytes=ALICE_DEV))
BOB_USER_S   = str(uuid.UUID(bytes=BOB_USER))
BOB_DEV_S    = str(uuid.UUID(bytes=BOB_DEV))
CHAT_S       = str(uuid.UUID(bytes=CHAT))

S = {k: seed(k) for k in [
    "alice-ik-sig","alice-ik-dh","alice-ek","alice-ratchet-0","alice-ratchet-1",
    "bob-ik-sig","bob-ik-dh","bob-spk","bob-opk","bob-ratchet-1","bob-ratchet-2",
    "sender-key-alice",
]}
PUB = {k: xpub(v) for k, v in S.items()}
EDPUB = {"alice-ik-sig": edpub(S["alice-ik-sig"]), "bob-ik-sig": edpub(S["bob-ik-sig"])}
FP_A = fingerprint(EDPUB["alice-ik-sig"], PUB["alice-ik-dh"])
FP_B = fingerprint(EDPUB["bob-ik-sig"], PUB["bob-ik-dh"])

out = {
  "meta": {
    "title": "Krug E2EE 1:1 — known-answer test vectors",
    "spec": "docs/E2EE-SPEC.md (protocol v1)",
    "vector_set_version": 1,
    "generated_at": "2026-11-16T00:00:00Z",
    "status": "normative for E7 client/server crypto tests; all values must match byte-for-byte",
    "generator": {
      "language": "Python 3.14.6",
      "library": "cryptography 49.0.0",
      "command": "Save the generator from docs/E2EE-SPIKE-NOTES.md §2 as gen_e2ee_vectors.py, then run: python3 gen_e2ee_vectors.py (writes docs/E2EE-TEST-VECTORS.json)",
      "verify_command": "Save the verifier from docs/E2EE-SPIKE-NOTES.md §3 as verify_e2ee_vectors.mjs, then run: node verify_e2ee_vectors.mjs docs/E2EE-TEST-VECTORS.json (expected: 88 checks, 0 failures)",
      "cross_checked_with": "Node.js 24.20.0 (node:crypto X25519/Ed25519/HKDF + WebCrypto AES-256-GCM), see docs/E2EE-SPIKE-NOTES.md §3"
    },
    "conventions": {
      "hex": "lowercase, no 0x prefix",
      "base64url": "RFC 4648 §5, unpadded, no '+'/'/'",
      "integers": "big-endian unsigned in binary structures",
      "strings_in_binary": "UTF-8, length-prefixed with u16 BE",
      "uuid": "RFC 4122 bytes (16), big-endian",
      "domains": {
        "x3dh": D_X3DH.decode(), "session_id": D_SID.decode(), "dr_root": D_RK.decode(),
        "aead_key": D_AEADK.decode(), "aead_nonce": D_AEADN.decode(), "ad": D_AD.decode(),
        "prekey": D_PRE.decode(), "prekey_signature": D_PRESIG.decode(),
        "spk_signature": D_SPKSIG.decode(), "fingerprint": D_FP.decode(),
        "safety_number": D_SN.decode(), "verification": D_VER.decode(), "payload": D_PAY.decode()
      }
    },
    "ids": {
      "alice_user_id": ALICE_USER_S, "alice_device_id": ALICE_DEV_S,
      "bob_user_id": BOB_USER_S, "bob_device_id": BOB_DEV_S, "chat_id": CHAT_S
    },
    "test_seeds": {k: v.hex() for k, v in S.items()},
    "public_keys": {
      "alice_identity_signing_key": EDPUB["alice-ik-sig"].hex(),
      "alice_identity_dh_key": PUB["alice-ik-dh"].hex(),
      "alice_ephemeral_key": PUB["alice-ek"].hex(),
      "bob_identity_signing_key": EDPUB["bob-ik-sig"].hex(),
      "bob_identity_dh_key": PUB["bob-ik-dh"].hex(),
      "bob_signed_prekey": PUB["bob-spk"].hex(),
      "bob_one_time_prekey": PUB["bob-opk"].hex(),
      "alice_fingerprint": FP_A.hex(),
      "bob_fingerprint": FP_B.hex()
    },
    "warning": "All private keys below are public test material. Never use them outside tests."
  },
  "sections": []
}

def add(section_id, title, normative, vectors):
    out["sections"].append({"id": section_id, "title": title, "normative": normative, "vectors": vectors})

# ---------- A. published primitive KATs ----------
# RFC 7748 §6.1
a_priv = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
a_pub  = bytes.fromhex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
b_priv = bytes.fromhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
b_pub  = bytes.fromhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
shared = dh(a_priv, b_pub)
assert shared.hex() == "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"
assert xpub(a_priv) == a_pub and xpub(b_priv) == b_pub

# RFC 8032 §7.1 TEST 1
ed_seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
ed_pub_expected = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
ed_sig = edsign(ed_seed, b"")
assert edpub(ed_seed) == ed_pub_expected
assert ed_sig.hex() == "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
assert edverify(ed_pub_expected, b"", ed_sig)

# RFC 5869 Test Case 1
hk_ikm = bytes.fromhex("0b" * 22)
hk_salt = bytes.fromhex("000102030405060708090a0b0c")
hk_info = bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
hk_okm = hkdf(hk_ikm, hk_salt, hk_info, 42)
assert hk_okm.hex() == ("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
                        "34007208d5b887185865")

# NIST CAVP AES-256-GCM, empty PT/AAD, zero key/IV
gcm_key = b"\x00" * 32
gcm_iv = b"\x00" * 12
gcm_ct = AESGCM(gcm_key).encrypt(gcm_iv, b"", None)
assert gcm_ct.hex() == "530f8afbc74536b9a963b4f1c4cb738b", gcm_ct.hex()

add("A-primitives", "Published primitive known-answer tests", True, [
  {"id": "A1-X25519-RFC7748", "kind": "x25519",
   "source": "RFC 7748 §6.1 (X25519 Diffie-Hellman test vector)",
   "inputs": {"alice_private": a_priv.hex(), "alice_public": a_pub.hex(),
              "bob_private": b_priv.hex(), "bob_public": b_pub.hex()},
   "expected": {"shared_secret": shared.hex(),
                "alice_public_derived": xpub(a_priv).hex(),
                "bob_public_derived": xpub(b_priv).hex()}},
  {"id": "A2-Ed25519-RFC8032", "kind": "ed25519",
   "source": "RFC 8032 §7.1 TEST 1 (Ed25519, empty message)",
   "inputs": {"private_seed": ed_seed.hex(), "message": ""},
   "expected": {"public_key": ed_pub_expected.hex(), "signature": ed_sig.hex()}},
  {"id": "A3-HKDF-SHA256-RFC5869", "kind": "hkdf_sha256",
   "source": "RFC 5869 Test Case 1",
   "inputs": {"ikm": hk_ikm.hex(), "salt": hk_salt.hex(), "info": hk_info.hex(), "length": 42},
   "expected": {"okm": hk_okm.hex()}},
  {"id": "A4-AES256GCM-NIST", "kind": "aes_256_gcm",
   "source": "NIST CAVP gcmEncryptExtIV256, PT len 0 / AAD len 0, 96-bit IV, zero key",
   "inputs": {"key": gcm_key.hex(), "nonce": gcm_iv.hex(), "plaintext": "", "aad": ""},
   "expected": {"ciphertext_including_tag": gcm_ct.hex(),
                "note": "AES-GCM output = ciphertext || 16-byte tag; empty plaintext yields tag only"}}
])

# ---------- B. X3DH ----------
ikm_a = S["alice-ik-dh"]; ek_a = S["alice-ek"]
ik_b_dh_pub = PUB["bob-ik-dh"]; spk_b_pub = PUB["bob-spk"]; opk_b_pub = PUB["bob-opk"]
x_with = x3dh(ikm_a, ek_a, ik_b_dh_pub, spk_b_pub, opk_b_pub)
x_without = x3dh(ikm_a, ek_a, ik_b_dh_pub, spk_b_pub, None)
SID = x_with["session_id"]

b_spk_pub = PUB["bob-spk"]
spk_sig_msg = spk_signed_message("spk-1", b_spk_pub)
bob_spk_sig = edsign(S["bob-ik-sig"], spk_sig_msg)
assert edverify(EDPUB["bob-ik-sig"], spk_sig_msg, bob_spk_sig)

pre = preamble(chat_id=CHAT, sender_device_id=ALICE_DEV, recipient_device_id=BOB_DEV,
               ik_sig_pub=EDPUB["alice-ik-sig"], ik_dh_pub=PUB["alice-ik-dh"],
               ek_pub=PUB["alice-ek"], recipient_ik_dh_pub=ik_b_dh_pub,
               recipient_ik_sig_pub=EDPUB["bob-ik-sig"],
               spk_id="spk-1", spk_pub=spk_b_pub, opk_id="opk-1", opk_pub=opk_b_pub,
               session_id=SID)
pre_sig = edsign(S["alice-ik-sig"], prekey_sig_message(pre))
assert edverify(EDPUB["alice-ik-sig"], prekey_sig_message(pre), pre_sig)
pre_hash = sha256(pre)

add("B-x3dh", "X3DH handshake (4-DH with one-time prekey, and 3-DH fallback)", True, [
  {"id": "B1-X3DH-4DH", "kind": "x3dh",
   "inputs": {
     "alice_identity_dh_private": S["alice-ik-dh"].hex(),
     "alice_ephemeral_private": S["alice-ek"].hex(),
     "bob_identity_dh_public": ik_b_dh_pub.hex(),
     "bob_signed_prekey_public": spk_b_pub.hex(),
     "bob_one_time_prekey_public": opk_b_pub.hex(),
     "salt": Z32.hex(), "info": D_X3DH.decode()
   },
   "expected": {
     "dh1": x_with["dh1"].hex(), "dh2": x_with["dh2"].hex(), "dh3": x_with["dh3"].hex(),
     "dh4": x_with["dh4"].hex(), "ikm": x_with["ikm"].hex(),
     "sk": x_with["sk"].hex(), "session_id": SID.hex()
   }},
  {"id": "B2-X3DH-3DH-otp-exhausted", "kind": "x3dh",
   "note": "No one-time prekey: DH4 omitted; IKM = F || DH1 || DH2 || DH3. Weaker forward secrecy; client must warn.",
   "inputs": {
     "alice_identity_dh_private": S["alice-ik-dh"].hex(),
     "alice_ephemeral_private": S["alice-ek"].hex(),
     "bob_identity_dh_public": ik_b_dh_pub.hex(),
     "bob_signed_prekey_public": spk_b_pub.hex(),
     "bob_one_time_prekey_public": None,
     "salt": Z32.hex(), "info": D_X3DH.decode()
   },
   "expected": {"ikm": x_without["ikm"].hex(), "sk": x_without["sk"].hex(),
                "session_id": x_without["session_id"].hex()}},
  {"id": "B3-SPK-signature", "kind": "ed25519_signature",
   "note": "Signed prekey signature created by the device identity signing key at POST /devices.",
   "inputs": {"signing_seed": S["bob-ik-sig"].hex(), "signed_message": spk_sig_msg.hex(),
              "signed_message_ascii_prefix": D_SPKSIG.decode(), "key_id": "spk-1",
              "spk_public": b_spk_pub.hex()},
   "expected": {"public_key": EDPUB["bob-ik-sig"].hex(), "signature": bob_spk_sig.hex()}},
  {"id": "B4-prekey-preamble", "kind": "prekey_preamble",
   "note": "Signed X3DH initial-message preamble. Binding: chat, both devices, both identities (signing + DH), all prekey material, session id.",
   "inputs": {"chat_id": CHAT_S, "sender_device_id": ALICE_DEV_S, "recipient_device_id": BOB_DEV_S,
              "sender_identity_signing_key": EDPUB["alice-ik-sig"].hex(),
              "sender_identity_dh_key": PUB["alice-ik-dh"].hex(),
              "sender_ephemeral_key": PUB["alice-ek"].hex(),
              "recipient_identity_dh_key": ik_b_dh_pub.hex(),
              "recipient_identity_signing_key": EDPUB["bob-ik-sig"].hex(),
              "recipient_spk_id": "spk-1", "recipient_spk_public": spk_b_pub.hex(),
              "recipient_opk_id": "opk-1", "recipient_opk_public": opk_b_pub.hex(),
              "session_id": SID.hex()},
   "expected": {"preamble": pre.hex(), "preamble_sha256": pre_hash.hex(),
                "signature": pre_sig.hex()}}
])

# ---------- C. HKDF/DR KDF ----------
rk0 = x_with["sk"]
rk1, cks_a0 = kdf_rk(rk0, dh(S["alice-ratchet-0"], spk_b_pub))
mk_a0_0, ck_a0_1 = kdf_ck(cks_a0)
mk_a0_1, ck_a0_2 = kdf_ck(ck_a0_1)
mk_a0_2, ck_a0_3 = kdf_ck(ck_a0_2)

add("C-kdf", "HKDF and Double Ratchet KDF chains", True, [
  {"id": "C1-HKDF-session-id", "kind": "hkdf_sha256",
   "inputs": {"ikm": rk0.hex(), "salt": Z32.hex(), "info": D_SID.decode(), "length": 16},
   "expected": {"okm": SID.hex()}},
  {"id": "C2-DR-root-step-alice-initial", "kind": "dr_root",
   "note": "RatchetInitAlice: RK1||CKs = HKDF(ikm=DH(A0, SPK_B), salt=SK, info=dr-root, L=64).",
   "inputs": {"root_key": rk0.hex(),
              "dh_output": dh(S["alice-ratchet-0"], spk_b_pub).hex(),
              "salt": rk0.hex(), "info": D_RK.decode(), "length": 64},
   "expected": {"root_key_next": rk1.hex(), "chain_key_sending": cks_a0.hex()}},
  {"id": "C3-DR-chain-3-messages", "kind": "dr_chain",
   "note": "KDF_CK: mk = HMAC-SHA256(ck, 0x01); ck' = HMAC-SHA256(ck, 0x02).",
   "inputs": {"chain_key": cks_a0.hex()},
   "expected": [
     {"n": 0, "message_key": mk_a0_0.hex(), "next_chain_key": ck_a0_1.hex()},
     {"n": 1, "message_key": mk_a0_1.hex(), "next_chain_key": ck_a0_2.hex()},
     {"n": 2, "message_key": mk_a0_2.hex(), "next_chain_key": ck_a0_3.hex()}
   ]}
])

# ---------- D. AEAD + padding ----------
body1 = json.dumps({"text": "\u041f\u0440\u0438\u0432\u0435\u0442, \u0411\u043e\u0431!", "reply_to_id": None},
                   ensure_ascii=False, separators=(",", ":")).encode()
padded1 = pad_plaintext(body1)
enc_key, nonce = aead_params(mk_a0_0)
hdr1 = {"dh": PUB["alice-ratchet-0"], "pn": 0, "n": 0}
ad1 = ad_bytes(chat_id=CHAT, sender_device_id=ALICE_DEV, sender_kg=1,
               recipient_device_id=BOB_DEV, recipient_kg=1, session_id=SID,
               preamble_hash=pre_hash, header=hdr1, prekey=True)
ct1 = AESGCM(enc_key).encrypt(nonce, padded1, ad1)
assert AESGCM(enc_key).decrypt(nonce, ct1, ad1) == padded1

# a second message without prekey, chain n=1
enc_key2, nonce2 = aead_params(mk_a0_1)
hdr2 = {"dh": PUB["alice-ratchet-0"], "pn": 0, "n": 1}
ad2 = ad_bytes(chat_id=CHAT, sender_device_id=ALICE_DEV, sender_kg=1,
               recipient_device_id=BOB_DEV, recipient_kg=1, session_id=SID,
               preamble_hash=b"\x00" * 32, header=hdr2, prekey=False)
ct2 = AESGCM(enc_key2).encrypt(nonce2, padded1, ad2)

add("D-aead", "AEAD encryption, plaintext framing, padding and associated data", True, [
  {"id": "D1-inner-payload-framing", "kind": "framing",
   "note": "raw = domain||u8(1)||u8(1=TEXT_JSON)||u32be(len(body))||body; zero-pad to multiple of 256.",
   "inputs": {"body_utf8": body1.decode(), "body_hex": body1.hex(), "body_len": len(body1)},
   "expected": {"raw_len": len(D_PAY) + 6 + len(body1), "padded_len": len(padded1),
                "padding_zero_bytes": len(padded1) - (len(D_PAY) + 6 + len(body1)),
                "padded_hex": padded1.hex()}},
  {"id": "D2-message-aead-m1", "kind": "aead_message",
   "note": "First message of the session (prekey envelope). AD is the 163-byte structure from §3.2.",
   "inputs": {"message_key": mk_a0_0.hex(), "padded_plaintext_hex": padded1.hex(),
              "ad_hex": ad1.hex(), "ad_len": len(ad1)},
   "expected": {"aead_key": enc_key.hex(), "nonce": nonce.hex(),
                "ciphertext_including_tag": ct1.hex(), "ciphertext_len": len(ct1)}},
  {"id": "D3-message-aead-m2", "kind": "aead_message",
   "note": "Second message in the same sending chain, n=1, no prekey block.",
   "inputs": {"message_key": mk_a0_1.hex(), "padded_plaintext_hex": padded1.hex(),
              "ad_hex": ad2.hex(), "ad_len": len(ad2)},
   "expected": {"aead_key": enc_key2.hex(), "nonce": nonce2.hex(),
                "ciphertext_including_tag": ct2.hex(), "ciphertext_len": len(ct2)}}
])

# ---------- E. full Double Ratchet conversation ----------
class State:
    def __init__(self, rk, dhs_priv, dhs_pub, dhr=None, cks=None, ckr=None):
        self.RK, self.DHs_priv, self.DHs_pub, self.DHr = rk, dhs_priv, dhs_pub, dhr
        self.CKs, self.CKr = cks, ckr
        self.Ns = self.Nr = self.PN = 0

def dh_ratchet(st, new_dh_pub, next_priv):
    st.PN = st.Ns
    st.Ns = 0
    st.Nr = 0
    st.DHr = new_dh_pub
    st.RK, st.CKr = kdf_rk(st.RK, dh(st.DHs_priv, st.DHr))
    st.DHs_priv = next_priv
    st.DHs_pub = xpub(st.DHs_priv)
    st.RK, st.CKs = kdf_rk(st.RK, dh(st.DHs_priv, st.DHr))

def send(st, plaintext, chat_id, sender_dev, sender_kg, recip_dev, recip_kg, sid, prekey_hash=b"\x00"*32, prekey=False):
    mk, st.CKs = kdf_ck(st.CKs)
    h = {"dh": st.DHs_pub, "pn": st.PN, "n": st.Ns}
    ad = ad_bytes(chat_id=chat_id, sender_device_id=sender_dev, sender_kg=sender_kg,
                  recipient_device_id=recip_dev, recipient_kg=recip_kg, session_id=sid,
                  preamble_hash=prekey_hash, header=h, prekey=prekey)
    ek, nn = aead_params(mk)
    ct = AESGCM(ek).encrypt(nn, plaintext, ad)
    st.Ns += 1
    return mk, h, ad, ct

def recv(st, h, ct, plaintext_len, chat_id, sender_dev, sender_kg, recip_dev, recip_kg, sid, prekey_hash, next_priv):
    if st.DHr != h["dh"]:
        dh_ratchet(st, h["dh"], next_priv)
    assert st.Nr == h["n"], (st.Nr, h["n"])
    mk, st.CKr = kdf_ck(st.CKr)
    ad = ad_bytes(chat_id=chat_id, sender_device_id=sender_dev, sender_kg=sender_kg,
                  recipient_device_id=recip_dev, recipient_kg=recip_kg, session_id=sid,
                  preamble_hash=prekey_hash, header=h, prekey=prekey_hash != b"\x00"*32)
    ek, nn = aead_params(mk)
    pt = AESGCM(ek).decrypt(nn, ct, ad)
    st.Nr += 1
    return mk, pt

# Alice init
alice = State(rk0, S["alice-ratchet-0"], PUB["alice-ratchet-0"], dhr=b_spk_pub)
alice.RK, alice.CKs = kdf_rk(alice.RK, dh(alice.DHs_priv, alice.DHr))
# Bob init: signing key is SPK; Bob does not run a receiving ratchet until first message
bob = State(rk0, S["bob-spk"], spk_b_pub, dhr=None)

trace = []
pt1 = padded1
mk1, h1, ad1b, ct1b = send(alice, pt1, CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID, pre_hash, True)
trace.append({"step": "A->B m1", "message_key": mk1.hex(), "header": {"dh": h1["dh"].hex(), "pn": h1["pn"], "n": h1["n"]},
              "ad_hex": ad1b.hex(), "ciphertext": ct1b.hex()})
# Bob receive m1
mk1b, got = recv(bob, h1, ct1b, len(pt1), CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID, pre_hash, S['bob-ratchet-1'])
assert got == pt1 and mk1b == mk1
# Bob replies
pt2 = pad_plaintext(json.dumps({"text": "Привет, Алиса!", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode())
mk2, h2, ad2b, ct2b = send(bob, pt2, CHAT, BOB_DEV, 1, ALICE_DEV, 1, SID)
trace.append({"step": "B->A r1", "message_key": mk2.hex(), "header": {"dh": h2["dh"].hex(), "pn": h2["pn"], "n": h2["n"]},
              "ad_hex": ad2b.hex(), "ciphertext": ct2b.hex(),
              "plaintext_hex": pt2.hex()})
# Alice receive r1
mk2b, got2 = recv(alice, h2, ct2b, len(pt2), CHAT, BOB_DEV, 1, ALICE_DEV, 1, SID, b"\x00"*32, S['alice-ratchet-1'])
assert got2 == pt2 and mk2b == mk2
# Alice m2
pt3 = pad_plaintext(json.dumps({"text": "Сообщение 2", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode())
mk3, h3, ad3, ct3 = send(alice, pt3, CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID)
trace.append({"step": "A->B m2", "message_key": mk3.hex(), "header": {"dh": h3["dh"].hex(), "pn": h3["pn"], "n": h3["n"]},
              "ad_hex": ad3.hex(), "ciphertext": ct3.hex(), "plaintext_hex": pt3.hex()})
mk3b, got3 = recv(bob, h3, ct3, len(pt3), CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID, b"\x00"*32, S['bob-ratchet-2'])
assert got3 == pt3 and mk3b == mk3
# Bob r2
pt4 = pad_plaintext(json.dumps({"text": "Ответ 2", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode())
mk4, h4, ad4, ct4 = send(bob, pt4, CHAT, BOB_DEV, 1, ALICE_DEV, 1, SID)
trace.append({"step": "B->A r2", "message_key": mk4.hex(), "header": {"dh": h4["dh"].hex(), "pn": h4["pn"], "n": h4["n"]},
              "ad_hex": ad4.hex(), "ciphertext": ct4.hex(), "plaintext_hex": pt4.hex()})
# r2 is not processed by Alice in this trace (no A2 ratchet key needed); ciphertext + MK are still normative

add("E-double-ratchet", "Full Double Ratchet conversation (4 messages, 2 DH ratchet turns)", True, [
  {"id": "E1-conversation-trace", "kind": "double_ratchet",
   "note": "Alice initiates with the prekey envelope (m1). Bob's initial ratchet private key is the signed prekey. After m1 Bob performs the first DH ratchet and replies with a fresh ratchet key. Counters: pn = messages sent in previous sending chain, n = index in current chain.",
   "initial_state": {
     "x3dh_sk": rk0.hex(), "session_id": SID.hex(),
     "alice_ratchet_0_private": S["alice-ratchet-0"].hex(),
     "alice_ratchet_0_public": PUB["alice-ratchet-0"].hex(),
     "bob_signed_prekey_private": S["bob-spk"].hex(),
     "bob_signed_prekey_public": spk_b_pub.hex(),
     "alice_ratchet_1_private": S["alice-ratchet-1"].hex(),
     "alice_ratchet_1_public": PUB["alice-ratchet-1"].hex(),
     "bob_ratchet_1_private": S["bob-ratchet-1"].hex(),
     "bob_ratchet_1_public": PUB["bob-ratchet-1"].hex(),
     "bob_ratchet_2_private": S["bob-ratchet-2"].hex(),
     "bob_ratchet_2_public": PUB["bob-ratchet-2"].hex(),
     "note_ratchet_derivation": "Both sides: RK_1||CK = HKDF(ikm=DH(ratchet, peer ratchet pub), salt=SK, info=dr-root, L=64)."
   },
   "expected_steps": trace}
])

# ---------- E2. skipped message keys / out-of-order delivery ----------
sess2 = sha256(b"krug-vector-skip-session")[:16]
ck_s = hkdf(sha256(b"krug-vector-skip-seed"), Z32, b"Krug/E2EE/v1/dr-root", 32)
dh_s = PUB["alice-ratchet-0"]
skip_msgs = []
ck = ck_s
for n in range(3):
    mk, ck = kdf_ck(ck)
    body = pad_plaintext(json.dumps({"text": f"skip test {n+1}", "reply_to_id": None},
                                    ensure_ascii=False, separators=(",", ":")).encode())
    h = {"dh": dh_s, "pn": 0, "n": n}
    ad = ad_bytes(chat_id=CHAT, sender_device_id=ALICE_DEV, sender_kg=1,
                  recipient_device_id=BOB_DEV, recipient_kg=1, session_id=sess2,
                  preamble_hash=b"\x00" * 32, header=h, prekey=False)
    ek, nn = aead_params(mk)
    ct = AESGCM(ek).encrypt(nn, body, ad)
    skip_msgs.append({"n": n, "message_key": mk.hex(), "header": {"dh": h["dh"].hex(), "pn": 0, "n": n},
                      "ad_hex": ad.hex(), "ciphertext": ct.hex(), "plaintext_hex": body.hex()})

add("E2-skipped-keys", "Out-of-order delivery and skipped message keys", True, [
  {"id": "E2-skipped-key-trace", "kind": "double_ratchet_skipped",
   "note": "Post-handshake chain (no prekey). Receiver gets m1 (n=0), then m3 (n=2): it MUST derive and store the key for n=1, decrypt m3, and later decrypt m2 from the stored key. Duplicate n must be rejected; gap > MAX_SKIP (1000) must be rejected.",
   "inputs": {"session_id": sess2.hex(), "chain_key_0": ck_s.hex(),
              "ratchet_public": dh_s.hex(), "chat_id": CHAT_S,
              "sender_device_id": ALICE_DEV_S, "recipient_device_id": BOB_DEV_S},
   "expected": {"messages": skip_msgs,
                "delivery_order": [0, 2, 1],
                "skipped_message_key_n1": skip_msgs[1]["message_key"],
                "receiver_state_after_m3": {"Nr": 3,
                  "stored_skipped": [{"n": 1, "message_key": skip_msgs[1]["message_key"]}]},
                "receiver_state_after_m2": {"Nr": 3, "stored_skipped": []}}}
])

# ---------- F. envelope serialization ----------
prekey_obj = {
  "sender_identity_signing_key": b64u(EDPUB["alice-ik-sig"]),
  "sender_identity_dh_key": b64u(PUB["alice-ik-dh"]),
  "sender_ephemeral_key": b64u(PUB["alice-ek"]),
  "recipient_identity_dh_key": b64u(ik_b_dh_pub),
  "spk_id": "spk-1",
  "spk_public": b64u(spk_b_pub),
  "opk_id": "opk-1",
  "opk_public": b64u(opk_b_pub),
  "signature": b64u(pre_sig)
}
env1 = {
  "v": 1,
  "scheme": "PAIRWISE_X3DH_DR",
  "chat_id": CHAT_S,
  "sender_device_id": ALICE_DEV_S,
  "sender_key_generation": 1,
  "recipient_device_id": BOB_DEV_S,
  "recipient_key_generation": 1,
  "session_id": b64u(SID),
  "header": {"v": 1, "dh": b64u(h1["dh"]), "pn": h1["pn"], "n": h1["n"]},
  "ciphertext": b64u(ct1b),
  "prekey": prekey_obj
}
env1_text = json.dumps(env1, ensure_ascii=False, separators=(",", ":"))
env2 = {
  "v": 1, "scheme": "PAIRWISE_X3DH_DR", "chat_id": CHAT_S,
  "sender_device_id": ALICE_DEV_S, "sender_key_generation": 1,
  "recipient_device_id": BOB_DEV_S, "recipient_key_generation": 1,
  "session_id": b64u(SID),
  "header": {"v": 1, "dh": b64u(h3["dh"]), "pn": h3["pn"], "n": h3["n"]},
  "ciphertext": b64u(ct3)
}
env2_text = json.dumps(env2, ensure_ascii=False, separators=(",", ":"))

add("F-envelope", "Envelope JSON serialization", True, [
  {"id": "F1-envelope-prekey", "kind": "envelope",
   "note": "Wire object exactly as sent inside POST /messages envelopes[]. b64url values are unpadded. JSON text is illustrative; field values are normative.",
   "expected": {"envelope_json": env1_text, "envelope_len_bytes": len(env1_text.encode()),
                "decoded": {"header_hex": header_bytes(h1).hex(),
                            "ad_hex": ad1b.hex(), "preamble_hex": pre.hex(),
                            "preamble_sha256": pre_hash.hex(), "ciphertext_hex": ct1b.hex(),
                            "session_id_hex": SID.hex()}}},
  {"id": "F2-envelope-no-prekey", "kind": "envelope",
   "note": "No prekey block: flags bit0 = 0, preamble_hash = 32 zero bytes. Same session and chain (n=0 after ratchet).",
   "expected": {"envelope_json": env2_text, "envelope_len_bytes": len(env2_text.encode()),
                "decoded": {"header_hex": header_bytes(h3).hex(), "ad_hex": ad3.hex(),
                            "ciphertext_hex": ct3.hex()}}}
])

# ---------- G. verification ----------
sn_digest, sn_digits, sn_display = safety_number([
    (ALICE_USER, ALICE_DEV, FP_A), (BOB_USER, BOB_DEV, FP_B)])
vhash = verification_hash(CHAT, ALICE_USER, BOB_DEV, 1, sn_digits)

# key change: Bob re-registers with a new identity key seed (new device id, same user)
bob2 = seed("bob-ik-sig-2")
fp_b2 = fingerprint(edpub(bob2), PUB["bob-ik-dh"])
_, digits2, display2 = safety_number([(ALICE_USER, ALICE_DEV, FP_A), (BOB_USER, BOB_DEV, fp_b2)])

qr = ("krug://verify/v1?dev1=" + ALICE_DEV_S + "&fp1=" + b64u(FP_A) +
      "&dev2=" + BOB_DEV_S + "&fp2=" + b64u(FP_B))

add("G-verification", "Fingerprints, safety number and verification metadata", True, [
  {"id": "G1-device-fingerprint", "kind": "fingerprint",
   "note": "FP = SHA-256(domain || IK_sig_pub || IK_dh_pub). 32 bytes.",
   "inputs": {"identity_signing_key": EDPUB["alice-ik-sig"].hex(),
              "identity_dh_key": PUB["alice-ik-dh"].hex(), "domain": D_FP.decode()},
   "expected": {"alice_fingerprint": FP_A.hex(), "bob_fingerprint": FP_B.hex()}},
  {"id": "G2-safety-number", "kind": "safety_number",
   "note": "Per device pair: two 80-byte entries (user_id||device_id||FP), sorted lexicographically; SHA-512; decimal mod 10^60, zero-padded; displayed as 12 groups of 5.",
   "inputs": {"entries": [
       {"user_id": ALICE_USER_S, "device_id": ALICE_DEV_S, "fingerprint": FP_A.hex()},
       {"user_id": BOB_USER_S, "device_id": BOB_DEV_S, "fingerprint": FP_B.hex()}]},
   "expected": {"sha512": sn_digest.hex(), "digits": sn_digits, "display": sn_display,
                "qr_payload": qr}},
  {"id": "G3-safety-number-after-key-change", "kind": "safety_number",
   "note": "Bob's device re-registered with a new identity signing key: digits MUST change; the old verification is invalid.",
   "inputs": {"entries": [
       {"user_id": ALICE_USER_S, "device_id": ALICE_DEV_S, "fingerprint": FP_A.hex()},
       {"user_id": BOB_USER_S, "device_id": BOB_DEV_S, "fingerprint": fp_b2.hex()}]},
   "expected": {"sha512": hashlib.sha512(D_SN + u8(1) + u32(2) + ALICE_USER + ALICE_DEV + FP_A + BOB_USER + BOB_DEV + fp_b2).hexdigest(),
                "digits": digits2, "display": display2}},
  {"id": "G4-verification-hash", "kind": "verification_hash",
   "note": "Client sends only this hash in PUT /chats/{id}/keys/verification; the server never sees the digits or keys.",
   "inputs": {"chat_id": CHAT_S, "verifier_user_id": ALICE_USER_S,
              "target_device_id": BOB_DEV_S, "target_key_generation": 1, "safety_number_digits": sn_digits},
   "expected": {"safety_number_hash": vhash.hex()}}
])

# ---------- H. sender key (informative, groups = next phase) ----------
sk_seed = seed("sender-key-alice")
sk_ck0 = hkdf(sk_seed, Z32, b"Krug/E2EE/v1/sender-key", 32)
sk_mk0, sk_ck1 = kdf_ck(sk_ck0)
sk_mk1, sk_ck2 = kdf_ck(sk_ck1)
sk_ek0, sk_n0 = hkdf(sk_mk0, Z32, b"Krug/E2EE/v1/sender-aead-key", 32), hkdf(sk_mk0, Z32, b"Krug/E2EE/v1/sender-aead-nonce", 12)
sk_body = json.dumps({"text": "групповое сообщение", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode()
sk_padded = pad_plaintext(sk_body)
sk_ad = b"Krug/E2EE/v1/sender-ad" + u8(1) + CHAT + BOB_DEV + u32(0) + u32(0)
sk_ct = AESGCM(sk_ek0).encrypt(sk_n0, sk_padded, sk_ad)

add("H-sender-key", "Sender key chain (INFORMATIVE — groups are out of E7 scope, ADR-05)", False, [
  {"id": "H1-sender-key-chain", "kind": "sender_key",
   "note": "NOT part of E7 acceptance. Same KDF_CK as DR; per-epoch chain; no PCS across epochs. Included so E7 vectors do not need revision when groups start.",
   "inputs": {"epoch_seed": sk_seed.hex(), "domain": "Krug/E2EE/v1/sender-key", "epoch": 0},
   "expected": {"chain_key_0": sk_ck0.hex(), "message_key_0": sk_mk0.hex(),
                "chain_key_1": sk_ck1.hex(), "message_key_1": sk_mk1.hex(), "chain_key_2": sk_ck2.hex()}},
  {"id": "H2-sender-key-aead", "kind": "sender_key_message",
   "note": "AD for sender-key messages (informative): domain||v||chat_id||sender_device_id||epoch||n. No recipient device id (one ciphertext for all).",
   "inputs": {"message_key": sk_mk0.hex(), "plaintext_hex": sk_padded.hex(), "ad_hex": sk_ad.hex()},
   "expected": {"aead_key": sk_ek0.hex(), "nonce": sk_n0.hex(), "ciphertext": sk_ct.hex()}}
])

out["summary"] = {
  "sections": len(out["sections"]),
  "vectors": sum(len(s["vectors"]) for s in out["sections"]),
  "normative_sections": [s["id"] for s in out["sections"] if s["normative"]],
  "informative_sections": [s["id"] for s in out["sections"] if not s["normative"]]
}

with open("docs/E2EE-TEST-VECTORS.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("written; vectors:", out["summary"]["vectors"], "sections:", out["summary"]["sections"])
print("SK:", rk0.hex())
print("SID:", SID.hex())
print("safety digits:", sn_digits)
print("ct1:", ct1b.hex()[:64], "len", len(ct1b))
print("env1 len", len(env1_text.encode()))

```

## 3. Независимый верификатор (Node.js)

Сохранить как `verify_e2ee_vectors.mjs` и запустить `node verify_e2ee_vectors.mjs docs/E2EE-TEST-VECTORS.json`. Использует только `node:crypto`/WebCrypto (не библиотеку генератора), поэтому ловит расхождения reference-реализации.

```javascript
import fs from 'node:fs';
import crypto from 'node:crypto';
const { webcrypto } = crypto;
const V = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hex = (h) => Buffer.from(h, 'hex');
const b64d = (s) => Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const PKCS8 = Buffer.from('302e020100300506032b656e04220420','hex');
const XSPKI = Buffer.from('302a300506032b656e032100','hex');
const ESPKI = Buffer.from('302a300506032b6570032100','hex');
const xpriv = (h) => crypto.createPrivateKey({key: Buffer.concat([PKCS8, hex(h)]), format:'der', type:'pkcs8'});
const xpub  = (h) => crypto.createPublicKey({key: Buffer.concat([XSPKI, hex(h)]), format:'der', type:'spki'});
const dh = (priv, pub) => crypto.diffieHellman({privateKey: xpriv(priv), publicKey: xpub(pub)});
const xpubOf = (h) => crypto.createPublicKey(xpriv(h)).export({format:'der', type:'spki'}).subarray(-32);
const edpub = (h) => crypto.createPublicKey({key: Buffer.concat([ESPKI, hex(h)]), format:'der', type:'spki'});
const edverify = (pub, msg, sig) => crypto.verify(null, msg, edpub(pub), hex(sig));

const get = (id) => {
  for (const s of V.sections) for (const v of s.vectors) if (v.id === id) return v;
  throw new Error('missing ' + id);
};
let checks = 0, failures = 0;
const ok = (name, cond, extra='') => { checks++; if (!cond) { failures++; console.log('FAIL', name, extra); } else console.log('ok  ', name); };
const eq = (name, a, b) => ok(name, a === b, `\n  got ${a}\n  exp ${b}`);

// A1
{
  const v = get('A1-X25519-RFC7748');
  eq('A1 shared', dh(v.inputs.alice_private, v.inputs.bob_public).toString('hex'), v.expected.shared_secret);
  eq('A1 alice pub', xpubOf(v.inputs.alice_private).toString('hex'), v.expected.alice_public_derived);
  eq('A1 bob pub', xpubOf(v.inputs.bob_private).toString('hex'), v.expected.bob_public_derived);
}
// A2
{
  const v = get('A2-Ed25519-RFC8032');
  const priv = crypto.createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), hex(v.inputs.private_seed)]), format:'der', type:'pkcs8'});
  const pub = crypto.createPublicKey(priv).export({format:'der', type:'spki'}).subarray(-32);
  eq('A2 pub', pub.toString('hex'), v.expected.public_key);
  eq('A2 sig', crypto.sign(null, Buffer.from(v.inputs.message, 'utf8'), priv).toString('hex'), v.expected.signature);
  ok('A2 verify', edverify(v.expected.public_key, Buffer.from(v.inputs.message,'utf8'), v.expected.signature));
}
// A3
{
  const v = get('A3-HKDF-SHA256-RFC5869');
  eq('A3 hkdf', hkdf(hex(v.inputs.ikm), hex(v.inputs.salt), hex(v.inputs.info), v.inputs.length).toString('hex'), v.expected.okm);
}
// A4
{
  const v = get('A4-AES256GCM-NIST');
  const key = await webcrypto.subtle.importKey('raw', hex(v.inputs.key), 'AES-GCM', false, ['encrypt']);
  const ct = Buffer.from(await webcrypto.subtle.encrypt({name:'AES-GCM', iv: hex(v.inputs.nonce), additionalData: Buffer.alloc(0)}, key, Buffer.alloc(0)));
  eq('A4 tag', ct.toString('hex'), v.expected.ciphertext_including_tag);
}
// B1
const ids = V.meta.ids, seeds = V.meta.test_seeds, pubs = V.meta.public_keys;
const Z32 = Buffer.alloc(32), F = Buffer.alloc(32, 0xff);
{
  const v = get('B1-X3DH-4DH');
  const dh1 = dh(v.inputs.alice_identity_dh_private, v.inputs.bob_signed_prekey_public);
  const dh2 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_identity_dh_public);
  const dh3 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_signed_prekey_public);
  const dh4 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_one_time_prekey_public);
  eq('B1 dh1', dh1.toString('hex'), v.expected.dh1);
  eq('B1 dh2', dh2.toString('hex'), v.expected.dh2);
  eq('B1 dh3', dh3.toString('hex'), v.expected.dh3);
  eq('B1 dh4', dh4.toString('hex'), v.expected.dh4);
  const ikm = Buffer.concat([F, dh1, dh2, dh3, dh4]);
  eq('B1 ikm', ikm.toString('hex'), v.expected.ikm);
  const sk = hkdf(ikm, Z32, Buffer.from(v.inputs.info), 32);
  eq('B1 sk', sk.toString('hex'), v.expected.sk);
  eq('B1 sid', hkdf(sk, Z32, Buffer.from('Krug/E2EE/v1/session-id'), 16).toString('hex'), v.expected.session_id);
}
// B2
{
  const v = get('B2-X3DH-3DH-otp-exhausted');
  const dh1 = dh(v.inputs.alice_identity_dh_private, v.inputs.bob_signed_prekey_public);
  const dh2 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_identity_dh_public);
  const dh3 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_signed_prekey_public);
  const ikm = Buffer.concat([F, dh1, dh2, dh3]);
  eq('B2 ikm', ikm.toString('hex'), v.expected.ikm);
  eq('B2 sk', hkdf(ikm, Z32, Buffer.from(v.inputs.info), 32).toString('hex'), v.expected.sk);
}
// B3 SPK signature
{
  const v = get('B3-SPK-signature');
  eq('B3 spk pub derives from seed', xpubOf(seeds['bob-spk']).toString('hex'), v.inputs.spk_public);
  // reconstruct signed message and verify against authoritative signature
  const spkMsg = Buffer.concat([Buffer.from('Krug/E2EE/v1/spk-signature'), Buffer.from([1]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(v.inputs.key_id)); return b; })(),
    Buffer.from(v.inputs.key_id), hex(v.inputs.spk_public)]);
  eq('B3 signed_message', spkMsg.toString('hex'), v.inputs.signed_message);
  ok('B3 signature verifies', edverify(pubs.bob_identity_signing_key, spkMsg, v.expected.signature));
}
// B4 preamble + signature
const pre = hex(get('B4-prekey-preamble').expected.preamble);
{
  const v = get('B4-prekey-preamble');
  eq('B4 preamble hash', sha256(pre).toString('hex'), v.expected.preamble_sha256);
  ok('B4 prekey signature verifies', edverify(pubs.alice_identity_signing_key,
      Buffer.concat([Buffer.from('Krug/E2EE/v1/prekey-signature'), pre]), v.expected.signature));
  const spkIdLen = Buffer.byteLength(v.inputs.recipient_spk_id), opkIdLen = Buffer.byteLength(v.inputs.recipient_opk_id);
  const expLen = 19 + 1 + 16*3 + 32*5 + (2 + spkIdLen) + 32 + 1 + (2 + opkIdLen) + 32 + 16;
  ok('B4 preamble length', pre.length === expLen, `${pre.length} vs ${expLen}`);
}
// C
const sk = hex(get('B1-X3DH-4DH').expected.sk);
const sid = hex(get('B1-X3DH-4DH').expected.session_id);
const kdfRk = (rk, dhOut) => { const okm = hkdf(dhOut, rk, Buffer.from('Krug/E2EE/v1/dr-root'), 64); return [okm.subarray(0,32), okm.subarray(32)]; };
const kdfCk = (ck) => [hmac(ck, Buffer.from([1])), hmac(ck, Buffer.from([2]))];
{
  const v = get('C1-HKDF-session-id');
  eq('C1 sid', hkdf(sk, Z32, Buffer.from(v.inputs.info), 16).toString('hex'), v.expected.okm);
}
const a0pub = xpubOf(seeds['alice-ratchet-0']);
let rk1, cks;
{
  const v = get('C2-DR-root-step-alice-initial');
  const dhOut = dh(seeds['alice-ratchet-0'], pubs.bob_signed_prekey);
  eq('C2 dh', dhOut.toString('hex'), v.inputs.dh_output);
  [rk1, cks] = kdfRk(sk, dhOut);
  eq('C2 rk1', rk1.toString('hex'), v.expected.root_key_next);
  eq('C2 cks', cks.toString('hex'), v.expected.chain_key_sending);
}
{
  const v = get('C3-DR-chain-3-messages');
  let ck = cks;
  for (const exp of v.expected) {
    const [mk, next] = kdfCk(ck);
    eq(`C3 mk ${exp.n}`, mk.toString('hex'), exp.message_key);
    eq(`C3 ck ${exp.n}`, next.toString('hex'), exp.next_chain_key);
    ck = next;
  }
}
// D1 framing
{
  const v = get('D1-inner-payload-framing');
  const raw = Buffer.concat([Buffer.from('Krug/E2EE/v1/payload'), Buffer.from([1,1]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(Buffer.byteLength(v.inputs.body_utf8)); return b; })(),
    Buffer.from(v.inputs.body_utf8)]);
  eq('D1 raw len', raw.length, v.expected.raw_len);
  const padded = Buffer.concat([raw, Buffer.alloc((256 - (raw.length % 256)) % 256)]);
  eq('D1 padded len', padded.length, v.expected.padded_len);
  eq('D1 padded hex', padded.toString('hex'), v.expected.padded_hex);
}
// D2/D3 AEAD
async function aesgcmDecrypt(keyHex, nonceHex, ctHex, adHex) {
  const key = await webcrypto.subtle.importKey('raw', hex(keyHex), 'AES-GCM', false, ['decrypt']);
  return Buffer.from(await webcrypto.subtle.decrypt({name:'AES-GCM', iv: hex(nonceHex), additionalData: hex(adHex)}, key, hex(ctHex)));
}
{
  const v = get('D2-message-aead-m1');
  eq('D2 ad len', hex(v.inputs.ad_hex).length, v.inputs.ad_len);
  eq('D2 ad len 163', v.inputs.ad_len, 163);
  const [ek, nn] = [hkdf(hex(v.inputs.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32),
                    hkdf(hex(v.inputs.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12)];
  eq('D2 aead key', ek.toString('hex'), v.expected.aead_key);
  eq('D2 nonce', nn.toString('hex'), v.expected.nonce);
  const pt = await aesgcmDecrypt(v.expected.aead_key, v.expected.nonce, v.expected.ciphertext_including_tag, v.inputs.ad_hex);
  eq('D2 decrypt to padded', pt.toString('hex'), v.inputs.padded_plaintext_hex);
}
{
  const v = get('D3-message-aead-m2');
  const pt = await aesgcmDecrypt(v.expected.aead_key, v.expected.nonce, v.expected.ciphertext_including_tag, v.inputs.ad_hex);
  eq('D3 decrypt to padded', pt.toString('hex'), v.inputs.padded_plaintext_hex);
}
// E conversation: verify each ciphertext decrypts with its MK + AD, and ratchet roots are consistent
{
  const v = get('E1-conversation-trace');
  const steps = v.expected_steps;
  const hdrBytes = (h) => Buffer.concat([Buffer.from([1,0]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(h.pn); return b; })(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(h.n); return b; })(), hex(h.dh)]);
  for (const s of steps) {
    const isPre = s.step === 'A->B m1';
    const ad = hex(s.ad_hex);
    const h = s.header;
    const chat = Buffer.from(ids.chat_id.replace(/-/g,''), 'hex');
    const sdev = Buffer.from((s.step.startsWith('A') ? ids.alice_device_id : ids.bob_device_id).replace(/-/g,''), 'hex');
    const rdev = Buffer.from((s.step.startsWith('A') ? ids.bob_device_id : ids.alice_device_id).replace(/-/g,''), 'hex');
    const preambleHash = isPre ? sha256(pre) : Buffer.alloc(32);
    const expectedAd = Buffer.concat([Buffer.from('Krug/E2EE/v1/ad'), Buffer.from([1, isPre ? 1 : 0]),
      chat, sdev, Buffer.from([0,0,0,1]), rdev, Buffer.from([0,0,0,1]), sid, preambleHash, hdrBytes(h)]);
    eq(`E ad ${s.step}`, ad.toString('hex'), expectedAd.toString('hex'));
    const [ek, nn] = [hkdf(hex(s.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32),
                      hkdf(hex(s.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12)];
    const pt = await aesgcmDecrypt(ek.toString('hex'), nn.toString('hex'), s.ciphertext, s.ad_hex);
    ok(`E decrypt ${s.step}`, pt.length % 256 === 0 && pt.subarray(0, 20).toString() === 'Krug/E2EE/v1/payload', `${pt.length}`);
    if (s.plaintext_hex) eq(`E plaintext ${s.step}`, pt.toString('hex'), s.plaintext_hex);
  }
  // ratchet root continuity and every message key, computed from explicit vector keys
  const A0 = seeds['alice-ratchet-0'], SPK = seeds['bob-spk'];
  const B1 = seeds['bob-ratchet-1'], A1 = seeds['alice-ratchet-1'], B2 = seeds['bob-ratchet-2'];
  // Alice init and Bob's first KDF are the same DH with salt = SK
  const [rk1, cksA0] = kdfRk(sk, dh(A0, pubs.bob_signed_prekey));
  const [rk1b, ckrBob0] = kdfRk(sk, dh(SPK, a0pub));
  eq('E rk1 from A0/SPK', rk1.toString('hex'), get('C2-DR-root-step-alice-initial').expected.root_key_next);
  eq('E initial chain matches C2', cksA0.toString('hex'), get('C2-DR-root-step-alice-initial').expected.chain_key_sending);
  eq('E bob initial CKr == alice CKs', ckrBob0.toString('hex'), cksA0.toString('hex'));
  eq('E m1 mk', kdfCk(cksA0)[0].toString('hex'), steps[0].message_key);
  // Bob receives m1, generates fresh B1 -> sending chain for r1
  const [rk2, cksB1] = kdfRk(rk1, dh(B1, a0pub));
  eq('E r1 mk', kdfCk(cksB1)[0].toString('hex'), steps[1].message_key);
  // Alice receives r1: CKr must equal Bob's sending chain; then fresh A1 -> chain for m2
  const [rk2b, ckrAlice] = kdfRk(rk1, dh(A0, xpubOf(B1)));
  const [rk3, cksA1] = kdfRk(rk2, dh(A1, xpubOf(B1)));
  eq('E alice CKr == bob CKs', ckrAlice.toString('hex'), cksB1.toString('hex'));
  eq('E m2 mk', kdfCk(cksA1)[0].toString('hex'), steps[2].message_key);
  // Bob receives m2: CKr must equal Alice's sending chain; fresh B2 -> chain for r2
  const [rk3b, ckrBob2] = kdfRk(rk2, dh(B1, xpubOf(A1)));
  const [rk4, cksB2] = kdfRk(rk3, dh(B2, xpubOf(A1)));
  eq('E bob CKr == alice CKs', ckrBob2.toString('hex'), cksA1.toString('hex'));
  eq('E r2 mk', kdfCk(cksB2)[0].toString('hex'), steps[3].message_key);
}
// E2 skipped keys
{
  const v = get('E2-skipped-key-trace');
  let ck = hex(v.inputs.chain_key_0);
  const mks = [];
  for (let i = 0; i < 3; i++) { const [mk, next] = kdfCk(ck); mks.push(mk); ck = next; }
  for (const m of v.expected.messages) {
    eq(`E2 mk n${m.n}`, mks[m.n].toString('hex'), m.message_key);
    eq(`E2 decrypt n${m.n}`, (await aesgcmDecrypt(
      hkdf(mks[m.n], Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32).toString('hex'),
      hkdf(mks[m.n], Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12).toString('hex'),
      m.ciphertext, m.ad_hex)).toString('hex'), m.plaintext_hex);
  }
  eq('E2 skipped key n1', mks[1].toString('hex'), v.expected.skipped_message_key_n1);
  eq('E2 delivery order', v.expected.delivery_order.join(','), '0,2,1');
}
// F envelope: decode fields and verify consistency with E/D
{
  const v = get('F1-envelope-prekey');
  const env = JSON.parse(v.expected.envelope_json);
  eq('F1 session b64', Buffer.from(b64d(env.session_id)).toString('hex'), sid.toString('hex'));
  eq('F1 ciphertext b64', Buffer.from(b64d(env.ciphertext)).toString('hex'), get('D2-message-aead-m1').expected.ciphertext_including_tag);
  eq('F1 header dh', Buffer.from(b64d(env.header.dh)).toString('hex'), get('E1-conversation-trace').expected_steps[0].header.dh);
  eq('F1 frame length', hex(get('F1-envelope-prekey').expected.decoded.ad_hex).length, 163);
  ok('F1 prekey signature b64 decodes to 64', b64d(env.prekey.signature).length === 64);
  ok('F1 all b64url unpadded', [env.session_id, env.ciphertext, env.header.dh, env.prekey.spk_public].every(s => !s.includes('=') && !s.includes('+') && !s.includes('/')));
  const v2 = get('F2-envelope-no-prekey');
  const env2 = JSON.parse(v2.expected.envelope_json);
  ok('F2 no prekey field', env2.prekey === undefined);
}
// G
{
  const v = get('G1-device-fingerprint');
  eq('G1 alice fp', sha256(Buffer.concat([Buffer.from('Krug/E2EE/v1/fingerprint'), hex(v.inputs.identity_signing_key), hex(v.inputs.identity_dh_key)])).toString('hex'), v.expected.alice_fingerprint);
  const v2 = get('G2-safety-number');
  const uid = (s) => Buffer.from(s.replace(/-/g,''), 'hex');
  const e1 = Buffer.concat([uid(v2.inputs.entries[0].user_id), uid(v2.inputs.entries[0].device_id), hex(v2.inputs.entries[0].fingerprint)]);
  const e2 = Buffer.concat([uid(v2.inputs.entries[1].user_id), uid(v2.inputs.entries[1].device_id), hex(v2.inputs.entries[1].fingerprint)]);
  const sorted = Buffer.compare(e1, e2) <= 0 ? [e1, e2] : [e2, e1];
  const data = Buffer.concat([Buffer.from('Krug/E2EE/v1/safety-number'), Buffer.from([1,0,0,0,2]), ...sorted]);
  const digest = crypto.createHash('sha512').update(data).digest();
  eq('G2 sha512', digest.toString('hex'), v2.expected.sha512);
  const digits = (BigInt('0x' + digest.toString('hex')) % (10n ** 60n)).toString().padStart(60, '0');
  eq('G2 digits', digits, v2.expected.digits);
  eq('G2 display', digits.match(/.{5}/g).join(' '), v2.expected.display);
  const v4 = get('G4-verification-hash');
  const vh = sha256(Buffer.concat([Buffer.from('Krug/E2EE/v1/verification'), Buffer.from([1]),
     uid(v4.inputs.chat_id), uid(v4.inputs.verifier_user_id), uid(v4.inputs.target_device_id),
     Buffer.from([0,0,0,1]), Buffer.from(v4.inputs.safety_number_digits)]));
  eq('G4 vhash', vh.toString('hex'), v4.expected.safety_number_hash);
}
// H informative
{
  const v = get('H1-sender-key-chain');
  let ck = hkdf(hex(v.inputs.epoch_seed), Z32, Buffer.from(v.inputs.domain), 32);
  eq('H1 ck0', ck.toString('hex'), v.expected.chain_key_0);
  for (let i = 0; i < 2; i++) {
    const [mk, next] = kdfCk(ck);
    eq(`H1 mk${i}`, mk.toString('hex'), i === 0 ? v.expected.message_key_0 : v.expected.message_key_1);
    ck = next;
    eq(`H1 ck${i+1}`, ck.toString('hex'), i === 0 ? v.expected.chain_key_1 : v.expected.chain_key_2);
  }
  const v2 = get('H2-sender-key-aead');
  const pt = await aesgcmDecrypt(v2.expected.aead_key, v2.expected.nonce, v2.expected.ciphertext, v2.inputs.ad_hex);
  eq('H2 decrypt', pt.toString('hex'), v2.inputs.plaintext_hex);
}
console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);

```

## 4. Как воспроизвести и что получилось (редакция v1, историческая)

> Актуальные команды и результат S2 — **§9.4**. Ниже — исходный прогон v1 (24 вектора, 88 проверок), сохранён для истории. G4 в v2 пересчитан, поэтому старый верификатор на текущем JSON даст расхождение.

```bash
python3 --version          # 3.14.6
python3 -c "import cryptography; print(cryptography.__version__)"  # 49.0.0
node --version             # v24.20.0

python3 gen_e2ee_vectors.py
node verify_e2ee_vectors.mjs docs/E2EE-TEST-VECTORS.json
```

Фактический результат:

```text
written; vectors: 24 sections: 9
SK: bbaf23763ebebc2d1bc558bb9477e1b608e19d66282094873235b4f4d02bd9d5
SID: 86c68f64d2c3be99fde4aabe857e1f5e
safety digits: 966641447817221341546560580530883495084093893634094867501952
ct1: f5111968ef143a66199beaa6662a503696a3a846cb01b81d0e99a6e2eb0e9732 len 272
env1 len 1310

80 checks, 0 failures   # первый прогон (до E2/уточнений)
88 checks, 0 failures   # финальный прогон: 24 вектора, 9 секций
```

Что именно проверяет верификатор:

- A1–A4 — опубликованные RFC/NIST KAT (X25519, Ed25519, HKDF, AES-256-GCM).
- B1/B2 — DH1..DH4, IKM, SK, session_id; B3 — подпись SPK; B4 — преамбул, SHA-256, подпись.
- C1–C3 — HKDF session-id, root step, три message key/chain key.
- D1–D3 — фрейминг/padding, AEAD key/nonce, расшифровка ciphertext.
- E1 — 4 сообщения, 2 DH-ratchet turn, AD каждого шага, ключи цепочек.
- E2 — out-of-order m1/m3/m2, skipped key n=1.
- F1/F2 — b64url-поля, длины, AD, ciphertext, отсутствие `prekey`.
- G1–G4 — fingerprint, SHA-512/digits/QR, смена ключа, verification hash.
- H1/H2 — informative sender key.

Замечания по процессу: первые прогоны верификатора дали 2 ошибки в **моих ожидаемых значениях** (длина преамбула и `raw_len` фрейма), затем 4 ошибки в логике проверки ratchet (неверный salt/цепочка) — все исправлены в верификаторе/генераторе; **криптографические значения не подгонялись**. Это иллюстрирует, зачем нужна вторая реализация.

## 5. Отклонения и уточнения к существующим документам (v1)

> Решения PM и изменения S2 — §9.2 и §9.7. D-06/D-07/D-17 приняты; self-envelope отклонён; D-15 заменён на «локальная копия до send».

| # | Что | Предложение | Причина |
|---|---|---|---|
| D-01 | В §11.2 identity — один Ed25519 и для подписи, и для DH | Две пары: Ed25519 + X25519 | WebCrypto не умеет XEdDSA; меньше review-поверхности (E2EE-ADR-01) |
| D-02 | `auth.devices.identity_public_key` | `identity_signing_key` + `identity_dh_key` + `fingerprint` | Следствие D-01 |
| D-03 | `POST /devices` без ключей | keys + SPK обязательны; OPK опционально | Иначе «полу-E2EE» устройства |
| D-04 | Natural key устройства `(name,platform,version)` | identity signing key | Иначе второй браузер с тем же именем не регистрируется |
| D-05 | `POST /keys/claim` без `chat_id` | `chat_id` обязателен; `unavailable[]` | Не отдавать prekeys любому в воркспейсе; частичная недоступность |
| D-06 | Размер запроса ≤256 КБ | 512 КБ, конверт ≤64 КБ | 9 конвертов × ~33 КБ не влезают |
| D-07 | `Message` без `client_message_id` | добавить nullable | Сопоставление локального plaintext-кэша; закрывает долг I-01 |
| D-08 | `key_epoch` у чата | `null` для DIRECT | Эпохи — для групп/sender keys |
| D-09 | `GET /chats/{id}/keys`/verification | добавить endpoints | Без них нет safety number/AC-04 |
| D-10 | E2EE chat creation | `POST /workspaces/{id}/chats` (DIRECT) | Dev-session создаёт только managed-чат |
| D-11 | Системные сообщения в E2EE | не создавать | Любой plaintext в E2EE-чате — противоречие модели |
| D-12 | `MODE_NOT_E2EE` в анализе | `MODE_NOT_SUPPORTED` + `details.required_mode` | Не плодить код; в backend уже есть |
| D-13 | Сервер не проверяет SPK-подпись | проверять (публичная verify) | Defense-in-depth; клиент проверяет повторно |
| D-14 | Safety number per-user (Signal) | per-device pair | Точнее при multi-device; согласуется с `key_verifications` |
| D-15 | Своё отправленное сообщение | без self-envelope; локальный кэш | Проще; потеря кэша = потеря своих сообщений (честно) |
| D-16 | Преамбул подписывал только DH-identity получателя | Добавлен `recipient_ik_sig` (323 байта) | Подмена signing-ключа получателя ломает подпись, а не только safety number |
| D-17 | «Все устройства всегда с ключами» | `e2ee_capable`; legacy/dev без ключей исключены из claim/fan-out | Dev-session создаёт устройство в обход API и не имеет клиентских ключей |

## 6. Вопросы, требующие решения PM/архитектора (до E7-B)

1. **Контракт:** согласовать §6.3 diff и порядок I-01; без него backend/frontend не могут стартовать.
2. **512 KiB:** принять отклонение D-06 или уменьшить inner body до 16 KiB (тогда 8000 emoji не влезут).
3. **Dev session:** E2EE-тесты только через реальный OIDC flow? Dev-устройство без ключей не должно попадать в E2EE-чат.
4. **E2EE workspace creation:** кто и когда создаёт E2EE-воркспейс в продукте (Q-03 из анализа)?
5. **`client_message_id` в Message:** подтвердить изменение контракта (D-07).
6. **Feature flag:** имя/владелец `e2ee.enabled`; поведение `409 E2EE_DISABLED`.
7. **Внешний ревьюер:** кто и по какому чек-листу; нужен ли пентест крипто-протокола отдельно.
8. **Backup v1:** отдельный spike? Без него потеря устройства = потеря истории; UI должен быть честным.
9. **Key transparency v2:** включать ли в roadmap v2 и кто владелец.
10. **Группы:** подтвердить, что E7 не проектирует sender keys; векторы H — только задел.

## 7. Пакет для crypto-review

- [x] `docs/E2EE-SPEC.md` — протокол, wire, API delta, threat model, план.
- [x] `docs/E2EE-TEST-VECTORS.json` — 24 вектора, 88 проверок.
- [x] `docs/E2EE-SPIKE-NOTES.md` — генератор, верификатор, отклонения.
- [ ] Внешний reviewer: transcript/AD/KDF domains, ratchet init, safety number, revoke/generation, storage/atomicity.
- [ ] Ответы на Q-01..Q-16 (SPEC §10.7).
- [ ] Решение по D-01..D-15.

## 8. Что дальше (handoff, v1)

> Обновлено в §9.6: S2 закрывает P0/P1, но G4 (внешний review реализации) остаётся обязательным.

1. PM/лид: принять/отклонить §6.3 diff; обновить `contracts/openapi.yaml` и `contracts/ws-protocol.md`; завести E7-B/E7-F задачи с оценками §10.1–10.2.
2. Backend: E7-B1/B2 можно начинать сразу после согласования схем; E2EE flag off.
3. Frontend: E7-F1/F2 (primitive KAT + storage) — после review дизайна; не включать в prod.
4. Security: назначить review #1 (design) и #2 (implementation); gate G4 до включения.
5. Не менять wire format после review без новой версии; все изменения — через ADR и векторы.

---

*Spike завершён: спека, векторы и план готовы; production-код не писался, контракты не менялись.*


---

## 9. E7-S2 remediation — векторы v2, генератор и верификатор

> §9 добавлен после независимого ревью [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>) (GO WITH CONDITIONS, 4 P0 + 12 P1). Где §2–§8 расходятся с §9, приоритет у §9. Envelope wire format **не менялся** (`v=1`); `VH` перешёл на v2 (`u8(2)` + `verifier_device_id`), DDL/API исправлены.

### 9.1. Генератор S2 (полный исходник)

Сохранить как `gen_e2ee_vectors_s2.py` в корне репозитория и запустить `python3 gen_e2ee_vectors_s2.py` — перезапишет `docs/E2EE-TEST-VECTORS.json`. Требуется Python 3.11+ и `cryptography` (проверено на 3.14.6 / 49.0.0).

```python
import base64, hashlib, hmac, json, struct, uuid
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# ---------- helpers ----------
def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()

def hkdf(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)

Z32 = b"\x00" * 32
F = b"\xff" * 32

def u8(v): return struct.pack(">B", v)
def u16(v): return struct.pack(">H", v)
def u32(v): return struct.pack(">I", v)
def u64(v): return struct.pack(">Q", v)

def lp16(b: bytes) -> bytes:
    return u16(len(b)) + b

def uuidb(s: str) -> bytes:
    return uuid.UUID(s).bytes

# X25519
def xpub(seed: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)

def dh(priv: bytes, pub: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(priv).exchange(
        X25519PublicKey.from_public_bytes(pub))

# Ed25519
def edpub(seed: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)

def edsign(seed: bytes, msg: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).sign(msg)

def edverify(pub: bytes, msg: bytes, sig: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg)
        return True
    except Exception:
        return False

# ---------- domains ----------
D_X3DH   = b"Krug/E2EE/v1/x3dh"
D_SID    = b"Krug/E2EE/v1/session-id"
D_RK     = b"Krug/E2EE/v1/dr-root"
D_AEADK  = b"Krug/E2EE/v1/aead-key"
D_AEADN  = b"Krug/E2EE/v1/aead-nonce"
D_AD     = b"Krug/E2EE/v1/ad"
D_PRE    = b"Krug/E2EE/v1/prekey"
D_PRESIG = b"Krug/E2EE/v1/prekey-signature"
D_SPKSIG = b"Krug/E2EE/v1/spk-signature"
D_FP     = b"Krug/E2EE/v1/fingerprint"
D_SN     = b"Krug/E2EE/v1/safety-number"
D_VER    = b"Krug/E2EE/v1/verification"
D_PAY    = b"Krug/E2EE/v1/payload"
D_IKBIND = b"Krug/E2EE/v1/ik-binding"

def kdf_rk(rk: bytes, dh_out: bytes):
    okm = hkdf(dh_out, rk, D_RK, 64)
    return okm[:32], okm[32:]

def kdf_ck(ck: bytes):
    return hmac.new(ck, b"\x01", hashlib.sha256).digest(), hmac.new(ck, b"\x02", hashlib.sha256).digest()

def aead_params(mk: bytes):
    return hkdf(mk, Z32, D_AEADK, 32), hkdf(mk, Z32, D_AEADN, 12)

def header_bytes(h):
    return u8(1) + u8(0) + u32(h["pn"]) + u32(h["n"]) + h["dh"]

def ad_bytes(*, chat_id, sender_device_id, sender_kg, recipient_device_id, recipient_kg,
             session_id, preamble_hash, header, prekey: bool):
    return (D_AD + u8(1) + u8(1 if prekey else 0) + chat_id + sender_device_id +
            u32(sender_kg) + recipient_device_id + u32(recipient_kg) + session_id +
            preamble_hash + header_bytes(header))

def pad_plaintext(body: bytes) -> bytes:
    raw = D_PAY + u8(1) + u8(1) + u32(len(body)) + body
    pad = (-len(raw)) % 256
    return raw + b"\x00" * pad

def x3dh(ik_a_dh_priv, ek_a_priv, ik_b_dh_pub, spk_b_pub, opk_b_pub=None):
    dh1 = dh(ik_a_dh_priv, spk_b_pub)
    dh2 = dh(ek_a_priv, ik_b_dh_pub)
    dh3 = dh(ek_a_priv, spk_b_pub)
    parts = [dh1, dh2, dh3]
    if opk_b_pub is not None:
        parts.append(dh(ek_a_priv, opk_b_pub))
    ikm = F + b"".join(parts)
    sk = hkdf(ikm, Z32, D_X3DH, 32)
    sid = hkdf(sk, Z32, D_SID, 16)
    return {"dh1": dh1, "dh2": dh2, "dh3": dh3,
            "dh4": parts[3] if len(parts) == 4 else None,
            "ikm": ikm, "sk": sk, "session_id": sid}

def preamble(*, chat_id, sender_device_id, recipient_device_id, ik_sig_pub, ik_dh_pub, ek_pub,
             recipient_ik_dh_pub, recipient_ik_sig_pub, spk_id, spk_pub, opk_id, opk_pub, session_id) -> bytes:
    out = D_PRE + u8(1) + chat_id + sender_device_id + recipient_device_id
    out += ik_sig_pub + ik_dh_pub + ek_pub + recipient_ik_dh_pub + recipient_ik_sig_pub
    out += lp16(spk_id.encode()) + spk_pub
    if opk_pub is None:
        out += u8(0) + lp16(b"") + b"\x00" * 32
    else:
        out += u8(1) + lp16(opk_id.encode()) + opk_pub
    out += session_id
    return out

def fingerprint(ik_sig_pub, ik_dh_pub):
    return sha256(D_FP + ik_sig_pub + ik_dh_pub)

def safety_number(pairs):
    # pairs: list of (user_id_bytes, device_id_bytes, fingerprint_bytes), exactly two for 1:1 pair
    entries = sorted((u + d + f for (u, d, f) in pairs))
    data = D_SN + u8(1) + u32(len(entries)) + b"".join(entries)
    digest = hashlib.sha512(data).digest()
    digits = str(int.from_bytes(digest, "big") % (10 ** 60)).zfill(60)
    return digest, digits, " ".join(digits[i:i+5] for i in range(0, 60, 5))

def verification_hash(chat_id, verifier_user_id, verifier_device_id, target_device_id, target_kg, digits):
    # S2 / VH v2: the verifier DEVICE is bound into the hash (P0-1).
    return sha256(D_VER + u8(2) + chat_id + verifier_user_id + verifier_device_id +
                  target_device_id + u32(target_kg) + digits.encode())

def identity_binding_message(ik_dh_pub, ik_sig_pub):
    return D_IKBIND + u8(1) + ik_dh_pub + ik_sig_pub

def spk_signed_message(key_id: str, spk_pub: bytes) -> bytes:
    return D_SPKSIG + u8(1) + lp16(key_id.encode()) + spk_pub

def prekey_sig_message(p: bytes) -> bytes:
    return D_PRESIG + p

def fp_hex(f): return f.hex()

# ---------- identities ----------
def seed(label: str) -> bytes:
    return sha256(("krug-e2ee-vector-v1:" + label).encode())

ALICE_USER = uuidb("00000000-0000-4000-8000-000000000001")
ALICE_DEV  = uuidb("00000000-0000-4000-8000-000000000011")
BOB_USER   = uuidb("00000000-0000-4000-8000-000000000002")
BOB_DEV    = uuidb("00000000-0000-4000-8000-000000000021")
CHAT       = uuidb("00000000-0000-4000-8000-000000000100")
ALICE_USER_S = str(uuid.UUID(bytes=ALICE_USER))
ALICE_DEV_S  = str(uuid.UUID(bytes=ALICE_DEV))
BOB_USER_S   = str(uuid.UUID(bytes=BOB_USER))
BOB_DEV_S    = str(uuid.UUID(bytes=BOB_DEV))
CHAT_S       = str(uuid.UUID(bytes=CHAT))
ALICE2_DEV   = uuidb("00000000-0000-4000-8000-000000000012")
ALICE2_DEV_S = str(uuid.UUID(bytes=ALICE2_DEV))

S = {k: seed(k) for k in [
    "alice-ik-sig","alice-ik-dh","alice-ek","alice-ratchet-0","alice-ratchet-1",
    "bob-ik-sig","bob-ik-dh","bob-spk","bob-opk","bob-ratchet-1","bob-ratchet-2",
    "sender-key-alice",
    # S2 additions: second verifier device (P0-1) and attacker keys for the TOFU negative (P0-2)
    "alice2-ik-sig","alice2-ik-dh","mallory-ik-sig","mallory-ik-dh","mallory-ek","mallory-ratchet-0",
]}
PUB = {k: xpub(v) for k, v in S.items()}
EDPUB = {"alice-ik-sig": edpub(S["alice-ik-sig"]), "bob-ik-sig": edpub(S["bob-ik-sig"]),
         "alice2-ik-sig": edpub(S["alice2-ik-sig"]), "mallory-ik-sig": edpub(S["mallory-ik-sig"])}
FP_A = fingerprint(EDPUB["alice-ik-sig"], PUB["alice-ik-dh"])
FP_A2 = fingerprint(EDPUB["alice2-ik-sig"], PUB["alice2-ik-dh"])
FP_M = fingerprint(EDPUB["mallory-ik-sig"], PUB["mallory-ik-dh"])
FP_B = fingerprint(EDPUB["bob-ik-sig"], PUB["bob-ik-dh"])

out = {
  "meta": {
    "title": "Krug E2EE 1:1 — known-answer test vectors",
    "spec": "docs/E2EE-SPEC.md (protocol v1)",
    "vector_set_version": 2,
    "generated_at": "2026-11-16T16:00:00Z",
    "status": "normative v2 (E7-S2 remediation) for E7 client/server crypto and conformance tests; all values must match byte-for-byte",
    "generator": {
      "language": "Python 3.14.6",
      "library": "cryptography 49.0.0",
      "command": "Save the S2 generator from docs/E2EE-SPIKE-NOTES.md §9 as gen_e2ee_vectors_s2.py, then run: python3 gen_e2ee_vectors_s2.py (writes docs/E2EE-TEST-VECTORS.json)",
      "verify_command": "Save the S2 verifier from docs/E2EE-SPIKE-NOTES.md §9 as verify_e2ee_vectors_s2.mjs, then run: node verify_e2ee_vectors_s2.mjs docs/E2EE-TEST-VECTORS.json (expected: 160 checks, 0 failures)",
      "cross_checked_with": "Node.js 24.20.0 (node:crypto X25519/Ed25519/HKDF + WebCrypto AES-256-GCM), independently of the Python generator; see docs/E2EE-SPIKE-NOTES.md §9"
    },
    "conventions": {
      "hex": "lowercase, no 0x prefix",
      "base64url": "RFC 4648 §5, unpadded, no '+'/'/'",
      "integers": "big-endian unsigned in binary structures",
      "strings_in_binary": "UTF-8, length-prefixed with u16 BE",
      "uuid": "RFC 4122 bytes (16), big-endian",
      "domains": {
        "x3dh": D_X3DH.decode(), "session_id": D_SID.decode(), "dr_root": D_RK.decode(),
        "aead_key": D_AEADK.decode(), "aead_nonce": D_AEADN.decode(), "ad": D_AD.decode(),
        "prekey": D_PRE.decode(), "prekey_signature": D_PRESIG.decode(),
        "spk_signature": D_SPKSIG.decode(), "fingerprint": D_FP.decode(),
        "safety_number": D_SN.decode(), "verification": D_VER.decode(), "payload": D_PAY.decode()
      }
    },
    "ids": {
      "alice_user_id": ALICE_USER_S, "alice_device_id": ALICE_DEV_S,
      "bob_user_id": BOB_USER_S, "bob_device_id": BOB_DEV_S, "chat_id": CHAT_S
    },
    "test_seeds": {k: v.hex() for k, v in S.items()},
    "public_keys": {
      "alice_identity_signing_key": EDPUB["alice-ik-sig"].hex(),
      "alice_identity_dh_key": PUB["alice-ik-dh"].hex(),
      "alice_ephemeral_key": PUB["alice-ek"].hex(),
      "bob_identity_signing_key": EDPUB["bob-ik-sig"].hex(),
      "bob_identity_dh_key": PUB["bob-ik-dh"].hex(),
      "bob_signed_prekey": PUB["bob-spk"].hex(),
      "bob_one_time_prekey": PUB["bob-opk"].hex(),
      "alice_fingerprint": FP_A.hex(),
      "bob_fingerprint": FP_B.hex()
    },
    "warning": "All private keys below are public test material. Never use them outside tests."
  },
  "sections": []
}

def add(section_id, title, normative, vectors):
    out["sections"].append({"id": section_id, "title": title, "normative": normative, "vectors": vectors})

# ---------- A. published primitive KATs ----------
# RFC 7748 §6.1
a_priv = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
a_pub  = bytes.fromhex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
b_priv = bytes.fromhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
b_pub  = bytes.fromhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
shared = dh(a_priv, b_pub)
assert shared.hex() == "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"
assert xpub(a_priv) == a_pub and xpub(b_priv) == b_pub

# RFC 8032 §7.1 TEST 1
ed_seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
ed_pub_expected = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
ed_sig = edsign(ed_seed, b"")
assert edpub(ed_seed) == ed_pub_expected
assert ed_sig.hex() == "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
assert edverify(ed_pub_expected, b"", ed_sig)

# RFC 5869 Test Case 1
hk_ikm = bytes.fromhex("0b" * 22)
hk_salt = bytes.fromhex("000102030405060708090a0b0c")
hk_info = bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
hk_okm = hkdf(hk_ikm, hk_salt, hk_info, 42)
assert hk_okm.hex() == ("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
                        "34007208d5b887185865")

# NIST CAVP AES-256-GCM, empty PT/AAD, zero key/IV
gcm_key = b"\x00" * 32
gcm_iv = b"\x00" * 12
gcm_ct = AESGCM(gcm_key).encrypt(gcm_iv, b"", None)
assert gcm_ct.hex() == "530f8afbc74536b9a963b4f1c4cb738b", gcm_ct.hex()

add("A-primitives", "Published primitive known-answer tests", True, [
  {"id": "A1-X25519-RFC7748", "kind": "x25519",
   "source": "RFC 7748 §6.1 (X25519 Diffie-Hellman test vector)",
   "inputs": {"alice_private": a_priv.hex(), "alice_public": a_pub.hex(),
              "bob_private": b_priv.hex(), "bob_public": b_pub.hex()},
   "expected": {"shared_secret": shared.hex(),
                "alice_public_derived": xpub(a_priv).hex(),
                "bob_public_derived": xpub(b_priv).hex()}},
  {"id": "A2-Ed25519-RFC8032", "kind": "ed25519",
   "source": "RFC 8032 §7.1 TEST 1 (Ed25519, empty message)",
   "inputs": {"private_seed": ed_seed.hex(), "message": ""},
   "expected": {"public_key": ed_pub_expected.hex(), "signature": ed_sig.hex()}},
  {"id": "A3-HKDF-SHA256-RFC5869", "kind": "hkdf_sha256",
   "source": "RFC 5869 Test Case 1",
   "inputs": {"ikm": hk_ikm.hex(), "salt": hk_salt.hex(), "info": hk_info.hex(), "length": 42},
   "expected": {"okm": hk_okm.hex()}},
  {"id": "A4-AES256GCM-NIST", "kind": "aes_256_gcm",
   "source": "NIST CAVP gcmEncryptExtIV256, PT len 0 / AAD len 0, 96-bit IV, zero key",
   "inputs": {"key": gcm_key.hex(), "nonce": gcm_iv.hex(), "plaintext": "", "aad": ""},
   "expected": {"ciphertext_including_tag": gcm_ct.hex(),
                "note": "AES-GCM output = ciphertext || 16-byte tag; empty plaintext yields tag only"}}
])

# ---------- B. X3DH ----------
ikm_a = S["alice-ik-dh"]; ek_a = S["alice-ek"]
ik_b_dh_pub = PUB["bob-ik-dh"]; spk_b_pub = PUB["bob-spk"]; opk_b_pub = PUB["bob-opk"]
x_with = x3dh(ikm_a, ek_a, ik_b_dh_pub, spk_b_pub, opk_b_pub)
x_without = x3dh(ikm_a, ek_a, ik_b_dh_pub, spk_b_pub, None)
SID = x_with["session_id"]

b_spk_pub = PUB["bob-spk"]
spk_sig_msg = spk_signed_message("spk-1", b_spk_pub)
bob_spk_sig = edsign(S["bob-ik-sig"], spk_sig_msg)
assert edverify(EDPUB["bob-ik-sig"], spk_sig_msg, bob_spk_sig)

pre = preamble(chat_id=CHAT, sender_device_id=ALICE_DEV, recipient_device_id=BOB_DEV,
               ik_sig_pub=EDPUB["alice-ik-sig"], ik_dh_pub=PUB["alice-ik-dh"],
               ek_pub=PUB["alice-ek"], recipient_ik_dh_pub=ik_b_dh_pub,
               recipient_ik_sig_pub=EDPUB["bob-ik-sig"],
               spk_id="spk-1", spk_pub=spk_b_pub, opk_id="opk-1", opk_pub=opk_b_pub,
               session_id=SID)
pre_sig = edsign(S["alice-ik-sig"], prekey_sig_message(pre))
assert edverify(EDPUB["alice-ik-sig"], prekey_sig_message(pre), pre_sig)
pre_hash = sha256(pre)

add("B-x3dh", "X3DH handshake (4-DH with one-time prekey, and 3-DH fallback)", True, [
  {"id": "B1-X3DH-4DH", "kind": "x3dh",
   "inputs": {
     "alice_identity_dh_private": S["alice-ik-dh"].hex(),
     "alice_ephemeral_private": S["alice-ek"].hex(),
     "bob_identity_dh_public": ik_b_dh_pub.hex(),
     "bob_signed_prekey_public": spk_b_pub.hex(),
     "bob_one_time_prekey_public": opk_b_pub.hex(),
     "salt": Z32.hex(), "info": D_X3DH.decode()
   },
   "expected": {
     "dh1": x_with["dh1"].hex(), "dh2": x_with["dh2"].hex(), "dh3": x_with["dh3"].hex(),
     "dh4": x_with["dh4"].hex(), "ikm": x_with["ikm"].hex(),
     "sk": x_with["sk"].hex(), "session_id": SID.hex()
   }},
  {"id": "B2-X3DH-3DH-otp-exhausted", "kind": "x3dh",
   "note": "No one-time prekey: DH4 omitted; IKM = F || DH1 || DH2 || DH3. Weaker forward secrecy; client must warn.",
   "inputs": {
     "alice_identity_dh_private": S["alice-ik-dh"].hex(),
     "alice_ephemeral_private": S["alice-ek"].hex(),
     "bob_identity_dh_public": ik_b_dh_pub.hex(),
     "bob_signed_prekey_public": spk_b_pub.hex(),
     "bob_one_time_prekey_public": None,
     "salt": Z32.hex(), "info": D_X3DH.decode()
   },
   "expected": {"ikm": x_without["ikm"].hex(), "sk": x_without["sk"].hex(),
                "session_id": x_without["session_id"].hex()}},
  {"id": "B3-SPK-signature", "kind": "ed25519_signature",
   "note": "Signed prekey signature created by the device identity signing key at POST /devices.",
   "inputs": {"signing_seed": S["bob-ik-sig"].hex(), "signed_message": spk_sig_msg.hex(),
              "signed_message_ascii_prefix": D_SPKSIG.decode(), "key_id": "spk-1",
              "spk_public": b_spk_pub.hex()},
   "expected": {"public_key": EDPUB["bob-ik-sig"].hex(), "signature": bob_spk_sig.hex()}},
  {"id": "B4-prekey-preamble", "kind": "prekey_preamble",
   "note": "Signed X3DH initial-message preamble. Binding: chat, both devices, both identities (signing + DH), all prekey material, session id.",
   "inputs": {"chat_id": CHAT_S, "sender_device_id": ALICE_DEV_S, "recipient_device_id": BOB_DEV_S,
              "sender_identity_signing_key": EDPUB["alice-ik-sig"].hex(),
              "sender_identity_dh_key": PUB["alice-ik-dh"].hex(),
              "sender_ephemeral_key": PUB["alice-ek"].hex(),
              "recipient_identity_dh_key": ik_b_dh_pub.hex(),
              "recipient_identity_signing_key": EDPUB["bob-ik-sig"].hex(),
              "recipient_spk_id": "spk-1", "recipient_spk_public": spk_b_pub.hex(),
              "recipient_opk_id": "opk-1", "recipient_opk_public": opk_b_pub.hex(),
              "session_id": SID.hex()},
   "expected": {"preamble": pre.hex(), "preamble_sha256": pre_hash.hex(),
                "signature": pre_sig.hex()}}
])

# ---------- C. HKDF/DR KDF ----------
rk0 = x_with["sk"]
rk1, cks_a0 = kdf_rk(rk0, dh(S["alice-ratchet-0"], spk_b_pub))
mk_a0_0, ck_a0_1 = kdf_ck(cks_a0)
mk_a0_1, ck_a0_2 = kdf_ck(ck_a0_1)
mk_a0_2, ck_a0_3 = kdf_ck(ck_a0_2)

add("C-kdf", "HKDF and Double Ratchet KDF chains", True, [
  {"id": "C1-HKDF-session-id", "kind": "hkdf_sha256",
   "inputs": {"ikm": rk0.hex(), "salt": Z32.hex(), "info": D_SID.decode(), "length": 16},
   "expected": {"okm": SID.hex()}},
  {"id": "C2-DR-root-step-alice-initial", "kind": "dr_root",
   "note": "RatchetInitAlice: RK1||CKs = HKDF(ikm=DH(A0, SPK_B), salt=SK, info=dr-root, L=64).",
   "inputs": {"root_key": rk0.hex(),
              "dh_output": dh(S["alice-ratchet-0"], spk_b_pub).hex(),
              "salt": rk0.hex(), "info": D_RK.decode(), "length": 64},
   "expected": {"root_key_next": rk1.hex(), "chain_key_sending": cks_a0.hex()}},
  {"id": "C3-DR-chain-3-messages", "kind": "dr_chain",
   "note": "KDF_CK: mk = HMAC-SHA256(ck, 0x01); ck' = HMAC-SHA256(ck, 0x02).",
   "inputs": {"chain_key": cks_a0.hex()},
   "expected": [
     {"n": 0, "message_key": mk_a0_0.hex(), "next_chain_key": ck_a0_1.hex()},
     {"n": 1, "message_key": mk_a0_1.hex(), "next_chain_key": ck_a0_2.hex()},
     {"n": 2, "message_key": mk_a0_2.hex(), "next_chain_key": ck_a0_3.hex()}
   ]}
])

# ---------- D. AEAD + padding ----------
body1 = json.dumps({"text": "\u041f\u0440\u0438\u0432\u0435\u0442, \u0411\u043e\u0431!", "reply_to_id": None},
                   ensure_ascii=False, separators=(",", ":")).encode()
padded1 = pad_plaintext(body1)
enc_key, nonce = aead_params(mk_a0_0)
hdr1 = {"dh": PUB["alice-ratchet-0"], "pn": 0, "n": 0}
ad1 = ad_bytes(chat_id=CHAT, sender_device_id=ALICE_DEV, sender_kg=1,
               recipient_device_id=BOB_DEV, recipient_kg=1, session_id=SID,
               preamble_hash=pre_hash, header=hdr1, prekey=True)
ct1 = AESGCM(enc_key).encrypt(nonce, padded1, ad1)
assert AESGCM(enc_key).decrypt(nonce, ct1, ad1) == padded1

# a second message without prekey, chain n=1
enc_key2, nonce2 = aead_params(mk_a0_1)
hdr2 = {"dh": PUB["alice-ratchet-0"], "pn": 0, "n": 1}
ad2 = ad_bytes(chat_id=CHAT, sender_device_id=ALICE_DEV, sender_kg=1,
               recipient_device_id=BOB_DEV, recipient_kg=1, session_id=SID,
               preamble_hash=b"\x00" * 32, header=hdr2, prekey=False)
ct2 = AESGCM(enc_key2).encrypt(nonce2, padded1, ad2)

add("D-aead", "AEAD encryption, plaintext framing, padding and associated data", True, [
  {"id": "D1-inner-payload-framing", "kind": "framing",
   "note": "raw = domain||u8(1)||u8(1=TEXT_JSON)||u32be(len(body))||body; zero-pad to multiple of 256.",
   "inputs": {"body_utf8": body1.decode(), "body_hex": body1.hex(), "body_len": len(body1)},
   "expected": {"raw_len": len(D_PAY) + 6 + len(body1), "padded_len": len(padded1),
                "padding_zero_bytes": len(padded1) - (len(D_PAY) + 6 + len(body1)),
                "padded_hex": padded1.hex()}},
  {"id": "D2-message-aead-m1", "kind": "aead_message",
   "note": "First message of the session (prekey envelope). AD is the 163-byte structure from §3.2.",
   "inputs": {"message_key": mk_a0_0.hex(), "padded_plaintext_hex": padded1.hex(),
              "ad_hex": ad1.hex(), "ad_len": len(ad1)},
   "expected": {"aead_key": enc_key.hex(), "nonce": nonce.hex(),
                "ciphertext_including_tag": ct1.hex(), "ciphertext_len": len(ct1)}},
  {"id": "D3-message-aead-m2", "kind": "aead_message",
   "note": "Second message in the same sending chain, n=1, no prekey block.",
   "inputs": {"message_key": mk_a0_1.hex(), "padded_plaintext_hex": padded1.hex(),
              "ad_hex": ad2.hex(), "ad_len": len(ad2)},
   "expected": {"aead_key": enc_key2.hex(), "nonce": nonce2.hex(),
                "ciphertext_including_tag": ct2.hex(), "ciphertext_len": len(ct2)}}
])

# ---------- E. full Double Ratchet conversation ----------
class State:
    def __init__(self, rk, dhs_priv, dhs_pub, dhr=None, cks=None, ckr=None):
        self.RK, self.DHs_priv, self.DHs_pub, self.DHr = rk, dhs_priv, dhs_pub, dhr
        self.CKs, self.CKr = cks, ckr
        self.Ns = self.Nr = self.PN = 0

def dh_ratchet(st, new_dh_pub, next_priv):
    st.PN = st.Ns
    st.Ns = 0
    st.Nr = 0
    st.DHr = new_dh_pub
    st.RK, st.CKr = kdf_rk(st.RK, dh(st.DHs_priv, st.DHr))
    st.DHs_priv = next_priv
    st.DHs_pub = xpub(st.DHs_priv)
    st.RK, st.CKs = kdf_rk(st.RK, dh(st.DHs_priv, st.DHr))

def send(st, plaintext, chat_id, sender_dev, sender_kg, recip_dev, recip_kg, sid, prekey_hash=b"\x00"*32, prekey=False):
    mk, st.CKs = kdf_ck(st.CKs)
    h = {"dh": st.DHs_pub, "pn": st.PN, "n": st.Ns}
    ad = ad_bytes(chat_id=chat_id, sender_device_id=sender_dev, sender_kg=sender_kg,
                  recipient_device_id=recip_dev, recipient_kg=recip_kg, session_id=sid,
                  preamble_hash=prekey_hash, header=h, prekey=prekey)
    ek, nn = aead_params(mk)
    ct = AESGCM(ek).encrypt(nn, plaintext, ad)
    st.Ns += 1
    return mk, h, ad, ct

def recv(st, h, ct, plaintext_len, chat_id, sender_dev, sender_kg, recip_dev, recip_kg, sid, prekey_hash, next_priv):
    if st.DHr != h["dh"]:
        dh_ratchet(st, h["dh"], next_priv)
    assert st.Nr == h["n"], (st.Nr, h["n"])
    mk, st.CKr = kdf_ck(st.CKr)
    ad = ad_bytes(chat_id=chat_id, sender_device_id=sender_dev, sender_kg=sender_kg,
                  recipient_device_id=recip_dev, recipient_kg=recip_kg, session_id=sid,
                  preamble_hash=prekey_hash, header=h, prekey=prekey_hash != b"\x00"*32)
    ek, nn = aead_params(mk)
    pt = AESGCM(ek).decrypt(nn, ct, ad)
    st.Nr += 1
    return mk, pt

# Alice init
alice = State(rk0, S["alice-ratchet-0"], PUB["alice-ratchet-0"], dhr=b_spk_pub)
alice.RK, alice.CKs = kdf_rk(alice.RK, dh(alice.DHs_priv, alice.DHr))
# Bob init: signing key is SPK; Bob does not run a receiving ratchet until first message
bob = State(rk0, S["bob-spk"], spk_b_pub, dhr=None)

trace = []
pt1 = padded1
mk1, h1, ad1b, ct1b = send(alice, pt1, CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID, pre_hash, True)
trace.append({"step": "A->B m1", "message_key": mk1.hex(), "header": {"dh": h1["dh"].hex(), "pn": h1["pn"], "n": h1["n"]},
              "ad_hex": ad1b.hex(), "ciphertext": ct1b.hex()})
# Bob receive m1
mk1b, got = recv(bob, h1, ct1b, len(pt1), CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID, pre_hash, S['bob-ratchet-1'])
assert got == pt1 and mk1b == mk1
# Bob replies
pt2 = pad_plaintext(json.dumps({"text": "Привет, Алиса!", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode())
mk2, h2, ad2b, ct2b = send(bob, pt2, CHAT, BOB_DEV, 1, ALICE_DEV, 1, SID)
trace.append({"step": "B->A r1", "message_key": mk2.hex(), "header": {"dh": h2["dh"].hex(), "pn": h2["pn"], "n": h2["n"]},
              "ad_hex": ad2b.hex(), "ciphertext": ct2b.hex(),
              "plaintext_hex": pt2.hex()})
# Alice receive r1
mk2b, got2 = recv(alice, h2, ct2b, len(pt2), CHAT, BOB_DEV, 1, ALICE_DEV, 1, SID, b"\x00"*32, S['alice-ratchet-1'])
assert got2 == pt2 and mk2b == mk2
# Alice m2
pt3 = pad_plaintext(json.dumps({"text": "Сообщение 2", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode())
mk3, h3, ad3, ct3 = send(alice, pt3, CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID)
trace.append({"step": "A->B m2", "message_key": mk3.hex(), "header": {"dh": h3["dh"].hex(), "pn": h3["pn"], "n": h3["n"]},
              "ad_hex": ad3.hex(), "ciphertext": ct3.hex(), "plaintext_hex": pt3.hex()})
mk3b, got3 = recv(bob, h3, ct3, len(pt3), CHAT, ALICE_DEV, 1, BOB_DEV, 1, SID, b"\x00"*32, S['bob-ratchet-2'])
assert got3 == pt3 and mk3b == mk3
# Bob r2
pt4 = pad_plaintext(json.dumps({"text": "Ответ 2", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode())
mk4, h4, ad4, ct4 = send(bob, pt4, CHAT, BOB_DEV, 1, ALICE_DEV, 1, SID)
trace.append({"step": "B->A r2", "message_key": mk4.hex(), "header": {"dh": h4["dh"].hex(), "pn": h4["pn"], "n": h4["n"]},
              "ad_hex": ad4.hex(), "ciphertext": ct4.hex(), "plaintext_hex": pt4.hex()})
# r2 is not processed by Alice in this trace (no A2 ratchet key needed); ciphertext + MK are still normative

add("E-double-ratchet", "Full Double Ratchet conversation (4 messages, 2 DH ratchet turns)", True, [
  {"id": "E1-conversation-trace", "kind": "double_ratchet",
   "note": "Alice initiates with the prekey envelope (m1). Bob's initial ratchet private key is the signed prekey. After m1 Bob performs the first DH ratchet and replies with a fresh ratchet key. Counters: pn = messages sent in previous sending chain, n = index in current chain.",
   "initial_state": {
     "x3dh_sk": rk0.hex(), "session_id": SID.hex(),
     "alice_ratchet_0_private": S["alice-ratchet-0"].hex(),
     "alice_ratchet_0_public": PUB["alice-ratchet-0"].hex(),
     "bob_signed_prekey_private": S["bob-spk"].hex(),
     "bob_signed_prekey_public": spk_b_pub.hex(),
     "alice_ratchet_1_private": S["alice-ratchet-1"].hex(),
     "alice_ratchet_1_public": PUB["alice-ratchet-1"].hex(),
     "bob_ratchet_1_private": S["bob-ratchet-1"].hex(),
     "bob_ratchet_1_public": PUB["bob-ratchet-1"].hex(),
     "bob_ratchet_2_private": S["bob-ratchet-2"].hex(),
     "bob_ratchet_2_public": PUB["bob-ratchet-2"].hex(),
     "note_ratchet_derivation": "Both sides: RK_1||CK = HKDF(ikm=DH(ratchet, peer ratchet pub), salt=SK, info=dr-root, L=64)."
   },
   "expected_steps": trace}
])

# ---------- E2. skipped message keys / out-of-order delivery ----------
sess2 = sha256(b"krug-vector-skip-session")[:16]
ck_s = hkdf(sha256(b"krug-vector-skip-seed"), Z32, b"Krug/E2EE/v1/dr-root", 32)
dh_s = PUB["alice-ratchet-0"]
skip_msgs = []
ck = ck_s
for n in range(3):
    mk, ck = kdf_ck(ck)
    body = pad_plaintext(json.dumps({"text": f"skip test {n+1}", "reply_to_id": None},
                                    ensure_ascii=False, separators=(",", ":")).encode())
    h = {"dh": dh_s, "pn": 0, "n": n}
    ad = ad_bytes(chat_id=CHAT, sender_device_id=ALICE_DEV, sender_kg=1,
                  recipient_device_id=BOB_DEV, recipient_kg=1, session_id=sess2,
                  preamble_hash=b"\x00" * 32, header=h, prekey=False)
    ek, nn = aead_params(mk)
    ct = AESGCM(ek).encrypt(nn, body, ad)
    skip_msgs.append({"n": n, "message_key": mk.hex(), "header": {"dh": h["dh"].hex(), "pn": 0, "n": n},
                      "ad_hex": ad.hex(), "ciphertext": ct.hex(), "plaintext_hex": body.hex()})

add("E2-skipped-keys", "Out-of-order delivery and skipped message keys", True, [
  {"id": "E2-skipped-key-trace", "kind": "double_ratchet_skipped",
   "note": "Post-handshake chain (no prekey). Receiver gets m1 (n=0), then m3 (n=2): it MUST derive and store the key for n=1, decrypt m3, and later decrypt m2 from the stored key. Duplicate n must be rejected; gap > MAX_SKIP (1000) must be rejected.",
   "inputs": {"session_id": sess2.hex(), "chain_key_0": ck_s.hex(),
              "ratchet_public": dh_s.hex(), "chat_id": CHAT_S,
              "sender_device_id": ALICE_DEV_S, "recipient_device_id": BOB_DEV_S},
   "expected": {"messages": skip_msgs,
                "delivery_order": [0, 2, 1],
                "skipped_message_key_n1": skip_msgs[1]["message_key"],
                "receiver_state_after_m3": {"Nr": 3,
                  "stored_skipped": [{"n": 1, "message_key": skip_msgs[1]["message_key"]}]},
                "receiver_state_after_m2": {"Nr": 3, "stored_skipped": []}}}
])

# ---------- F. envelope serialization ----------
prekey_obj = {
  "sender_identity_signing_key": b64u(EDPUB["alice-ik-sig"]),
  "sender_identity_dh_key": b64u(PUB["alice-ik-dh"]),
  "sender_ephemeral_key": b64u(PUB["alice-ek"]),
  "recipient_identity_dh_key": b64u(ik_b_dh_pub),
  "spk_id": "spk-1",
  "spk_public": b64u(spk_b_pub),
  "opk_id": "opk-1",
  "opk_public": b64u(opk_b_pub),
  "signature": b64u(pre_sig)
}
env1 = {
  "v": 1,
  "scheme": "PAIRWISE_X3DH_DR",
  "chat_id": CHAT_S,
  "sender_device_id": ALICE_DEV_S,
  "sender_key_generation": 1,
  "recipient_device_id": BOB_DEV_S,
  "recipient_key_generation": 1,
  "session_id": b64u(SID),
  "header": {"v": 1, "dh": b64u(h1["dh"]), "pn": h1["pn"], "n": h1["n"]},
  "ciphertext": b64u(ct1b),
  "prekey": prekey_obj
}
env1_text = json.dumps(env1, ensure_ascii=False, separators=(",", ":"))
env2 = {
  "v": 1, "scheme": "PAIRWISE_X3DH_DR", "chat_id": CHAT_S,
  "sender_device_id": ALICE_DEV_S, "sender_key_generation": 1,
  "recipient_device_id": BOB_DEV_S, "recipient_key_generation": 1,
  "session_id": b64u(SID),
  "header": {"v": 1, "dh": b64u(h3["dh"]), "pn": h3["pn"], "n": h3["n"]},
  "ciphertext": b64u(ct3)
}
env2_text = json.dumps(env2, ensure_ascii=False, separators=(",", ":"))

add("F-envelope", "Envelope JSON serialization", True, [
  {"id": "F1-envelope-prekey", "kind": "envelope",
   "note": "Wire object exactly as sent inside POST /messages envelopes[]. b64url values are unpadded. JSON text is illustrative; field values are normative.",
   "expected": {"envelope_json": env1_text, "envelope_len_bytes": len(env1_text.encode()),
                "decoded": {"header_hex": header_bytes(h1).hex(),
                            "ad_hex": ad1b.hex(), "preamble_hex": pre.hex(),
                            "preamble_sha256": pre_hash.hex(), "ciphertext_hex": ct1b.hex(),
                            "session_id_hex": SID.hex()}}},
  {"id": "F2-envelope-no-prekey", "kind": "envelope",
   "note": "No prekey block: flags bit0 = 0, preamble_hash = 32 zero bytes. Same session and chain (n=0 after ratchet).",
   "expected": {"envelope_json": env2_text, "envelope_len_bytes": len(env2_text.encode()),
                "decoded": {"header_hex": header_bytes(h3).hex(), "ad_hex": ad3.hex(),
                            "ciphertext_hex": ct3.hex()}}}
])

# ---------- G. verification ----------
sn_digest, sn_digits, sn_display = safety_number([
    (ALICE_USER, ALICE_DEV, FP_A), (BOB_USER, BOB_DEV, FP_B)])
vhash = verification_hash(CHAT, ALICE_USER, ALICE_DEV, BOB_DEV, 1, sn_digits)

# key change: Bob re-registers with a new identity key seed (new device id, same user)
bob2 = seed("bob-ik-sig-2")
fp_b2 = fingerprint(edpub(bob2), PUB["bob-ik-dh"])
_, digits2, display2 = safety_number([(ALICE_USER, ALICE_DEV, FP_A), (BOB_USER, BOB_DEV, fp_b2)])

qr = ("krug://verify/v1?dev1=" + ALICE_DEV_S + "&fp1=" + b64u(FP_A) +
      "&dev2=" + BOB_DEV_S + "&fp2=" + b64u(FP_B))

add("G-verification", "Fingerprints, safety number and verification metadata", True, [
  {"id": "G1-device-fingerprint", "kind": "fingerprint",
   "note": "FP = SHA-256(domain || IK_sig_pub || IK_dh_pub). 32 bytes.",
   "inputs": {"identity_signing_key": EDPUB["alice-ik-sig"].hex(),
              "identity_dh_key": PUB["alice-ik-dh"].hex(), "domain": D_FP.decode()},
   "expected": {"alice_fingerprint": FP_A.hex(), "bob_fingerprint": FP_B.hex()}},
  {"id": "G2-safety-number", "kind": "safety_number",
   "note": "Per device pair: two 80-byte entries (user_id||device_id||FP), sorted lexicographically; SHA-512; decimal mod 10^60, zero-padded; displayed as 12 groups of 5.",
   "inputs": {"entries": [
       {"user_id": ALICE_USER_S, "device_id": ALICE_DEV_S, "fingerprint": FP_A.hex()},
       {"user_id": BOB_USER_S, "device_id": BOB_DEV_S, "fingerprint": FP_B.hex()}]},
   "expected": {"sha512": sn_digest.hex(), "digits": sn_digits, "display": sn_display,
                "qr_payload": qr}},
  {"id": "G3-safety-number-after-key-change", "kind": "safety_number",
   "note": "Bob's device re-registered with a new identity signing key: digits MUST change; the old verification is invalid.",
   "inputs": {"entries": [
       {"user_id": ALICE_USER_S, "device_id": ALICE_DEV_S, "fingerprint": FP_A.hex()},
       {"user_id": BOB_USER_S, "device_id": BOB_DEV_S, "fingerprint": fp_b2.hex()}]},
   "expected": {"sha512": hashlib.sha512(D_SN + u8(1) + u32(2) + ALICE_USER + ALICE_DEV + FP_A + BOB_USER + BOB_DEV + fp_b2).hexdigest(),
                "digits": digits2, "display": display2}},
  {"id": "G4-verification-hash", "kind": "verification_hash",
   "note": "Client sends only this hash in PUT /chats/{id}/keys/verification; the server never sees the digits or keys.",
   "inputs": {"chat_id": CHAT_S, "verifier_user_id": ALICE_USER_S,
              "target_device_id": BOB_DEV_S, "target_key_generation": 1, "safety_number_digits": sn_digits},
   "expected": {"safety_number_hash": vhash.hex()}}
])

# ---------- H. sender key (informative, groups = next phase) ----------
sk_seed = seed("sender-key-alice")
sk_ck0 = hkdf(sk_seed, Z32, b"Krug/E2EE/v1/sender-key", 32)
sk_mk0, sk_ck1 = kdf_ck(sk_ck0)
sk_mk1, sk_ck2 = kdf_ck(sk_ck1)
sk_ek0, sk_n0 = hkdf(sk_mk0, Z32, b"Krug/E2EE/v1/sender-aead-key", 32), hkdf(sk_mk0, Z32, b"Krug/E2EE/v1/sender-aead-nonce", 12)
sk_body = json.dumps({"text": "групповое сообщение", "reply_to_id": None}, ensure_ascii=False, separators=(",", ":")).encode()
sk_padded = pad_plaintext(sk_body)
sk_ad = b"Krug/E2EE/v1/sender-ad" + u8(1) + CHAT + BOB_DEV + u32(0) + u32(0)
sk_ct = AESGCM(sk_ek0).encrypt(sk_n0, sk_padded, sk_ad)

add("H-sender-key", "Sender key chain (INFORMATIVE — groups are out of E7 scope, ADR-05)", False, [
  {"id": "H1-sender-key-chain", "kind": "sender_key",
   "note": "NOT part of E7 acceptance. Same KDF_CK as DR; per-epoch chain; no PCS across epochs. Included so E7 vectors do not need revision when groups start.",
   "inputs": {"epoch_seed": sk_seed.hex(), "domain": "Krug/E2EE/v1/sender-key", "epoch": 0},
   "expected": {"chain_key_0": sk_ck0.hex(), "message_key_0": sk_mk0.hex(),
                "chain_key_1": sk_ck1.hex(), "message_key_1": sk_mk1.hex(), "chain_key_2": sk_ck2.hex()}},
  {"id": "H2-sender-key-aead", "kind": "sender_key_message",
   "note": "AD for sender-key messages (informative): domain||v||chat_id||sender_device_id||epoch||n. No recipient device id (one ciphertext for all).",
   "inputs": {"message_key": sk_mk0.hex(), "plaintext_hex": sk_padded.hex(), "ad_hex": sk_ad.hex()},
   "expected": {"aead_key": sk_ek0.hex(), "nonce": sk_n0.hex(), "ciphertext": sk_ct.hex()}}
])

# ============================================================================
# E7-S2 remediation vectors (review E2EE-REVIEW-01 P0-1, P0-2, P0-3, P0-4,
# P1-1, P1-2, P1-3, P1-10). Envelope wire format is unchanged (v=1); VH is v2.
# ============================================================================

def getsec(sid):
    return next(s for s in out["sections"] if s["id"] == sid)

def getv(vid):
    for s in out["sections"]:
        for v in s["vectors"]:
            if v["id"] == vid:
                return v
    raise KeyError(vid)

# ---------- B5. identity binding signature (P1-2) ----------
alice_bind_msg = identity_binding_message(PUB["alice-ik-dh"], EDPUB["alice-ik-sig"])
alice_bind_sig = edsign(S["alice-ik-sig"], alice_bind_msg)
bob_bind_msg = identity_binding_message(PUB["bob-ik-dh"], EDPUB["bob-ik-sig"])
bob_bind_sig = edsign(S["bob-ik-sig"], bob_bind_msg)
wrong_bind_msg = identity_binding_message(PUB["mallory-ik-dh"], EDPUB["alice-ik-sig"])
assert edverify(EDPUB["alice-ik-sig"], alice_bind_msg, alice_bind_sig)
assert edverify(EDPUB["bob-ik-sig"], bob_bind_msg, bob_bind_sig)
assert not edverify(EDPUB["alice-ik-sig"], wrong_bind_msg, alice_bind_sig)
assert not edverify(EDPUB["bob-ik-sig"], alice_bind_msg, alice_bind_sig)
assert len(alice_bind_msg) == 88

getsec("B-x3dh")["vectors"].append({
  "id": "B5-identity-binding-signature",
  "kind": "identity_binding_signature",
  "note": ("Self-signature binding IK_sig -> IK_dh (P1-2). Signed message = D_IKBIND || u8(1) || IK_dh_pub || IK_sig_pub (88 bytes). "
           "POST /devices stores it; the server verifies it; the client MUST re-verify it on every claim and on every key change, "
           "before trusting the bundle or updating the TOFU pin."),
  "inputs": {
    "domain": D_IKBIND.decode(), "version": 1,
    "alice_ik_sig_public": EDPUB["alice-ik-sig"].hex(),
    "alice_ik_dh_public": PUB["alice-ik-dh"].hex(),
    "bob_ik_sig_public": EDPUB["bob-ik-sig"].hex(),
    "bob_ik_dh_public": PUB["bob-ik-dh"].hex(),
    "alice_signed_message": alice_bind_msg.hex(),
    "bob_signed_message": bob_bind_msg.hex()
  },
  "expected": {
    "alice_identity_binding_signature": alice_bind_sig.hex(),
    "bob_identity_binding_signature": bob_bind_sig.hex(),
    "alice_binding_verifies": True,
    "bob_binding_verifies": True,
    "mismatched_ik_dh_verifies": False,
    "wrong_signer_verifies": False,
    "signed_message_len": len(alice_bind_msg)
  }
})

# ---------- P2-3: E1/E2 headers are complete wire headers now ----------
for step in getv("E1-conversation-trace")["expected_steps"]:
    step["header"] = {"v": 1, "dh": step["header"]["dh"], "pn": step["header"]["pn"], "n": step["header"]["n"]}
for msg in getv("E2-skipped-key-trace")["expected"]["messages"]:
    msg["header"] = {"v": 1, "dh": msg["header"]["dh"], "pn": msg["header"]["pn"], "n": msg["header"]["n"]}

# ---------- G4 v2 and G5 per-verifier-device (P0-1) ----------
g4 = getv("G4-verification-hash")
g4["note"] = ("VH v2 (P0-1): the verifier's DEVICE is part of the hash. "
              "VH = SHA-256(D_VER || u8(2) || chat_id(16) || verifier_user_id(16) || verifier_device_id(16) || "
              "target_device_id(16) || u32(target_key_generation) || ascii(digits_60)). "
              "Rows created with u8(1) MUST be treated as unverified (migration: verifier_device_id IS NULL).")
g4["inputs"] = {
  "chat_id": CHAT_S,
  "verifier_user_id": ALICE_USER_S,
  "verifier_device_id": ALICE_DEV_S,
  "target_device_id": BOB_DEV_S,
  "target_key_generation": 1,
  "safety_number_digits": sn_digits,
  "vh_version": 2
}
g4["expected"] = {"safety_number_hash": vhash.hex(), "vh_version": 2}

_, sn2_digits, sn2_display = safety_number([
    (ALICE_USER, ALICE2_DEV, FP_A2), (BOB_USER, BOB_DEV, FP_B)])
vh_l1 = verification_hash(CHAT, ALICE_USER, ALICE_DEV, BOB_DEV, 1, sn_digits)
vh_l2 = verification_hash(CHAT, ALICE_USER, ALICE2_DEV, BOB_DEV, 1, sn2_digits)
assert vh_l1 != vh_l2 and sn_digits != sn2_digits

getsec("G-verification")["vectors"].append({
  "id": "G5-verification-per-device",
  "kind": "verification_hash_per_device",
  "note": ("P0-1 regression: Alice has two devices (L1=...011, L2=...012). L1 verified Bob in this chat; L2 never did. "
           "The device-pair safety numbers differ (L2 has a different fingerprint/device_id), VH v2 binds the verifier device, "
           "and GET /chats/{id}/keys returned to L2 MUST report verified=null for Bob. A server-side boolean keyed only by user is a defect."),
  "inputs": {
    "chat_id": CHAT_S,
    "verifier_user_id": ALICE_USER_S,
    "verifier_device_id_l1": ALICE_DEV_S,
    "verifier_device_id_l2": ALICE2_DEV_S,
    "target_device_id": BOB_DEV_S,
    "target_key_generation": 1,
    "l1_safety_number_digits": sn_digits,
    "l2_safety_number_digits": sn2_digits,
    "l2_fingerprint": FP_A2.hex()
  },
  "expected": {
    "l1_verification_hash": vh_l1.hex(),
    "l2_verification_hash": vh_l2.hex(),
    "hashes_differ": True,
    "device_pair_digits_differ": True,
    "server_verified_for_l1": True,
    "server_verified_for_l2": None,
    "l2_verified_at": None,
    "verifier_device_bound_in_hash": True,
    "l2_display": sn2_display
  }
})

# ---------- I. TOFU pinning of the sender identity (P0-2) ----------
m_x = x3dh(S["mallory-ik-dh"], S["mallory-ek"], PUB["bob-ik-dh"], PUB["bob-spk"], PUB["bob-opk"])
M_SID = m_x["session_id"]
m_pre = preamble(chat_id=CHAT, sender_device_id=ALICE_DEV, recipient_device_id=BOB_DEV,
                 ik_sig_pub=EDPUB["mallory-ik-sig"], ik_dh_pub=PUB["mallory-ik-dh"],
                 ek_pub=PUB["mallory-ek"], recipient_ik_dh_pub=PUB["bob-ik-dh"],
                 recipient_ik_sig_pub=EDPUB["bob-ik-sig"], spk_id="spk-1",
                 spk_pub=PUB["bob-spk"], opk_id="opk-1", opk_pub=PUB["bob-opk"],
                 session_id=M_SID)
m_pre_hash = sha256(m_pre)
m_sig = edsign(S["mallory-ik-sig"], prekey_sig_message(m_pre))
assert edverify(EDPUB["mallory-ik-sig"], prekey_sig_message(m_pre), m_sig)
m_rk, m_cks = kdf_rk(m_x["sk"], dh(S["mallory-ratchet-0"], PUB["bob-spk"]))
m_mk, _ = kdf_ck(m_cks)
m_hdr = {"dh": PUB["mallory-ratchet-0"], "pn": 0, "n": 0}
m_ad = ad_bytes(chat_id=CHAT, sender_device_id=ALICE_DEV, sender_kg=1,
                recipient_device_id=BOB_DEV, recipient_kg=1, session_id=M_SID,
                preamble_hash=m_pre_hash, header=m_hdr, prekey=True)
m_body = pad_plaintext(json.dumps({"text": "Это не Алиса", "reply_to_id": None},
                                  ensure_ascii=False, separators=(",", ":")).encode())
m_enc, m_nonce = aead_params(m_mk)
m_ct = AESGCM(m_enc).encrypt(m_nonce, m_body, m_ad)
assert AESGCM(m_enc).decrypt(m_nonce, m_ct, m_ad) == m_body

env_m = {
  "v": 1, "scheme": "PAIRWISE_X3DH_DR", "chat_id": CHAT_S,
  "sender_device_id": ALICE_DEV_S, "sender_key_generation": 1,
  "recipient_device_id": BOB_DEV_S, "recipient_key_generation": 1,
  "session_id": b64u(M_SID),
  "header": {"v": 1, "dh": b64u(m_hdr["dh"]), "pn": 0, "n": 0},
  "ciphertext": b64u(m_ct),
  "prekey": {
    "sender_identity_signing_key": b64u(EDPUB["mallory-ik-sig"]),
    "sender_identity_dh_key": b64u(PUB["mallory-ik-dh"]),
    "sender_ephemeral_key": b64u(PUB["mallory-ek"]),
    "recipient_identity_dh_key": b64u(PUB["bob-ik-dh"]),
    "spk_id": "spk-1", "spk_public": b64u(PUB["bob-spk"]),
    "opk_id": "opk-1", "opk_public": b64u(PUB["bob-opk"]),
    "signature": b64u(m_sig)
  }
}
env_m_text = json.dumps(env_m, ensure_ascii=False, separators=(",", ":"))

_, m_digits, m_display = safety_number([
    (ALICE_USER, ALICE_DEV, FP_M), (BOB_USER, BOB_DEV, FP_B)])
assert m_digits != sn_digits

mallory_bind_msg = identity_binding_message(PUB["mallory-ik-dh"], EDPUB["mallory-ik-sig"])
mallory_bind_sig = edsign(S["mallory-ik-sig"], mallory_bind_msg)
assert edverify(EDPUB["mallory-ik-sig"], mallory_bind_msg, mallory_bind_sig)

pin_original = {
  "user_id": ALICE_USER_S, "device_id": ALICE_DEV_S,
  "ik_sig": EDPUB["alice-ik-sig"].hex(), "ik_dh": PUB["alice-ik-dh"].hex(),
  "fingerprint": FP_A.hex(), "identity_binding_signature": alice_bind_sig.hex(),
  "key_generation": 1, "verified": False
}

add("I-tofu", "TOFU pinning of the sender identity per device_id (P0-2, negative test)", True, [
  {"id": "I1-tofu-first-contact-no-pin",
   "kind": "tofu_decision",
   "note": ("First contact: no pin for sender_device_id. The recipient verifies the preamble signature, then the IK_sig->IK_dh "
            "binding, then records the TOFU pin BEFORE showing the message. Acceptance is honest but the device is UNVERIFIED; "
            "the safety number must be compared out-of-band. This vector also demonstrates the residual TOFU window: keys substituted "
            "at first contact are not detected by pinning."),
   "inputs": {
     "presented_device_id": ALICE_DEV_S, "presented_user_id": ALICE_USER_S,
     "presented_ik_sig": EDPUB["mallory-ik-sig"].hex(),
     "presented_ik_dh": PUB["mallory-ik-dh"].hex(),
     "presented_fingerprint": FP_M.hex(), "local_pin": None,
     "presented_identity_binding_signature": mallory_bind_sig.hex(),
     "identity_binding_source": "GET /chats/{id}/keys (device keys), not the envelope",
     "envelope_json": env_m_text,
     "recipient_ik_dh": PUB["bob-ik-dh"].hex(), "recipient_ik_sig": EDPUB["bob-ik-sig"].hex()
   },
   "expected": {
     "preamble_signature_valid": True,
     "identity_binding_present": True,
     "identity_binding_verified": True,
     "identity_binding_source": "GET /chats/{id}/keys (device keys), not the envelope",
     "binding_prevents_substitution": False,
     "identity_binding_required_for_new_devices": True,
     "pin_created": True,
     "pinned_identity_binding_signature": mallory_bind_sig.hex(),
     "pinned_device_id": ALICE_DEV_S,
     "pinned_fingerprint": FP_M.hex(),
     "verified": False,
     "warning": "TOFU_FIRST_CONTACT_UNVERIFIED",
     "session_created": True,
     "message_displayed": True,
     "safety_number_digits": m_digits,
     "safety_number_differs_from_expected_peer": True,
     "residual_risk": "TOFU window: attacker present at first contact is not detected by pinning"
   }},
  {"id": "I2-tofu-identity-mismatch",
   "kind": "tofu_decision",
   "note": ("P0-2 negative: the server substitutes the identity pair for an EXISTING device_id. The prekey envelope is wire-valid, "
            "the preamble signature verifies (Mallory's own keys), recipient keys/session_id/AD/AEAD all pass. Only the local pin "
            "(device_id -> IK_sig/IK_dh/fingerprint) detects the substitution. MUST be KEY_CHANGE_DETECTED: do not create/overwrite "
            "the session, do not display, do not consume the OPK, block sending until explicit user confirmation."),
   "inputs": {
     "presented_device_id": ALICE_DEV_S,
     "presented_ik_sig": EDPUB["mallory-ik-sig"].hex(),
     "presented_ik_dh": PUB["mallory-ik-dh"].hex(),
     "presented_fingerprint": FP_M.hex(),
     "local_pin": pin_original,
     "presented_identity_binding_signature": mallory_bind_sig.hex(),
     "envelope_json": env_m_text,
     "presented_safety_number_digits": m_digits
   },
   "expected": {
     "signature_valid": True,
     "preamble_valid": True,
     "recipient_keys_match": True,
     "session_id_matches": True,
     "aead_valid": True,
     "identity_binding_verified": True,
     "binding_prevents_substitution": False,
     "pin_exists": True,
     "pinned_fingerprint": FP_A.hex(),
     "presented_fingerprint": FP_M.hex(),
     "pin_mismatch": True,
     "decision": "KEY_CHANGE_DETECTED",
     "session_created": False,
     "session_overwritten": False,
     "message_displayed": False,
     "opk_consumed": False,
     "send_blocked_until_confirmation": True,
     "verified_reset": True,
     "server_event_reason": "IDENTITY_KEY_CHANGED",
     "requires_user_confirmation": True
   }}
])

# ---------- J. security_mode immutability (P0-3, P1-12) ----------
add("J-security-mode", "security_mode immutability and downgrade resistance (P0-3, P1-12)", True, [
  {"id": "J1-security-mode-downgrade-rejected",
   "kind": "security_mode_immutability",
   "note": ("A downgrade of an existing E2EE chat is an attack, not configuration. Server: immutable column + trigger "
            "(409 MODE_CHANGE_FORBIDDEN), no API to change the mode. Client: pins chat_id -> security_mode; if the server "
            "reports MANAGED for a pinned E2EE chat, it MUST NOT send plaintext and MUST show a security alert. "
            "Switching modes requires a NEW chat."),
   "inputs": {
     "chat_id": CHAT_S,
     "workspace_security_mode_at_creation": "E2EE",
     "chat_security_mode_at_creation": "E2EE",
     "client_pinned_security_mode": "E2EE",
     "server_reported_security_mode": "MANAGED",
     "attempted_operation": "UPDATE chat.chats SET security_mode = 'MANAGED'"
   },
   "expected": {
     "server_decision": "409 MODE_CHANGE_FORBIDDEN",
     "db_guard": "trg_chats_security_mode_immutable",
     "mode_changed": False,
     "client_decision": "BLOCK_SEND_SECURITY_ALERT",
     "plaintext_messages_sent": 0,
     "plaintext_envelopes_accepted": 0,
     "badge": "E2EE (pinned locally)",
     "requires_new_chat": True,
     "downgrade_is_attack": True
   }},
  {"id": "J2-e2ee-creation-with-flag-off",
   "kind": "feature_flag_conformance",
   "note": ("P1-12: with e2ee.enabled=false the server MUST NOT create E2EE workspaces/chats and MUST NOT show the E2EE badge. "
            "Existing E2EE chats, if any, remain E2EE and MUST NOT accept plaintext; the flag only gates NEW E2EE surfaces."),
   "inputs": {
     "e2ee_enabled": False,
     "operation": "POST /workspaces {security_mode: 'E2EE'}",
     "existing_e2ee_chat_security_mode": "E2EE",
     "plaintext_attempt": "POST /chats/{id}/messages {text: 'x'}"
   },
   "expected": {
     "workspace_created": False,
     "chat_created": False,
     "http_status": 409,
     "code": "E2EE_DISABLED",
     "badge_shown": False,
     "existing_e2ee_chat_plaintext": "422 E2EE_PLAINTEXT_FORBIDDEN",
     "flag_off_closes_existing_mode": False
   }}
])

# ---------- K. client_message_id scope (P1-10, D-07) ----------
CID = "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e10"
CID_MSG = "8b0f3c1d-2e4a-4b6c-8d0e-1f2a3b4c5d6e"
add("K-client-message-id", "client_message_id uniqueness scope and cross-user replay (P1-10, D-07)", True, [
  {"id": "K1-client-message-id-same-sender-replay",
   "kind": "client_message_id_scope",
   "note": ("Scope is (chat_id, sender_id, client_message_id). A repeat by the SAME sender with the same body is an idempotent "
            "replay (same id/seq). The value MUST be echoed in Message and MUST NOT be included in AD."),
   "inputs": {
     "chat_id": CHAT_S, "sender_user_id": ALICE_USER_S, "client_message_id": CID,
     "existing_message_id": CID_MSG, "repeat_sender_user_id": ALICE_USER_S,
     "repeat_body": "same envelope bytes", "unique_key": ["chat_id", "sender_id", "client_message_id"]
   },
   "expected": {
     "http_status": 201, "code": None, "idempotent_replay": True,
     "same_message_id": True, "same_seq": True,
     "db_index": "ux_<partition>_chat_sender_client",
     "unique_key": ["chat_id", "sender_id", "client_message_id"],
     "in_ad": False
   }},
  {"id": "K2-client-message-id-cross-user-conflict",
   "kind": "client_message_id_scope",
   "note": ("A different sender using the same UUID in the same chat MUST NOT receive the first user's message as a replay. "
            "The lookup is sender-scoped; otherwise a 201 replay leaks another user's message. Expected: 409 CLIENT_MESSAGE_ID_CONFLICT."),
   "inputs": {
     "chat_id": CHAT_S,
     "first": {"sender_user_id": ALICE_USER_S, "client_message_id": CID, "message_id": CID_MSG},
     "second": {"sender_user_id": BOB_USER_S, "client_message_id": CID},
     "lookup_filter": ["workspace_id", "chat_id", "sender_id", "client_message_id"]
   },
   "expected": {
     "http_status": 409,
     "code": "CLIENT_MESSAGE_ID_CONFLICT",
     "idempotent_replay": False,
     "returns_other_users_message": False,
     "sender_scoped": True,
     "message_created": False
   }}
])

# ---------- L. R-15: undecryptable session signal (P1-1) ----------
reset_body_obj = {
  "failed_session_id": b64u(SID),
  "failed_n": 3,
  "reason": "DECRYPT_FAILED",
  "retry_of_client_message_id": CID
}
reset_body = json.dumps(reset_body_obj, ensure_ascii=False, separators=(",", ":")).encode()
reset_raw = D_PAY + u8(1) + u8(2) + u32(len(reset_body)) + reset_body
reset_pad = (-len(reset_raw)) % 256
reset_padded = reset_raw + b"\x00" * reset_pad

add("L-session-reset", "R-15: undecryptable-session signal (P1-1)", True, [
  {"id": "L1-session-reset-payload",
   "kind": "inner_payload_session_reset",
   "note": ("content_type=2 (SESSION_RESET), a control payload inside a NEW prekey envelope; not user-visible. "
            "Unauthenticated WS events are NOT used for reset (spoofable). The sender of the failed message receives this "
            "control payload, tears down the failed session, claims a fresh bundle, and resends with a NEW client_message_id."),
   "inputs": {
     "content_type": 2, "content_type_name": "SESSION_RESET",
     "body_utf8": reset_body.decode(), "body_hex": reset_body.hex(), "body_len": len(reset_body),
     "domain": D_PAY.decode()
   },
   "expected": {
     "raw_len": len(reset_raw), "padded_len": len(reset_padded),
     "padding_zero_bytes": reset_pad, "padded_hex": reset_padded.hex(),
     "payload_sha256": sha256(reset_padded).hex(),
     "user_visible": False,
     "requires_prekey_session": True,
     "transport": "prekey_envelope_content_type_2"
   }},
  {"id": "L2-session-reset-state-machine",
   "kind": "session_reset_state_machine",
   "note": ("R-15 mitigation: the receiver never silently drops; it emits an encrypted reset signal, rate-limited to one per "
            "failed session, and the sender performs exactly one new prekey handshake. The retry is a NEW message with a NEW "
            "client_message_id (the old id already points at the old ciphertext); UI replaces the local pending copy, not duplicates it."),
   "inputs": {
     "trigger_errors": ["KEY_HANDSHAKE_INVALID", "UNKNOWN_SPK", "DECRYPT_FAILED"],
     "transport": "prekey_envelope_content_type_2",
     "ws_event_used": False,
     "cooldown_seconds": 300,
     "max_resets_per_failed_session": 1
   },
   "expected": {
     "recipient_emits_reset": True,
     "reset_is_user_visible": False,
     "reset_counts_as_user_message": False,
     "sender_deletes_failed_session": True,
     "sender_claims_new_bundle": True,
     "resend_uses_new_client_message_id": True,
     "old_client_message_id_reused": False,
     "old_ciphertext_reused": False,
     "ui_shows_retry_not_duplicate": True,
     "metric": "e2ee_prekey_undecrypted_24h",
     "max_reset_attempts": 1
   }}
])

# ---------- limits arithmetic (P1-3) ----------
CT_MAX_DECODED = 33040
ct_max_chars = len(b64u(b"\x00" * CT_MAX_DECODED))
assert ct_max_chars == 44054, ct_max_chars
ct_min_chars = len(b64u(b"\x00" * 272))
assert ct_min_chars == 363, ct_min_chars
env_overhead = len(env1_text.encode()) - len(env1["ciphertext"])
max_env_wire = ct_max_chars + env_overhead
wrapper = len(('{"client_message_id":"%s","type":"TEXT","envelopes":[' % CID).encode()) + 2
REQUEST_LIMIT = 524288
nine = 9 * max_env_wire + wrapper
ten = 10 * max_env_wire + wrapper
limits = {
  "max_message_request_wire_bytes": REQUEST_LIMIT,
  "max_envelopes_per_message": 10,
  "max_inner_body_decoded_bytes": 32768,
  "max_padded_plaintext_bytes": 33024,
  "max_ciphertext_decoded_bytes": CT_MAX_DECODED,
  "max_ciphertext_encoded_chars": ct_max_chars,
  "min_ciphertext_encoded_chars": ct_min_chars,
  "per_envelope_form_cap_encoded_chars": 65536,
  "envelope_json_overhead_bytes": env_overhead,
  "max_envelope_wire_bytes": max_env_wire,
  "request_wrapper_bytes": wrapper,
  "nine_envelopes_wire_bytes": nine,
  "ten_envelopes_wire_bytes": ten,
  "nine_envelopes_kib": round(nine / 1024, 1),
  "ten_envelopes_kib": round(ten / 1024, 1),
  "wire_slack_nine_envelopes_bytes": REQUEST_LIMIT - nine,
  "wire_slack_ten_envelopes_bytes": REQUEST_LIMIT - ten,
  "fanout_budget_per_envelope_bytes": 45056,
  "ten_envelopes_at_budget_bytes": 10 * 45056 + wrapper,
  "decoded_sum_nine_envelopes_bytes": 9 * CT_MAX_DECODED,
  "wire_if_decoded_sum_were_budget_bytes": 699051,
  "max_envelopes_at_canonical_cap_that_fit": 11,
  "max_envelopes_at_form_cap_that_fit": 7,
  "review_measured_nine_envelopes_wire_bytes": 405129,
  "arithmetic_note": ("512 KiB is the WIRE (HTTP body) limit; the old §4.7 compared 512 KiB against the DECODED sum, "
                      "which would allow ~683 KiB on the wire. 9 canonical envelopes = 396 KiB wire; 10 = 440 KiB. "
                      "Per-envelope form cap 65536 encoded chars is NOT a fan-out budget: 10 x 65536 chars > 512 KiB.")
}
assert nine < REQUEST_LIMIT and ten < REQUEST_LIMIT
assert 10 * 65536 > REQUEST_LIMIT
assert nine + 119190 == REQUEST_LIMIT

# ---------- meta updates ----------
out["meta"]["vector_set_version"] = 2
out["meta"]["protocol_envelope_version"] = 1
out["meta"]["supersedes"] = ("vector_set_version 1 (24 vectors, 88 checks). Envelope wire format is unchanged (v=1). "
                             "G4 was recomputed because VH moved to u8(2) with verifier_device_id (P0-1); old u8(1) hashes are untrusted.")
out["meta"]["conventions"]["domains"]["ik_binding"] = D_IKBIND.decode()
out["meta"]["conventions"]["informative_domains"] = {
  "sender_key": "Krug/E2EE/v1/sender-key",
  "sender_ad": "Krug/E2EE/v1/sender-ad",
  "sender_aead_key": "Krug/E2EE/v1/sender-aead-key",
  "sender_aead_nonce": "Krug/E2EE/v1/sender-aead-nonce",
  "note": "H-section only; NOT part of the v1 D_* registry and NOT E7 acceptance criteria."
}
out["meta"]["conventions"]["verification_hash_version"] = 2
out["meta"]["ids"]["alice_verifier_device_2_id"] = ALICE2_DEV_S
out["meta"]["test_seeds"] = {k: v.hex() for k, v in S.items()}
out["meta"]["public_keys"] = {
  "alice_identity_signing_key": EDPUB["alice-ik-sig"].hex(),
  "alice_identity_dh_key": PUB["alice-ik-dh"].hex(),
  "alice_ephemeral_key": PUB["alice-ek"].hex(),
  "alice_fingerprint": FP_A.hex(),
  "alice_identity_binding_signature": alice_bind_sig.hex(),
  "alice_verifier_device_2_identity_signing_key": EDPUB["alice2-ik-sig"].hex(),
  "alice_verifier_device_2_identity_dh_key": PUB["alice2-ik-dh"].hex(),
  "alice_verifier_device_2_fingerprint": FP_A2.hex(),
  "bob_identity_signing_key": EDPUB["bob-ik-sig"].hex(),
  "bob_identity_dh_key": PUB["bob-ik-dh"].hex(),
  "bob_signed_prekey": PUB["bob-spk"].hex(),
  "bob_one_time_prekey": PUB["bob-opk"].hex(),
  "bob_fingerprint": FP_B.hex(),
  "bob_identity_binding_signature": bob_bind_sig.hex(),
  "attacker_identity_signing_key": EDPUB["mallory-ik-sig"].hex(),
  "attacker_identity_dh_key": PUB["mallory-ik-dh"].hex(),
  "attacker_fingerprint": FP_M.hex()
}
out["meta"]["limits"] = limits
out["meta"]["checks"] = {
  "generator": "internal assertions (assert) during generation",
  "verifier": "verify_e2ee_vectors_s2.mjs",
  "verifier_checks": 189,
  "verifier_failures": 0
}
out["meta"]["new_in_v2"] = [
  "B5-identity-binding-signature",
  "G5-verification-per-device",
  "I1-tofu-first-contact-no-pin",
  "I2-tofu-identity-mismatch",
  "J1-security-mode-downgrade-rejected",
  "J2-e2ee-creation-with-flag-off",
  "K1-client-message-id-same-sender-replay",
  "K2-client-message-id-cross-user-conflict",
  "L1-session-reset-payload",
  "L2-session-reset-state-machine"
]
out["meta"]["recomputed_in_v2"] = {
  "G4-verification-hash": "VH v2: verifier_device_id is hashed; expected hash changed",
  "E1-conversation-trace": "header objects in expected_steps now include v=1 (bytes unchanged; P2-3)",
  "E2-skipped-key-trace": "header objects in expected.messages now include v=1 (bytes unchanged; P2-3)"
}
out["meta"]["review"] = {
  "document": "docs/E2EE-REVIEW-01.md",
  "verdict": "GO WITH CONDITIONS",
  "closed_in_this_set": ["P0-1", "P0-2", "P0-3", "P0-4", "P1-1", "P1-2", "P1-3", "P1-4", "P1-5",
                          "P1-6", "P1-7", "P1-8", "P1-9", "P1-10", "P1-11", "P1-12"]
}


out["summary"] = {
  "sections": len(out["sections"]),
  "vectors": sum(len(s["vectors"]) for s in out["sections"]),
  "normative_sections": [s["id"] for s in out["sections"] if s["normative"]],
  "informative_sections": [s["id"] for s in out["sections"] if not s["normative"]]
}

with open("docs/E2EE-TEST-VECTORS.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("written; vectors:", out["summary"]["vectors"], "sections:", out["summary"]["sections"])
print("SK:", rk0.hex())
print("SID:", SID.hex())
print("safety digits:", sn_digits)
print("ct1:", ct1b.hex()[:64], "len", len(ct1b))
print("env1 len", len(env1_text.encode()))
```

### 9.2. Что изменено относительно §2

| Изменение | Зачем | Где в коде |
|---|---|---|
| `D_IKBIND = Krug/E2EE/v1/ik-binding`; `identity_binding_message = D_IKBIND || 01 || IK_dh || IK_sig` | P1-2: самоподпись `IK_sig→IK_dh` | `identity_binding_message`, B5 |
| Новые seeds `alice2-ik-*`, `mallory-ik-*`, `mallory-ek`, `mallory-ratchet-0` | G5 (второе устройство-верификатор) и I2 (валидная, но чужая пара) | блок `S`/`EDPUB` |
| `verification_hash(...)` принимает `verifier_device_id`, `u8(2)` | P0-1: verified per verifier device | G4/G5 |
| G4 пересчитан; G5 добавлен | P0-1 | секция G |
| I1/I2: полный prekey-конверт с валидной подписью/AD/AEAD, но подменённой парой | P0-2 negative | секция I |
| J1/J2, K1/K2, L1/L2 | P0-3/P1-12, P1-10, P1-1 | секции J/K/L |
| `E1/E2.header` получили `"v":1` | P2-3: векторы — валидные wire-объекты; байты не изменились | постобработка `expected_steps/messages` |
| `meta.limits` и `meta.checks` | P1-3: арифметика и проверяемость | конец генератора |
| `meta.conventions.informative_domains` | P2-4: H-домены не входят в v1 | конец генератора |

Криптографические значения A–H (кроме G4) **не подгонялись**: они воспроизводятся из прежних seeds и прежнего кода.

### 9.3. Независимый верификатор S2 (полный исходник)

Сохранить как `verify_e2ee_vectors_s2.mjs` и запустить `node verify_e2ee_vectors_s2.mjs docs/E2EE-TEST-VECTORS.json`. Использует только `node:crypto`/WebCrypto (не код генератора). Ожидаемо: **189 checks, 0 failures**.

```javascript
import fs from 'node:fs';
import crypto from 'node:crypto';
const { webcrypto } = crypto;

const V = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hex = (h) => Buffer.from(h, 'hex');
const b64d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const sha512 = (b) => crypto.createHash('sha512').update(b).digest();
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const XSPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ESPKI = Buffer.from('302a300506032b6570032100', 'hex');
const xpriv = (h) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, hex(h)]), format: 'der', type: 'pkcs8' });
const xpub = (h) => crypto.createPublicKey({ key: Buffer.concat([XSPKI, hex(h)]), format: 'der', type: 'spki' });
const dh = (priv, pub) => crypto.diffieHellman({ privateKey: xpriv(priv), publicKey: xpub(pub) });
const xpubOf = (h) => crypto.createPublicKey(xpriv(h)).export({ format: 'der', type: 'spki' }).subarray(-32);
const edpub = (h) => crypto.createPublicKey({ key: Buffer.concat([ESPKI, hex(h)]), format: 'der', type: 'spki' });
const edverify = (pub, msg, sig) => { try { return crypto.verify(null, msg, edpub(pub), hex(sig)); } catch { return false; } };
const uid = (s) => Buffer.from(s.replace(/-/g, ''), 'hex');
const u8 = (n) => Buffer.from([n]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

const get = (id) => {
  for (const s of V.sections) for (const v of s.vectors) if (v.id === id) return v;
  throw new Error('missing ' + id);
};
let checks = 0, failures = 0;
const ok = (name, cond, extra = '') => {
  checks++;
  if (!cond) { failures++; console.log('FAIL', name, extra); }
  else console.log('ok  ', name);
};
const eq = (name, a, b) => ok(name, a === b, `\n  got ${a}\n  exp ${b}`);

// ---------- meta ----------
eq('meta sections', V.sections.length, 13);
eq('meta vectors', V.sections.reduce((n, s) => n + s.vectors.length, 0), 34);
eq('meta normative sections', V.sections.filter(s => s.normative).length, 12);
eq('meta vector_set_version', V.meta.vector_set_version, 2);
eq('meta protocol envelope version unchanged', V.meta.protocol_envelope_version, 1);
eq('meta ik-binding domain', V.meta.conventions.domains.ik_binding, 'Krug/E2EE/v1/ik-binding');
eq('meta VH version', V.meta.conventions.verification_hash_version, 2);
ok('meta all vector ids unique', new Set(V.sections.flatMap(s => s.vectors.map(v => v.id))).size === 34);

// ---------- A ----------
{
  const v = get('A1-X25519-RFC7748');
  eq('A1 shared', dh(v.inputs.alice_private, v.inputs.bob_public).toString('hex'), v.expected.shared_secret);
  eq('A1 alice pub', xpubOf(v.inputs.alice_private).toString('hex'), v.expected.alice_public_derived);
  eq('A1 bob pub', xpubOf(v.inputs.bob_private).toString('hex'), v.expected.bob_public_derived);
}
{
  const v = get('A2-Ed25519-RFC8032');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), hex(v.inputs.private_seed)]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  eq('A2 pub key', pub.toString('hex'), v.expected.public_key);
  eq('A2 sig', crypto.sign(null, Buffer.from(v.inputs.message, 'utf8'), priv).toString('hex'), v.expected.signature);
  ok('A2 verify', edverify(v.expected.public_key, Buffer.from(v.inputs.message, 'utf8'), v.expected.signature));
}
{
  const v = get('A3-HKDF-SHA256-RFC5869');
  eq('A3 hkdf', hkdf(hex(v.inputs.ikm), hex(v.inputs.salt), hex(v.inputs.info), v.inputs.length).toString('hex'), v.expected.okm);
}
{
  const v = get('A4-AES256GCM-NIST');
  const key = await webcrypto.subtle.importKey('raw', hex(v.inputs.key), 'AES-GCM', false, ['encrypt']);
  const ct = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: hex(v.inputs.nonce), additionalData: Buffer.alloc(0) }, key, Buffer.alloc(0)));
  eq('A4 tag', ct.toString('hex'), v.expected.ciphertext_including_tag);
}

const ids = V.meta.ids, seeds = V.meta.test_seeds, pubs = V.meta.public_keys;
const Z32 = Buffer.alloc(32), F = Buffer.alloc(32, 0xff);
const CHAT = uid(ids.chat_id), A_DEV = uid(ids.alice_device_id), A2_DEV = uid(ids.alice_verifier_device_2_id);
const B_DEV = uid(ids.bob_device_id), A_USER = uid(ids.alice_user_id), B_USER = uid(ids.bob_user_id);

// ---------- B ----------
let sk, sid;
{
  const v = get('B1-X3DH-4DH');
  const dh1 = dh(v.inputs.alice_identity_dh_private, v.inputs.bob_signed_prekey_public);
  const dh2 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_identity_dh_public);
  const dh3 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_signed_prekey_public);
  const dh4 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_one_time_prekey_public);
  eq('B1 dh1', dh1.toString('hex'), v.expected.dh1);
  eq('B1 dh2', dh2.toString('hex'), v.expected.dh2);
  eq('B1 dh3', dh3.toString('hex'), v.expected.dh3);
  eq('B1 dh4', dh4.toString('hex'), v.expected.dh4);
  const ikm = Buffer.concat([F, dh1, dh2, dh3, dh4]);
  eq('B1 ikm', ikm.toString('hex'), v.expected.ikm);
  sk = hkdf(ikm, Z32, Buffer.from(v.inputs.info), 32);
  eq('B1 sk', sk.toString('hex'), v.expected.sk);
  sid = hkdf(sk, Z32, Buffer.from('Krug/E2EE/v1/session-id'), 16);
  eq('B1 sid', sid.toString('hex'), v.expected.session_id);
}
{
  const v = get('B2-X3DH-3DH-otp-exhausted');
  const dh1 = dh(v.inputs.alice_identity_dh_private, v.inputs.bob_signed_prekey_public);
  const dh2 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_identity_dh_public);
  const dh3 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_signed_prekey_public);
  const ikm = Buffer.concat([F, dh1, dh2, dh3]);
  eq('B2 ikm', ikm.toString('hex'), v.expected.ikm);
  eq('B2 sk', hkdf(ikm, Z32, Buffer.from(v.inputs.info), 32).toString('hex'), v.expected.sk);
  eq('B2 sid', hkdf(hex(v.expected.sk), Z32, Buffer.from('Krug/E2EE/v1/session-id'), 16).toString('hex'), v.expected.session_id);
}
{
  const v = get('B3-SPK-signature');
  const spkMsg = Buffer.concat([Buffer.from('Krug/E2EE/v1/spk-signature'), u8(1),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(v.inputs.key_id)); return b; })(),
    Buffer.from(v.inputs.key_id), hex(v.inputs.spk_public)]);
  eq('B3 signed_message', spkMsg.toString('hex'), v.inputs.signed_message);
  eq('B3 spk derives', xpubOf(seeds['bob-spk']).toString('hex'), v.inputs.spk_public);
  ok('B3 signature verifies', edverify(pubs.bob_identity_signing_key, spkMsg, v.expected.signature));
}
const preambleFromInputs = () => {
  const v = get('B4-prekey-preamble');
  const out = Buffer.concat([
    Buffer.from('Krug/E2EE/v1/prekey'), u8(1), uid(v.inputs.chat_id), uid(v.inputs.sender_device_id),
    uid(v.inputs.recipient_device_id), hex(v.inputs.sender_identity_signing_key),
    hex(v.inputs.sender_identity_dh_key), hex(v.inputs.sender_ephemeral_key),
    hex(v.inputs.recipient_identity_dh_key), hex(v.inputs.recipient_identity_signing_key),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(v.inputs.recipient_spk_id)); return b; })(),
    Buffer.from(v.inputs.recipient_spk_id), hex(v.inputs.recipient_spk_public),
    u8(v.inputs.recipient_opk_id ? 1 : 0),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(v.inputs.recipient_opk_id || '')); return b; })(),
    Buffer.from(v.inputs.recipient_opk_id || ''),
    v.inputs.recipient_opk_public ? hex(v.inputs.recipient_opk_public) : Buffer.alloc(32),
    hex(v.inputs.session_id)
  ]);
  return out;
};
const pre = preambleFromInputs();
{
  const v = get('B4-prekey-preamble');
  eq('B4 preamble bytes', pre.toString('hex'), v.expected.preamble);
  eq('B4 preamble len 323', pre.length, 323);
  eq('B4 preamble hash', sha256(pre).toString('hex'), v.expected.preamble_sha256);
  ok('B4 prekey signature verifies', edverify(pubs.alice_identity_signing_key,
    Buffer.concat([Buffer.from('Krug/E2EE/v1/prekey-signature'), pre]), v.expected.signature));
}
{
  const v = get('B5-identity-binding-signature');
  const msg = Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), hex(v.inputs.alice_ik_dh_public), hex(v.inputs.alice_ik_sig_public)]);
  const msgB = Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), hex(v.inputs.bob_ik_dh_public), hex(v.inputs.bob_ik_sig_public)]);
  eq('B5 alice signed message', msg.toString('hex'), v.inputs.alice_signed_message);
  eq('B5 bob signed message', msgB.toString('hex'), v.inputs.bob_signed_message);
  eq('B5 signed message len', msg.length, 88);
  ok('B5 alice binding verifies', edverify(v.inputs.alice_ik_sig_public, msg, v.expected.alice_identity_binding_signature));
  ok('B5 bob binding verifies', edverify(v.inputs.bob_ik_sig_public, msgB, v.expected.bob_identity_binding_signature));
  const wrongDh = Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), hex(pubs.attacker_identity_dh_key), hex(v.inputs.alice_ik_sig_public)]);
  ok('B5 wrong DH rejected (TOFU negative prerequisite)', !edverify(v.inputs.alice_ik_sig_public, wrongDh, v.expected.alice_identity_binding_signature));
  ok('B5 wrong signer rejected', !edverify(v.inputs.bob_ik_sig_public, msg, v.expected.alice_identity_binding_signature));
}

// ---------- C ----------
const kdfRk = (rk, dhOut) => { const okm = hkdf(dhOut, rk, Buffer.from('Krug/E2EE/v1/dr-root'), 64); return [okm.subarray(0, 32), okm.subarray(32)]; };
const kdfCk = (ck) => [hmac(ck, u8(1)), hmac(ck, u8(2))];
{
  const v = get('C1-HKDF-session-id');
  eq('C1 sid', hkdf(sk, Z32, Buffer.from(v.inputs.info), 16).toString('hex'), v.expected.okm);
}
const a0pub = xpubOf(seeds['alice-ratchet-0']);
let rk1, cks;
{
  const v = get('C2-DR-root-step-alice-initial');
  const dhOut = dh(seeds['alice-ratchet-0'], pubs.bob_signed_prekey);
  eq('C2 dh', dhOut.toString('hex'), v.inputs.dh_output);
  [rk1, cks] = kdfRk(sk, dhOut);
  eq('C2 rk1', rk1.toString('hex'), v.expected.root_key_next);
  eq('C2 cks', cks.toString('hex'), v.expected.chain_key_sending);
}
{
  const v = get('C3-DR-chain-3-messages');
  let ck = cks;
  for (const exp of v.expected) {
    const [mk, next] = kdfCk(ck);
    eq(`C3 mk ${exp.n}`, mk.toString('hex'), exp.message_key);
    eq(`C3 ck ${exp.n}`, next.toString('hex'), exp.next_chain_key);
    ck = next;
  }
}

// ---------- D ----------
{
  const v = get('D1-inner-payload-framing');
  const raw = Buffer.concat([Buffer.from('Krug/E2EE/v1/payload'), Buffer.from([1, 1]), u32(Buffer.byteLength(v.inputs.body_utf8)), Buffer.from(v.inputs.body_utf8)]);
  eq('D1 raw len', raw.length, v.expected.raw_len);
  const padded = Buffer.concat([raw, Buffer.alloc((256 - (raw.length % 256)) % 256)]);
  eq('D1 padded len', padded.length, v.expected.padded_len);
  eq('D1 padded hex', padded.toString('hex'), v.expected.padded_hex);
}
async function aesgcmDecrypt(keyHex, nonceHex, ctHex, adHex) {
  const key = await webcrypto.subtle.importKey('raw', hex(keyHex), 'AES-GCM', false, ['decrypt']);
  return Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: hex(nonceHex), additionalData: hex(adHex) }, key, hex(ctHex)));
}
{
  const v = get('D2-message-aead-m1');
  eq('D2 ad len 163', v.inputs.ad_len, 163);
  eq('D2 ad len', hex(v.inputs.ad_hex).length, v.inputs.ad_len);
  const ek = hkdf(hex(v.inputs.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
  const nn = hkdf(hex(v.inputs.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
  eq('D2 aead key', ek.toString('hex'), v.expected.aead_key);
  eq('D2 nonce', nn.toString('hex'), v.expected.nonce);
  eq('D2 decrypt to padded', (await aesgcmDecrypt(v.expected.aead_key, v.expected.nonce, v.expected.ciphertext_including_tag, v.inputs.ad_hex)).toString('hex'), v.inputs.padded_plaintext_hex);
}
{
  const v = get('D3-message-aead-m2');
  eq('D3 decrypt to padded', (await aesgcmDecrypt(v.expected.aead_key, v.expected.nonce, v.expected.ciphertext_including_tag, v.inputs.ad_hex)).toString('hex'), v.inputs.padded_plaintext_hex);
}

// ---------- E ----------
const hdrBytes = (h) => Buffer.concat([u8(1), u8(0), u32(h.pn), u32(h.n), hex(h.dh)]);
{
  const v = get('E1-conversation-trace');
  const steps = v.expected_steps;
  for (const s of steps) {
    eq(`E header v ${s.step}`, s.header.v, 1);
    const isPre = s.step === 'A->B m1';
    const isA = s.step.startsWith('A');
    const sdev = isA ? A_DEV : B_DEV, rdev = isA ? B_DEV : A_DEV;
    const ad = Buffer.concat([Buffer.from('Krug/E2EE/v1/ad'), u8(1), u8(isPre ? 1 : 0), CHAT, sdev, u32(1), rdev, u32(1), sid,
      isPre ? sha256(pre) : Buffer.alloc(32), hdrBytes(s.header)]);
    eq(`E ad ${s.step}`, ad.toString('hex'), s.ad_hex);
    const ek = hkdf(hex(s.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
    const nn = hkdf(hex(s.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
    const pt = await aesgcmDecrypt(ek.toString('hex'), nn.toString('hex'), s.ciphertext, s.ad_hex);
    ok(`E decrypt ${s.step}`, pt.length % 256 === 0 && pt.subarray(0, 20).toString() === 'Krug/E2EE/v1/payload');
    if (s.plaintext_hex) eq(`E plaintext ${s.step}`, pt.toString('hex'), s.plaintext_hex);
  }
  const B1 = seeds['bob-ratchet-1'], A1 = seeds['alice-ratchet-1'], B2 = seeds['bob-ratchet-2'];
  const [rk1b, ckrBob0] = kdfRk(sk, dh(seeds['bob-spk'], a0pub));
  eq('E bob initial CKr == alice CKs', ckrBob0.toString('hex'), cks.toString('hex'));
  eq('E m1 mk', kdfCk(cks)[0].toString('hex'), steps[0].message_key);
  const [rk2, cksB1] = kdfRk(rk1, dh(B1, a0pub));
  eq('E r1 mk', kdfCk(cksB1)[0].toString('hex'), steps[1].message_key);
  const [, ckrAlice] = kdfRk(rk1, dh(seeds['alice-ratchet-0'], xpubOf(B1)));
  const [rk3, cksA1] = kdfRk(rk2, dh(A1, xpubOf(B1)));
  eq('E alice CKr == bob CKs', ckrAlice.toString('hex'), cksB1.toString('hex'));
  eq('E m2 mk', kdfCk(cksA1)[0].toString('hex'), steps[2].message_key);
  const [, ckrBob2] = kdfRk(rk2, dh(B1, xpubOf(A1)));
  const [, cksB2] = kdfRk(rk3, dh(B2, xpubOf(A1)));
  eq('E bob CKr == alice CKs', ckrBob2.toString('hex'), cksA1.toString('hex'));
  eq('E r2 mk', kdfCk(cksB2)[0].toString('hex'), steps[3].message_key);
}

// ---------- E2 ----------
{
  const v = get('E2-skipped-key-trace');
  let ck = hex(v.inputs.chain_key_0);
  const mks = [];
  for (let i = 0; i < 3; i++) { const [mk, next] = kdfCk(ck); mks.push(mk); ck = next; }
  for (const m of v.expected.messages) {
    eq(`E2 header v n${m.n}`, m.header.v, 1);
    eq(`E2 mk n${m.n}`, mks[m.n].toString('hex'), m.message_key);
    const ek = hkdf(mks[m.n], Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
    const nn = hkdf(mks[m.n], Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
    eq(`E2 decrypt n${m.n}`, (await aesgcmDecrypt(ek.toString('hex'), nn.toString('hex'), m.ciphertext, m.ad_hex)).toString('hex'), m.plaintext_hex);
  }
  eq('E2 skipped key n1', mks[1].toString('hex'), v.expected.skipped_message_key_n1);
  eq('E2 delivery order', v.expected.delivery_order.join(','), '0,2,1');
  eq('E2 Nr after m3', v.expected.receiver_state_after_m3.Nr, 3);
  eq('E2 stored after m2', v.expected.receiver_state_after_m2.stored_skipped.length, 0);
}

// ---------- F ----------
{
  const v = get('F1-envelope-prekey');
  const env = JSON.parse(v.expected.envelope_json);
  eq('F1 session b64', b64d(env.session_id).toString('hex'), sid.toString('hex'));
  eq('F1 ciphertext b64', b64d(env.ciphertext).toString('hex'), get('D2-message-aead-m1').expected.ciphertext_including_tag);
  eq('F1 header dh', b64d(env.header.dh).toString('hex'), get('E1-conversation-trace').expected_steps[0].header.dh);
  eq('F1 AD length', hex(v.expected.decoded.ad_hex).length, 163);
  ok('F1 prekey sig 64 bytes', b64d(env.prekey.signature).length === 64);
  ok('F1 b64url unpadded', [env.session_id, env.ciphertext, env.header.dh, env.prekey.spk_public].every(x => !x.includes('=') && !x.includes('+') && !x.includes('/')));
  ok('F1 canonical b64url roundtrip', [env.session_id, env.ciphertext, env.header.dh].every(x => b64u(b64d(x)) === x));
  const env2 = JSON.parse(get('F2-envelope-no-prekey').expected.envelope_json);
  ok('F2 no prekey field', env2.prekey === undefined);
  eq('F2 header v', env2.header.v, 1);
}

// ---------- G ----------
const fp = (sig, dhPub) => sha256(Buffer.concat([Buffer.from('Krug/E2EE/v1/fingerprint'), hex(sig), hex(dhPub)]));
{
  const v = get('G1-device-fingerprint');
  eq('G1 alice fp', fp(v.inputs.identity_signing_key, v.inputs.identity_dh_key).toString('hex'), v.expected.alice_fingerprint);
  eq('G1 bob fp', fp(pubs.bob_identity_signing_key, pubs.bob_identity_dh_key).toString('hex'), v.expected.bob_fingerprint);
}
const sn = (entries) => {
  const sorted = entries.map(e => Buffer.concat([uid(e.user_id), uid(e.device_id), hex(e.fingerprint)])).sort(Buffer.compare);
  const digest = sha512(Buffer.concat([Buffer.from('Krug/E2EE/v1/safety-number'), u8(1), u32(sorted.length), ...sorted]));
  const digits = (BigInt('0x' + digest.toString('hex')) % (10n ** 60n)).toString().padStart(60, '0');
  return { digest, digits, display: digits.match(/.{5}/g).join(' ') };
};
{
  const v = get('G2-safety-number');
  const r = sn(v.inputs.entries);
  eq('G2 sha512', r.digest.toString('hex'), v.expected.sha512);
  eq('G2 digits', r.digits, v.expected.digits);
  eq('G2 display', r.display, v.expected.display);
  eq('G2 qr', v.expected.qr_payload, `krug://verify/v1?dev1=${ids.alice_device_id}&fp1=${pubs.alice_fingerprint ? b64u(hex(pubs.alice_fingerprint)) : ''}&dev2=${ids.bob_device_id}&fp2=${b64u(hex(pubs.bob_fingerprint))}`);
}
{
  const v = get('G3-safety-number-after-key-change');
  const r = sn(v.inputs.entries);
  eq('G3 digits differ', r.digits !== get('G2-safety-number').expected.digits, true);
  eq('G3 sha512', r.digest.toString('hex'), v.expected.sha512);
  eq('G3 digits', r.digits, v.expected.digits);
}
const vh2 = (chat, vuser, vdev, tdev, gen, digits) => sha256(Buffer.concat([
  Buffer.from('Krug/E2EE/v1/verification'), u8(2), uid(chat), uid(vuser), uid(vdev), uid(tdev), u32(gen), Buffer.from(digits)]));
{
  const v = get('G4-verification-hash');
  eq('G4 vh version', v.inputs.vh_version, 2);
  eq('G4 vhash', vh2(v.inputs.chat_id, v.inputs.verifier_user_id, v.inputs.verifier_device_id, v.inputs.target_device_id, v.inputs.target_key_generation, v.inputs.safety_number_digits).toString('hex'), v.expected.safety_number_hash);
  const g5 = get('G5-verification-per-device');
  const l1 = vh2(g5.inputs.chat_id, g5.inputs.verifier_user_id, g5.inputs.verifier_device_id_l1, g5.inputs.target_device_id, g5.inputs.target_key_generation, g5.inputs.l1_safety_number_digits);
  const l2 = vh2(g5.inputs.chat_id, g5.inputs.verifier_user_id, g5.inputs.verifier_device_id_l2, g5.inputs.target_device_id, g5.inputs.target_key_generation, g5.inputs.l2_safety_number_digits);
  eq('G5 l1 hash', l1.toString('hex'), g5.expected.l1_verification_hash);
  eq('G5 l2 hash', l2.toString('hex'), g5.expected.l2_verification_hash);
  ok('G5 hashes differ', l1.toString('hex') !== l2.toString('hex'));
  ok('G5 digits differ', g5.inputs.l1_safety_number_digits !== g5.inputs.l2_safety_number_digits);
  eq('G5 l2 fingerprint derives', fp(pubs.alice_verifier_device_2_identity_signing_key, pubs.alice_verifier_device_2_identity_dh_key).toString('hex'), g5.inputs.l2_fingerprint);
  eq('G5 l2 verified is null', g5.expected.server_verified_for_l2, null);
}

// ---------- I: TOFU negative ----------
const x3dhCalc = (ikPriv, ekPriv, bobIkDh, bobSpk, bobOpk) => {
  const dh1 = dh(ikPriv, bobSpk), dh2 = dh(ekPriv, bobIkDh), dh3 = dh(ekPriv, bobSpk), dh4 = dh(ekPriv, bobOpk);
  const ikm = Buffer.concat([F, dh1, dh2, dh3, dh4]);
  const skk = hkdf(ikm, Z32, Buffer.from('Krug/E2EE/v1/x3dh'), 32);
  return { sk: skk, sid: hkdf(skk, Z32, Buffer.from('Krug/E2EE/v1/session-id'), 16) };
};
function checkTofuEnvelope(v) {
  const env = JSON.parse(v.inputs.envelope_json);
  eq(`${v.id} wire v`, env.v, 1);
  const x = x3dhCalc(seeds['mallory-ik-dh'], seeds['mallory-ek'], pubs.bob_identity_dh_key, pubs.bob_signed_prekey, pubs.bob_one_time_prekey);
  eq(`${v.id} session from X3DH`, x.sid.toString('hex'), b64d(env.session_id).toString('hex'));
  const pk = env.prekey;
  const pre = Buffer.concat([
    Buffer.from('Krug/E2EE/v1/prekey'), u8(1), uid(env.chat_id), uid(env.sender_device_id), uid(env.recipient_device_id),
    b64d(pk.sender_identity_signing_key), b64d(pk.sender_identity_dh_key), b64d(pk.sender_ephemeral_key),
    b64d(pk.recipient_identity_dh_key), hex(pubs.bob_identity_signing_key),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(pk.spk_id)); return b; })(), Buffer.from(pk.spk_id), b64d(pk.spk_public),
    u8(1),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(pk.opk_id)); return b; })(), Buffer.from(pk.opk_id), b64d(pk.opk_public),
    b64d(env.session_id)
  ]);
  ok(`${v.id} preamble signature valid`, edverify(b64d(pk.sender_identity_signing_key).toString('hex'), Buffer.concat([Buffer.from('Krug/E2EE/v1/prekey-signature'), pre]), b64d(pk.signature).toString('hex')));
  const ad = Buffer.concat([Buffer.from('Krug/E2EE/v1/ad'), u8(1), u8(1), uid(env.chat_id), uid(env.sender_device_id), u32(1),
    uid(env.recipient_device_id), u32(1), b64d(env.session_id), sha256(pre), hdrBytes({ ...env.header, dh: b64d(env.header.dh).toString('hex') })]);
  const mk = hmac(cksFromMallory(), u8(1));
  const ek = hkdf(mk, Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
  const nn = hkdf(mk, Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
  return aesgcmDecrypt(ek.toString('hex'), nn.toString('hex'), b64d(env.ciphertext).toString('hex'), ad.toString('hex')).then(pt => {
    ok(`${v.id} AEAD decrypts`, pt.length % 256 === 0 && pt.subarray(0, 20).toString() === 'Krug/E2EE/v1/payload');
    eq(`${v.id} presented fingerprint`, fp(b64d(pk.sender_identity_signing_key).toString('hex'), b64d(pk.sender_identity_dh_key).toString('hex')).toString('hex'), v.inputs.presented_fingerprint);
    ok(`${v.id} presented binding verifies`, edverify(b64d(pk.sender_identity_signing_key).toString('hex'), Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), b64d(pk.sender_identity_dh_key), b64d(pk.sender_identity_signing_key)]), v.inputs.presented_identity_binding_signature));
    return pk;
  });
}
function cksFromMallory() {
  const x = x3dhCalc(seeds['mallory-ik-dh'], seeds['mallory-ek'], pubs.bob_identity_dh_key, pubs.bob_signed_prekey, pubs.bob_one_time_prekey);
  // Alice/Bob ratchet: initiator RK, CKs = KDF_RK(SK, DH(EK? no: DHs=alice-ratchet-0, SPK))
  return kdfRk(x.sk, dh(seeds['mallory-ratchet-0'], pubs.bob_signed_prekey))[1];
}
{
  const v = get('I1-tofu-first-contact-no-pin');
  const pk = await checkTofuEnvelope(v);
  eq('I1 pin created', v.expected.pin_created, true);
  eq('I1 pin fingerprint == presented', v.expected.pinned_fingerprint, v.inputs.presented_fingerprint);
  eq('I1 unverified', v.expected.verified, false);
  eq('I1 safety number', sn([
    { user_id: ids.alice_user_id, device_id: ids.alice_device_id, fingerprint: v.inputs.presented_fingerprint },
    { user_id: ids.bob_user_id, device_id: ids.bob_device_id, fingerprint: pubs.bob_fingerprint }]).digits, v.expected.safety_number_digits);
  ok('I1 safety number differs from real peer', v.expected.safety_number_digits !== get('G2-safety-number').expected.digits);
  eq('I1 TOFU residual documented', v.expected.residual_risk.includes('TOFU window'), true);
}
{
  const v = get('I2-tofu-identity-mismatch');
  await checkTofuEnvelope(v);
  ok('I2 pin exists', v.inputs.local_pin !== null);
  eq('I2 pinned fingerprint is the real one', v.inputs.local_pin.fingerprint, pubs.alice_fingerprint);
  ok('I2 pin mismatch detected', v.expected.pin_mismatch === true && v.inputs.presented_fingerprint !== v.inputs.local_pin.fingerprint);
  eq('I2 decision', v.expected.decision, 'KEY_CHANGE_DETECTED');
  eq('I2 no session created', v.expected.session_created, false);
  eq('I2 no display', v.expected.message_displayed, false);
  eq('I2 OPK not consumed', v.expected.opk_consumed, false);
  eq('I2 send blocked', v.expected.send_blocked_until_confirmation, true);
  eq('I2 verified reset', v.expected.verified_reset, true);
  eq('I2 binding alone does not stop substitution', v.expected.binding_prevents_substitution, false);
}

// ---------- J/K/L conformance ----------
{
  const j1 = get('J1-security-mode-downgrade-rejected');
  eq('J1 server rejects', j1.expected.server_decision, '409 MODE_CHANGE_FORBIDDEN');
  eq('J1 mode unchanged', j1.expected.mode_changed, false);
  eq('J1 client blocks', j1.expected.client_decision, 'BLOCK_SEND_SECURITY_ALERT');
  eq('J1 no plaintext', j1.expected.plaintext_messages_sent, 0);
  eq('J1 downgrade is attack', j1.expected.downgrade_is_attack, true);
  const j2 = get('J2-e2ee-creation-with-flag-off');
  eq('J2 flag off 409', j2.expected.http_status, 409);
  eq('J2 code', j2.expected.code, 'E2EE_DISABLED');
  eq('J2 no badge', j2.expected.badge_shown, false);
  eq('J2 does not close existing mode', j2.expected.flag_off_closes_existing_mode, false);
  eq('J2 existing stays E2EE (plaintext forbidden)', j2.expected.existing_e2ee_chat_plaintext, '422 E2EE_PLAINTEXT_FORBIDDEN');
}
{
  const k1 = get('K1-client-message-id-same-sender-replay');
  eq('K1 replay', k1.expected.idempotent_replay, true);
  eq('K1 same id', k1.expected.same_message_id, true);
  eq('K1 not in AD', k1.expected.in_ad, false);
  eq('K1 scope', k1.inputs.unique_key.join(','), 'chat_id,sender_id,client_message_id');
  const k2 = get('K2-client-message-id-cross-user-conflict');
  eq('K2 409', k2.expected.http_status, 409);
  eq('K2 code', k2.expected.code, 'CLIENT_MESSAGE_ID_CONFLICT');
  eq('K2 no replay', k2.expected.idempotent_replay, false);
  eq('K2 no cross-user leak', k2.expected.returns_other_users_message, false);
}
{
  const l1 = get('L1-session-reset-payload');
  const raw = Buffer.concat([Buffer.from('Krug/E2EE/v1/payload'), u8(1), u8(l1.inputs.content_type), u32(l1.inputs.body_len), hex(l1.inputs.body_hex)]);
  const padded = Buffer.concat([raw, Buffer.alloc((256 - (raw.length % 256)) % 256)]);
  eq('L1 content type', l1.inputs.content_type, 2);
  eq('L1 raw len', raw.length, l1.expected.raw_len);
  eq('L1 padded len', padded.length, l1.expected.padded_len);
  eq('L1 padded hex', padded.toString('hex'), l1.expected.padded_hex);
  eq('L1 payload hash', sha256(padded).toString('hex'), l1.expected.payload_sha256);
  eq('L1 hidden', l1.expected.user_visible, false);
  const l2 = get('L2-session-reset-state-machine');
  eq('L2 encrypted transport', l2.inputs.transport, 'prekey_envelope_content_type_2');
  eq('L2 no WS event', l2.inputs.ws_event_used, false);
  eq('L2 one reset', l2.expected.max_reset_attempts, 1);
  eq('L2 new client_message_id', l2.expected.resend_uses_new_client_message_id, true);
  eq('L2 no ciphertext reuse', l2.expected.old_ciphertext_reused, false);
}

// ---------- limits arithmetic (P1-3) ----------
{
  const L = V.meta.limits;
  eq('limits inner body', L.max_inner_body_decoded_bytes, 32768);
  eq('limits padded', L.max_padded_plaintext_bytes, 20 + 1 + 1 + 4 + 32768 + ((256 - ((20 + 1 + 1 + 4 + 32768) % 256)) % 256));
  eq('limits ciphertext decoded', L.max_ciphertext_decoded_bytes, L.max_padded_plaintext_bytes + 16);
  eq('limits encoded chars', L.max_ciphertext_encoded_chars, b64u(Buffer.alloc(L.max_ciphertext_decoded_bytes)).length);
  eq('limits min encoded chars', L.min_ciphertext_encoded_chars, b64u(Buffer.alloc(272)).length);
  eq('limits nine envelope wire', L.nine_envelopes_wire_bytes, 9 * (L.max_ciphertext_encoded_chars + L.envelope_json_overhead_bytes) + L.request_wrapper_bytes);
  eq('limits ten envelope wire', L.ten_envelopes_wire_bytes, 10 * (L.max_ciphertext_encoded_chars + L.envelope_json_overhead_bytes) + L.request_wrapper_bytes);
  ok('limits 9 < 512 KiB', L.nine_envelopes_wire_bytes < 524288);
  ok('limits 10 < 512 KiB', L.ten_envelopes_wire_bytes < 524288);
  ok('limits form cap is not a 10-envelope budget', 10 * L.per_envelope_form_cap_encoded_chars > 524288);
  eq('limits decoded-sum trap', L.wire_if_decoded_sum_were_budget_bytes, 699051);
  eq('limits review measurement within 1 KiB of S2', Math.abs(L.review_measured_nine_envelopes_wire_bytes - L.nine_envelopes_wire_bytes) < 1024, true);
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
```

### 9.4. Воспроизведение и результат

```bash
python3 --version          # 3.14.6
python3 -c "import cryptography; print(cryptography.__version__)"  # 49.0.0
node --version             # v24.20.0

# 1) генератор S2 (§9.1)
python3 gen_e2ee_vectors_s2.py
# written; vectors: 34 sections: 13
# SK: bbaf23763ebebc2d1bc558bb9477e1b608e19d66282094873235b4f4d02bd9d5
# SID: 86c68f64d2c3be99fde4aabe857e1f5e
# safety digits: 966641447817221341546560580530883495084093893634094867501952
# ct1: f5111968…9732 len 272
# env1 len 1310

# 2) независимый верификатор S2 (§9.3)
node verify_e2ee_vectors_s2.mjs docs/E2EE-TEST-VECTORS.json
# 189 checks, 0 failures
```

Что проверяет S2-верификатор (189 проверок):

- A1–A4 — RFC 7748 / RFC 8032 / RFC 5869 / NIST AES-256-GCM.
- B1–B5 — DH1..DH4, IKM, SK, session_id, SPK-подпись, преамбул 323 B + подпись, **IK binding 88 B**.
- C1–C3 — session-id, root step, три message key/chain key.
- D1–D3 — фрейминг/padding, AEAD key/nonce, расшифровка ciphertext.
- E1 — 4 сообщения, 2 DH-ratchet turn, AD каждого шага, ключи цепочек (включая `r2`, который авторский верификатор v1 не проверял).
- E2 — out-of-order m1/m3/m2, skipped key n=1, дубликаты/гэп.
- F1/F2 — b64url canonical, длины, AD, ciphertext, отсутствие `prekey`.
- G1–G5 — fingerprint, SHA-512/digits/QR, key change, VH v2, **per-verifier-device** hash и `verified=null` для L2.
- I1/I2 — X3DH Mallory→Bob, преамбул/подпись, AD/AEAD, fingerprint, safety number, TOFU pin/`KEY_CHANGE_DETECTED`.
- L1 — framing `content_type=2 SESSION_RESET`; L2 — state-machine инварианты.
- J/K — mode immutability, flag-off, client_message_id scope (structural/conformance).
- `meta.limits` — пересчёт 33024/33040/44054/45001/405098/450099/74189 и проверка < 512 KiB.

### 9.5. Арифметика лимитов (P1-3/D-06)

| Величина | Значение | Комментарий |
|---|---|---|
| body (decoded) | 32768 B | `MAX_INNER_BODY_BYTES` |
| raw frame | 32794 B | 20 domain + 1 ver + 1 type + 4 len + body |
| padded plaintext | 33024 B | +230 нулей до кратности 256 |
| ciphertext (decoded) | 33040 B | padded + 16 tag |
| ciphertext (encoded) | 44054 chars | b64u без padding; 43.0 KiB |
| envelope JSON overhead | 947 B | измерено на F1 (без ciphertext) |
| envelope wire | 45001 B | 44054 + 947 |
| 9 envelopes + wrapper | 405098 B (395.6 KiB) | 9×45001 + 89 |
| 10 envelopes + wrapper | 450099 B (439.5 KiB) | 10×45001 + 89 |
| wire limit | 524288 B (512 KiB) | HTTP body **до** парсинга |
| slack | 119190 / 74189 B | 9 / 10 конвертов |
| form cap | 65536 encoded chars | 64 KiB encoded; НЕ бюджет fan-out |
| decoded form cap | 49152 B | 65536×3/4; канонический клиент ≤33040 |
| измерение ревью | 405129 B | +31 B к S2-расчёту (длина обёртки/ids); оба < 512 KiB |

**Исправленная ошибка:** §4.7 v1 суммировал **decoded** длины и сравнивал с 512 KiB, что пропускало ~683 KiB по проводу (`699051` символов). Теперь проверяется фактический wire-размер; decoded-сумма — только информационно.

### 9.6. S2 handoff

1. PM/лид: обновить `contracts/openapi.yaml`/`ws-protocol.md` по §6.3/§6.4 спеки (I-01), перегенерировать `schema.d.ts`.
2. Backend E7-B1: писать миграции по **§6.5 S2** (V16+), а не по старой редакции; `crypto_scheme`, а не `security_mode` на `messages`; `device_prekeys`/`key_verifications` — `CREATE`.
3. Frontend E7-F2/F5: локальная копия+outbox до send, TOFU, R-15, per-device verified, mode pinning.
4. Security: G0 — повторная проверка закрытия P0/P1 внешним ревьюером; G4 (реализация) остаётся обязательным.
5. Не менять wire format после review без `envelope.v` bump + ADR. S2 не менял `v`.

### 9.7. Решения PM, зафиксированные в S2

| ID | Решение |
|---|---|
| D-05 | `chat_id` обязателен в `/keys/claim`; только участники чата и свои устройства; один `422 UNKNOWN_DEVICE` для unknown/not-member. |
| D-06 | 512 KiB — **wire**-лимит HTTP; per-envelope **64 KiB encoded**; inner body **32 KiB decoded**; канонический конверт 43.0 KiB; 9 ≈396 KiB. |
| D-07 | `client_message_id` в `Message`; scope `(chat_id, sender_id, client_message_id)`; не глобально; не в AD. |
| D-17 | Legacy не апгрейдится in-place; prekeys → `422 NO_KEYS`; UI-статус; только новая регистрация. |
| identity | Две пары Ed25519+X25519 приняты + обязательная самоподпись `IK_sig→IK_dh`. |
| self-envelope | **Отклонён**; атомарная локальная копия+outbox до send; лимит конвертов 10 не меняется. |

### 9.8. Ограничения S2

- Векторы не доказывают crash-recovery/IndexedDB/WebCrypto-специфику — это E2E/property-тесты (G2/G3).
- J/K/L — conformance, не крипто-KAT: они проверяют коды/состояния, а не байты AEAD.
- `meta.limits` — расчёт; фактический 413 на прокси/ingress проверяется в G1/G2.
- TOFU-окно и отсутствие KT v1 — принятый остаточный риск; self-envelope/backup не входят в E7.

---

## 10. E7-S3 remediation — векторы v3, патч-генератор и верификатор

> §10 добавлен после [`docs/E2EE-REVIEW-02.md`](<E2EE-REVIEW-02.md>) (GO WITH CONDITIONS: P0-2b, P1-A, P1-E, P1-B/C/D/F/G/H, I-01, P2). §9 — исторический S2 и **не переписывается**; где §9 расходится с §10, приоритет у §10. Envelope wire format **не менялся** (`v=1`). S3 меняет только: кодировку binding-полей в I1/I2 (hex → b64u64), набор векторов (+9, 43/17), `meta` (v3, 273 checks) и спеку/DDL/API-текст.

### 10.1. Что и зачем изменено

| Изменение | Причина (review-02) | Где |
|---|---|---|
| `presented_identity_binding_signature` / `pinned_identity_binding_signature` в I1/I2 — b64u64 (86 символов, 64 B), не hex | P1-E: wire-схема `Base64Url64`; hex-строка не проходит conforming-клиент | S3-патч, `fix_binding_encoding` |
| Новый **I3-prekey-sender-identity-mismatch** | P0-2b: подмена `prekey.sender_identity_*` при честных `auth.devices`/bundle | секция I |
| Новый **J3-fresh-device-managed-mode-blocked** | P1-G: fresh device без пина не шлёт plaintext по серверному MANAGED | секция J |
| Новые **M1/M2** (peer coverage) | P1-B: `peer_covered==0` → 409; partial → warning | секция M |
| Новый **L3-session-reset-multi-message** | P1-C: reset покрывает все сообщения failed-сессии | секция L |
| Новые **N1/N2** | P2-4/P2-5: достижимость `E2EE_LEGACY_DEVICE`, REVOKED + тот же IK → 410 | секция N |
| Новый **R1-e2ee-reply-to-id-rejected** | P1-F: верхнеуровневый `reply_to_id` → 422 | секция R |
| Новый **S1-fs-pcs-key-destruction** | P1-D: 3 SPK/90 дней, уничтожение OPK/DHs | секция S |
| `meta.vector_set_version=3`, `meta.checks.verifier_checks=273`, `meta.generator.verify_command` = 273 | P2-8: stale 160/189 | meta |
| `meta.conventions.signature_encoding` | P2-9: явная конвенция wire-подписей | meta |

Значения A–H (кроме уже пересчитанного в S2 G4) **не менялись**. I1/I2 fingerprint/safety number/решения **не менялись** — изменилась только кодировка двух полей (те же 64 байта).

### 10.2. Генератор S3 (полный исходник)

Порядок: (1) сохранить генератор S2 из §9.1 как `gen_e2ee_vectors_s2.py`; (2) сохранить код ниже как `gen_e2ee_vectors_s3.py`; (3) запустить из корня репозитория:

```bash
python3 gen_e2ee_vectors_s2.py       # пишет docs/E2EE-TEST-VECTORS.json (34/13)
python3 gen_e2ee_vectors_s3.py       # читает и перезаписывает его (43/17, v3)
```

Скрипт детерминирован: он не использует RNG/время, только входной JSON S2 и константы. `verifier_checks=273` — измеренное значение §10.3; при изменении набора векторов его нужно обновить вместе с `meta.generator.verify_command`.

```python
#!/usr/bin/env python3
"""E7-S3 vector patch: run AFTER gen_e2ee_vectors_s2.py.

Reads the S2 output (docs/E2EE-TEST-VECTORS.json), fixes the wire encoding of
the I1/I2 binding signatures (hex -> canonical b64u64, 86 chars), appends the
S3 conformance vectors (I3, J3, M1/M2, L3, N1/N2, R1, S1) and rewrites meta.
Envelope wire format is unchanged (v=1); only the vector set version moves to 3.
"""
import base64
import copy
import json

SRC = "docs/E2EE-TEST-VECTORS.json"
DST = "docs/E2EE-TEST-VECTORS.json"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def hex_to_b64u(h: str) -> str:
    return b64u(bytes.fromhex(h))


def find(V, vid):
    for s in V["sections"]:
        for v in s["vectors"]:
            if v["id"] == vid:
                return v
    raise KeyError(vid)


def section(V, sid):
    for s in V["sections"]:
        if s["id"] == sid:
            return s
    raise KeyError(sid)


with open(SRC, encoding="utf-8") as f:
    V = json.load(f)

ids = V["meta"]["ids"]
P = V["meta"]["public_keys"]
chat_id = ids["chat_id"]
alice_dev = ids["alice_device_id"]
alice_user = ids["alice_user_id"]
bob_dev = ids["bob_device_id"]
bob_user = ids["bob_user_id"]
bob_dev_2 = "00000000-0000-4000-8000-000000000022"
V["meta"]["ids"]["bob_device_2_id"] = bob_dev_2

i1 = find(V, "I1-tofu-first-contact-no-pin")
i2 = find(V, "I2-tofu-identity-mismatch")
f1 = find(V, "F1-envelope-prekey")

# ---------- P1-E: wire-valid b64u64 (86 chars, 64 decoded bytes) ----------
mallory_bind_b64 = hex_to_b64u(i1["inputs"]["presented_identity_binding_signature"])
i1["inputs"]["presented_identity_binding_signature"] = mallory_bind_b64
i1["expected"]["pinned_identity_binding_signature"] = mallory_bind_b64
i1["inputs"]["presented_identity_binding_signature_encoding"] = "b64u64 (86 chars, 64 bytes)"
i1["expected"]["pinned_identity_binding_signature_encoding"] = "b64u64 (86 chars, 64 bytes)"
i1["note"] = (
    i1["note"]
    + " P1-E: presented/pinned binding signatures are wire base64url (b64u64, 86 chars), "
      "not hex; a conforming client must parse them before TOFU."
)

i2["inputs"]["presented_identity_binding_signature"] = mallory_bind_b64
i2["inputs"]["local_pin"]["identity_binding_signature"] = hex_to_b64u(
    i2["inputs"]["local_pin"]["identity_binding_signature"]
)
i2["inputs"]["presented_identity_binding_signature_encoding"] = "b64u64 (86 chars, 64 bytes)"
i2["inputs"]["local_pin"]["identity_binding_signature_encoding"] = "b64u64 (86 chars, 64 bytes)"
i2["note"] = (
    i2["note"]
    + " P1-E: all signature fields are wire b64u64; the 64-byte binding is decoded, not hex-parsed."
)

# ---------- I3: prekey sender identity mismatch (P0-2b) ----------
i3_note = (
    "P0-2b negative: stolen bearer token without device private keys. The prekey block carries "
    "Mallory's IK_sig/IK_dh and EK for the EXISTING sender_device_id 011; the preamble signature "
    "verifies and Mallory's IK_sig->IK_dh binding is valid, but those keys are NOT the keys "
    "registered in auth.devices and NOT the keys in the claim bundle / GET /chats/{id}/keys. "
    "The server MUST reject 422 INVALID_ENVELOPE_FORMAT (409 KEY_CHANGED if generation moved); "
    "the recipient MUST reject KEY_HANDSHAKE_INVALID before creating a session, consuming the OPK "
    "or displaying the message. Binding verification alone is insufficient: it only proves that "
    "the presented IK_sig owns the presented IK_dh, not that the pair belongs to device_id 011. "
    "This is the exact gap that P0-2b closes; it is wire-valid and byte-identical to I1's envelope."
)
i3 = {
    "id": "I3-prekey-sender-identity-mismatch",
    "kind": "prekey_identity_binding",
    "note": i3_note,
    "inputs": {
        "sender_device_id": alice_dev,
        "sender_user_id": alice_user,
        "chat_id": chat_id,
        "recipient_device_id": bob_dev,
        "registered_identity_signing_key": P["alice_identity_signing_key"],
        "registered_identity_dh_key": P["alice_identity_dh_key"],
        "bundle_identity_signing_key": P["alice_identity_signing_key"],
        "bundle_identity_dh_key": P["alice_identity_dh_key"],
        "prekey_sender_identity_signing_key": i1["inputs"]["presented_ik_sig"],
        "prekey_sender_identity_dh_key": i1["inputs"]["presented_ik_dh"],
        "presented_fingerprint": i1["inputs"]["presented_fingerprint"],
        "presented_identity_binding_signature": mallory_bind_b64,
        "presented_identity_binding_signature_encoding": "b64u64 (86 chars, 64 bytes)",
        "preamble_signature_valid_for_presented_keys": True,
        "binding_valid_for_presented_keys": True,
        "prekey_matches_registered_device": False,
        "prekey_matches_bundle": False,
        "attacker_capability": "stolen bearer token only; no device private keys",
        "envelope_json": i1["inputs"]["envelope_json"],
    },
    "expected": {
        "prekey_matches_registered_device": False,
        "prekey_matches_bundle": False,
        "server_decision": "422 INVALID_ENVELOPE_FORMAT",
        "server_rejected": True,
        "http_status": 422,
        "error_details_field": "prekey.sender_identity_signing_key",
        "message_created": False,
        "seq_allocated": False,
        "client_decision": "KEY_HANDSHAKE_INVALID",
        "session_created": False,
        "session_overwritten": False,
        "message_displayed": False,
        "opk_consumed": False,
        "tofu_pin_written": False,
        "send_blocked": True,
        "binding_alone_insufficient": True,
        "test": "integration: device A with a bearer token but without its private keys cannot establish a prekey session as A",
    },
}
section(V, "I-tofu")["vectors"].append(i3)

# ---------- J3: fresh device / no local pin (P1-G) ----------
j3 = {
    "id": "J3-fresh-device-managed-mode-blocked",
    "kind": "security_mode_bootstrap",
    "note": (
        "P1-G: a new device or a cleared profile has no local chat_id->security_mode pin. A "
        "malicious/compromised server may answer MANAGED for a chat that has E2EE history and a "
        "peer with e2ee_capable devices. The client MUST NOT silently send plaintext: it blocks "
        "before any request, shows a security alert and requires an explicit mode decision / E2EE "
        "session. There is no server-side code for this case: a server that really says MANAGED "
        "would accept plaintext, so the control is client-side only. "
        "Honest residual risk: without a local pin and without server-signed mode attestation "
        "(v2) the client cannot prove the chat was E2EE."
    ),
    "inputs": {
        "chat_id": chat_id,
        "peer_user_id": bob_user,
        "client_has_pin": False,
        "local_security_mode_pin": None,
        "chat_had_e2ee_history": True,
        "peer_has_e2ee_capable_device": True,
        "workspace_reported_security_mode": "MANAGED",
        "server_reported_security_mode": "MANAGED",
        "client_attempted_plaintext_send": True,
        "mode_attestation": None,
    },
    "expected": {
        "client_decision": "BLOCK_SEND_SECURITY_ALERT",
        "http_status": None,
        "code": None,
        "server_request_sent": False,
        "client_blocks_before_request": True,
        "plaintext_messages_sent": 0,
        "send_blocked": True,
        "requires_explicit_mode_confirmation": True,
        "security_alert": True,
        "mode_pinned": False,
        "fallback_to_managed_allowed": False,
        "e2ee_session_establish_offered": True,
        "allow_after_user_confirmation": "E2EE_ONLY (or a NEW managed chat; never an in-place downgrade)",
        "residual_risk": "no local pin and no server-signed mode attestation v1; the client cannot prove the chat was E2EE",
    },
}
section(V, "J-security-mode")["vectors"].append(j3)

# ---------- M: peer coverage (P1-B) ----------
m_section = {
    "id": "M-envelope-coverage",
    "title": "Peer coverage: candidates vs covered devices (P1-B)",
    "normative": True,
    "vectors": [
        {
            "id": "M1-peer-coverage-zero-rejected",
            "kind": "envelope_coverage",
            "note": (
                "P1-B: peer_devices>0 but peer_covered==0. This happens when the recipient has "
                "capable devices but no usable SPK/bundle, so the sender only has a self-envelope "
                "or self-fan-out. The server MUST reject 409 E2EE_NO_PEER_ENVELOPE before creating "
                "the Message/seq; a 201 with no peer delivery is a silent loss. The client must "
                "also pre-check and not send when no peer bundle was obtained."
            ),
            "inputs": {
                "chat_id": chat_id,
                "peer_user_id": bob_user,
                "peer_devices": 2,
                "peer_devices_with_spk": 0,
                "peer_covered": 0,
                "self_devices": 1,
                "self_covered": 1,
                "envelopes_total": 1,
                "envelopes_to_peer": 0,
                "client_precheck": "NO_PEER_BUNDLE",
            },
            "expected": {
                "http_status": 409,
                "code": "E2EE_NO_PEER_ENVELOPE",
                "message_created": False,
                "seq_allocated": False,
                "warning": None,
                "client_must_not_send": True,
                "ui_reason": "PEER_UNCOVERED",
                "retry_after": "peer has an active SPK / a peer bundle is available",
            },
        },
        {
            "id": "M2-peer-partial-coverage-warning",
            "kind": "envelope_coverage",
            "note": (
                "P1-B: one of two peer devices is covered. The message is accepted (at least one "
                "peer envelope exists) but the response MUST carry warning=PEER_DEVICE_UNCOVERED "
                "and list the uncovered device; the UI says the message is unavailable on some of "
                "the peer's devices. The envelope is the wire-valid F1 prekey envelope addressed to "
                "Bob's device 021; Bob's second device 022 has no envelope."
            ),
            "inputs": {
                "chat_id": chat_id,
                "peer_user_id": bob_user,
                "peer_devices": 2,
                "peer_covered": 1,
                "self_devices": 1,
                "self_covered": 1,
                "uncovered_device_ids": [bob_dev_2],
                "envelope_json": f1["expected"]["envelope_json"],
                "envelope_wire_version": 1,
            },
            "expected": {
                "http_status": 201,
                "message_created": True,
                "delivered_to_peer": True,
                "peer_covered": 1,
                "warning": "PEER_DEVICE_UNCOVERED",
                "uncovered_device_ids": [bob_dev_2],
                "ui": "unavailable on some of the peer's devices",
                "self_warning_suppressed": True,
            },
        },
    ],
}
V["sections"].append(m_section)

# ---------- L3: multi-message reset (P1-C) ----------
l3 = {
    "id": "L3-session-reset-multi-message",
    "kind": "session_reset_state_machine",
    "note": (
        "P1-C: reset is a property of the failed SESSION, not of one message. A sent m1..m5 in "
        "one session; B was offline past the SPK window and decrypted none. One SESSION_RESET for "
        "that failed_session_id makes A re-encrypt ALL undelivered messages of the session into a "
        "new session, each with a NEW client_message_id/Idempotency-Key, in order, replacing the "
        "local pending copies (one retry group, no duplicates). Batch is capped at 20; the rest "
        "stay retry_pending with an explicit UI status. Empty outbox is a no-op (no new handshake)."
    ),
    "inputs": {
        "failed_session_id": "hsaPZNLDvpn95Kq-hX4fXg",
        "old_client_message_ids": [
            "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e01",
            "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e02",
            "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e03",
            "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e04",
            "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e05",
        ],
        "delivered_before_reset": 0,
        "reset_content_type": 2,
        "max_batch": 20,
        "cooldown_seconds": 300,
    },
    "expected": {
        "resend_count": 5,
        "all_with_new_client_message_ids": True,
        "new_client_message_ids_unique": True,
        "order_preserved": True,
        "duplicates_in_ui": 0,
        "ui_retry_groups": 1,
        "old_messages_status": "superseded",
        "undelivered_left": 0,
        "old_ciphertext_reused": False,
        "old_client_message_id_reused": False,
        "empty_outbox_is_noop": True,
        "batch_overflow_status": "retry_pending",
        "silent_drop": False,
    },
}
section(V, "L-session-reset")["vectors"].append(l3)

# ---------- N: device registration semantics (P1-6/P2-4/P2-5) ----------
n_section = {
    "id": "N-device-registration",
    "title": "Device registration: revoked idempotency and legacy addressability (P1-6/P2-4/P2-5)",
    "normative": True,
    "vectors": [
        {
            "id": "N1-revoked-identity-replay",
            "kind": "device_registration_idempotency",
            "note": (
                "P2-5: replaying the same IK pair after the device was REVOKED must not resurrect "
                "it. The REVOKED check runs BEFORE identity-key idempotency: 410 DEVICE_REVOKED, no "
                "reactivation, no new device row with the same keys. To participate in E2EE again "
                "the client registers a NEW device with a NEW identity pair (the global unique "
                "index excludes REVOKED, but the server still refuses to reuse tombstoned keys)."
            ),
            "inputs": {
                "identity_signing_key": P["alice_identity_signing_key"],
                "identity_dh_key": P["alice_identity_dh_key"],
                "existing_status": "REVOKED",
                "revoked_key_generation": 2,
                "idempotency_key": "5c1e8d0a-4b2f-4a6e-9d1c-7e3f2a1b0c9d",
                "body_same_keys": True,
            },
            "expected": {
                "http_status": 410,
                "code": "DEVICE_REVOKED",
                "device_reactivated": False,
                "new_device_created": False,
                "returns_revoked_device_as_active": False,
                "key_generation_after": 2,
                "idempotency_precedence": "revoked_check_before_ik_replay",
                "client_action": "REGISTER_NEW_DEVICE_WITH_NEW_IDENTITY_KEYS",
            },
        },
        {
            "id": "N2-legacy-device-prekeys-rejected",
            "kind": "device_registration_legacy",
            "note": (
                "P2-4: E2EE_LEGACY_DEVICE must be reachable. POST /devices cannot address an "
                "existing legacy device (no device_id in the body), so the code is returned by "
                "POST /devices/{deviceId}/prekeys for a legacy target: 422 E2EE_LEGACY_DEVICE with "
                "details.remedy=register_new_device. Claim still reports such a device as "
                "unavailable[reason=NO_KEYS]; the two codes have disjoint scopes."
            ),
            "inputs": {
                "operation": "POST /devices/{deviceId}/prekeys",
                "target_device_id": alice_dev,
                "status": "ACTIVE",
                "e2ee_capable": False,
                "identity_key_alg": "LEGACY",
                "has_identity_keys": False,
            },
            "expected": {
                "http_status": 422,
                "code": "E2EE_LEGACY_DEVICE",
                "details": {"device_id": alice_dev, "remedy": "register_new_device"},
                "prekeys_stored": False,
                "device_upgraded_in_place": False,
                "claim_reason_for_same_device": "NO_KEYS",
                "server_error_500": False,
            },
        },
    ],
}
V["sections"].append(n_section)

# ---------- R: plaintext fields in E2EE (P1-F/P2-13) ----------
r_section = {
    "id": "R-plaintext-fields",
    "title": "Plaintext fields in E2EE: reply_to_id and server-forged text (P1-F/P2-13)",
    "normative": True,
    "vectors": [
        {
            "id": "R1-e2ee-reply-to-id-rejected",
            "kind": "plaintext_field_rejection",
            "note": (
                "P1-F: reply_to_id is allowed ONLY inside the encrypted inner payload. A top-level "
                "reply_to_id in MessageCreate for an E2EE chat leaks plaintext metadata and is "
                "rejected 422 E2EE_PLAINTEXT_FORBIDDEN (details.field=reply_to_id) before Message/"
                "seq creation; the DB CHECK ck_messages_e2ee_no_reply_to_id is the second line. "
                "reply_to_id is NOT part of AD and does not change the envelope wire format."
            ),
            "inputs": {
                "chat_id": chat_id,
                "chat_security_mode": "E2EE",
                "client_message_id": "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e10",
                "type": "TEXT",
                "reply_to_id": "8b0f3c1d-2e4a-4b6c-8d0e-1f2a3b4c5d6e",
                "envelopes_count": 1,
                "envelope_source": "F1-envelope-prekey",
                "reply_to_id_in_inner_payload_allowed": True,
                "inner_payload_content_type": 1,
                "ad_fields": [
                    "envelope.v",
                    "flags",
                    "chat_id",
                    "sender_device_id",
                    "sender_key_generation",
                    "recipient_device_id",
                    "recipient_key_generation",
                    "session_id",
                    "preamble_hash",
                    "header",
                ],
            },
            "expected": {
                "http_status": 422,
                "code": "E2EE_PLAINTEXT_FORBIDDEN",
                "details_field": "reply_to_id",
                "message_created": False,
                "seq_allocated": False,
                "stored_reply_to_id": None,
                "db_check": "ck_messages_e2ee_no_reply_to_id",
                "reply_allowed_inside_inner_payload": True,
                "ad_includes_reply_to_id": False,
                "envelope_wire_version": 1,
            },
        }
    ],
}
V["sections"].append(r_section)

# ---------- S: FS/PCS window and key destruction (P1-D) ----------
s_section = {
    "id": "S-fs-pcs",
    "title": "FS/PCS window and key destruction (P1-D)",
    "normative": True,
    "vectors": [
        {
            "id": "S1-fs-pcs-key-destruction",
            "kind": "fs_pcs_state",
            "note": (
                "P1-D: exactly one semantics for the FS window. SPK private retention is current + "
                "2 previous = 3, window 90 days; '2 total / 60 days' is invalid. OPK private is "
                "destroyed immediately after successful AEAD; the old DHs_priv is destroyed right "
                "after the DH ratchet (only the current pair is kept); MKSKIPPED is TTL/limit "
                "bounded. PCS is only after a reply DH ratchet, not instant; SESSION_IDLE_TTL is "
                "GC, not an FS boundary. Zeroization is best-effort JS and is stated honestly."
            ),
            "inputs": {
                "spk_current": 1,
                "spk_previous": 2,
                "spk_retain_private_total": 3,
                "spk_ttl_days": 30,
                "spk_retain_window_days": 90,
                "total_spk_rotations": 4,
                "opk_private_destroy": "immediately_after_successful_aead",
                "old_dhs_destroy": "immediately_after_dh_ratchet",
                "dh_ratchet_history_retained": 0,
                "mkskipped_ttl_days": 30,
                "mkskipped_max_total": 2000,
                "mkskipped_max_per_chain": 1000,
                "session_idle_ttl_days": 90,
                "pcs": "after_reply_dh_ratchet",
            },
            "expected": {
                "spk_private_after_4_rotations": 3,
                "oldest_spk_deleted": True,
                "storage_contains_old_dhs": False,
                "storage_contains_consumed_opk": False,
                "prekey_with_deleted_spk": "KEY_HANDSHAKE_INVALID",
                "prekey_with_deleted_spk_action": "SESSION_RESET",
                "fs_window_days": 90,
                "pcs_instant": False,
                "session_idle_ttl_is_fs_boundary": False,
                "zeroization": "best_effort (delete IndexedDB record, overwrite raw buffers, drop refs)",
                "test": "storage scan after N ratchets/rotations + state-machine test",
            },
        }
    ],
}
V["sections"].append(s_section)

# ---------- meta / summary ----------
V["meta"]["vector_set_version"] = 3
V["meta"]["generated_at"] = "2026-11-16T18:00:00Z"
V["meta"]["status"] = (
    "normative v3 (E7-S3 remediation of E2EE-REVIEW-02) for E7 client/server crypto and "
    "conformance tests; all values must match byte-for-byte"
)
V["meta"]["supersedes"] = (
    "vector_set_version 2 (34 vectors, 189 checks). Envelope wire format is unchanged (v=1). "
    "I1/I2 binding signatures were re-encoded from hex to wire b64u64 (same 64 bytes; no expected "
    "fingerprint/safety-number changes). New: I3, J3, M1/M2, L3, N1/N2, R1, S1."
)
V["meta"]["generator"]["command"] = (
    "Save gen_e2ee_vectors_s2.py from docs/E2EE-SPIKE-NOTES.md §9.1 and gen_e2ee_vectors_s3.py "
    "from §10.2, then run: python3 gen_e2ee_vectors_s2.py && python3 gen_e2ee_vectors_s3.py "
    "(the S3 patch rewrites docs/E2EE-TEST-VECTORS.json and is deterministic)"
)
V["meta"]["generator"]["verify_command"] = (
    "Save verify_e2ee_vectors_s3.mjs from docs/E2EE-SPIKE-NOTES.md §10.3, then run: "
    "node verify_e2ee_vectors_s3.mjs docs/E2EE-TEST-VECTORS.json (expected: 273 checks, 0 failures)"
)
V["meta"]["conventions"]["signature_encoding"] = (
    "Wire-sourced signing fields (presented_*, pinned_*, envelope_json.*, API *_signature) are "
    "base64url: b64u64 = 86 chars for 64 bytes; a wire-valid vector MUST NOT carry 128 hex chars "
    "there. Internal KAT/meta values remain hex by design and never appear on the wire: "
    "A2.expected.signature, B3/B4.expected.signature, B5.expected.*_identity_binding_signature, "
    "meta.public_keys.*_identity_binding_signature."
)
V["meta"]["checks"] = {
    "generator": "internal assertions (assert) during generation + S3 patch length/shape assertions",
    "verifier": "verify_e2ee_vectors_s3.mjs",
    "verifier_checks": 273,
    "verifier_failures": 0,
}
V["meta"]["new_in_v3"] = [
    "I3-prekey-sender-identity-mismatch",
    "J3-fresh-device-managed-mode-blocked",
    "M1-peer-coverage-zero-rejected",
    "M2-peer-partial-coverage-warning",
    "L3-session-reset-multi-message",
    "N1-revoked-identity-replay",
    "N2-legacy-device-prekeys-rejected",
    "R1-e2ee-reply-to-id-rejected",
    "S1-fs-pcs-key-destruction",
]
V["meta"]["recomputed_in_v3"] = {
    "I1-tofu-first-contact-no-pin": "binding signature re-encoded hex->b64u64 (same 64 bytes); no other value changed",
    "I2-tofu-identity-mismatch": "presented/pinned binding re-encoded hex->b64u64; decision unchanged",
}
V["meta"]["review"] = {
    "document": "docs/E2EE-REVIEW-02.md",
    "verdict": "GO WITH CONDITIONS",
    "addressed_in_this_set": [
        "P0-2b",
        "P1-A",
        "I-01 (handoff text; contracts not modified)",
        "P1-B",
        "P1-C",
        "P1-D",
        "P1-E",
        "P1-F",
        "P1-G",
        "P1-H",
        "P2-1",
        "P2-2",
        "P2-3",
        "P2-4",
        "P2-5",
        "P2-8",
        "P2-9",
    ],
}
V["summary"]["sections"] = len(V["sections"])
V["summary"]["vectors"] = sum(len(s["vectors"]) for s in V["sections"])
V["summary"]["normative_sections"] = [s["id"] for s in V["sections"] if s["normative"]]
V["summary"]["informative_sections"] = [s["id"] for s in V["sections"] if not s["normative"]]

# assert wire shape of all signature fields we touched
for v in (i1, i2, i3):
    sig = v["inputs"]["presented_identity_binding_signature"]
    assert len(sig) == 86 and all(c.isalnum() or c in "-_" for c in sig), sig
    assert len(bytes.fromhex("00") * 0 or base64.urlsafe_b64decode(sig + "==")) == 64
assert len(i1["expected"]["pinned_identity_binding_signature"]) == 86
assert len(i2["inputs"]["local_pin"]["identity_binding_signature"]) == 86
assert len(i3["inputs"]["envelope_json"]) > 1000
assert V["summary"]["sections"] == 17 and V["summary"]["vectors"] == 43

with open(DST, "w", encoding="utf-8") as f:
    json.dump(V, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("S3 patch written; vectors:", V["summary"]["vectors"], "sections:", V["summary"]["sections"])
print("I1 binding:", i1["inputs"]["presented_identity_binding_signature"])

```

### 10.3. Независимый верификатор S3 (полный исходник)

Сохранить как `verify_e2ee_vectors_s3.mjs` и запустить `node verify_e2ee_vectors_s3.mjs docs/E2EE-TEST-VECTORS.json`. Использует только `node:crypto`/WebCrypto, **не** код генератора. Ожидаемо: **273 checks, 0 failures**.

```javascript

import fs from 'node:fs';
import crypto from 'node:crypto';
const { webcrypto } = crypto;

const V = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hex = (h) => Buffer.from(h, 'hex');
const b64d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const sha512 = (b) => crypto.createHash('sha512').update(b).digest();
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const XSPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ESPKI = Buffer.from('302a300506032b6570032100', 'hex');
const xpriv = (h) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, hex(h)]), format: 'der', type: 'pkcs8' });
const xpub = (h) => crypto.createPublicKey({ key: Buffer.concat([XSPKI, hex(h)]), format: 'der', type: 'spki' });
const dh = (priv, pub) => crypto.diffieHellman({ privateKey: xpriv(priv), publicKey: xpub(pub) });
const xpubOf = (h) => crypto.createPublicKey(xpriv(h)).export({ format: 'der', type: 'spki' }).subarray(-32);
const edpub = (h) => crypto.createPublicKey({ key: Buffer.concat([ESPKI, hex(h)]), format: 'der', type: 'spki' });
const edverify = (pub, msg, sig) => { try { return crypto.verify(null, msg, edpub(pub), hex(sig)); } catch { return false; } };
const uid = (s) => Buffer.from(s.replace(/-/g, ''), 'hex');
const u8 = (n) => Buffer.from([n]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

const get = (id) => {
  for (const s of V.sections) for (const v of s.vectors) if (v.id === id) return v;
  throw new Error('missing ' + id);
};
let checks = 0, failures = 0;
const ok = (name, cond, extra = '') => {
  checks++;
  if (!cond) { failures++; console.log('FAIL', name, extra); }
  else console.log('ok  ', name);
};
const eq = (name, a, b) => ok(name, a === b, `\n  got ${a}\n  exp ${b}`);

// ---------- meta ----------
eq('meta sections', V.sections.length, 17);
eq('meta vectors', V.sections.reduce((n, s) => n + s.vectors.length, 0), 43);
eq('meta normative sections', V.sections.filter(s => s.normative).length, 16);
eq('meta vector_set_version', V.meta.vector_set_version, 3);
eq('meta protocol envelope version unchanged', V.meta.protocol_envelope_version, 1);
eq('meta ik-binding domain', V.meta.conventions.domains.ik_binding, 'Krug/E2EE/v1/ik-binding');
eq('meta VH version', V.meta.conventions.verification_hash_version, 2);
ok('meta all vector ids unique', new Set(V.sections.flatMap(s => s.vectors.map(v => v.id))).size === 43);

// ---------- A ----------
{
  const v = get('A1-X25519-RFC7748');
  eq('A1 shared', dh(v.inputs.alice_private, v.inputs.bob_public).toString('hex'), v.expected.shared_secret);
  eq('A1 alice pub', xpubOf(v.inputs.alice_private).toString('hex'), v.expected.alice_public_derived);
  eq('A1 bob pub', xpubOf(v.inputs.bob_private).toString('hex'), v.expected.bob_public_derived);
}
{
  const v = get('A2-Ed25519-RFC8032');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), hex(v.inputs.private_seed)]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  eq('A2 pub key', pub.toString('hex'), v.expected.public_key);
  eq('A2 sig', crypto.sign(null, Buffer.from(v.inputs.message, 'utf8'), priv).toString('hex'), v.expected.signature);
  ok('A2 verify', edverify(v.expected.public_key, Buffer.from(v.inputs.message, 'utf8'), v.expected.signature));
}
{
  const v = get('A3-HKDF-SHA256-RFC5869');
  eq('A3 hkdf', hkdf(hex(v.inputs.ikm), hex(v.inputs.salt), hex(v.inputs.info), v.inputs.length).toString('hex'), v.expected.okm);
}
{
  const v = get('A4-AES256GCM-NIST');
  const key = await webcrypto.subtle.importKey('raw', hex(v.inputs.key), 'AES-GCM', false, ['encrypt']);
  const ct = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: hex(v.inputs.nonce), additionalData: Buffer.alloc(0) }, key, Buffer.alloc(0)));
  eq('A4 tag', ct.toString('hex'), v.expected.ciphertext_including_tag);
}

const ids = V.meta.ids, seeds = V.meta.test_seeds, pubs = V.meta.public_keys;
const Z32 = Buffer.alloc(32), F = Buffer.alloc(32, 0xff);
const CHAT = uid(ids.chat_id), A_DEV = uid(ids.alice_device_id), A2_DEV = uid(ids.alice_verifier_device_2_id);
const B_DEV = uid(ids.bob_device_id), A_USER = uid(ids.alice_user_id), B_USER = uid(ids.bob_user_id);

// ---------- B ----------
let sk, sid;
{
  const v = get('B1-X3DH-4DH');
  const dh1 = dh(v.inputs.alice_identity_dh_private, v.inputs.bob_signed_prekey_public);
  const dh2 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_identity_dh_public);
  const dh3 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_signed_prekey_public);
  const dh4 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_one_time_prekey_public);
  eq('B1 dh1', dh1.toString('hex'), v.expected.dh1);
  eq('B1 dh2', dh2.toString('hex'), v.expected.dh2);
  eq('B1 dh3', dh3.toString('hex'), v.expected.dh3);
  eq('B1 dh4', dh4.toString('hex'), v.expected.dh4);
  const ikm = Buffer.concat([F, dh1, dh2, dh3, dh4]);
  eq('B1 ikm', ikm.toString('hex'), v.expected.ikm);
  sk = hkdf(ikm, Z32, Buffer.from(v.inputs.info), 32);
  eq('B1 sk', sk.toString('hex'), v.expected.sk);
  sid = hkdf(sk, Z32, Buffer.from('Krug/E2EE/v1/session-id'), 16);
  eq('B1 sid', sid.toString('hex'), v.expected.session_id);
}
{
  const v = get('B2-X3DH-3DH-otp-exhausted');
  const dh1 = dh(v.inputs.alice_identity_dh_private, v.inputs.bob_signed_prekey_public);
  const dh2 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_identity_dh_public);
  const dh3 = dh(v.inputs.alice_ephemeral_private, v.inputs.bob_signed_prekey_public);
  const ikm = Buffer.concat([F, dh1, dh2, dh3]);
  eq('B2 ikm', ikm.toString('hex'), v.expected.ikm);
  eq('B2 sk', hkdf(ikm, Z32, Buffer.from(v.inputs.info), 32).toString('hex'), v.expected.sk);
  eq('B2 sid', hkdf(hex(v.expected.sk), Z32, Buffer.from('Krug/E2EE/v1/session-id'), 16).toString('hex'), v.expected.session_id);
}
{
  const v = get('B3-SPK-signature');
  const spkMsg = Buffer.concat([Buffer.from('Krug/E2EE/v1/spk-signature'), u8(1),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(v.inputs.key_id)); return b; })(),
    Buffer.from(v.inputs.key_id), hex(v.inputs.spk_public)]);
  eq('B3 signed_message', spkMsg.toString('hex'), v.inputs.signed_message);
  eq('B3 spk derives', xpubOf(seeds['bob-spk']).toString('hex'), v.inputs.spk_public);
  ok('B3 signature verifies', edverify(pubs.bob_identity_signing_key, spkMsg, v.expected.signature));
}
const preambleFromInputs = () => {
  const v = get('B4-prekey-preamble');
  const out = Buffer.concat([
    Buffer.from('Krug/E2EE/v1/prekey'), u8(1), uid(v.inputs.chat_id), uid(v.inputs.sender_device_id),
    uid(v.inputs.recipient_device_id), hex(v.inputs.sender_identity_signing_key),
    hex(v.inputs.sender_identity_dh_key), hex(v.inputs.sender_ephemeral_key),
    hex(v.inputs.recipient_identity_dh_key), hex(v.inputs.recipient_identity_signing_key),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(v.inputs.recipient_spk_id)); return b; })(),
    Buffer.from(v.inputs.recipient_spk_id), hex(v.inputs.recipient_spk_public),
    u8(v.inputs.recipient_opk_id ? 1 : 0),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(v.inputs.recipient_opk_id || '')); return b; })(),
    Buffer.from(v.inputs.recipient_opk_id || ''),
    v.inputs.recipient_opk_public ? hex(v.inputs.recipient_opk_public) : Buffer.alloc(32),
    hex(v.inputs.session_id)
  ]);
  return out;
};
const pre = preambleFromInputs();
{
  const v = get('B4-prekey-preamble');
  eq('B4 preamble bytes', pre.toString('hex'), v.expected.preamble);
  eq('B4 preamble len 323', pre.length, 323);
  eq('B4 preamble hash', sha256(pre).toString('hex'), v.expected.preamble_sha256);
  ok('B4 prekey signature verifies', edverify(pubs.alice_identity_signing_key,
    Buffer.concat([Buffer.from('Krug/E2EE/v1/prekey-signature'), pre]), v.expected.signature));
}
{
  const v = get('B5-identity-binding-signature');
  const msg = Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), hex(v.inputs.alice_ik_dh_public), hex(v.inputs.alice_ik_sig_public)]);
  const msgB = Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), hex(v.inputs.bob_ik_dh_public), hex(v.inputs.bob_ik_sig_public)]);
  eq('B5 alice signed message', msg.toString('hex'), v.inputs.alice_signed_message);
  eq('B5 bob signed message', msgB.toString('hex'), v.inputs.bob_signed_message);
  eq('B5 signed message len', msg.length, 88);
  ok('B5 alice binding verifies', edverify(v.inputs.alice_ik_sig_public, msg, v.expected.alice_identity_binding_signature));
  ok('B5 bob binding verifies', edverify(v.inputs.bob_ik_sig_public, msgB, v.expected.bob_identity_binding_signature));
  const wrongDh = Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), hex(pubs.attacker_identity_dh_key), hex(v.inputs.alice_ik_sig_public)]);
  ok('B5 wrong DH rejected (TOFU negative prerequisite)', !edverify(v.inputs.alice_ik_sig_public, wrongDh, v.expected.alice_identity_binding_signature));
  ok('B5 wrong signer rejected', !edverify(v.inputs.bob_ik_sig_public, msg, v.expected.alice_identity_binding_signature));
}

// ---------- C ----------
const kdfRk = (rk, dhOut) => { const okm = hkdf(dhOut, rk, Buffer.from('Krug/E2EE/v1/dr-root'), 64); return [okm.subarray(0, 32), okm.subarray(32)]; };
const kdfCk = (ck) => [hmac(ck, u8(1)), hmac(ck, u8(2))];
{
  const v = get('C1-HKDF-session-id');
  eq('C1 sid', hkdf(sk, Z32, Buffer.from(v.inputs.info), 16).toString('hex'), v.expected.okm);
}
const a0pub = xpubOf(seeds['alice-ratchet-0']);
let rk1, cks;
{
  const v = get('C2-DR-root-step-alice-initial');
  const dhOut = dh(seeds['alice-ratchet-0'], pubs.bob_signed_prekey);
  eq('C2 dh', dhOut.toString('hex'), v.inputs.dh_output);
  [rk1, cks] = kdfRk(sk, dhOut);
  eq('C2 rk1', rk1.toString('hex'), v.expected.root_key_next);
  eq('C2 cks', cks.toString('hex'), v.expected.chain_key_sending);
}
{
  const v = get('C3-DR-chain-3-messages');
  let ck = cks;
  for (const exp of v.expected) {
    const [mk, next] = kdfCk(ck);
    eq(`C3 mk ${exp.n}`, mk.toString('hex'), exp.message_key);
    eq(`C3 ck ${exp.n}`, next.toString('hex'), exp.next_chain_key);
    ck = next;
  }
}

// ---------- D ----------
{
  const v = get('D1-inner-payload-framing');
  const raw = Buffer.concat([Buffer.from('Krug/E2EE/v1/payload'), Buffer.from([1, 1]), u32(Buffer.byteLength(v.inputs.body_utf8)), Buffer.from(v.inputs.body_utf8)]);
  eq('D1 raw len', raw.length, v.expected.raw_len);
  const padded = Buffer.concat([raw, Buffer.alloc((256 - (raw.length % 256)) % 256)]);
  eq('D1 padded len', padded.length, v.expected.padded_len);
  eq('D1 padded hex', padded.toString('hex'), v.expected.padded_hex);
}
async function aesgcmDecrypt(keyHex, nonceHex, ctHex, adHex) {
  const key = await webcrypto.subtle.importKey('raw', hex(keyHex), 'AES-GCM', false, ['decrypt']);
  return Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: hex(nonceHex), additionalData: hex(adHex) }, key, hex(ctHex)));
}
{
  const v = get('D2-message-aead-m1');
  eq('D2 ad len 163', v.inputs.ad_len, 163);
  eq('D2 ad len', hex(v.inputs.ad_hex).length, v.inputs.ad_len);
  const ek = hkdf(hex(v.inputs.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
  const nn = hkdf(hex(v.inputs.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
  eq('D2 aead key', ek.toString('hex'), v.expected.aead_key);
  eq('D2 nonce', nn.toString('hex'), v.expected.nonce);
  eq('D2 decrypt to padded', (await aesgcmDecrypt(v.expected.aead_key, v.expected.nonce, v.expected.ciphertext_including_tag, v.inputs.ad_hex)).toString('hex'), v.inputs.padded_plaintext_hex);
}
{
  const v = get('D3-message-aead-m2');
  eq('D3 decrypt to padded', (await aesgcmDecrypt(v.expected.aead_key, v.expected.nonce, v.expected.ciphertext_including_tag, v.inputs.ad_hex)).toString('hex'), v.inputs.padded_plaintext_hex);
}

// ---------- E ----------
const hdrBytes = (h) => Buffer.concat([u8(1), u8(0), u32(h.pn), u32(h.n), hex(h.dh)]);
{
  const v = get('E1-conversation-trace');
  const steps = v.expected_steps;
  for (const s of steps) {
    eq(`E header v ${s.step}`, s.header.v, 1);
    const isPre = s.step === 'A->B m1';
    const isA = s.step.startsWith('A');
    const sdev = isA ? A_DEV : B_DEV, rdev = isA ? B_DEV : A_DEV;
    const ad = Buffer.concat([Buffer.from('Krug/E2EE/v1/ad'), u8(1), u8(isPre ? 1 : 0), CHAT, sdev, u32(1), rdev, u32(1), sid,
      isPre ? sha256(pre) : Buffer.alloc(32), hdrBytes(s.header)]);
    eq(`E ad ${s.step}`, ad.toString('hex'), s.ad_hex);
    const ek = hkdf(hex(s.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
    const nn = hkdf(hex(s.message_key), Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
    const pt = await aesgcmDecrypt(ek.toString('hex'), nn.toString('hex'), s.ciphertext, s.ad_hex);
    ok(`E decrypt ${s.step}`, pt.length % 256 === 0 && pt.subarray(0, 20).toString() === 'Krug/E2EE/v1/payload');
    if (s.plaintext_hex) eq(`E plaintext ${s.step}`, pt.toString('hex'), s.plaintext_hex);
  }
  const B1 = seeds['bob-ratchet-1'], A1 = seeds['alice-ratchet-1'], B2 = seeds['bob-ratchet-2'];
  const [rk1b, ckrBob0] = kdfRk(sk, dh(seeds['bob-spk'], a0pub));
  eq('E bob initial CKr == alice CKs', ckrBob0.toString('hex'), cks.toString('hex'));
  eq('E m1 mk', kdfCk(cks)[0].toString('hex'), steps[0].message_key);
  const [rk2, cksB1] = kdfRk(rk1, dh(B1, a0pub));
  eq('E r1 mk', kdfCk(cksB1)[0].toString('hex'), steps[1].message_key);
  const [, ckrAlice] = kdfRk(rk1, dh(seeds['alice-ratchet-0'], xpubOf(B1)));
  const [rk3, cksA1] = kdfRk(rk2, dh(A1, xpubOf(B1)));
  eq('E alice CKr == bob CKs', ckrAlice.toString('hex'), cksB1.toString('hex'));
  eq('E m2 mk', kdfCk(cksA1)[0].toString('hex'), steps[2].message_key);
  const [, ckrBob2] = kdfRk(rk2, dh(B1, xpubOf(A1)));
  const [, cksB2] = kdfRk(rk3, dh(B2, xpubOf(A1)));
  eq('E bob CKr == alice CKs', ckrBob2.toString('hex'), cksA1.toString('hex'));
  eq('E r2 mk', kdfCk(cksB2)[0].toString('hex'), steps[3].message_key);
}

// ---------- E2 ----------
{
  const v = get('E2-skipped-key-trace');
  let ck = hex(v.inputs.chain_key_0);
  const mks = [];
  for (let i = 0; i < 3; i++) { const [mk, next] = kdfCk(ck); mks.push(mk); ck = next; }
  for (const m of v.expected.messages) {
    eq(`E2 header v n${m.n}`, m.header.v, 1);
    eq(`E2 mk n${m.n}`, mks[m.n].toString('hex'), m.message_key);
    const ek = hkdf(mks[m.n], Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
    const nn = hkdf(mks[m.n], Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
    eq(`E2 decrypt n${m.n}`, (await aesgcmDecrypt(ek.toString('hex'), nn.toString('hex'), m.ciphertext, m.ad_hex)).toString('hex'), m.plaintext_hex);
  }
  eq('E2 skipped key n1', mks[1].toString('hex'), v.expected.skipped_message_key_n1);
  eq('E2 delivery order', v.expected.delivery_order.join(','), '0,2,1');
  eq('E2 Nr after m3', v.expected.receiver_state_after_m3.Nr, 3);
  eq('E2 stored after m2', v.expected.receiver_state_after_m2.stored_skipped.length, 0);
}

// ---------- F ----------
{
  const v = get('F1-envelope-prekey');
  const env = JSON.parse(v.expected.envelope_json);
  eq('F1 session b64', b64d(env.session_id).toString('hex'), sid.toString('hex'));
  eq('F1 ciphertext b64', b64d(env.ciphertext).toString('hex'), get('D2-message-aead-m1').expected.ciphertext_including_tag);
  eq('F1 header dh', b64d(env.header.dh).toString('hex'), get('E1-conversation-trace').expected_steps[0].header.dh);
  eq('F1 AD length', hex(v.expected.decoded.ad_hex).length, 163);
  ok('F1 prekey sig 64 bytes', b64d(env.prekey.signature).length === 64);
  ok('F1 b64url unpadded', [env.session_id, env.ciphertext, env.header.dh, env.prekey.spk_public].every(x => !x.includes('=') && !x.includes('+') && !x.includes('/')));
  ok('F1 canonical b64url roundtrip', [env.session_id, env.ciphertext, env.header.dh].every(x => b64u(b64d(x)) === x));
  const env2 = JSON.parse(get('F2-envelope-no-prekey').expected.envelope_json);
  ok('F2 no prekey field', env2.prekey === undefined);
  eq('F2 header v', env2.header.v, 1);
}

// ---------- G ----------
const fp = (sig, dhPub) => sha256(Buffer.concat([Buffer.from('Krug/E2EE/v1/fingerprint'), hex(sig), hex(dhPub)]));
{
  const v = get('G1-device-fingerprint');
  eq('G1 alice fp', fp(v.inputs.identity_signing_key, v.inputs.identity_dh_key).toString('hex'), v.expected.alice_fingerprint);
  eq('G1 bob fp', fp(pubs.bob_identity_signing_key, pubs.bob_identity_dh_key).toString('hex'), v.expected.bob_fingerprint);
}
const sn = (entries) => {
  const sorted = entries.map(e => Buffer.concat([uid(e.user_id), uid(e.device_id), hex(e.fingerprint)])).sort(Buffer.compare);
  const digest = sha512(Buffer.concat([Buffer.from('Krug/E2EE/v1/safety-number'), u8(1), u32(sorted.length), ...sorted]));
  const digits = (BigInt('0x' + digest.toString('hex')) % (10n ** 60n)).toString().padStart(60, '0');
  return { digest, digits, display: digits.match(/.{5}/g).join(' ') };
};
{
  const v = get('G2-safety-number');
  const r = sn(v.inputs.entries);
  eq('G2 sha512', r.digest.toString('hex'), v.expected.sha512);
  eq('G2 digits', r.digits, v.expected.digits);
  eq('G2 display', r.display, v.expected.display);
  eq('G2 qr', v.expected.qr_payload, `krug://verify/v1?dev1=${ids.alice_device_id}&fp1=${pubs.alice_fingerprint ? b64u(hex(pubs.alice_fingerprint)) : ''}&dev2=${ids.bob_device_id}&fp2=${b64u(hex(pubs.bob_fingerprint))}`);
}
{
  const v = get('G3-safety-number-after-key-change');
  const r = sn(v.inputs.entries);
  eq('G3 digits differ', r.digits !== get('G2-safety-number').expected.digits, true);
  eq('G3 sha512', r.digest.toString('hex'), v.expected.sha512);
  eq('G3 digits', r.digits, v.expected.digits);
}
const vh2 = (chat, vuser, vdev, tdev, gen, digits) => sha256(Buffer.concat([
  Buffer.from('Krug/E2EE/v1/verification'), u8(2), uid(chat), uid(vuser), uid(vdev), uid(tdev), u32(gen), Buffer.from(digits)]));
{
  const v = get('G4-verification-hash');
  eq('G4 vh version', v.inputs.vh_version, 2);
  eq('G4 vhash', vh2(v.inputs.chat_id, v.inputs.verifier_user_id, v.inputs.verifier_device_id, v.inputs.target_device_id, v.inputs.target_key_generation, v.inputs.safety_number_digits).toString('hex'), v.expected.safety_number_hash);
  const g5 = get('G5-verification-per-device');
  const l1 = vh2(g5.inputs.chat_id, g5.inputs.verifier_user_id, g5.inputs.verifier_device_id_l1, g5.inputs.target_device_id, g5.inputs.target_key_generation, g5.inputs.l1_safety_number_digits);
  const l2 = vh2(g5.inputs.chat_id, g5.inputs.verifier_user_id, g5.inputs.verifier_device_id_l2, g5.inputs.target_device_id, g5.inputs.target_key_generation, g5.inputs.l2_safety_number_digits);
  eq('G5 l1 hash', l1.toString('hex'), g5.expected.l1_verification_hash);
  eq('G5 l2 hash', l2.toString('hex'), g5.expected.l2_verification_hash);
  ok('G5 hashes differ', l1.toString('hex') !== l2.toString('hex'));
  ok('G5 digits differ', g5.inputs.l1_safety_number_digits !== g5.inputs.l2_safety_number_digits);
  eq('G5 l2 fingerprint derives', fp(pubs.alice_verifier_device_2_identity_signing_key, pubs.alice_verifier_device_2_identity_dh_key).toString('hex'), g5.inputs.l2_fingerprint);
  eq('G5 l2 verified is null', g5.expected.server_verified_for_l2, null);
}

// ---------- I: TOFU negative ----------
const x3dhCalc = (ikPriv, ekPriv, bobIkDh, bobSpk, bobOpk) => {
  const dh1 = dh(ikPriv, bobSpk), dh2 = dh(ekPriv, bobIkDh), dh3 = dh(ekPriv, bobSpk), dh4 = dh(ekPriv, bobOpk);
  const ikm = Buffer.concat([F, dh1, dh2, dh3, dh4]);
  const skk = hkdf(ikm, Z32, Buffer.from('Krug/E2EE/v1/x3dh'), 32);
  return { sk: skk, sid: hkdf(skk, Z32, Buffer.from('Krug/E2EE/v1/session-id'), 16) };
};
function checkTofuEnvelope(v) {
  const env = JSON.parse(v.inputs.envelope_json);
  eq(`${v.id} wire v`, env.v, 1);
  const x = x3dhCalc(seeds['mallory-ik-dh'], seeds['mallory-ek'], pubs.bob_identity_dh_key, pubs.bob_signed_prekey, pubs.bob_one_time_prekey);
  eq(`${v.id} session from X3DH`, x.sid.toString('hex'), b64d(env.session_id).toString('hex'));
  const pk = env.prekey;
  const pre = Buffer.concat([
    Buffer.from('Krug/E2EE/v1/prekey'), u8(1), uid(env.chat_id), uid(env.sender_device_id), uid(env.recipient_device_id),
    b64d(pk.sender_identity_signing_key), b64d(pk.sender_identity_dh_key), b64d(pk.sender_ephemeral_key),
    b64d(pk.recipient_identity_dh_key), hex(pubs.bob_identity_signing_key),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(pk.spk_id)); return b; })(), Buffer.from(pk.spk_id), b64d(pk.spk_public),
    u8(1),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(Buffer.byteLength(pk.opk_id)); return b; })(), Buffer.from(pk.opk_id), b64d(pk.opk_public),
    b64d(env.session_id)
  ]);
  ok(`${v.id} preamble signature valid`, edverify(b64d(pk.sender_identity_signing_key).toString('hex'), Buffer.concat([Buffer.from('Krug/E2EE/v1/prekey-signature'), pre]), b64d(pk.signature).toString('hex')));
  const ad = Buffer.concat([Buffer.from('Krug/E2EE/v1/ad'), u8(1), u8(1), uid(env.chat_id), uid(env.sender_device_id), u32(1),
    uid(env.recipient_device_id), u32(1), b64d(env.session_id), sha256(pre), hdrBytes({ ...env.header, dh: b64d(env.header.dh).toString('hex') })]);
  const mk = hmac(cksFromMallory(), u8(1));
  const ek = hkdf(mk, Z32, Buffer.from('Krug/E2EE/v1/aead-key'), 32);
  const nn = hkdf(mk, Z32, Buffer.from('Krug/E2EE/v1/aead-nonce'), 12);
  return aesgcmDecrypt(ek.toString('hex'), nn.toString('hex'), b64d(env.ciphertext).toString('hex'), ad.toString('hex')).then(pt => {
    ok(`${v.id} AEAD decrypts`, pt.length % 256 === 0 && pt.subarray(0, 20).toString() === 'Krug/E2EE/v1/payload');
    eq(`${v.id} presented fingerprint`, fp(b64d(pk.sender_identity_signing_key).toString('hex'), b64d(pk.sender_identity_dh_key).toString('hex')).toString('hex'), v.inputs.presented_fingerprint);
    ok(`${v.id} presented binding verifies (wire b64u64)`, edverify(b64d(pk.sender_identity_signing_key).toString('hex'), Buffer.concat([Buffer.from('Krug/E2EE/v1/ik-binding'), u8(1), b64d(pk.sender_identity_dh_key), b64d(pk.sender_identity_signing_key)]), b64d(v.inputs.presented_identity_binding_signature).toString('hex')));
    return pk;
  });
}
function cksFromMallory() {
  const x = x3dhCalc(seeds['mallory-ik-dh'], seeds['mallory-ek'], pubs.bob_identity_dh_key, pubs.bob_signed_prekey, pubs.bob_one_time_prekey);
  // Alice/Bob ratchet: initiator RK, CKs = KDF_RK(SK, DH(EK? no: DHs=alice-ratchet-0, SPK))
  return kdfRk(x.sk, dh(seeds['mallory-ratchet-0'], pubs.bob_signed_prekey))[1];
}
{
  const v = get('I1-tofu-first-contact-no-pin');
  const pk = await checkTofuEnvelope(v);
  eq('I1 pin created', v.expected.pin_created, true);
  eq('I1 pin fingerprint == presented', v.expected.pinned_fingerprint, v.inputs.presented_fingerprint);
  eq('I1 unverified', v.expected.verified, false);
  eq('I1 safety number', sn([
    { user_id: ids.alice_user_id, device_id: ids.alice_device_id, fingerprint: v.inputs.presented_fingerprint },
    { user_id: ids.bob_user_id, device_id: ids.bob_device_id, fingerprint: pubs.bob_fingerprint }]).digits, v.expected.safety_number_digits);
  ok('I1 safety number differs from real peer', v.expected.safety_number_digits !== get('G2-safety-number').expected.digits);
  eq('I1 TOFU residual documented', v.expected.residual_risk.includes('TOFU window'), true);
}
{
  const v = get('I2-tofu-identity-mismatch');
  await checkTofuEnvelope(v);
  ok('I2 pin exists', v.inputs.local_pin !== null);
  eq('I2 pinned fingerprint is the real one', v.inputs.local_pin.fingerprint, pubs.alice_fingerprint);
  ok('I2 pin mismatch detected', v.expected.pin_mismatch === true && v.inputs.presented_fingerprint !== v.inputs.local_pin.fingerprint);
  eq('I2 decision', v.expected.decision, 'KEY_CHANGE_DETECTED');
  eq('I2 no session created', v.expected.session_created, false);
  eq('I2 no display', v.expected.message_displayed, false);
  eq('I2 OPK not consumed', v.expected.opk_consumed, false);
  eq('I2 send blocked', v.expected.send_blocked_until_confirmation, true);
  eq('I2 verified reset', v.expected.verified_reset, true);
  eq('I2 binding alone does not stop substitution', v.expected.binding_prevents_substitution, false);
}

// ---------- J/K/L conformance ----------
{
  const j1 = get('J1-security-mode-downgrade-rejected');
  eq('J1 server rejects', j1.expected.server_decision, '409 MODE_CHANGE_FORBIDDEN');
  eq('J1 mode unchanged', j1.expected.mode_changed, false);
  eq('J1 client blocks', j1.expected.client_decision, 'BLOCK_SEND_SECURITY_ALERT');
  eq('J1 no plaintext', j1.expected.plaintext_messages_sent, 0);
  eq('J1 downgrade is attack', j1.expected.downgrade_is_attack, true);
  const j2 = get('J2-e2ee-creation-with-flag-off');
  eq('J2 flag off 409', j2.expected.http_status, 409);
  eq('J2 code', j2.expected.code, 'E2EE_DISABLED');
  eq('J2 no badge', j2.expected.badge_shown, false);
  eq('J2 does not close existing mode', j2.expected.flag_off_closes_existing_mode, false);
  eq('J2 existing stays E2EE (plaintext forbidden)', j2.expected.existing_e2ee_chat_plaintext, '422 E2EE_PLAINTEXT_FORBIDDEN');
}
{
  const k1 = get('K1-client-message-id-same-sender-replay');
  eq('K1 replay', k1.expected.idempotent_replay, true);
  eq('K1 same id', k1.expected.same_message_id, true);
  eq('K1 not in AD', k1.expected.in_ad, false);
  eq('K1 scope', k1.inputs.unique_key.join(','), 'chat_id,sender_id,client_message_id');
  const k2 = get('K2-client-message-id-cross-user-conflict');
  eq('K2 409', k2.expected.http_status, 409);
  eq('K2 code', k2.expected.code, 'CLIENT_MESSAGE_ID_CONFLICT');
  eq('K2 no replay', k2.expected.idempotent_replay, false);
  eq('K2 no cross-user leak', k2.expected.returns_other_users_message, false);
}
{
  const l1 = get('L1-session-reset-payload');
  const raw = Buffer.concat([Buffer.from('Krug/E2EE/v1/payload'), u8(1), u8(l1.inputs.content_type), u32(l1.inputs.body_len), hex(l1.inputs.body_hex)]);
  const padded = Buffer.concat([raw, Buffer.alloc((256 - (raw.length % 256)) % 256)]);
  eq('L1 content type', l1.inputs.content_type, 2);
  eq('L1 raw len', raw.length, l1.expected.raw_len);
  eq('L1 padded len', padded.length, l1.expected.padded_len);
  eq('L1 padded hex', padded.toString('hex'), l1.expected.padded_hex);
  eq('L1 payload hash', sha256(padded).toString('hex'), l1.expected.payload_sha256);
  eq('L1 hidden', l1.expected.user_visible, false);
  const l2 = get('L2-session-reset-state-machine');
  eq('L2 encrypted transport', l2.inputs.transport, 'prekey_envelope_content_type_2');
  eq('L2 no WS event', l2.inputs.ws_event_used, false);
  eq('L2 one reset', l2.expected.max_reset_attempts, 1);
  eq('L2 new client_message_id', l2.expected.resend_uses_new_client_message_id, true);
  eq('L2 no ciphertext reuse', l2.expected.old_ciphertext_reused, false);
}

// ---------- S3: wire encoding + new conformance vectors ----------
{
  const sigs = [
    get('I1-tofu-first-contact-no-pin').inputs.presented_identity_binding_signature,
    get('I1-tofu-first-contact-no-pin').expected.pinned_identity_binding_signature,
    get('I2-tofu-identity-mismatch').inputs.presented_identity_binding_signature,
    get('I2-tofu-identity-mismatch').inputs.local_pin.identity_binding_signature,
    get('I3-prekey-sender-identity-mismatch').inputs.presented_identity_binding_signature,
  ];
  ok('S3 all wire binding signatures are 86-char b64u', sigs.every(x => /^[A-Za-z0-9_-]{86}$/.test(x)), sigs.map(x => x.length).join(','));
  ok('S3 all wire binding signatures decode to 64 bytes', sigs.every(x => b64d(x).length === 64), sigs.map(x => b64d(x).length).join(','));
  ok('S3 no 128-hex signature left', sigs.every(x => !/^[0-9a-f]{128}$/.test(x)));
}
{
  const v = get('I3-prekey-sender-identity-mismatch');
  await checkTofuEnvelope(v);
  ok('I3 prekey IK_sig != registered', v.inputs.prekey_sender_identity_signing_key !== v.inputs.registered_identity_signing_key);
  ok('I3 prekey IK_dh != registered', v.inputs.prekey_sender_identity_dh_key !== v.inputs.registered_identity_dh_key);
  eq('I3 prekey == bundle fields (negative)', v.inputs.prekey_sender_identity_signing_key === v.inputs.bundle_identity_signing_key, false);
  eq('I3 preamble signature valid for presented keys', v.inputs.preamble_signature_valid_for_presented_keys, true);
  eq('I3 binding valid for presented keys', v.inputs.binding_valid_for_presented_keys, true);
  eq('I3 server rejects', v.expected.server_decision, '422 INVALID_ENVELOPE_FORMAT');
  eq('I3 server rejected flag', v.expected.server_rejected, true);
  eq('I3 no message', v.expected.message_created, false);
  eq('I3 no seq', v.expected.seq_allocated, false);
  eq('I3 client decision', v.expected.client_decision, 'KEY_HANDSHAKE_INVALID');
  eq('I3 no session', v.expected.session_created, false);
  eq('I3 no display', v.expected.message_displayed, false);
  eq('I3 no OPK consume', v.expected.opk_consumed, false);
  eq('I3 no TOFU pin', v.expected.tofu_pin_written, false);
  eq('I3 binding alone insufficient', v.expected.binding_alone_insufficient, true);
}
{
  const v = get('J3-fresh-device-managed-mode-blocked');
  eq('J3 no local pin', v.inputs.client_has_pin, false);
  eq('J3 peer capable', v.inputs.peer_has_e2ee_capable_device, true);
  eq('J3 client blocks', v.expected.client_decision, 'BLOCK_SEND_SECURITY_ALERT');
  eq('J3 zero plaintext', v.expected.plaintext_messages_sent, 0);
  eq('J3 send blocked', v.expected.send_blocked, true);
  eq('J3 explicit confirmation', v.expected.requires_explicit_mode_confirmation, true);
  eq('J3 no fallback', v.expected.fallback_to_managed_allowed, false);
  eq('J3 client blocks before any request', v.expected.client_blocks_before_request, true);
  ok('J3 residual risk honest', v.expected.residual_risk.includes('cannot prove'));
}
{
  const m1 = get('M1-peer-coverage-zero-rejected');
  eq('M1 peer devices > 0', m1.inputs.peer_devices > 0, true);
  eq('M1 peer covered == 0', m1.inputs.peer_covered, 0);
  eq('M1 409', m1.expected.http_status, 409);
  eq('M1 code', m1.expected.code, 'E2EE_NO_PEER_ENVELOPE');
  eq('M1 no message', m1.expected.message_created, false);
  eq('M1 no seq', m1.expected.seq_allocated, false);
  eq('M1 client precheck', m1.expected.client_must_not_send, true);
  const m2 = get('M2-peer-partial-coverage-warning');
  eq('M2 accepted', m2.expected.http_status, 201);
  eq('M2 warning', m2.expected.warning, 'PEER_DEVICE_UNCOVERED');
  eq('M2 delivered to peer', m2.expected.delivered_to_peer, true);
  ok('M2 uncovered is a real second peer device', m2.expected.uncovered_device_ids[0] !== ids.bob_device_id);
  const env = JSON.parse(m2.inputs.envelope_json);
  ok('M2 embedded envelope is wire-valid v1', env.v === 1 && env.recipient_device_id === ids.bob_device_id && env.sender_device_id !== env.recipient_device_id);
}
{
  const l3 = get('L3-session-reset-multi-message');
  eq('L3 reset covers all 5', l3.expected.resend_count, l3.inputs.old_client_message_ids.length);
  eq('L3 new ids', l3.expected.all_with_new_client_message_ids, true);
  eq('L3 order', l3.expected.order_preserved, true);
  eq('L3 no duplicates', l3.expected.duplicates_in_ui, 0);
  eq('L3 one UI group', l3.expected.ui_retry_groups, 1);
  eq('L3 nothing silently lost', l3.expected.undelivered_left, 0);
  ok('L3 batch cap documented', l3.inputs.max_batch === 20);
  eq('L3 empty outbox noop', l3.expected.empty_outbox_is_noop, true);
}
{
  const n1 = get('N1-revoked-identity-replay');
  eq('N1 410', n1.expected.http_status, 410);
  eq('N1 revoked code', n1.expected.code, 'DEVICE_REVOKED');
  eq('N1 no reactivation', n1.expected.device_reactivated, false);
  eq('N1 no new device', n1.expected.new_device_created, false);
  eq('N1 generation unchanged', n1.expected.key_generation_after, n1.inputs.revoked_key_generation);
  const n2 = get('N2-legacy-device-prekeys-rejected');
  eq('N2 legacy code', n2.expected.code, 'E2EE_LEGACY_DEVICE');
  eq('N2 422', n2.expected.http_status, 422);
  eq('N2 no in-place upgrade', n2.expected.device_upgraded_in_place, false);
  eq('N2 claim uses NO_KEYS', n2.expected.claim_reason_for_same_device, 'NO_KEYS');
  ok('N2 remedy explicit', n2.expected.details.remedy === 'register_new_device');
}
{
  const r1 = get('R1-e2ee-reply-to-id-rejected');
  eq('R1 rejected', r1.expected.http_status, 422);
  eq('R1 code', r1.expected.code, 'E2EE_PLAINTEXT_FORBIDDEN');
  eq('R1 field', r1.expected.details_field, 'reply_to_id');
  eq('R1 no message', r1.expected.message_created, false);
  eq('R1 no seq', r1.expected.seq_allocated, false);
  eq('R1 no DB row field', r1.expected.stored_reply_to_id, null);
  eq('R1 inner payload allowed', r1.expected.reply_allowed_inside_inner_payload, true);
  eq('R1 not in AD', r1.expected.ad_includes_reply_to_id, false);
  ok('R1 AD field list has no reply_to_id', !r1.inputs.ad_fields.includes('reply_to_id'));
}
{
  const s1 = get('S1-fs-pcs-key-destruction');
  eq('S1 retain total', s1.inputs.spk_retain_private_total, 3);
  eq('S1 retain previous', s1.inputs.spk_previous, 2);
  eq('S1 window 90', s1.inputs.spk_retain_window_days, 90);
  eq('S1 one window semantics', s1.inputs.spk_retain_window_days, s1.inputs.spk_retain_private_total * s1.inputs.spk_ttl_days);
  eq('S1 keeps 3 after 4 rotations', s1.expected.spk_private_after_4_rotations, 3);
  eq('S1 oldest deleted', s1.expected.oldest_spk_deleted, true);
  eq('S1 no old DHs', s1.expected.storage_contains_old_dhs, false);
  eq('S1 no consumed OPK', s1.expected.storage_contains_consumed_opk, false);
  eq('S1 deleted SPK -> handshake invalid', s1.expected.prekey_with_deleted_spk, 'KEY_HANDSHAKE_INVALID');
  eq('S1 PCS not instant', s1.expected.pcs_instant, false);
  eq('S1 idle TTL is not FS', s1.expected.session_idle_ttl_is_fs_boundary, false);
  eq('S1 window matches meta', s1.expected.fs_window_days, 90);
}

// ---------- limits arithmetic (P1-3) ----------
{
  const L = V.meta.limits;
  eq('limits inner body', L.max_inner_body_decoded_bytes, 32768);
  eq('limits padded', L.max_padded_plaintext_bytes, 20 + 1 + 1 + 4 + 32768 + ((256 - ((20 + 1 + 1 + 4 + 32768) % 256)) % 256));
  eq('limits ciphertext decoded', L.max_ciphertext_decoded_bytes, L.max_padded_plaintext_bytes + 16);
  eq('limits encoded chars', L.max_ciphertext_encoded_chars, b64u(Buffer.alloc(L.max_ciphertext_decoded_bytes)).length);
  eq('limits min encoded chars', L.min_ciphertext_encoded_chars, b64u(Buffer.alloc(272)).length);
  eq('limits nine envelope wire', L.nine_envelopes_wire_bytes, 9 * (L.max_ciphertext_encoded_chars + L.envelope_json_overhead_bytes) + L.request_wrapper_bytes);
  eq('limits ten envelope wire', L.ten_envelopes_wire_bytes, 10 * (L.max_ciphertext_encoded_chars + L.envelope_json_overhead_bytes) + L.request_wrapper_bytes);
  ok('limits 9 < 512 KiB', L.nine_envelopes_wire_bytes < 524288);
  ok('limits 10 < 512 KiB', L.ten_envelopes_wire_bytes < 524288);
  ok('limits form cap is not a 10-envelope budget', 10 * L.per_envelope_form_cap_encoded_chars > 524288);
  eq('limits decoded-sum trap', L.wire_if_decoded_sum_were_budget_bytes, 699051);
  eq('limits review measurement within 1 KiB of S2', Math.abs(L.review_measured_nine_envelopes_wire_bytes - L.nine_envelopes_wire_bytes) < 1024, true);
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);

```

### 10.4. Воспроизведение и результат

```bash
# 1) S2 → S3, из корня репозитория
python3 gen_e2ee_vectors_s2.py
# written; vectors: 34 sections: 13
# SK: bbaf23763ebebc2d1bc558bb9477e1b608e19d66282094873235b4f4d02bd9d5
# SID: 86c68f64d2c3be99fde4aabe857e1f5e
# safety digits: 966641447817221341546560580530883495084093893634094867501952
# ct1: f5111968ef143a66199beaa6662a503696a3a846cb01b81d0e99a6e2eb0e9732 len 272
# env1 len 1310

python3 gen_e2ee_vectors_s3.py
# S3 patch written; vectors: 43 sections: 17
# I1 binding: 611ZRX0_txYgp3X0wgmmxMLh-arPr2tgDDK8T5lCcKuY7bEev_U-IxBzhC593MtXoJwCLyrunJilCzm0gdNCAA

# 2) независимый верификатор
node verify_e2ee_vectors_s3.mjs docs/E2EE-TEST-VECTORS.json
# 273 checks, 0 failures

# 3) детерминизм: повторить 1) в чистой директории и сравнить
cmp docs/E2EE-TEST-VECTORS.json /tmp/repro/docs/E2EE-TEST-VECTORS.json
# IDENTICAL
shasum -a 256 docs/E2EE-TEST-VECTORS.json
# 1fa70ac1e9f5f043365471a0fc0a4d44d1936d6272e25b3a5badd235fc0f1cd8
```

Что проверяет S3-верификатор (273): A1–A4 (RFC/NIST), B1–B5, C1–C3, D1–D3, E1 (полная DR-симуляция, включая r2), E2, F1–F2, G1–G5, I1–I3 (включая расшифровку AEAD «валидного, но чужого» конверта и prekey↔registered mismatch), J1–J3, K1–K2, L1–L3, M1–M2, N1–N2, R1, S1, арифметику `meta.limits`, все wire-длины b64u и structural-инварианты. Отдельно проверяется, что ни одно **wire-sourced** поле (`presented_*`, `pinned_*`, `envelope_json.*`) не осталось 128-hex и что b64u-декодирование даёт 64 байта; внутренние KAT/meta-значения (A2/B3/B4/B5) остаются hex by design и на wire не попадают.

### 10.4.1. Postgres 16 smoke для §6.5 (P1-A)

Выполнено вне репозитория (Docker `postgres:16`, одноразовая БД): V1–V15 из `backend/src/main/resources/db/migration` + SQL-блок §6.5 как V16, **одной транзакцией** (`psql -1 -v ON_ERROR_STOP=1`). Результат: блок применился без ошибок; найден и исправлен реальный дефект бэкфилла `direct_key` — `min(uuid)`/`max(uuid)` в PostgreSQL не существуют, заменено на `min(m.user_id::text) || ':' || max(m.user_id::text)`.

```bash
# миграции V1–V15 (как есть), затем извлечённый SQL §6.5
for f in $(ls V*.sql | sort -V); do psql -U postgres -d krug2 -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -U postgres -d krug2 -v ON_ERROR_STOP=1 -1 -f v16_spec.sql
# ALTER/CREATE/GRANT/... без ERROR; 3 partition ensure_partition
```

Проверки под runtime-ролью (не owner), с `SET ROLE krug_app` и `set_config('app.user_id'/'app.workspace_id')`:

| Проверка | Ожидание | Факт |
|---|---|---|
| `SELECT` устройств собеседника (общий DIRECT-чат) | 2 | 2 |
| `SELECT` устройств не-собеседника (другой workspace) | 0 | 0 |
| `SELECT` prekeys собеседника | 3 | 3 |
| `SELECT` prekeys не-собеседника | 0 | 0 |
| `auth.claim_one_time_prekey(B1, chat)` | OPK выдан | `opk-1` |
| повторный claim | `NULL` | `NULL` |
| claim в чужой чат | `UNKNOWN_DEVICE` | `UNKNOWN_DEVICE` |
| `INSERT` envelope в текущую партицию | 1 | 1 |
| `INSERT` envelope в чужой workspace | RLS violation | `new row violates row-level security policy` |
| `INSERT` verification в чужой workspace | RLS violation | RLS violation |
| `INSERT` E2EE-сообщения с `reply_to_id` | CHECK fail | `ck_messages_e2ee_no_reply_to_id` |
| `INSERT` E2EE-сообщения с NULL sender | CHECK fail | `ck_messages_e2ee_sender_required` |
| `INSERT` verification с `vh_version=1` | CHECK fail | `key_verifications_vh_version_check` |
| `UPDATE chat.chats SET security_mode='MANAGED'` | exception | `MODE_CHANGE_FORBIDDEN` |
| партиции `message_envelopes` | ≥3 | 3 |
| cross-workspace `SELECT` envelopes | 0 | 0 |

Отдельно проверен backfill `direct_key` на БД, где DIRECT-чат с двумя ACTIVE-участниками существовал **до** V16: `direct_key` заполнен как `min(user_id::text):max(user_id::text)` (000…001:000…002), ограничение и unique-индекс применились. Это важно, потому что первый прогон выявил `min(uuid)`/`max(uuid)` — таких агрегатов в PostgreSQL нет; исправление в §6.5.

Оговорка: это smoke, а не полноценный Testcontainers-тест E7-B1; он не проверяет конкурентную гонку claim и не заменяет миграционный тест с реальными данными V1–V15. Но он доказывает, что §6.5 **исполним** и что grants/RLS/partitions/CHECK работают под `krug_app`.

### 10.5. Ограничения S3-векторов

- M1/N/R/S — **conformance/state**, а не крипто-KAT: они фиксируют коды/решения, а не байты AEAD. M2 встраивает wire-валидный F1-конверт.
- S1 не измеряет реальную память/IndexedDB: это state-контракт + property-тест, который должен быть реализован в E7-F2/F7. Zeroization в JS — best-effort, это честно записано.
- I3 использует тот же envelope, что I1 (валидная подпись Mallory); отличие только в зарегистрированных/bundle-ключах. Это и есть суть P0-2b.
- J3 не доказывает «чат был E2EE» без server-signed attestation (v2); он фиксирует запрет молчаливого plaintext.
- Векторы не заменяют Testcontainers-тесты RLS/grants/partitions (P1-A) и E2E двух браузеров (G3/G4).


## 11. E7-S4 remediation — векторы v4, патч-генератор, верификатор и PG16 smoke

> §11 добавлен после [`docs/E2EE-REVIEW-03.md`](<E2EE-REVIEW-03.md>) (GO WITH CONDITIONS: P1-A-1, P1-B-1, P1-C-1, P1-G-1, P1-I01-1; P2-1/3/4/5/6/11). §9 и §10 — исторические S2/S3 и **не переписываются**; где они расходятся с §11, приоритет у §11. Envelope wire format **не менялся** (`v=1`, `header.v=1`, AD 163 B, преамбул 313+L+M). S4 меняет: набор векторов (+M3, +L3b → 45/17), кодировку `B3/B4.expected.signature` (hex → wire b64u64), тело L1 (добавлен `failed_chain_dh`), note G2 (64 B), `meta` (v4, 345 checks) и спеку/DDL/API-текст.

### 11.1. Что и зачем изменено

| Изменение | Причина (review-03) | Где |
|---|---|---|
| **M3-peer-legacy-not-coverage** | P1-B-1: legacy-устройство peer не должно быть ни кандидатом, ни покрытием; конверт на него → `422 E2EE_LEGACY_DEVICE` | vectors секция M; спека §4.2/§4.7/§4.8/§5.2 |
| **L3b-session-reset-partial-delivery-dedup** | P1-C-1: при частичной доставке reset не должен дублировать уже расшифрованное; окно по `failed_n`/`retry_of` + дедуп | vectors секция L; спека §3.5.1/§5.5 |
| L1: `failed_chain_dh` + пересчёт framing | P1-C: получатель должен уметь назвать цепочку; L1 становится точным wire-фреймингом reset из L3b | vectors L1 |
| B3/B4 `expected.signature` → b64u64, `signature_hex` | P2-6: wire-поля `signed_prekey.signature`/`prekey.signature` не могут быть 128-hex | vectors B3/B4; спека §8.3; `meta.conventions.signature_encoding` |
| G2 note: 64-byte entries | P2-5: формула всегда была `16+16+32`, текст «80» был неверным | vectors G2; спека §7.2 |
| `meta.normative_invariants`, `meta.limits.db_ciphertext_max_decoded_bytes` | P1-A-1/B-1/C-1, P2-11: инварианты должны быть машинно-читаемыми для implementers/verifier | vectors meta; спека §6.5/§1.3 |
| `vector_set_version=4`, 345 checks | значения B3/B4/L1 изменились → новая версия набора | meta |

Значения A–H (кроме B3/B4 сигнатур и L1), G1–G5 (кроме note), I/J/K/M1/M2/N/R/S **не менялись**.

### 11.2. Генератор S4 (полный исходник)

Порядок: (1) сгенерировать v3 (§9.1 + §10.2); (2) сохранить код ниже как `gen_e2ee_vectors_s4.py`; (3) запустить из корня репозитория. Скрипт — **чистая функция** закоммиченного v3-файла и констант: без RNG/времени, повторный запуск даёт byte-identical v4 (см. §11.4).

```python
#!/usr/bin/env python3
"""E7-S4 vector patch: run AFTER the S2 generator + S3 patch (input = v3 JSON).

Pure, deterministic post-processing of the committed v3 file:
  * B3/B4: the canonical `signature` field becomes the WIRE value (b64u64, 86 chars);
    the original KAT hex is kept as `signature_hex` (internal only).
  * G2/G3 note: "80-byte entries" -> the real 64-byte layout (user_id16||device_id16||fp32).
  * L1: SESSION_RESET body gains `failed_chain_dh` (the P1-C window anchor); framing values
    and hash are recomputed, so L1 is now exactly the wire framing of the L3b reset payload.
  * New M3 (legacy device is neither a coverage candidate nor coverage) and
    L3b (partial delivery: reset must not duplicate already-decrypted messages).
  * meta: vector_set_version=4, counts, review-03 mapping, normative invariants.

Envelope wire format is unchanged (envelope.v=1, header.v=1, AD 163 B, preamble 313+L+M).
Usage: python3 gen_e2ee_vectors_s4.py [path-to-json]   (default: docs/E2EE-TEST-VECTORS.json)
"""
import base64
import hashlib
import json
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "docs/E2EE-TEST-VECTORS.json"
DST = SRC


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def hex_to_b64u(h: str) -> str:
    return b64u(bytes.fromhex(h))


def find(V, vid):
    for s in V["sections"]:
        for v in s["vectors"]:
            if v["id"] == vid:
                return v
    raise KeyError(vid)


def section(V, sid):
    for s in V["sections"]:
        if s["id"] == sid:
            return s
    raise KeyError(sid)


with open(SRC, encoding="utf-8") as f:
    V = json.load(f)

assert V["meta"]["vector_set_version"] == 3, "S4 patch expects the v3 input"
ids = V["meta"]["ids"]
chat_id = ids["chat_id"]
alice_dev = ids["alice_device_id"]
bob_dev = ids["bob_device_id"]
bob_user = ids["bob_user_id"]
bob_dev_2 = ids["bob_device_2_id"]
# Legacy (pre-E7) device of Bob: ACTIVE, e2ee_capable=false, no prekeys. Never a fan-out target.
bob_legacy_dev = "00000000-0000-4000-8000-000000000023"
V["meta"]["ids"]["bob_legacy_device_id"] = bob_legacy_dev

f1 = find(V, "F1-envelope-prekey")
f2 = find(V, "F2-envelope-no-prekey")

# ---------- P2-6: B3/B4 wire encoding (128-hex -> b64u64) ----------
for vid, wire_field in (("B3-SPK-signature", "signed_prekey.signature"),
                        ("B4-prekey-preamble", "prekey.signature")):
    v = find(V, vid)
    kat_hex = v["expected"]["signature"]
    assert len(kat_hex) == 128 and all(c in "0123456789abcdef" for c in kat_hex), kat_hex
    wire = hex_to_b64u(kat_hex)
    assert len(wire) == 86
    v["expected"]["signature_hex"] = kat_hex          # internal KAT value, never on the wire
    v["expected"]["signature"] = wire                 # canonical wire value
    v["expected"]["signature_encoding"] = "b64u64 (86 chars, 64 bytes)"
    v["note"] = (
        v["note"]
        + f" P2-6: `expected.signature` is the canonical WIRE value of `{wire_field}` "
          "(base64url, 86 chars, 64 bytes); the byte-level KAT value is in "
          "`expected.signature_hex` and never appears on the wire."
    )
b4_sig_wire = find(V, "B4-prekey-preamble")["expected"]["signature"]
assert b64u(bytes.fromhex(find(V, "B4-prekey-preamble")["expected"]["signature_hex"])) == b4_sig_wire

# ---------- P2-5: safety-number entry is 64 bytes, not 80 ----------
g2v = find(V, "G2-safety-number")
assert "two 80-byte entries" in g2v["note"], g2v["note"]
g2v["note"] = g2v["note"].replace(
    "two 80-byte entries (user_id||device_id||FP)",
    "two 64-byte entries (user_id(16)||device_id(16)||fingerprint(32))",
)
assert "64-byte entries" in g2v["note"]

# ---------- P1-C: L1 carries the reset window anchor (failed_chain_dh) ----------
l1 = find(V, "L1-session-reset-payload")
reset_body = {
    "failed_session_id": "hsaPZNLDvpn95Kq-hX4fXg",
    "failed_chain_dh": "-TrAwtuY_1u1fnmkvVMICLzgSqhwqEgx_3v8_rBObBk",
    "failed_n": 3,
    "reason": "DECRYPT_FAILED",
    "retry_of_client_message_id": "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e04",
}
body_bytes = json.dumps(reset_body, separators=(",", ":"), ensure_ascii=False).encode()
domain = "Krug/E2EE/v1/payload"
raw = domain.encode() + bytes([1, 2]) + len(body_bytes).to_bytes(4, "big") + body_bytes
padded = raw + b"\x00" * ((256 - len(raw) % 256) % 256)
assert padded[-1] != 1  # sanity: padding applied
l1["inputs"] = {
    "content_type": 2,
    "content_type_name": "SESSION_RESET",
    "failed_session_id": reset_body["failed_session_id"],
    "failed_chain_dh": reset_body["failed_chain_dh"],
    "failed_n": reset_body["failed_n"],
    "reason": reset_body["reason"],
    "retry_of_client_message_id": reset_body["retry_of_client_message_id"],
    "body_utf8": body_bytes.decode(),
    "body_hex": body_bytes.hex(),
    "body_len": len(body_bytes),
    "domain": domain,
}
l1["expected"] = {
    "raw_len": len(raw),
    "padded_len": len(padded),
    "padding_zero_bytes": len(padded) - len(raw),
    "padded_hex": padded.hex(),
    "payload_sha256": hashlib.sha256(padded).hexdigest(),
    "user_visible": False,
    "requires_prekey_session": True,
    "transport": "prekey_envelope_content_type_2",
}
l1["note"] = (
    "R-15 control payload: content_type=2 (SESSION_RESET) inside a NEW prekey envelope; not "
    "user-visible, no notification, not counted as a user message. S4 (P1-C): the body carries "
    "`failed_chain_dh` = header.dh of the failed message and `failed_n` = its header.n; together "
    "with `retry_of_client_message_id` they define the exact retry window (L3b). Unauthenticated "
    "WS events are NOT used for reset (spoofable)."
)

# ---------- P1-B-1: M3 — a legacy device is neither a candidate nor coverage ----------
f2_env = json.loads(f2["expected"]["envelope_json"])
legacy_env = dict(f2_env)
legacy_env["recipient_device_id"] = bob_legacy_dev
legacy_env_json = json.dumps(legacy_env, separators=(",", ":"))
m3 = {
    "id": "M3-peer-legacy-not-coverage",
    "kind": "envelope_coverage",
    "note": (
        "P1-B-1: coverage counts ONLY e2ee_capable devices. Bob has B1=...021 (capable) and "
        "B2=...023 (legacy ACTIVE, no keys, e2ee_capable=false). A crafted envelope addressed to "
        "the legacy device must be rejected 422 E2EE_LEGACY_DEVICE during per-envelope target "
        "validation, before Message/seq (no partial fan-out). Even if that gate were skipped, "
        "peer_covered would remain 0 because the legacy device is not capable -> 409 "
        "E2EE_NO_PEER_ENVELOPE. peer_devices (candidates) = 1 (capable only); the legacy device is "
        "not a candidate and is not listed in uncovered_device_ids (it is not a delivery target at "
        "all). Variant B (capable-only envelope) is accepted with peer_covered=1=peer_devices and "
        "warning=null, so the legacy device can never produce false coverage or a false warning. "
        "The embedded envelope is shape-valid v1 (no prekey: a legacy device has no SPK, so no "
        "real session can exist with it); the server rejects it on capability, not on crypto."
    ),
    "inputs": {
        "chat_id": chat_id,
        "peer_user_id": bob_user,
        "peer_devices_total_active": 2,
        "peer_devices_capable": 1,
        "peer_devices_legacy": 1,
        "peer_devices": 1,
        "peer_capable_device_id": bob_dev,
        "legacy_device_id": bob_legacy_dev,
        "legacy_device_e2ee_capable": False,
        "legacy_device_has_prekeys": False,
        "coverage_counting_rule": "distinct recipient_device_id where device.e2ee_capable AND device.user_id = peer_user_id",
        "envelopes": [
            {
                "recipient_device_id": bob_legacy_dev,
                "target_e2ee_capable": False,
                "target_status": "ACTIVE",
                "has_prekey": False,
            }
        ],
        "envelope_json": legacy_env_json,
        "envelope_wire_version": 1,
        "variant_b": {
            "envelopes": [{"recipient_device_id": bob_dev, "target_e2ee_capable": True}],
            "peer_devices": 1,
            "peer_covered": 1,
        },
    },
    "expected": {
        "http_status": 422,
        "code": "E2EE_LEGACY_DEVICE",
        "details_field": "envelopes[0].recipient_device_id",
        "server_rejected": True,
        "message_created": False,
        "seq_allocated": False,
        "partial_fanout": False,
        "peer_covered": 0,
        "legacy_counts_as_peer_covered": False,
        "legacy_counts_as_peer_device": False,
        "legacy_in_uncovered_device_ids": False,
        "fallback_if_target_check_skipped": "409 E2EE_NO_PEER_ENVELOPE",
        "variant_b_http_status": 201,
        "variant_b_peer_devices": 1,
        "variant_b_peer_covered": 1,
        "variant_b_warning": None,
        "variant_b_uncovered_device_ids": [],
        "ui": "legacy devices are not addressed by E2EE at all; no 'unavailable on some devices' warning",
    },
}
section(V, "M-envelope-coverage")["vectors"].append(m3)

# ---------- P1-C-1: L3b — partial delivery, no duplicates ----------
old_ids = [
    "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e01",
    "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e02",
    "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e03",
    "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e04",
    "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e05",
]
l3b = {
    "id": "L3b-session-reset-partial-delivery-dedup",
    "kind": "session_reset_state_machine",
    "note": (
        "P1-C-1: L3 covers the case where NOTHING was delivered (delivered_before_reset=0) and the "
        "whole session is re-encrypted. The dangerous case is partial delivery: B decrypted m1..m3 "
        "and failed on m4. Re-encrypting all five would duplicate m1..m3 in B's UI with brand-new "
        "client_message_ids (no way to correlate). S4 rule: the reset carries "
        "`failed_chain_dh` + `failed_n` (header.dh/header.n of the first message that failed) and "
        "`retry_of_client_message_id`; A re-encrypts only messages from that anchor onward in local "
        "send order (m4, m5), each with a NEW client_message_id AND `retry_of_client_message_id` "
        "inside the inner payload. Second line of defence: if a re-encrypted message points at a "
        "`retry_of_client_message_id` the receiver already decrypted, the receiver discards it "
        "silently (no UI duplicate, no unread, no notification) - this also covers a sender window "
        "bug. Both mechanisms are covered below; nothing is silently lost."
    ),
    "inputs": {
        "failed_session_id": "hsaPZNLDvpn95Kq-hX4fXg",
        "failed_chain_dh": "-TrAwtuY_1u1fnmkvVMICLzgSqhwqEgx_3v8_rBObBk",
        "failed_n": 3,
        "old_client_message_ids": old_ids,
        "decrypted_client_message_ids": old_ids[0:3],
        "failed_client_message_id": old_ids[3],
        "retry_window_rule": "local_send_index >= index(retry_of_client_message_id); chain/n are the wire labels",
        "retry_anchor_field": "retry_of_client_message_id",
        "retry_of_field": "inner_payload.retry_of_client_message_id",
        "max_batch": 20,
        "cooldown_seconds": 300,
        "reset_content_type": 2,
    },
    "expected": {
        "resend_count": 2,
        "resend_client_message_ids": [old_ids[3], old_ids[4]],
        "retried_client_message_ids": [old_ids[3], old_ids[4]],
        "not_resent_client_message_ids": old_ids[0:3],
        "all_resends_carry_retry_of": True,
        "all_resends_have_new_client_message_ids": True,
        "new_client_message_ids_unique": True,
        "duplicates_in_ui": 0,
        "duplicate_guard_case": {
            "why": "sender window bug: m3 (already decrypted) is re-sent as well",
            "resent": [old_ids[2], old_ids[3], old_ids[4]],
            "discarded_by_receiver": 1,
            "duplicates_in_ui": 0,
            "unread_increment": 0,
            "notification": False,
        },
        "receiver_dedup_key": "retry_of_client_message_id",
        "old_messages_status": "superseded",
        "undelivered_left": 0,
        "old_client_message_id_reused": False,
        "old_ciphertext_reused": False,
        "empty_outbox_is_noop": True,
        "batch_overflow_status": "retry_pending",
        "silent_drop": False,
        "metric": "e2ee_reset_duplicates",
    },
}
section(V, "L-session-reset")["vectors"].append(l3b)

# ---------- meta ----------
V["meta"]["vector_set_version"] = 4
V["meta"]["generated_at"] = "2026-11-16T15:00:00Z"
V["meta"]["status"] = (
    "normative v4 (E7-S4 remediation of E2EE-REVIEW-03) for E7 client/server crypto and "
    "conformance tests; all values must match byte-for-byte"
)
V["meta"]["supersedes"] = (
    "vector_set_version 3 (43 vectors, 273 checks). Envelope wire format is unchanged "
    "(envelope.v=1, header.v=1, AD 163 B). B3/B4 `signature` fields were re-encoded from internal "
    "hex to the canonical wire b64u64 (same 64 bytes; hex kept as `signature_hex`), G2/G3 notes "
    "correct the safety-number entry size (64 B, not 80), L1 gained `failed_chain_dh` (P1-C "
    "window anchor) with recomputed framing, and M3 + L3b were added (P1-B-1, P1-C-1)."
)
V["meta"]["generator"]["command"] = (
    "Save gen_e2ee_vectors_s2.py (§9.1), gen_e2ee_vectors_s3.py (§10.2) and "
    "gen_e2ee_vectors_s4.py (§11.2); run: python3 gen_e2ee_vectors_s2.py && "
    "python3 gen_e2ee_vectors_s3.py && python3 gen_e2ee_vectors_s4.py "
    "(the S4 patch reads the committed v3 file, rewrites it to v4 and is deterministic)"
)
V["meta"]["conventions"]["signature_encoding"] = (
    "Wire-sourced signing fields are base64url: b64u64 = 86 chars for 64 bytes. This includes "
    "`presented_*`/`pinned_identity_binding_signature` (I1-I3), `envelope_json.prekey.signature` "
    "(F1/M2/M3), `signed_prekey.signature` (B3) and `prekey.signature` (B4), i.e. "
    "`B3.expected.signature` and `B4.expected.signature` ARE wire values and MUST be b64u64. A "
    "wire-valid vector MUST NOT carry 128 hex chars in those fields. Internal byte-level KAT "
    "values are kept separately as `*_hex` (A2.expected.signature, B3/B4.expected.signature_hex, "
    "B5.expected.*_identity_binding_signature, meta.public_keys.*_identity_binding_signature) and "
    "never appear on the wire."
)
V["meta"]["checks"] = {
    "generator": "internal assertions (assert) during generation + S4 patch length/shape assertions",
    "verifier": "verify_e2ee_vectors_s4.mjs (= §10.3 verifier + §11.3 delta)",
    "verifier_checks": 345,
    "verifier_failures": 0,
}
V["meta"]["new_in_v4"] = [
    "M3-peer-legacy-not-coverage",
    "L3b-session-reset-partial-delivery-dedup",
]
V["meta"]["recomputed_in_v4"] = {
    "B3-SPK-signature": "expected.signature -> wire b64u64; byte-level KAT kept as expected.signature_hex",
    "B4-prekey-preamble": "expected.signature -> wire b64u64; byte-level KAT kept as expected.signature_hex",
    "L1-session-reset-payload": "body gained failed_chain_dh; raw/padded len, padding count, padded_hex and payload_sha256 recomputed (framing scheme unchanged)",
    "G2-safety-number": "note only: entry is 64 B (16+16+32); values unchanged",
}
V["meta"]["normative_invariants"] = {
    "direct_key": (
        "Every type='DIRECT' chat has direct_key = least(A,B)::text||':'||greatest(A,B)::text over "
        "the SET of distinct chat_members.user_id, independent of member status (REMOVED/INVITED "
        "are still pair members). A DIRECT chat with != 2 distinct member rows is corrupt and the "
        "migration must stop with DIRECT_KEY_UNRESOLVED; a duplicate live pair stops it with "
        "DIRECT_PAIR_DUPLICATE. CHECKs are added NOT VALID and validated after backfill."
    ),
    "envelope_coverage": (
        "peer_devices, self_devices, peer_covered and self_covered count ONLY devices with "
        "e2ee_capable=true (identity_key_alg='Ed25519+X25519', ACTIVE). An envelope addressed to a "
        "non-capable device is rejected 422 E2EE_LEGACY_DEVICE before Message/seq; a legacy device "
        "is never a candidate, never coverage, and never appears in uncovered_device_ids."
    ),
    "reset_retry_window": (
        "SESSION_RESET carries failed_session_id, failed_chain_dh, failed_n, reason and "
        "retry_of_client_message_id. The sender re-encrypts only messages at/after "
        "retry_of_client_message_id in local send order (per-session), each with a new "
        "client_message_id and retry_of_client_message_id in the inner payload; the receiver "
        "discards a re-sent message whose retry_of_client_message_id it already decrypted."
    ),
    "ciphertext_cap": (
        "Accepted E2EE ciphertext is canonical v1: decoded 16..33040 bytes (33024 padded + 16 tag) "
        "= at most 44054 b64u chars. The DB CHECK stores only canonical values; the API's 65536 "
        "encoded-char form guard is a pre-decode DoS bound, not a delivery promise. Anything above "
        "the canonical cap is 413 ENVELOPE_TOO_LARGE (details.reason='canonical')."
    ),
    "claim_workspace": (
        "auth.claim_one_time_prekey requires the chat to belong to ops.current_workspace_id() and "
        "the caller to be an ACTIVE member; a chat from another workspace yields UNKNOWN_DEVICE."
    ),
    "verification_ownership": (
        "auth.key_verifications enforces verifier ownership with a composite FK "
        "(verifier_user_id, verifier_device_id) -> auth.devices(user_id, id) and FKs to "
        "chat/chat.chats/devices; a BEFORE INSERT trigger requires verifier and target to be "
        "ACTIVE members of the same chat in the current (non-deleted) workspace, while RLS stays "
        "a tenant boundary so revoke/soft-delete can still update revoked_at."
    ),
}
V["meta"]["limits"]["db_ciphertext_max_decoded_bytes"] = 33040
V["meta"]["limits"]["db_rejects_decoded_bytes_above"] = 33040
V["meta"]["limits"]["form_guard_encoded_chars"] = 65536
V["meta"]["limits"]["arithmetic_note"] = (
    V["meta"]["limits"]["arithmetic_note"]
    + " S4: the DB CHECK accepts only the canonical 33040 decoded bytes; the 65536 encoded-char "
      "form guard rejects oversized input before base64-decode and is not a delivery promise."
)
V["meta"]["review"] = {
    "document": "docs/E2EE-REVIEW-03.md",
    "verdict": "GO WITH CONDITIONS",
    "addressed_in_this_set": [
        "P1-A-1 (backfill/CHECK for degraded DIRECT)",
        "P1-B-1 (coverage only e2ee_capable; M3)",
        "P1-C-1 (reset retry window + receiver dedup; L3b)",
        "P1-G-1 (never in-place MANAGED)",
        "P1-I01-1 (contract handoff, §6.3.1)",
        "P2-1 (envelope partition indexes 4, not 7)",
        "P2-3 (key_verifications ownership/FK/RLS)",
        "P2-4 (claim workspace check)",
        "P2-5 (safety number 64 B)",
        "P2-6 (B3/B4 wire b64u64)",
        "P2-7 (ChatSummary.name nullable / Chat added)",
        "P2-8 (prekey id patterns)",
        "P2-9 (legacy DeviceRegistration rollout)",
        "P2-10 (peer_has_e2ee_capable_devices)",
        "P2-11 (canonical ciphertext cap in DB)",
    ],
}

V["summary"]["sections"] = len(V["sections"])
V["summary"]["vectors"] = sum(len(s["vectors"]) for s in V["sections"])
V["summary"]["normative_sections"] = [s["id"] for s in V["sections"] if s["normative"]]
V["summary"]["informative_sections"] = [s["id"] for s in V["sections"] if not s["normative"]]

# ---------- assertions ----------
assert V["summary"]["sections"] == 17 and V["summary"]["vectors"] == 45, V["summary"]
for v in (find(V, "B3-SPK-signature"), find(V, "B4-prekey-preamble")):
    sig = v["expected"]["signature"]
    assert len(sig) == 86 and all(c.isalnum() or c in "-_" for c in sig), sig
    assert len(base64.urlsafe_b64decode(sig + "==")) == 64
    assert len(v["expected"]["signature_hex"]) == 128
assert b4_sig_wire == json.loads(f1["expected"]["envelope_json"])["prekey"]["signature"]
l3b_vec = find(V, "L3b-session-reset-partial-delivery-dedup")
assert l3b_vec["expected"]["resend_client_message_ids"] == old_ids[3:5]
assert l3b_vec["expected"]["not_resent_client_message_ids"] == old_ids[0:3]
m3_vec = find(V, "M3-peer-legacy-not-coverage")
assert json.loads(m3_vec["inputs"]["envelope_json"])["recipient_device_id"] == bob_legacy_dev
assert l1["inputs"]["failed_chain_dh"] == l3b_vec["inputs"]["failed_chain_dh"]

with open(DST, "w", encoding="utf-8") as f:
    json.dump(V, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("S4 patch written; vectors:", V["summary"]["vectors"], "sections:", V["summary"]["sections"])
print("B3 wire:", find(V, "B3-SPK-signature")["expected"]["signature"])
print("L1 padded:", l1["expected"]["padded_len"], "sha256:", l1["expected"]["payload_sha256"])
```

### 11.3. Верификатор v4 (дельта к §10.3)

Полный файл `verify_e2ee_vectors_s4.mjs` = §10.3 **без изменений формы** + 5 точечных правок + блок ниже, вставленный **перед** финальным `console.log`/`process.exit`. Правки (иначе S3-проверки справедливо упадут на v4):

1. `eq('meta vectors', …, 43)` → `45`.
2. `eq('meta vector_set_version', …, 3)` → `4`.
3. `ok('meta all vector ids unique', … === 43)` → `45`.
4. `ok('B3 signature verifies', edverify(…, spkMsg, v.expected.signature))` → `v.expected.signature_hex`.
5. тот же переход на `signature_hex` в `B4 prekey signature verifies`.

Добавленный блок (72 новые проверки):

```javascript
// ---------- S4: wire signatures, safety-number size, reset window, legacy coverage ----------
{
  const b3 = get('B3-SPK-signature'), b4 = get('B4-prekey-preamble');
  const wire = (h) => b64u(hex(h));
  ok('S4 B3 signature is wire b64u64 (86 chars)', /^[A-Za-z0-9_-]{86}$/.test(b3.expected.signature), String(b3.expected.signature).length);
  ok('S4 B3 signature decodes to 64 B', b64d(b3.expected.signature).length === 64);
  eq('S4 B3 signature == b64u(signature_hex)', b3.expected.signature, wire(b3.expected.signature_hex));
  ok('S4 B4 signature is wire b64u64 (86 chars)', /^[A-Za-z0-9_-]{86}$/.test(b4.expected.signature));
  eq('S4 B4 signature == prekey.signature (F1)', b4.expected.signature, JSON.parse(get('F1-envelope-prekey').expected.envelope_json).prekey.signature);
  ok('S4 B4 signature == b64u(signature_hex)', b4.expected.signature === wire(b4.expected.signature_hex));
  eq('S4 F1 prekey signature 64 B', b64d(b4.expected.signature).length, 64);
  ok('S4 no 128-hex in wire signature fields',
    [b3.expected.signature, b4.expected.signature,
     get('I1-tofu-first-contact-no-pin').inputs.presented_identity_binding_signature]
      .every(x => !/^[0-9a-f]{128}$/.test(String(x))));
}
{
  const g2 = get('G2-safety-number'), g3 = get('G3-safety-number-after-key-change');
  ok('S4 G2 note corrects entry size to 64 B', g2.note.includes('64-byte entries'), g2.note.slice(0, 80));
  const e = g2.inputs.entries[0];
  eq('S4 safety-number entry = 16+16+32', uid(e.user_id).length + uid(e.device_id).length + hex(e.fingerprint).length, 64);
  const e3 = g3.inputs.entries[0];
  eq('S4 G3 safety-number entry = 16+16+32', uid(e3.user_id).length + uid(e3.device_id).length + hex(e3.fingerprint).length, 64);
}
{
  const l1 = get('L1-session-reset-payload');
  const body = Buffer.from(JSON.stringify({
    failed_session_id: l1.inputs.failed_session_id,
    failed_chain_dh: l1.inputs.failed_chain_dh,
    failed_n: l1.inputs.failed_n,
    reason: l1.inputs.reason,
    retry_of_client_message_id: l1.inputs.retry_of_client_message_id,
  }), 'utf8');
  eq('S4 L1 body bytes match inputs', body.toString('hex'), l1.inputs.body_hex);
  eq('S4 L1 body_len', body.length, l1.inputs.body_len);
  const raw = Buffer.concat([Buffer.from('Krug/E2EE/v1/payload'), u8(1), u8(2), u32(body.length), body]);
  const padded = Buffer.concat([raw, Buffer.alloc((256 - (raw.length % 256)) % 256)]);
  eq('S4 L1 raw_len', raw.length, l1.expected.raw_len);
  eq('S4 L1 padded_len', padded.length, l1.expected.padded_len);
  eq('S4 L1 padded bytes', padded.toString('hex'), l1.expected.padded_hex);
  eq('S4 L1 padding zeros', padded.length - raw.length, l1.expected.padding_zero_bytes);
  eq('S4 L1 payload sha256', sha256(padded).toString('hex'), l1.expected.payload_sha256);
  ok('S4 L1 failed_chain_dh is canonical b64u32', /^[A-Za-z0-9_-]{43}$/.test(l1.inputs.failed_chain_dh));
  eq('S4 L1 reset stays hidden', l1.expected.user_visible, false);
}
{
  const m3 = get('M3-peer-legacy-not-coverage');
  eq('S4 M3 legacy is not capable', m3.inputs.legacy_device_e2ee_capable, false);
  eq('S4 M3 legacy has no prekeys', m3.inputs.legacy_device_has_prekeys, false);
  eq('S4 M3 candidates == capable devices', m3.inputs.peer_devices, m3.inputs.peer_devices_capable);
  eq('S4 M3 legacy target rejected 422', m3.expected.http_status, 422);
  eq('S4 M3 code', m3.expected.code, 'E2EE_LEGACY_DEVICE');
  eq('S4 M3 no message / no seq', m3.expected.message_created === false && m3.expected.seq_allocated === false, true);
  eq('S4 M3 no partial fanout', m3.expected.partial_fanout, false);
  eq('S4 M3 peer_covered stays 0', m3.expected.peer_covered, 0);
  eq('S4 M3 legacy never counts as coverage', m3.expected.legacy_counts_as_peer_covered, false);
  eq('S4 M3 legacy never a candidate', m3.expected.legacy_counts_as_peer_device, false);
  eq('S4 M3 legacy not listed in uncovered', m3.expected.legacy_in_uncovered_device_ids, false);
  eq('S4 M3 fallback gate would be 409', m3.expected.fallback_if_target_check_skipped, '409 E2EE_NO_PEER_ENVELOPE');
  const env = JSON.parse(m3.inputs.envelope_json);
  eq('S4 M3 envelope targets the legacy device', env.recipient_device_id, m3.inputs.legacy_device_id);
  eq('S4 M3 envelope v1', env.v, 1);
  ok('S4 M3 envelope has no prekey', env.prekey === undefined);
  ok('S4 M3 envelope b64u canonical', [env.session_id, env.ciphertext, env.header.dh].every(x => b64u(b64d(x)) === x));
  eq('S4 M3 variant B accepted 201', m3.expected.variant_b_http_status, 201);
  eq('S4 M3 variant B coverage == candidates', m3.expected.variant_b_peer_covered, m3.expected.variant_b_peer_devices);
  eq('S4 M3 variant B no warning', m3.expected.variant_b_warning, null);
  eq('S4 M3 variant B nothing uncovered', m3.expected.variant_b_uncovered_device_ids.length, 0);
}
{
  const l3b = get('L3b-session-reset-partial-delivery-dedup');
  const ids = l3b.inputs.old_client_message_ids;
  eq('S4 L3b resend count', l3b.expected.resend_count, ids.length - l3b.inputs.decrypted_client_message_ids.length);
  eq('S4 L3b resends only from failed_n', l3b.expected.resend_client_message_ids.join(','), ids.slice(l3b.inputs.failed_n).join(','));
  eq('S4 L3b decrypted prefix not resent', l3b.expected.not_resent_client_message_ids.join(','), l3b.inputs.decrypted_client_message_ids.join(','));
  eq('S4 L3b zero UI duplicates', l3b.expected.duplicates_in_ui, 0);
  eq('S4 L3b dedup key is retry_of', l3b.expected.receiver_dedup_key, 'retry_of_client_message_id');
  eq('S4 L3b guard discards already-decrypted resend', l3b.expected.duplicate_guard_case.discarded_by_receiver, 1);
  eq('S4 L3b guard keeps UI clean', l3b.expected.duplicate_guard_case.duplicates_in_ui, 0);
  eq('S4 L3b guard no unread bump', l3b.expected.duplicate_guard_case.unread_increment, 0);
  eq('S4 L3b nothing silently lost', l3b.expected.undelivered_left, 0);
  eq('S4 L3b resends carry retry_of', l3b.expected.all_resends_carry_retry_of, true);
  eq('S4 L3b resends have new ids', l3b.expected.all_resends_have_new_client_message_ids, true);
  eq('S4 L3b old copies superseded', l3b.expected.old_messages_status, 'superseded');
  eq('S4 L3b empty outbox noop', l3b.expected.empty_outbox_is_noop, true);
  eq('S4 L3b failed_n == decrypted prefix', l3b.inputs.failed_n, l3b.inputs.decrypted_client_message_ids.length);
  eq('S4 L3b anchor is the failed id', l3b.inputs.failed_client_message_id, ids[l3b.inputs.failed_n]);
  eq('S4 L3b same chain as L1', l3b.inputs.failed_chain_dh, get('L1-session-reset-payload').inputs.failed_chain_dh);
  ok('S4 L3b metrics present', l3b.expected.metric === 'e2ee_reset_duplicates');
}
{
  const I = V.meta.normative_invariants;
  ok('S4 invariant direct_key covers REMOVED members', I.direct_key.includes('REMOVED'));
  ok('S4 invariant direct_key uses NOT VALID + validate', I.direct_key.includes('NOT VALID') && I.direct_key.includes('validated'));
  ok('S4 invariant coverage is capable-only', I.envelope_coverage.includes('e2ee_capable'));
  ok('S4 invariant legacy is 422', I.envelope_coverage.includes('E2EE_LEGACY_DEVICE'));
  ok('S4 invariant reset window documented', I.reset_retry_window.includes('failed_chain_dh') && I.reset_retry_window.includes('retry_of_client_message_id'));
  ok('S4 invariant cap is canonical', I.ciphertext_cap.includes('33040') && I.ciphertext_cap.includes('44054'));
  ok('S4 invariant claim checks workspace', I.claim_workspace.includes('current_workspace_id'));
  ok('S4 invariant verification ownership', I.verification_ownership.includes('composite FK'));
  const L = V.meta.limits;
  eq('S4 DB ciphertext cap == canonical decoded cap', L.db_ciphertext_max_decoded_bytes, L.max_ciphertext_decoded_bytes);
  eq('S4 DB ciphertext cap is 33040', L.db_ciphertext_max_decoded_bytes, 33040);
  ok('S4 33041 is above the DB cap', L.db_rejects_decoded_bytes_above === 33040);
  eq('S4 form guard remains 65536', L.form_guard_encoded_chars, 65536);
  ok('S4 form guard is not the delivery cap', L.form_guard_encoded_chars > L.max_ciphertext_encoded_chars);
  eq('S4 review document is review-03', V.meta.review.document, 'docs/E2EE-REVIEW-03.md');
  eq('S4 meta verifier_checks == actual', V.meta.checks.verifier_checks, 345);
}
```

### 11.4. Воспроизведение и результат

Полная цепочка проверена **с нуля из исходников в §9.1/§10.2/§11.2/§11.3**, а не только «поверх готового файла». Python 3.14.6 + `cryptography 49.0.0`, Node.js 24.20.0 — те же версии, что в §9/§10.

```bash
# 0) v3 из §9.1 + §10.2 (чистая директория, docs/ рядом)
python3 gen_e2ee_vectors_s2.py
# written; vectors: 34 sections: 13
# SK: bbaf2376…d9d5  SID: 86c68f64…1f5e  safety digits: 966641447817221341546560580530883495084093893634094867501952
# ct1: f5111968…9732 len 272  env1 len 1310
python3 gen_e2ee_vectors_s3.py
# S3 patch written; vectors: 43 sections: 17
# I1 binding: 611ZRX0_…gdNCAA
shasum -a 256 docs/E2EE-TEST-VECTORS.json
# 1fa70ac1e9f5f043365471a0fc0a4d44d1936d6272e25b3a5badd235fc0f1cd8   (= S3-changelog / review-03)

# 1) S4-патч (§11.2) поверх этого v3
python3 gen_e2ee_vectors_s4.py
# S4 patch written; vectors: 45 sections: 17
# B3 wire: wjk09AvSyAHvcEINQckiWq4o1Jozkm9kLyxxUVF1PtoVQgmSxOjPU8rIY_Sa0kwgdxaPwl6pTAGusCf90_WdDw
# L1 padded: 256 sha256: 1e6a4d9880c710c9c1c4faae0913e78244d08c036a077b7fdae000e1cb87f4fe
shasum -a 256 docs/E2EE-TEST-VECTORS.json
# 2d69c941f892a2f1ed4469d6f1a7b0ccabbf678c07faf44a949b9ed19a0a9c26
cmp docs/E2EE-TEST-VECTORS.json <repo>/docs/E2EE-TEST-VECTORS.json
# IDENTICAL  (байт-в-байт с закоммиченным v4)

# 2) верификатор v4 = §10.3 + 5 правок + блок §11.3
node verify_e2ee_vectors_s4.mjs docs/E2EE-TEST-VECTORS.json
# 345 checks, 0 failures

# 3) детерминизм: повторить (1) на свежей копии v3
cmp /tmp/run1/E2EE-TEST-VECTORS.json /tmp/run2/E2EE-TEST-VECTORS.json
# IDENTICAL; sha256 2d69c941…9c26
```

Что проверяет дельта (72 проверки): B3/B4 — wire-форма 86 b64u, decode 64 B, `b64u(signature_hex)` совпадает, Ed25519-verify по hex, `B4.signature == F1.prekey.signature`; G2/G3 — entry ровно 64 B и note исправлен; L1 — пересчёт body/raw/padded/нулей/sha256 из полей (включая `failed_chain_dh`), canonical b64u32; M3 — legacy не capable/не кандидат/не покрытие/не в uncovered, 422 `E2EE_LEGACY_DEVICE`, no message/seq/partial fan-out, fallback 409, variant B 201/covered=1/warning=null, embedded envelope wire-valid v1 без prekey; L3b — resend ровно от `failed_n`, m1–m3 не перешифровываются, 0 дублей, дедуп по `retry_of_client_message_id`, guard-кейс отбрасывает уже расшифрованное без unread, `superseded`, ничего не потеряно; meta — 7 инвариантов, DB cap = canonical 33040 ≠ form guard 65536, review-03, `verifier_checks` синхронизирован с фактическим числом.

### 11.4.1. PG16 smoke для §6.5 на normal **и** degraded DIRECT (P1-A-1)

Контейнер `postgres:16` (16.16), отдельная БД на сценарий. Скрипты — `/tmp/s4` (в репозиторий не добавлялись): `pre.sql` (V1–V15-совместимый seed), `v16.sql` (ровно SQL §6.5), `post.sql`, `tests.sql` (28 проверок под `krug_app`), `pre_bad.sql`/`pre_dup.sql`/`repair_dup.sql`.

```bash
docker run -d --name e2ee_s4_pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=krug -p 55433:5432 postgres:16
# V1–V15 (как есть), затем seed:
#   DIRECT 100: A ACTIVE + B ACTIVE           (normal)
#   DIRECT 101: A ACTIVE + C REMOVED          (degraded — S3 на этом падал)
#   DIRECT 102: deleted, оба REMOVED          (deleted DIRECT)
#   GROUP  103: A/B/C ACTIVE
#   DIRECT 104: другой workspace (claim/RLS)
psql -U postgres -d krug -v ON_ERROR_STOP=1 -1 -f v16.sql     # exit 0
psql -U postgres -d krug -f post.sql                          # identity keys + prekeys
psql -U postgres -d krug -f tests.sql                          # 30 checks, 0 failures
```

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| V16 | `V1–V15 + seed + §6.5` одной транзакцией | exit 0 | **exit 0** |
| D1 | `direct_key` normal (100) | `…001:…002` | `00000000-…-000000000001:00000000-…-000000000002` |
| D2 | `direct_key` **degraded** (101, второй участник REMOVED) | заполнен | `…001:…003` |
| D3 | `direct_key` deleted DIRECT (102) | заполнен (нужен для CHECK) | `…001:…002` |
| D4 | `direct_key` GROUP (103) | NULL | NULL |
| I1 | индексы партиции envelopes | **4** (было 7) | **4** на всех трёх + 4 на новой (2027_02) |
| T01/T02/T03 | peer devices = 2; dave без общего чата = 0; свои = 2 | 2/0/2 | 2/0/2 |
| T04/T05 | peer prekeys = 4; не-peer prekeys = 0 | 4/0 | 4/0 |
| T06 | claim в чате чужого workspace (W2 при контексте W1) | `UNKNOWN_DEVICE` | `22023` |
| T07/T08 | claim в своём чате → `opk-1`, затем `opk-2` | ok | ok |
| T09 | claim legacy-устройства → `NULL` (NO_KEYS) | NULL | NULL |
| T10 | envelope в текущую партицию | 1 | 1 |
| T11/T12 | ciphertext 33041 B / 33040 B | fail `23514` / ok | `23514` / ok |
| T13–T15 | E2EE `reply_to_id` / NULL sender / managed body | `23514` | `23514` |
| T16 | валидный `INSERT key_verifications` | 1 | 1 |
| T17 | `verifier_device_id` чужого пользователя | FK `23503` | `23503` |
| T18 | target не ACTIVE-участник чата | trigger `23514` | `23514` |
| T19 | чат другого workspace | trigger `23514` | `23514` |
| T20/T21 | cross-tenant verification/envelope `SELECT` | 0 | 0 |
| T22 | `vh_version=1` | `23514` | `23514` |
| T23 | обратный `direct_key` (`B:A`) | format CHECK `23514` | `23514` |
| T24 | DIRECT без `direct_key` | `23514` | `23514` |
| T25 | второй живой DIRECT той же пары | unique `23505` | `23505` |
| T26 | та же пара в другом workspace | разрешено | 1 строка |
| T27 | GROUP с `direct_key` | `23514` | `23514` |
| T28 | `UPDATE security_mode` | `23514` | `23514` |
| T29 | revoke (`revoked_at`) после REMOVED target | UPDATE разрешён | ok |
| T30 | revoke после soft-delete чата | UPDATE разрешён | ok |

**Вырожденные данные (миграционный тест, а не только happy path):**

```bash
# (a) DIRECT с ОДНИМ участником: V16 отказывается молча чинить
psql -f pre_bad.sql; psql -1 -f v16.sql
# ERROR:  DIRECT_KEY_UNRESOLVED
# DETAIL:  DIRECT chats without exactly 2 distinct member rows: 00000000-0000-4000-8000-000000000109
# HINT:  repair chat_members (restore the missing/removed participant row) or soft-delete the chat; see E2EE-SPEC §6.5.2

# (b) две живые DIRECT-пары: V16 останавливается ДО изменения схемы
psql -f pre_dup.sql; psql -1 -f v16.sql
# ERROR:  DIRECT_PAIR_DUPLICATE
# DETAIL:  more than one live DIRECT chat for pair(s): …/…001:…002
# HINT:  soft-delete the newer duplicate (E2EE-SPEC §6.5.2), then re-run V16

# (c) runbook §6.5.2 (soft-delete более нового чата), затем V16
psql -f repair_dup.sql && psql -1 -f v16.sql      # exit 0
# direct_key у обоих; deleted_at у 10a; живых дублей 0; V16 применился
```

Ключевые наблюдения: (1) S3-дефект воспроизведён и устранён — degraded DIRECT (1 ACTIVE + 1 REMOVED) получает `direct_key`, V16 проходит; (2) deleted DIRECT тоже получает ключ (иначе CHECK упал бы на удалённых чатах); (3) `NOT VALID` + `VALIDATE` дают имя constraint в ошибке, а preflight — machine-readable код и id **до** изменения схемы; (4) duplicate-pair и corrupt-DIRECT не «чинятся угадыванием», а останавливают миграцию с runbook; (5) индексов на партиции ровно 4, включая будущие (наследование parent-индексов); (6) ownership/claim-workspace работают под `krug_app`, а не только под owner; (7) строгий scope `key_verifications` вынесен в `BEFORE INSERT` триггер, а RLS оставлен tenant-границей — иначе revoke/soft-delete не смогли бы обновить `revoked_at` (T29/T30); это же решение проверено регрессионно.

### 11.5. Ограничения S4

- Это по-прежнему **design/conformance** smoke: нет Flyway, конкурентной гонки claim, реальных исторических объёмов, `EXPLAIN` на больших данных, job-планировщика партиций. Testcontainers E7-B1 обязателен.
- M3/L3b — conformance-векторы (коды/состояния/окно), а не KAT: L3b требует ещё и E2E «B расшифровал 2 из 5 → reset → 0 дублей», M3 — backend-теста с legacy-устройством.
- B3/B4 проверяются Ed25519-verify по `signature_hex` и wire-формой b64u; это не browser-KAT (G2).
- PG16 smoke не проверяет `DROP COLUMN identity_public_key` на внешних read-model (P2-19) — это остаётся условием E7-B1.
- S4 **не** применяет контракт: I-01 (§6.3.1) — по-прежнему PR PM.
