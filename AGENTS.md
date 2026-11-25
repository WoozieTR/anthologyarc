# Anthology ARC — development guidelines

- Keep the fork close to upstream (falsisdev/anthology). Preserve attribution, license, existing behavior and Nuvio QuickJS compatibility.
- `main` mirrors upstream; `arc` is our integration branch. Base task branches and pull requests on `arc`. Never push to `main`, force-push, merge, publish, or enable scheduled workflows without explicit approval.
- Address only the requested issue. Inspect relevant files first; prefer the smallest maintainable change. No speculative optimization, unrelated refactors, new dependencies, or formatting churn.
- For bugs, reproduce with a focused regression test where practical. For performance, compare relevant before/after measurements; distinguish simulated results from actual device performance.
- Treat `src/` as the provider source of truth. Use existing build commands for generated bundles; inspect changes and avoid unrelated output churn. Preserve runtime compatibility and public interfaces.
- Prefer deterministic local tests, mocked HTTP responses and authorized test media. Do not attempt to bypass network restrictions or repeatedly retry blocked external services.
- Run task-specific tests first; run broader checks only when relevant. If a prerequisite is unavailable or a failure is unrelated, report it rather than expanding scope.
- Keep exploration and output concise. Stop when acceptance criteria are met or a concrete blocker is identified. Summarize changed files, tests, measured results, limitations and remaining risks. Never claim unrun tests passed.
