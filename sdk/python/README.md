# querynx-python

Python SDK for the Querynx web intelligence API.

```python
from querynx import QuerynxClient

client = QuerynxClient("http://localhost:3001", api_key="devkey")

results = client.search("postgresql mvcc", max_results=5)
for r in results.results:
    print(r.title, r.url)

doc = client.extract(["https://example.com/article"])
report = client.research("how does mvcc work", mode="fast")
```

Install: `pip install .` from this directory (or `pip install -e .[dev]`
for development).
