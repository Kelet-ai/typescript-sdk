# AI SDK Integration Research

## Vercel AI SDK Telemetry System

### How It Works
- Uses OpenTelemetry standard
- `experimental_telemetry` option on each function call
- Creates spans: `ai.generateText`, `ai.streamText`, `ai.generateObject`, etc.
- Uses GenAI semantic conventions (`gen_ai.*` attributes)

### Telemetry Configuration Options
```typescript
experimental_telemetry: {
  isEnabled: boolean,        // Enable telemetry
  recordInputs: boolean,     // Record prompts (default: true)
  recordOutputs: boolean,    // Record responses (default: true)
  functionId: string,        // Group telemetry by function
  metadata: Record<string, any>,  // Custom metadata
  tracer: Tracer,           // Custom OTEL Tracer instance
}
```

### Key Span Attributes
- `ai.model.id`, `ai.model.provider`
- `ai.prompt`, `ai.response.text`
- `ai.usage.promptTokens`, `ai.usage.completionTokens`
- `ai.telemetry.functionId`, `ai.telemetry.metadata.*`
- GenAI conventions: `gen_ai.system`, `gen_ai.request.*`, `gen_ai.response.*`

## Integration Patterns Observed

### Pattern 1: Custom SpanExporter (Langfuse, LangWatch, Traceloop)
- Create a custom `SpanExporter` or `SpanProcessor`
- Register via `registerOTel({ traceExporter: new CustomExporter() })`
- Intercept spans, transform, and send to backend

### Pattern 2: Environment Variables Only (Traceloop)
- Set OTEL_EXPORTER_OTLP_ENDPOINT and headers
- Relies on standard OTLP export
- Simplest approach, least control

### Pattern 3: Proxy/Wrapper (Helicone)
- Wraps model providers, not OTEL-based
- `helicone('gpt-4')` instead of standard provider
- Different approach, not pure OTEL

### Pattern 4: SpanProcessor (Braintrust, Arize)
- Custom `SpanProcessor` added to `spanProcessors[]`
- More control over span lifecycle (onStart, onEnd)

## Session/User Tracking

### Via metadata (common pattern)
```typescript
experimental_telemetry: {
  metadata: {
    userId: 'user-123',
    sessionId: 'session-456',
    tags: ['tag1', 'tag2'],
  }
}
```

### Via context propagation (Langfuse)
```typescript
propagateAttributes({
  userId, sessionId, tags, metadata
}, async () => { /* operations */ })
```

## Kelet-Specific Requirements

1. **Session grouping**: `gen_ai.conversation.id` attribute
2. **User tracking**: `user.id` attribute
3. **Signal correlation**: Need trace_id or session_id for feedback
4. **OTLP export**: Send spans to Kelet backend
5. **Project tagging**: `kelet.project` attribute on all spans
