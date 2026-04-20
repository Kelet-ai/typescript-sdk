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



# [0.4.0](https://github.com/kelet-ai/typescript-sdk/compare/v0.3.1...v0.4.0) (2026-03-23)


### Bug Fixes

* **KEL-342:** propagate metadata kwargs to child spans via SpanProcessor ([245cd38](https://github.com/kelet-ai/typescript-sdk/commit/245cd38d61c8dd1bde9b672b46780d80ec1abf08))
* upgrade deps ([d9e1341](https://github.com/kelet-ai/typescript-sdk/commit/d9e13417984b284b831dd5dd9e82cdd3d4e006cd))


### Features

* **KEL-329:** auto-instrumentation for Anthropic, OpenAI, LangChain/LangGraph [WIP] ([a644bfb](https://github.com/kelet-ai/typescript-sdk/commit/a644bfb9f09ae9882d1b2669e733d8b8265e1266))



## [0.3.1](https://github.com/kelet-ai/typescript-sdk/compare/v0.3.0...v0.3.1) (2026-02-27)


### Bug Fixes

* update build verification test to expect `SignalKind` instead of `SignalVote` ([06361e8](https://github.com/kelet-ai/typescript-sdk/commit/06361e8b2a48841835a28062c06e33bff5403b69))



