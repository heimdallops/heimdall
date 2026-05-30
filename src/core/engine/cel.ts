import { evaluate } from '@marcbachmann/cel-js';

import { EngineError } from './errors.ts';

const INTERPOLATION_PATTERN = /\$\{\{\s*([\s\S]+?)\s*\}\}/g;

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const mapToObj = (map: Map<unknown, unknown>): Record<string, unknown> => {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of map) {
    if (typeof k === 'string' && !BLOCKED_KEYS.has(k)) {
      result[k] = v;
    }
  }

  return result;
};

const sanitizeValue = (value: unknown, ancestors = new WeakSet<object>()): unknown => {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (ancestors.has(value)) {
    return Object.create(null) as Record<string, unknown>;
  }

  try {
    ancestors.add(value);

    if (Array.isArray(value)) {
      return value.map((item: unknown) => sanitizeValue(item, ancestors));
    }

    const obj =
      value instanceof Map
        ? mapToObj(value as Map<unknown, unknown>)
        : (value as Record<string, unknown>);

    const result = Object.create(null) as Record<string, unknown>;

    for (const [k, v] of Object.entries(obj)) {
      if (!BLOCKED_KEYS.has(k)) {
        result[k] = sanitizeValue(v, ancestors);
      }
    }

    return result;
  } finally {
    ancestors.delete(value);
  }
};

const sanitize = (ctx: Record<string, unknown>): Record<string, unknown> =>
  sanitizeValue(ctx) as Record<string, unknown>;

const evalCelWithContext = (expr: string, celContext: Record<string, unknown>): unknown => {
  try {
    return evaluate(expr, celContext) as unknown;
  } catch (error) {
    throw new EngineError('CEL evaluation failed', 'ENGINE_CEL_ERROR', { cause: error });
  }
};

export const evalCel = (expr: string, ctx: Record<string, unknown>): unknown =>
  evalCelWithContext(expr, sanitize(ctx));

export const interpolate = (template: string, ctx: Record<string, unknown>): string => {
  const celContext = sanitize(ctx);

  return template.replace(INTERPOLATION_PATTERN, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();
    const result = evalCelWithContext(expr, celContext);

    if (
      result === null ||
      typeof result === 'string' ||
      typeof result === 'number' ||
      typeof result === 'boolean' ||
      typeof result === 'bigint'
    ) {
      return String(result);
    }

    if (typeof result === 'object') {
      return JSON.stringify(result);
    }

    throw new EngineError(
      `CEL expression resolved to an unsupported type (${typeof result}) in template`,
      'ENGINE_CEL_ERROR'
    );
  });
};
