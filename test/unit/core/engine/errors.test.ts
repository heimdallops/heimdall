import { describe, expect, it } from 'vitest';

import {
  EngineConfigError,
  EngineError,
  EngineValidationError,
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
