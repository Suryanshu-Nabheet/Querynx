# End-to-end tests

Full-stack scenarios against a running API server (real process, real
ports): boot, health, search, extract, research, Tavily-compat, SSE
streams. See apps/api/test/stream.test.ts and the Docker CI workflow
which runs the containerized equivalent on every push.
