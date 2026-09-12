from app.security import decrypt_secret, encrypt_secret, hash_password, verify_password


def test_password_round_trip() -> None:
    encoded = hash_password("a-strong-test-password")
    assert verify_password("a-strong-test-password", encoded)
    assert not verify_password("wrong-password", encoded)


def test_secret_round_trip() -> None:
    encrypted = encrypt_secret("rpc-secret")
    assert encrypted != "rpc-secret"
    assert decrypt_secret(encrypted) == "rpc-secret"
