<div align="center">
  <img src=".github/logo.png" alt="Kelet" width="400">

  <h1>Automated Root Cause Analysis for AI Agents</h1>

  <p><strong>Agent failures take weeks to diagnose manually. Kelet runs 24/7 deep diagnosis and suggests targeted fixes.</strong></p>

  <img src=".github/illustration.png" alt="Kelet workflow" width="700">
</div>

Kelet analyzes production failures 24/7. Each trace takes 15-25 minutes to debug manually—finding patterns requires analyzing hundreds of traces. That's **weeks of engineering time** per root cause. Kelet does this automatically, surfacing issues like data imbalance, concept drift, prompt poisoning, and model laziness hidden in production noise.

---

## What Kelet Does

Kelet runs 24/7 analyzing every production trace:

1. **Captures** every interaction, user signal, and failure context automatically
2. **Analyzes** hundreds of failures in parallel to detect repeatable patterns
3. **Identifies** root causes (data issues, prompt problems, model behavior)
4. **Delivers** targeted fixes, not just dashboards

Unlike observability tools that show you data, Kelet analyzes it and tells you what to fix.

**Not magic**: Kelet is in alpha. Won't catch everything yet, needs your guidance sometimes. But it's already doing analysis that would take weeks manually.

Three lines of code to start.

## Installation

```bash
npm install kelet @opentelemetry/api @opentelemetry/exporter-trace-otlp-http
```

Or with your preferred package manager:

```bash
# pnpm
pnpm add kelet @opentelemetry/api @opentelemetry/exporter-trace-otlp-http

# yarn
yarn add kelet @opentelemetry/api @opentelemetry/exporter-trace-otlp-http

# bun
bun add kelet @opentelemetry/api @opentelemetry/exporter-trace-otlp-http
```

Set your API key:

```bash
export KELET_API_KEY=your_api_key
export KELET_PROJECT=production  # Optional: organize traces by environment
```

Or configure in code:

```typescript
import { configure } from 'kelet';

configure({
  apiKey: 'your_api_key',
  project: 'production',  // Groups traces by project/environment
});
```

## Quick Start

### Node.js / General Setup

```typescript
import { KeletExporter } from 'kelet';
import { NodeSDK } from '@opentelemetry/sdk-node';

// Set up tracing (once at app startup)
const sdk = new NodeSDK({
  traceExporter: new KeletExporter({
    apiKey: process.env.KELET_API_KEY,
    project: 'production',
  }),
});
sdk.start();
```

Works with any OpenTelemetry-instrumented framework or library.

### Next.js Setup

**1. Install dependencies:**

```bash
npm install kelet @vercel/otel @opentelemetry/api @opentelemetry/exporter-trace-otlp-http
```

**2. Create `instrumentation.ts` in your project root:**

```typescript
import { registerOTel } from '@vercel/otel';
import { KeletExporter } from 'kelet';

export function register() {
  registerOTel({
    serviceName: 'my-app',
    traceExporter: new KeletExporter({
      apiKey: process.env.KELET_API_KEY,
      project: 'production',
    }),
  });
}
```

**3. Enable instrumentation in `next.config.js`:**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
```

### Vercel AI SDK

Enable telemetry in your AI SDK calls:

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateText({
  model: openai('gpt-4'),
  prompt: 'Book a flight to NYC',
  experimental_telemetry: {
    isEnabled: true,
    metadata: {
      userId: 'user-123',
      sessionId: 'session-456',
    },
  },
});
```

### Capturing User Feedback

```typescript
import { signal, SignalSource, SignalVote } from 'kelet';

// Capture explicit user feedback
await signal({
  source: SignalSource.EXPLICIT,
  sessionId: 'user-123-session',
  vote: SignalVote.DOWNVOTE,  // User unhappy? Kelet analyzes why.
  explanation: 'Response was incorrect',
});

// Capture implicit signals (e.g., user copied text)
await signal({
  source: SignalSource.IMPLICIT,
  traceId: 'trace-abc-123',
  triggerName: 'user_copy',
  selection: 'copied text content',
});
```

**That's it.** Kelet now runs 24/7 analyzing every trace, clustering failure patterns, and identifying root causes—work that would take weeks manually.

### Easy Feedback UI for React

