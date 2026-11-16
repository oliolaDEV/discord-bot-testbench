import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { operationSchema, errorMessage, type Operation } from './protocol.js';

const scenarioSchema = z.object({
  name: z.string().min(1),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    request: z.record(z.string(), z.unknown()),
    expect: z.array(z.object({ path: z.string(), equals: z.unknown() }).strict()).default([])
  }).strict()).min(1)
}).strict();

export function atPath(value: unknown, path: string): unknown {
  let current = value as any;
  for (const part of path.split('.').filter(Boolean)) {
    if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error('Invalid reference path');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) throw new Error(`Reference path not found: ${path}`);
    current = current[part];
  }
  return current;
}

export function substitute(value: unknown, context: unknown): unknown {
  if (typeof value === 'string') {
    const match = /^\{\{([a-zA-Z0-9_.-]+)\}\}$/.exec(value);
    return match ? atPath(context, match[1]!) : value;
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, context)]));
  return value;
}

export async function runScenario(raw: unknown, execute: (operation: Operation) => Promise<any>) {
  const scenario = scenarioSchema.parse(raw);
  const ids = scenario.steps.map(s => s.id);
  if (new Set(ids).size !== ids.length) throw new Error('Scenario step IDs must be unique');
  const steps: Record<string, unknown> = {};
  const results = [];
  for (const step of scenario.steps) {
    try {
      const input = operationSchema.parse(substitute(step.request, { steps }));
      const result = await execute(input);
      steps[step.id] = result;
      const failures: string[] = [];
      for (const assertion of step.expect) {
        const actual = atPath(result, assertion.path);
        const expected = substitute(assertion.equals, { steps });
        if (!isDeepStrictEqual(actual, expected)) failures.push(`${assertion.path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
      }
      if (result?.status === 'failed' || result?.status === 'timed_out' || result?.passed === false || result?.matched === false || result?.errors?.length > 0) failures.push('Operation reported failure');
      results.push({ id: step.id, passed: failures.length === 0, failures, result });
      if (failures.length) break;
    } catch (error) {
      results.push({ id: step.id, passed: false, failures: [errorMessage(error)] });
      break;
    }
  }
  return { name: scenario.name, passed: results.length === scenario.steps.length && results.every(r => r.passed), steps: results };
}
