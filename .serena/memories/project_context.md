# Kelet TypeScript SDK - Project Context

## Overview
TypeScript SDK for Kelet - OpenTelemetry integration for AI observability.
Reference implementation: Python SDK at `../python-sdk`

## Project State
- **Current**: Empty scaffold (only `index.ts` with "Hello via Bun!")
- **Goal**: Port Python SDK functionality to TypeScript/Bun

## Python SDK Architecture (Reference)

### Core Modules
1. **_config.py** - Configuration state management
   - `KeletConfig` class with api_key, base_url, project
   - HTTP client management (httpx.AsyncClient)
   - Thread-safe config with double-checked locking

2. **_configure.py** - SDK initialization
   - `configure()` - Main entry point
   - `create_kelet_processor()` - OTLP span processor
   - OpenTelemetry TracerProvider setup
   - Auto-instrumentation for pydantic-ai

3. **_context.py** - Session/trace context
   - `agentic_session()` - Context manager for sessions
   - `get_session_id()`, `get_trace_id()`, `get_user_id()`
   - Uses ContextVars for async-safe storage
   - Semantic convention: `gen_ai.conversation.id`

4. **_signal.py** - Feedback submission
   - `signal()` - Submit user feedback
   - Retry logic with exponential backoff
   - Auto-detection of session/trace IDs

5. **models.py** - Enums
   - `SignalSource` (IMPLICIT, EXPLICIT)
   - `SignalVote` (UPVOTE, DOWNVOTE)

### API Client (api/client.py)
- `AsyncKeletClient` - Full API client
- Methods: `few_shots()`, `guidelines()`, `completion()`, `feedback()`
- Models: `FewShot`, `Guideline`, `Feedback`, `TransactionCompletion`

## TypeScript Implementation Plan

### Dependencies Needed
- OpenTelemetry SDK (@opentelemetry/sdk-trace-base)
- OTLP Exporter (@opentelemetry/exporter-trace-otlp-http)
- HTTP client (native fetch with Bun)

### Module Structure
```
src/
  index.ts          # Public API exports
  config.ts         # KeletConfig class
  configure.ts      # configure(), createKeletProcessor()
  context.ts        # agenticSession(), getSessionId(), etc.
  signal.ts         # signal() function
  models.ts         # SignalSource, SignalVote enums
  api/
    client.ts       # AsyncKeletClient
    models.ts       # API models
```

## Environment Variables
- `KELET_API_KEY` - Required
- `KELET_PROJECT` - Default: "default"
- `KELET_API_URL` - Default: "https://api.kelet.ai"

## Key Patterns to Port
1. Thread-safe config → Use module-level singleton
2. Context vars → Use AsyncLocalStorage
3. OTEL integration → Use JS OTEL SDK
4. Auto-instrument → Check for supported frameworks
