import httpx

from app.rss_service import describe_rss_exception


def test_timeout_exception_is_never_empty() -> None:
    message = describe_rss_exception(httpx.ReadTimeout(""))
    assert message.startswith("ReadTimeout: RSS 请求超时")


def test_transport_exception_keeps_type_and_detail() -> None:
    message = describe_rss_exception(httpx.ConnectError("TLS EOF"))
    assert message == "ConnectError: TLS EOF"
