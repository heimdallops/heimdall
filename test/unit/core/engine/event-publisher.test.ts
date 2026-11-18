import { describe, expect, it, vi } from 'vitest';

import { createEventPublisher } from '../../../../src/core/engine/event-publisher.ts';
import type { HeimdallEvent, NodeRef } from '../../../../src/core/engine/events.ts';

const FIXED_DATE = new Date('2026-01-02T03:04:05.678Z');

const ref: NodeRef = { id: 'build', name: 'Build', type: 'bash', path: ['build'], attempt: 1 };

const setup = (): {
  publisher: ReturnType<typeof createEventPublisher>;
  events: HeimdallEvent[];
} => {
  const publisher = createEventPublisher({ runId: 'run-1', now: () => FIXED_DATE });
  const events: HeimdallEvent[] = [];
  publisher.subscribe((event) => events.push(event));

  return { publisher, events };
};

describe('createEventPublisher', () => {
  it('numbers events 1, 2, 3 across run and node events', () => {
    const { publisher, events } = setup();

    publisher.publishRunEvent('run.started', { workflow: 'w', cwd: '/c', runDirectory: '/r' });
    publisher.publishNodeEvent(ref, 'node.started', {});
    publisher.publishRunEvent('run.completed', { success: true });

    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('stamps version, runId and the injected timestamp', () => {
    const { publisher, events } = setup();

    publisher.publishRunEvent('run.started', { workflow: 'w', cwd: '/c', runDirectory: '/r' });

    expect(events[0]).toEqual({
      version: 1,
      sequence: 1,
      timestamp: '2026-01-02T03:04:05.678Z',
      runId: 'run-1',
      type: 'run.started',
      data: { workflow: 'w', cwd: '/c', runDirectory: '/r' },
    });
    expect(publisher.runId).toBe('run-1');
  });

  it('attaches the NodeRef to node events and omits node from run events', () => {
    const { publisher, events } = setup();

    publisher.publishNodeEvent(ref, 'node.output', { stream: 'stdout', text: 'hello' });
    publisher.publishRunEvent('run.exited', { reason: 'done', failure: false });

    expect(events[0]).toMatchObject({ type: 'node.output', node: ref });
    expect(events[1]).not.toHaveProperty('node');
  });

  it('freezes events', () => {
    const { publisher, events } = setup();

    publisher.publishNodeEvent(ref, 'node.started', {});

    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it('calls sinks in subscription order', () => {
    const publisher = createEventPublisher({ runId: 'r' });
    const calls: string[] = [];
    publisher.subscribe(() => calls.push('a'));
    publisher.subscribe(() => calls.push('b'));
    publisher.subscribe(() => calls.push('c'));

    publisher.publishNodeEvent(ref, 'node.started', {});

    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('stops calling a sink after it unsubscribes', () => {
    const publisher = createEventPublisher({ runId: 'r' });
    const sink = vi.fn();
    const unsubscribe = publisher.subscribe(sink);

    publisher.publishNodeEvent(ref, 'node.started', {});
    unsubscribe();
    publisher.publishNodeEvent(ref, 'node.cancelled', {});

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing sink and reports it to onSinkError', () => {
    const onSinkError = vi.fn();
    const publisher = createEventPublisher({ runId: 'r', onSinkError });
    const failure = new Error('sink broke');
    const later = vi.fn();
    publisher.subscribe(() => {
      throw failure;
    });
    publisher.subscribe(later);

    expect(() => {
      publisher.publishNodeEvent(ref, 'node.started', {});
    }).not.toThrow();

    expect(later).toHaveBeenCalledTimes(1);
    expect(onSinkError).toHaveBeenCalledWith(failure, later.mock.calls[0]?.[0]);
  });

  it('never throws, even without onSinkError or when onSinkError throws', () => {
    const quiet = createEventPublisher({ runId: 'r' });
    quiet.subscribe(() => {
      throw new Error('x');
    });
    expect(() => {
      quiet.publishRunEvent('run.completed', { success: true });
    }).not.toThrow();

    const loud = createEventPublisher({
      runId: 'r',
      onSinkError: () => {
        throw new Error('reporter broke');
      },
    });
    loud.subscribe(() => {
      throw new Error('x');
    });
    expect(() => {
      loud.publishRunEvent('run.completed', { success: true });
    }).not.toThrow();
  });

  it('delivers the current event to every sink when one unsubscribes during delivery', () => {
    const publisher = createEventPublisher({ runId: 'r' });
    const calls: string[] = [];
    const unsubscribeA = publisher.subscribe(() => {
      calls.push('a');
      unsubscribeA();
    });
    publisher.subscribe(() => calls.push('b'));

    publisher.publishNodeEvent(ref, 'node.started', {});
    publisher.publishNodeEvent(ref, 'node.cancelled', {});

    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('keeps the sequence gapless when a sink throws', () => {
    const publisher = createEventPublisher({ runId: 'r' });
    const sequences: number[] = [];
    publisher.subscribe(() => {
      throw new Error('x');
    });
    publisher.subscribe((e) => sequences.push(e.sequence));

    publisher.publishNodeEvent(ref, 'node.started', {});
    publisher.publishNodeEvent(ref, 'node.completed', { result: { output: '' } });

    expect(sequences).toEqual([1, 2]);
  });
});
