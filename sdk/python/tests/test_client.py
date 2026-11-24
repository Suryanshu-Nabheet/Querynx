"""SDK tests against httpx MockTransport fixtures."""

from __future__ import annotations

import json as jsonlib
from typing import Any

import httpx
import pytest

from querynx import QuerynxClient, QuerynxError, AsyncQuerynxClient


def search_handler(request: httpx.Request) -> httpx.Response:
    assert request.url.path == "/v1/search"
    body = jsonlib.loads(request.content)
    assert request.headers["x-api-key"] == "test-key"
    return httpx.Response(200, json={
        "results": [
            {"title": "Result", "url": "https://example.com/r",
             "snippet": "snippet text", "score": 0.9, "provider": "stub"},
        ],
        "query": body["query"],
        "generatedAt": "2026-11-24T00:00:00Z",
        "requestId": "req-1",
        "diagnostics": {"providersQueried": 1, "providersSucceeded": 1,
                        "cacheHit": False, "rawResultCount": 1,
                        "duplicateCount": 0, "attempts": []},
    })


def failing_response(status: int, payload: dict[str, Any]) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)
    return handler


def client_with(handler: Any, **kwargs: Any) -> QuerynxClient:
    return QuerynxClient("http://fixture.local", api_key="test-key",
                        transport=httpx.MockTransport(handler), **kwargs)


def test_search_parses_results() -> None:
    client = client_with(search_handler)
    response = client.search("test query", max_results=3)
    assert response.results[0].title == "Result"
    assert response.results[0].url == "https://example.com/r"
    assert response.query == "test query"
    assert response.request_id == "req-1"


def test_auth_error_raises_typed_error() -> None:
    client = client_with(failing_response(401, {
        "error": {"code": "UNAUTHORIZED", "message": "bad key"},
        "requestId": "r9",
    }))
    with pytest.raises(QuerynxError) as excinfo:
        client.search("x")
    assert excinfo.value.status == 401
    assert excinfo.value.code == "UNAUTHORIZED"
    assert excinfo.value.request_id == "r9"


def test_client_error_not_retried() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"error": {"code": "VALIDATION_ERROR", "message": "bad"}})

    client = client_with(handler)
    with pytest.raises(QuerynxError):
        client.search("")
    assert calls["n"] == 1  # 4xx fails fast


def test_server_error_retried_then_raises() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, json={"error": {"code": "INTERNAL_ERROR", "message": "boom"}})

    client = client_with(handler, max_retries=2)
    with pytest.raises(QuerynxError) as excinfo:
        client.search("x")
    assert excinfo.value.status == 500
    assert calls["n"] == 3  # initial + 2 retries


def test_extract_parses_documents() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/extract"
        return httpx.Response(200, json={
            "results": [
                {"url": "https://example.com/p", "ok": True, "document": {
                    "url": "https://example.com/p", "title": "Page",
                    "content": "body", "format": "markdown", "fingerprint": "f",
                    "statusCode": 200, "fetchedAt": "2026-11-24T00:00:00Z"}},
                {"url": "https://dead.example", "ok": False, "error": "ECONNREFUSED"},
            ],
            "generatedAt": "2026-11-24T00:00:00Z",
        })

    client = client_with(handler)
    response = client.extract(["https://example.com/p", "https://dead.example"])
    assert response.results[0].ok and response.results[0].document.title == "Page"
    assert not response.results[1].ok
    assert response.results[1].error == "ECONNREFUSED"


def test_research_parses_report() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/research"
        return httpx.Response(200, json={
            "report": {
                "objective": "obj", "mode": "fast", "findings": "found",
                "evidence": [{"url": "https://e.example", "title": "E",
                              "passage": "p", "relevance": 0.9, "stepQuery": "q"}],
                "gaps": [{"question": "gap?", "attemptedQueries": ["a"]}],
                "usage": {"queries": 2, "pagesFetched": 1, "elapsedMs": 10, "contentChars": 5},
                "termination": "coverage-reached", "completedAt": "2026-11-24T00:00:00Z",
            },
            "events": [], "requestId": "r",
        })

    client = client_with(handler)
    report = client.research("obj", mode="fast")
    assert report.findings == "found"
    assert report.evidence[0].url == "https://e.example"
    assert report.gaps[0].question == "gap?"
    assert report.termination == "coverage-reached"


def test_providers_and_health() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/providers":
            return httpx.Response(200, json={"providers": [
                {"name": "stub", "state": "closed", "successRate": 1.0,
                 "medianLatencyMs": 12, "configured": True},
            ]})
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok", "version": "0.1.0"})
        raise AssertionError(f"unexpected path {request.url.path}")

    client = client_with(handler)
    providers = client.providers()
    assert providers[0].name == "stub"
    assert providers[0].configured is True
    assert client.health()["status"] == "ok"


@pytest.mark.asyncio
async def test_async_client_search() -> None:
    async_client = AsyncQuerynxClient(
        "http://fixture.local", api_key="test-key",
        transport=httpx.MockTransport(search_handler),
    )
    response = await async_client.search("async query")
    assert response.results[0].title == "Result"
