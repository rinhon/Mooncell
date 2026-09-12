from app.downloader_service import extract_info_hash


def test_extract_hash_from_mikan_torrent_url() -> None:
    assert extract_info_hash(
        "https://mikan.example/Download/20260824/eb804b2c8998b414617a071988b2de9290783631.torrent"
    ) == "eb804b2c8998b414617a071988b2de9290783631"


def test_extract_hex_hash_from_magnet() -> None:
    assert extract_info_hash(
        "magnet:?xt=urn:btih:EB804B2C8998B414617A071988B2DE9290783631&dn=Example"
    ) == "eb804b2c8998b414617a071988b2de9290783631"


def test_invalid_download_url_has_no_hash() -> None:
    assert extract_info_hash("https://example.test/download?id=12") is None
