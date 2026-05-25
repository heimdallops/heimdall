import { evaluate } from '@marcbachmann/cel-js';

import { EngineError } from './errors.ts';

const INTERPOLATION_PATTERN = /\$\{\{\s*([\s\S]+?)\s*\}\}/g;

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const sanitize = (ctx: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(ctx).filter(([k]) => !BLOCKED_KEYS.has(k)));

const evalCelWithContext = (expr: string, celContext: Record<string, unknown>): unknown => {
  try {
    return evaluate(expr, celContext) as unknown;
  } catch (error) {
    let detail: string;
    if (error instanceof Error) {
      detail = error.message;
    } else {
      detail = 'unknown error';
    }

    throw new EngineError(`CEL evaluation failed: ${detail}`, 'ENGINE_CEL_ERROR', { cause: error });
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
