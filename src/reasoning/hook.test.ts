import { describe, expect, test } from 'bun:test';
import { formatReasoning } from './hook.ts';

describe('formatReasoning', () => {
  test('returns undefined for null input', () => {
    expect(formatReasoning(null)).toBeUndefined();
  });

  test('returns undefined for undefined input', () => {
    expect(formatReasoning(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(formatReasoning('')).toBeUndefined();
  });

  test('returns undefined for empty array', () => {
    expect(formatReasoning([])).toBeUndefined();
  });

  test('handles string input directly', () => {
    const reasoning = 'This is my reasoning process';
    expect(formatReasoning(reasoning)).toBe(reasoning);
  });

  test('handles AI SDK array format with single item', () => {
    const reasoning = [{ type: 'text', text: 'Step 1: Analyze the problem' }];
    expect(formatReasoning(reasoning)).toBe('Step 1: Analyze the problem');
  });

  test('handles AI SDK array format with multiple items', () => {
    const reasoning = [
      { type: 'text', text: 'Step 1: Analyze the problem' },
      { type: 'text', text: 'Step 2: Consider options' },
      { type: 'text', text: 'Step 3: Choose solution' },
    ];
    expect(formatReasoning(reasoning)).toBe(
      'Step 1: Analyze the problem\nStep 2: Consider options\nStep 3: Choose solution'
    );
  });

  test('filters out non-text items in array', () => {
    const reasoning = [
      { type: 'text', text: 'Valid reasoning' },
      { type: 'image', data: 'base64...' },
      { type: 'text', text: 'More reasoning' },
    ];
    expect(formatReasoning(reasoning)).toBe('Valid reasoning\nMore reasoning');
  });

  test('handles array with invalid items', () => {
    const reasoning = [
      null,
      { type: 'text', text: 'Valid' },
      undefined,
      { type: 'text' }, // missing text
      { text: 'no type' }, // should still work since we check for text property
    ];
    expect(formatReasoning(reasoning)).toBe('Valid\nno type');
  });

  test('returns undefined for object without text property', () => {
    const reasoning = { type: 'something', data: 'value' };
    expect(formatReasoning(reasoning)).toBeUndefined();
  });

  test('returns undefined for number input', () => {
    expect(formatReasoning(42)).toBeUndefined();
  });

  test('returns undefined for boolean input', () => {
    expect(formatReasoning(true)).toBeUndefined();
  });
});
