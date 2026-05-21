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



# [0.6.0](https://github.com/kelet-ai/typescript-sdk/compare/v0.5.3...v0.6.0) (2026-04-28)


### Bug Fixes

* **cc:** ESM-safe SDK probe + sticky session captured before finality gate ([813c6b6](https://github.com/kelet-ai/typescript-sdk/commit/813c6b6317dbc7e14726a7b2cf11001e475ff283)), closes [#10](https://github.com/kelet-ai/typescript-sdk/issues/10) [#B1](https://github.com/kelet-ai/typescript-sdk/issues/B1) [#B2](https://github.com/kelet-ai/typescript-sdk/issues/B2)
* **kel-391:** address PR [#10](https://github.com/kelet-ai/typescript-sdk/issues/10) review blockers (no global clobber, finality, sticky session) ([718e821](https://github.com/kelet-ai/typescript-sdk/commit/718e8210e90205a8b39259deca01aec19ac22ad9)), closes [#1](https://github.com/kelet-ai/typescript-sdk/issues/1) [#2](https://github.com/kelet-ai/typescript-sdk/issues/2) [#4](https://github.com/kelet-ai/typescript-sdk/issues/4) [#5](https://github.com/kelet-ai/typescript-sdk/issues/5) [#6](https://github.com/kelet-ai/typescript-sdk/issues/6) [#7](https://github.com/kelet-ai/typescript-sdk/issues/7) [#9](https://github.com/kelet-ai/typescript-sdk/issues/9)
* **tests:** TS2352 cast via unknown on AsyncGenerator → AsyncIterable & Record ([4e4775f](https://github.com/kelet-ai/typescript-sdk/commit/4e4775f412afbd0b38497a1a1285ef05a777691b))


### Features

* **claude-agent-sdk:** slim stream observer + docs ([daa1833](https://github.com/kelet-ai/typescript-sdk/commit/daa18335ebbac8a3c5f4f57a77a41f126372f990))
* **setup:** install LoggerProvider for OTLP log export ([0ec1df5](https://github.com/kelet-ai/typescript-sdk/commit/0ec1df5d869e9f05b479820f00f78d9f6c1e168d))



## [0.5.3](https://github.com/kelet-ai/typescript-sdk/compare/v0.5.2...v0.5.3) (2026-04-21)


### Bug Fixes

* **configure:** warn-and-no-op on missing KELET_API_KEY instead of crashing ([6e91fc6](https://github.com/kelet-ai/typescript-sdk/commit/6e91fc6222a7b869a545775b101001883bdc0dc3))



