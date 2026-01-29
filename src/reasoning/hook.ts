/**
 * Reasoning formatting utilities for AI SDK.
 *
 * @module reasoning/hook
 */

/**
 * Format reasoning content for span attribute.
 * Handles both array format (from AI SDK) and string format.
 *
 * @param reasoning - Raw reasoning content from AI SDK response
 * @returns Formatted string or undefined if no valid reasoning
 */
export function formatReasoning(reasoning: unknown): string | undefined {
  if (!reasoning) return undefined;

  // AI SDK returns reasoning as array of { type: 'text', text: string }
  if (Array.isArray(reasoning)) {
    const text = reasoning
      .filter(
        (r): r is { type: string; text: string } =>
          r && typeof r === 'object' && 'text' in r && typeof r.text === 'string'
      )
      .map((r) => r.text)
      .join('\n');
    return text || undefined;
  }

  // Direct string
  if (typeof reasoning === 'string') {
    return reasoning;
  }

  return undefined;
}
