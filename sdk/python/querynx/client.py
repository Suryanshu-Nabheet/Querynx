"""Querynx Python SDK.

Thin typed client over the Querynx HTTP API using httpx. Synchronous
by default; an AsyncQuerynxClient mirrors every method for asyncio
applications.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

__all__ = [
    "QuerynxError",
    "SearchResponse",
    "SearchResult",
    "ExtractedDocument",
    "ExtractResponse",
    "ExtractResultItem",
    "ResearchReport",
    "Evidence",
    "InformationGap",
    "ProviderHealth",
    "QuerynxClient",
    "AsyncQuerynxClient",
]


class QuerynxError(Exception):
    """Error surfaced by the Querynx API."""

    def __init__(self, message: str, status: int = 0, code: Optional[str] = None,
                 request_id: Optional[str] = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    score: float
    provider: str
    published_at: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SearchResponse:
    results: list[SearchResult]
    query: str
    generated_at: str
    request_id: Optional[str] = None


@dataclass
class ExtractedDocument:
    url: str
    title: Optional[str]
    content: str
    format: str
    fingerprint: str
    status_code: int
    fetched_at: str
    metadata: Optional[dict[str, Any]] = None


@dataclass
class ExtractResultItem:
    url: str
    ok: bool
    document: Optional[ExtractedDocument] = None
    error: Optional[str] = None


@dataclass
class ExtractResponse:
    results: list[ExtractResultItem]
    generated_at: str
    request_id: Optional[str] = None


@dataclass
class Evidence:
    url: str
    title: str
    passage: str
    relevance: float
    step_query: str = ""


@dataclass
class InformationGap:
    question: str
    attempted_queries: list[str] = field(default_factory=list)


@dataclass
class ResearchReport:
    objective: str
    mode: str
    findings: str
    evidence: list[Evidence]
    gaps: list[InformationGap]
    usage: dict[str, Any]
    termination: str
    completed_at: str


@dataclass
class ProviderHealth:
    name: str
    state: str
    success_rate: float
    median_latency_ms: float
    configured: bool


def _parse_search(body: dict[str, Any]) -> SearchResponse:
    return SearchResponse(
        results=[
            SearchResult(
                title=r["title"],
                url=r["url"],
                snippet=r.get("snippet", ""),
                score=r.get("score", 0.0),
                provider=r.get("provider", ""),
                published_at=r.get("publishedAt"),
                metadata=r.get("metadata") or {},
            )
            for r in body.get("results", [])
        ],
        query=body.get("query", ""),
        generated_at=body.get("generatedAt", ""),
        request_id=body.get("requestId"),
    )


def _parse_extract(body: dict[str, Any]) -> ExtractResponse:
    items: list[ExtractResultItem] = []
    for r in body.get("results", []):
        doc = None
        if r.get("ok") and r.get("document"):
            d = r["document"]
            doc = ExtractedDocument(
                url=d["url"],
                title=d.get("title"),
                content=d.get("content", ""),
                format=d.get("format", "markdown"),
                fingerprint=d.get("fingerprint", ""),
                status_code=d.get("statusCode", 0),
                fetched_at=d.get("fetchedAt", ""),
                metadata=d.get("metadata"),
            )
        items.append(ExtractResultItem(url=r["url"], ok=r.get("ok", False),
                                       document=doc, error=r.get("error")))
    return ExtractResponse(results=items, generated_at=body.get("generatedAt", ""),
                           request_id=body.get("requestId"))


def _parse_research(body: dict[str, Any]) -> ResearchReport:
    rep = body.get("report", body)
    return ResearchReport(
        objective=rep.get("objective", ""),
        mode=rep.get("mode", "standard"),
        findings=rep.get("findings", ""),
        evidence=[
            Evidence(
                url=e["url"], title=e.get("title", ""),
                passage=e.get("passage", ""), relevance=e.get("relevance", 0.0),
                step_query=e.get("stepQuery", ""),
            )
            for e in rep.get("evidence", [])
        ],
        gaps=[
            InformationGap(question=g.get("question", ""),
                           attempted_queries=g.get("attemptedQueries", []))
            for g in rep.get("gaps", [])
        ],
        usage=rep.get("usage", {}),
        termination=rep.get("termination", ""),
        completed_at=rep.get("completedAt", ""),
    )


def _raise_for_status(response: httpx.Response) -> None:
    if response.is_success:
        return
    try:
        body = response.json()
        err = body.get("error", {})
        raise QuerynxError(
            err.get("message", f"HTTP {response.status_code}"),
            status=response.status_code,
            code=err.get("code"),
            request_id=body.get("requestId"),
        )
    except ValueError:
        raise QuerynxError(f"HTTP {response.status_code}", status=response.status_code) from None


class _Base:
    def __init__(self, base_url: str, api_key: Optional[str] = None,
                 timeout: float = 30.0, max_retries: int = 2,
                 transport: Optional[httpx.BaseTransport] = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._transport = transport

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        return headers

    @staticmethod
    def _backoff(attempt: int) -> float:
        import random
        return random.uniform(0, 300 * (2**attempt)) / 1000.0


class QuerynxClient(_Base):
    """Synchronous Querynx API client."""

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self._base_url, timeout=self._timeout,
                             headers=self._headers(), transport=self._transport)

    def _request(self, method: str, path: str, json: Optional[dict[str, Any]] = None) -> Any:
        last_error: Optional[Exception] = None
        for attempt in range(self._max_retries + 1):
            try:
                with self._client() as client:
                    response = client.request(method, path, json=json)
                if response.status_code >= 500 and attempt < self._max_retries:
                    time.sleep(self._backoff(attempt))
                    continue
                _raise_for_status(response)
                return response.json() if response.content else None
            except (httpx.HTTPError, QuerynxError) as exc:
                last_error = exc
                if isinstance(exc, QuerynxError):
                    raise
                if attempt < self._max_retries:
                    time.sleep(self._backoff(attempt))
                    continue
                raise
        raise last_error or QuerynxError("request failed")

    def search(self, query: str, max_results: int = 10, **kwargs: Any) -> SearchResponse:
        body: dict[str, Any] = {"query": query, "maxResults": max_results}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        return _parse_search(self._request("POST", "/v1/search", body))

    def search_batch(self, queries: list[str], max_results: int = 5) -> dict[str, Any]:
        return self._request("POST", "/v1/search/batch",
                             {"queries": queries, "maxResults": max_results})

    def extract(self, urls: list[str], **kwargs: Any) -> ExtractResponse:
        body: dict[str, Any] = {"urls": urls}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        return _parse_extract(self._request("POST", "/v1/extract", body))

    def research(self, objective: str, mode: str = "standard", **kwargs: Any) -> ResearchReport:
        body: dict[str, Any] = {"objective": objective, "mode": mode}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        return _parse_research(self._request("POST", "/v1/research", body))

    def providers(self) -> list[ProviderHealth]:
        body = self._request("GET", "/v1/providers")
        return [
            ProviderHealth(
                name=p["name"], state=p.get("state", "closed"),
                success_rate=p.get("successRate", 0.0),
                median_latency_ms=p.get("medianLatencyMs", 0.0),
                configured=p.get("configured", False),
            )
            for p in body.get("providers", [])
        ]

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health")


class AsyncQuerynxClient(_Base):
    """Asyncio Querynx API client (httpx.AsyncClient)."""

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout,
                                 headers=self._headers(),
                                 transport=self._transport)  # type: ignore[arg-type]

    async def _request(self, method: str, path: str,
                       json: Optional[dict[str, Any]] = None) -> Any:
        import asyncio
        last_error: Optional[Exception] = None
        for attempt in range(self._max_retries + 1):
            try:
                async with self._client() as client:
                    response = await client.request(method, path, json=json)
                if response.status_code >= 500 and attempt < self._max_retries:
                    await asyncio.sleep(self._backoff(attempt))
                    continue
                _raise_for_status(response)
                return response.json() if response.content else None
            except (httpx.HTTPError, QuerynxError) as exc:
                last_error = exc
                if isinstance(exc, QuerynxError):
                    raise
                if attempt < self._max_retries:
                    await asyncio.sleep(self._backoff(attempt))
                    continue
                raise
        raise last_error or QuerynxError("request failed")

    async def search(self, query: str, max_results: int = 10, **kwargs: Any) -> SearchResponse:
        body: dict[str, Any] = {"query": query, "maxResults": max_results}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        return _parse_search(await self._request("POST", "/v1/search", body))

    async def extract(self, urls: list[str], **kwargs: Any) -> ExtractResponse:
        body: dict[str, Any] = {"urls": urls}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        return _parse_extract(await self._request("POST", "/v1/extract", body))

    async def research(self, objective: str, mode: str = "standard",
                       **kwargs: Any) -> ResearchReport:
        body: dict[str, Any] = {"objective": objective, "mode": mode}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        return _parse_research(await self._request("POST", "/v1/research", body))

    async def providers(self) -> list[ProviderHealth]:
        body = await self._request("GET", "/v1/providers")
        return [
            ProviderHealth(
                name=p["name"], state=p.get("state", "closed"),
                success_rate=p.get("successRate", 0.0),
                median_latency_ms=p.get("medianLatencyMs", 0.0),
                configured=p.get("configured", False),
            )
            for p in body.get("providers", [])
        ]

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/health")
