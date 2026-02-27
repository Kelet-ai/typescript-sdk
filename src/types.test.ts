import { describe, expect, test } from 'bun:test';
import { SignalKind, SignalSource } from './types.ts';

describe('SignalKind', () => {
  test('has FEEDBACK value', () => {
    expect(SignalKind.FEEDBACK).toBe('feedback');
  });

  test('has EDIT value', () => {
    expect(SignalKind.EDIT).toBe('edit');
  });

  test('has EVENT value', () => {
    expect(SignalKind.EVENT).toBe('event');
  });

  test('has METRIC value', () => {
    expect(SignalKind.METRIC).toBe('metric');
  });

  test('has ARBITRARY value', () => {
    expect(SignalKind.ARBITRARY).toBe('arbitrary');
  });

  test('has five values', () => {
    expect(Object.values(SignalKind)).toHaveLength(5);
  });
});

describe('SignalSource', () => {
  test('has HUMAN value', () => {
    expect(SignalSource.HUMAN).toBe('human');
  });

  test('has LABEL value', () => {
    expect(SignalSource.LABEL).toBe('label');
  });

  test('has SYNTHETIC value', () => {
    expect(SignalSource.SYNTHETIC).toBe('synthetic');
  });

  test('has three values', () => {
    expect(Object.values(SignalSource)).toHaveLength(3);
  });
});
