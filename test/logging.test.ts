import { describe, it, expect } from 'vitest';
import { createRuntimeLogger, runWithLogContext } from '../lib/logging';

function makeSink() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
  };
}

describe('RuntimeLogger', () => {
  it('writes structured info entries to the log sink', () => {
    const sink = makeSink();
    createRuntimeLogger(sink, { component: 'test' }).info('evt.ok', 'hello', { count: 1 });
    expect(sink.errors).toHaveLength(0);
    expect(JSON.parse(sink.logs[0])).toMatchObject({ event: 'evt.ok', msg: 'hello', count: 1, component: 'test' });
  });

  it('writes errors with a serialized Error to the error sink', () => {
    const sink = makeSink();
    createRuntimeLogger(sink).error('evt.bad', 'boom', new Error('nope'), { unitId: 'u1' });
    const entry = JSON.parse(sink.errors[0]);
    expect(entry.event).toBe('evt.bad');
    expect(entry.unitId).toBe('u1');
    expect(entry.error.message).toBe('nope');
  });

  it('serializes string and object errors', () => {
    const sink = makeSink();
    const logger = createRuntimeLogger(sink);
    logger.error('e1', 'm', 'plain failure');
    logger.error('e2', 'm', { reason: 'weird' });
    expect(JSON.parse(sink.errors[0]).error.message).toBe('plain failure');
    expect(JSON.parse(sink.errors[1]).error.details).toEqual({ reason: 'weird' });
  });

  it('redacts sensitive fields', () => {
    const sink = makeSink();
    createRuntimeLogger(sink).info('e', 'm', { password: 'secret', token: 'abc', safe: 'ok' });
    const entry = JSON.parse(sink.logs[0]);
    expect(entry.password).toBe('[Redacted]');
    expect(entry.token).toBe('[Redacted]');
    expect(entry.safe).toBe('ok');
  });

  it('merges child bindings and async log context', () => {
    const sink = makeSink();
    const logger = createRuntimeLogger(sink).child({ unit: 'u1' });
    runWithLogContext({ operation: 'poll' }, () => logger.info('e', 'm'));
    const entry = JSON.parse(sink.logs[0]);
    expect(entry.unit).toBe('u1');
    expect(entry.operation).toBe('poll');
  });
});
