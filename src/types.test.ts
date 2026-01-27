import { describe, expect, test } from 'bun:test';
import { SignalSource, SignalVote } from './types.ts';

describe('SignalSource', () => {
  test('has IMPLICIT value', () => {
    expect(SignalSource.IMPLICIT).toBe('IMPLICIT');
  });

  test('has EXPLICIT value', () => {
    expect(SignalSource.EXPLICIT).toBe('EXPLICIT');
  });

  test('only has two values', () => {
    expect(Object.values(SignalSource)).toHaveLength(2);
  });
});

describe('SignalVote', () => {
  test('has UPVOTE value', () => {
    expect(SignalVote.UPVOTE).toBe('UPVOTE');
  });

  test('has DOWNVOTE value', () => {
    expect(SignalVote.DOWNVOTE).toBe('DOWNVOTE');
  });

  test('only has two values', () => {
    expect(Object.values(SignalVote)).toHaveLength(2);
  });
});
