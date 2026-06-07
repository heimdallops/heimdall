import { describe, expect, it } from 'vitest';

import {
  EngineConfigError,
  EngineError,
  EngineValidationError,
  NodeError,
} from '../../../../src/core/engine/errors.ts';

describe('EngineError', () => {
  it('exposes the message passed to the constructor', () => {
    const err = new EngineError('disk full', 'ENGINE_DISK_FULL');

    expect(err.message).toBe('disk full');
  });

  it('exposes the code passed to the constructor', () => {
    const err = new EngineError('disk full', 'ENGINE_DISK_FULL');

    expect(err.code).toBe('ENGINE_DISK_FULL');
  });

  it('has name set to EngineError', () => {
    const err = new EngineError('something went wrong', 'ENGINE_GENERIC');

    expect(err.name).toBe('EngineError');
  });

  it('propagates cause when provided in options', () => {
    const root = new Error('root cause');
    const err = new EngineError('wrapped', 'ENGINE_WRAPPED', { cause: root });

    expect(err.cause).toBe(root);
  });

  describe('effectiveCode', () => {
    it('returns own code when there is no cause', () => {
      const err = new EngineError('standalone', 'CODE_A');

      expect(err.effectiveCode).toBe('CODE_A');
    });

    it('returns the inner code and leaves own .code unchanged when cause is an EngineError', () => {
      const inner = new EngineError('inner', 'CODE_INNER');
      const outer = new EngineError('outer', 'CODE_OUTER', { cause: inner });

      expect(outer.effectiveCode).toBe('CODE_INNER');
      expect(outer.code).toBe('CODE_OUTER');
    });

    it('returns the innermost code across a three-link all-EngineError chain', () => {
      const innermost = new EngineError('innermost', 'CODE_DEEP');
      const middle = new EngineError('middle', 'CODE_MID', { cause: innermost });
      const outer = new EngineError('outer', 'CODE_TOP', { cause: middle });

      expect(outer.effectiveCode).toBe('CODE_DEEP');
    });

    it('stops at the deepest EngineError and ignores a plain Error leaf', () => {
      const plainLeaf = new Error('plain');
      const engineWrap = new EngineError('engine wrap', 'CODE_ENGINE', { cause: plainLeaf });
      const outer = new EngineError('outer', 'CODE_OUTER', { cause: engineWrap });

      expect(outer.effectiveCode).toBe('CODE_ENGINE');
    });
  });

  describe('toString', () => {
    it('returns the message when there is no cause', () => {
      const err = new EngineError('standalone message', 'CODE_A');

      expect(err.toString()).toBe('standalone message');
    });

    it('joins outer and inner messages when cause is a plain Error', () => {
      const inner = new Error('inner msg');
      const outer = new EngineError('outer msg', 'CODE_A', { cause: inner });

      expect(outer.toString()).toBe('outer msg: inner msg');
    });

    it('joins all three messages outer→inner including node suffixes for NodeError links', () => {
      const plain = new Error('plain cause');
      const middleNode = new NodeError('middle failed', 'CODE_MID', 'node-mid', {
        nodeName: 'Mid Node',
        cause: plain,
      });
      const outerNode = new NodeError('outer failed', 'CODE_TOP', 'node-top', {
        nodeName: 'Top Node',
        cause: middleNode,
      });

      expect(outerNode.toString()).toBe(
        'outer failed (node: "Top Node"): middle failed (node: "Mid Node"): plain cause'
      );
    });

    it('appends a primitive string cause', () => {
      const err = new EngineError('outer msg', 'CODE_A', { cause: 'some string reason' });

      expect(err.toString()).toBe('outer msg: some string reason');
    });

    it('does not append a plain object cause and does not throw', () => {
      const err = new EngineError('outer msg', 'CODE_A', { cause: { foo: 1 } });

      expect(err.toString()).toBe('outer msg');
    });
  });
});

describe('EngineValidationError', () => {
  it('has code ENGINE_VALIDATION_ERROR', () => {
    const err = new EngineValidationError('yaml parse failed');

    expect(err.code).toBe('ENGINE_VALIDATION_ERROR');
  });
});

describe('EngineConfigError', () => {
  it('has code ENGINE_CONFIG_ERROR', () => {
    const err = new EngineConfigError('cycle detected in depends_on');

    expect(err.code).toBe('ENGINE_CONFIG_ERROR');
  });
});

describe('NodeError', () => {
  it('appends nodeName to the message when provided', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1', {
      nodeName: 'My Node',
    });

    expect(err.message).toBe('bad expression (node: "My Node")');
  });

  it('appends nodeId to the message when nodeName is absent', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1');

    expect(err.message).toBe('bad expression (node: "node-1")');
  });

  it('exposes nodeId', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1');

    expect(err.nodeId).toBe('node-1');
  });

  it('exposes nodeName when provided', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1', {
      nodeName: 'My Node',
    });

    expect(err.nodeName).toBe('My Node');
  });

  it('has name set to NodeError', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1');

    expect(err.name).toBe('NodeError');
  });

  it('is an instance of EngineError', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1');

    expect(err).toBeInstanceOf(EngineError);
  });

  it('propagates cause when provided in options', () => {
    const root = new Error('root cause');
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1', { cause: root });

    expect(err.cause).toBe(root);
  });

  it('displayName returns nodeName when available', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1', {
      nodeName: 'My Node',
    });

    expect(err.displayName()).toBe('My Node');
  });

  it('displayName falls back to nodeId when nodeName is absent', () => {
    const err = new NodeError('bad expression', 'ENGINE_CEL_ERROR', 'node-1');

    expect(err.displayName()).toBe('node-1');
  });
});
