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



## [0.5.2](https://github.com/kelet-ai/typescript-sdk/compare/v0.5.1...v0.5.2) (2026-04-20)


### Bug Fixes

* **setup:** drop SIGINT/SIGTERM handlers ([1bd4f65](https://github.com/kelet-ai/typescript-sdk/commit/1bd4f658ea6eeac7f557c0447c4ae6b636a5b9e9))
* **signal:** log per-attempt retry warnings to match Python SDK ([107476a](https://github.com/kelet-ai/typescript-sdk/commit/107476a7f1f87258b7d402043a5c1ad6cf091cde))
* **signal:** swallow transport failures by default; add shutdown() ([f168b06](https://github.com/kelet-ai/typescript-sdk/commit/f168b06f2fc8b0ea008b1d58eabb960a5160e1b0))



## [0.5.1](https://github.com/kelet-ai/typescript-sdk/compare/v0.5.0...v0.5.1) (2026-04-07)


### Bug Fixes

* add @types/bun to tsconfig types so bun:test resolves ([145089c](https://github.com/kelet-ai/typescript-sdk/commit/145089c49209078ea8e862ea9180165d6721b822))
* add rootDir to tsconfig.build.json, revert unnecessary types override ([e070a1e](https://github.com/kelet-ai/typescript-sdk/commit/e070a1e4b847605ed0677982c4ec4f58e19f9c81))
* exclude @types/bun from build tsconfig to fix rootDir error ([ab91456](https://github.com/kelet-ai/typescript-sdk/commit/ab9145688249fe0c88e5be559e78e75162da8ffb))
* **KEL-374:** add project to KeletExporter tests missing project ([5f7aac3](https://github.com/kelet-ai/typescript-sdk/commit/5f7aac3cf973a04a11652ec2092d594a805450cc))
* **KEL-374:** remove default project fallback, fail-fast on missing project ([936d899](https://github.com/kelet-ai/typescript-sdk/commit/936d8995c4a78b933df1f613109ef31b906fe7b6))



# [0.5.0](https://github.com/kelet-ai/typescript-sdk/compare/v0.4.0...v0.5.0) (2026-03-23)


### Features

* **KEL-343:** add spanProcessor option to configure() ([2dd31a6](https://github.com/kelet-ai/typescript-sdk/commit/2dd31a6216ae7daff86f3bcc0c7ef3592d00f0f3))



