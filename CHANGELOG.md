## [0.10.1](https://github.com/kelet-ai/typescript-sdk/compare/v0.10.0...v0.10.1) (2026-05-23)


### Bug Fixes

* **claude-agent-sdk:** make Layer A process.env injection synchronous in configure() ([643ca57](https://github.com/kelet-ai/typescript-sdk/commit/643ca57fe1877e7c779db0bb4accd6e35e1484b8))
* **setup:** export _syncLayerAForTest and fix fire-once test to test actual guard ([dbdef3b](https://github.com/kelet-ai/typescript-sdk/commit/dbdef3b15af322aecea6032fd5e30dc76fd61b2c))



# [0.10.0](https://github.com/kelet-ai/typescript-sdk/compare/v0.8.1...v0.10.0) (2026-05-22)


### Bug Fixes

* **claude-agent-sdk:** isBracketed early-return + drop @ai-sdk/provider peer ([ef17617](https://github.com/kelet-ai/typescript-sdk/commit/ef17617c9f259c36fb4435112f2412e1d8487382))


### Features

* **claude-agent-sdk:** Slice C session grouping + @ai-sdk/otel auto-registration ([3ee5178](https://github.com/kelet-ai/typescript-sdk/commit/3ee517845d1f38a58a8b0d1f3143d6174bd1e4e1))



## [0.8.1](https://github.com/kelet-ai/typescript-sdk/compare/v0.8.0...v0.8.1) (2026-05-21)


### Bug Fixes

* **claude-agent-sdk:** inject CC trace-export beta gate + log-content vars ([25b0883](https://github.com/kelet-ai/typescript-sdk/commit/25b08835e58ad0028d99c68d353641bd3b1aeaeb))



# [0.8.0](https://github.com/kelet-ai/typescript-sdk/compare/v0.7.0...v0.8.0) (2026-05-20)


### Bug Fixes

* **ci:** add ai to devDependencies so typecheck resolves src/aisdk.ts ([fb89839](https://github.com/kelet-ai/typescript-sdk/commit/fb898397f8d21788d91a2e50a5c2d3c3e9abc676))
* **claude-agent-sdk:** correct wrapQuery arg shape, remove ClaudeSDKClient (TS-only), and fix Layer A/B consistency ([660721f](https://github.com/kelet-ai/typescript-sdk/commit/660721f40afc59265e0f9e6025d9482b6ccb1983))
* **claude-agent-sdk:** materialize options as plain object when ClaudeAgentOptionsCtor unavailable ([4aa9c10](https://github.com/kelet-ai/typescript-sdk/commit/4aa9c101d2bdc725b31ccc4da9932e28621eb90e))


### Features

* **claude-agent-sdk:** auto-inject OTLP env vars + reasoning capture (KEL-406) ([2f97b69](https://github.com/kelet-ai/typescript-sdk/commit/2f97b696cf7d93518f5e4e332761845d6014244a))



# [0.7.0](https://github.com/kelet-ai/typescript-sdk/compare/v0.6.0...v0.7.0) (2026-05-18)


### Features

* **temporal:** KeletPlugin for one-line Temporal integration ([65ec131](https://github.com/kelet-ai/typescript-sdk/commit/65ec13136a4e6838e903e947cae3ae2036964765))