Building a React frontend? Use the [Kelet Feedback UI](https://github.com/kelet-ai/feedback-ui) component for instant implicit and explicit feedback collection.
See the [live demo](https://feedback-ui.kelet.ai/) and [documentation](https://github.com/kelet-ai/feedback-ui) for full integration guide.

---

## What Gets Captured

Kelet is built on [OpenTelemetry](https://opentelemetry.io/) and supports multiple semantic conventions for AI/LLM observability:

| Semantic Convention | Supported Frameworks |
|---------------------|----------------------|
| [GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | Pydantic AI, LiteLLM, Langfuse SDK |
| Vercel AI SDK | Next.js, Vercel AI |
| OpenInference | Arize Phoenix |
| OpenLLMetry / Traceloop | LangChain, LangGraph, LlamaIndex, OpenAI SDK, Anthropic SDK |

Any framework that exports OpenTelemetry traces using the GenAI semantic conventions will work automatically.

**Captured data includes:**

- **LLM calls**: Model, provider, tokens, latency, errors
- **Agent sessions**: Multi-step interactions grouped by user session
- **Custom context**: User IDs, session metadata, business-specific attributes

Works with any OpenTelemetry-compatible AI framework out of the box.

---

## Reasoning Capture for Vercel AI SDK

Vercel AI SDK's telemetry currently doesn't include reasoning/thinking content in spans ([vercel/ai#8823](https://github.com/vercel/ai/issues/8823)). Until an official fix, you can use this hook to capture reasoning from models that support extended thinking (like Claude with `reasoningConfig`).

### Running with the Hook

Use the `--import` flag (Node.js 18.19+) or equivalent to load the reasoning capture hook:

```bash
# Node.js
node --import kelet/reasoning/register app.js

# Bun
bun --preload kelet/reasoning/register app.ts
```

The hook intercepts AI SDK's `generateText` and `streamText` functions using `import-in-the-middle`. When a response includes reasoning, it's captured in a span with:
- `ai.response.reasoning` - the full reasoning text
- `ai.reasoning.length` - character count
---

## Configuration

Set via environment variables:

```bash
export KELET_API_KEY=your_api_key    # Required
export KELET_PROJECT=production      # Optional, defaults to "default"
export KELET_API_URL=https://...     # Optional, defaults to api.kelet.ai
```

Or pass directly to the exporter:

```typescript
import { KeletExporter } from 'kelet';

const exporter = new KeletExporter({
  apiKey: 'your_api_key',
  project: 'production',
  apiUrl: 'https://custom.api.kelet.ai',  // Optional
});
```

## API Reference

### KeletExporter

OpenTelemetry trace exporter for sending traces to Kelet.

```typescript
import { KeletExporter } from 'kelet';
import { NodeSDK } from '@opentelemetry/sdk-node';

const exporter = new KeletExporter({
  apiKey?: string,     // KELET_API_KEY env var if not provided
  project?: string,    // defaults to "default"
  apiUrl?: string,     // defaults to "https://api.kelet.ai"
});

const sdk = new NodeSDK({ traceExporter: exporter });
sdk.start();
```

### signal()

Capture user feedback for AI responses.

```typescript
import { signal, SignalSource, SignalVote } from 'kelet';

await signal({
  source: SignalSource.EXPLICIT,  // EXPLICIT | IMPLICIT
  sessionId?: string,             // Session identifier (one required)
  traceId?: string,               // Trace identifier (one required)
  vote?: SignalVote,              // UPVOTE | DOWNVOTE
  explanation?: string,           // User explanation
  triggerName?: string,           // e.g., "thumbs_up", "user_copy"
  selection?: string,             // Selected/copied text
  correction?: string | object,   // Corrected response
});
```

### configure()

Set global defaults for the SDK.

```typescript
import { configure } from 'kelet';

configure({
  apiKey?: string,
  project?: string,
  apiUrl?: string,
});
```

### Types

```typescript
// Signal source enum
const SignalSource = {
  IMPLICIT: 'IMPLICIT',  // Auto-detected (copy, time on page)
  EXPLICIT: 'EXPLICIT',  // User action (thumbs up/down)
} as const;

// Vote type enum
const SignalVote = {
  UPVOTE: 'UPVOTE',
  DOWNVOTE: 'DOWNVOTE',
} as const;
```

---

## Production-Ready

The SDK never disrupts your application:

- **Async**: Telemetry exports in background, zero blocking
- **Fail-safe**: Network errors handled with retries and exponential backoff
- **Graceful**: If Kelet is down, your agent keeps running
- **Standard**: Built on OpenTelemetry, works with any OTEL-compatible setup

---

## Alpha Status

Kelet is in alpha. What this means:

- **It works**: Already analyzing thousands of production traces for early users
- **Not perfect**: Won't catch every failure pattern yet, sometimes needs guidance
- **Improving fast**: The AI learns from more production data every day
- **We need feedback**: Help us make it better—tell us what it catches and what it misses

Even in alpha, Kelet does analysis that would take your team weeks to do manually.

**The alternative?** Manually analyzing 15-25 minutes per trace, across hundreds of failures, trying to spot patterns by hand. Most teams just don't do it—and ship broken agents.

---

## Learn More

- **Website**: [kelet.ai](https://kelet.ai)
- **Early Access**: We're onboarding teams with production AI agents
- **Support**: [GitHub Issues](https://github.com/Kelet-ai/typescript-sdk/issues)

Built for teams shipping mission-critical AI agents.
