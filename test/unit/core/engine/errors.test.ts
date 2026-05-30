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
