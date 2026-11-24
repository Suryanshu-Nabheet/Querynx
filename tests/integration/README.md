# Integration tests

Multi-package scenarios: API over real providers-with-fakes, worker
handlers over queue+retrieval, MCP over SDK over API fixture. Run via
the workspace `pnpm test` (the owning packages import these scenarios
through their suites) or directly after booting a dev stack.
