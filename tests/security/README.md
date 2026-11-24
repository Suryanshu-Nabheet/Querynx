# Security regression suite

Cross-package security tests that span package boundaries. Package-level
security tests live alongside their packages (fetcher SSRF suite,
extractor untrusted-content suite, API auth/rate-limit suite); this
directory holds end-to-end attack scenarios that exercise multiple
layers at once.
