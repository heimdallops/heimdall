import type { EventPublisher, EventSink } from '../../../../src/core/engine/event-publisher.ts';
import {
  bindNodeEvents,
  createEventPublisher,
} from '../../../../src/core/engine/event-publisher.ts';
import type { HeimdallEvent, NodeRef } from '../../../../src/core/engine/events.ts';
import type { NodeRunOptions } from '../../../../src/core/engine/nodes/base.ts';

export const TEST_RUN_ID = 'test-run';

export interface CollectedEvents {
  publisher: EventPublisher;
  events: HeimdallEvent[];
  /** Events of one type, narrowed to that type. */
  ofType<T extends HeimdallEvent['type']>(type: T): Extract<HeimdallEvent, { type: T }>[];
  /** Node events whose `node.id` matches. */
  forNode(id: string): Extract<HeimdallEvent, { node: NodeRef }>[];
  /** `type` of every event, in publish order. */
  types(): string[];
}

/** A publisher that records every event it publishes. */
export const collectEvents = (): CollectedEvents => {
  const publisher = createEventPublisher({ runId: TEST_RUN_ID });
  const events: HeimdallEvent[] = [];
  publisher.subscribe((event) => {
    events.push(event);
  });

  return {
    publisher,
    events,
    ofType: <T extends HeimdallEvent['type']>(type: T) =>
      events.filter((e): e is Extract<HeimdallEvent, { type: T }> => e.type === type),
    forNode: (id) =>
      events.filter(
        (e): e is Extract<HeimdallEvent, { node: NodeRef }> => 'node' in e && e.node.id === id
      ),
    types: () => events.map((e) => e.type),
  };
};

const TEST_REF: NodeRef = { id: 'test', name: 'test', type: 'test', path: ['test'], attempt: 1 };

/**
 * The event fields of NodeRunOptions, for calling `node.run()` directly. Events go to `publisher`
 * (a fresh, unobserved one by default) under a fixed test NodeRef.
 */
export const eventOptions = (
  publisher: EventPublisher = createEventPublisher({ runId: TEST_RUN_ID }),
  ref: NodeRef = TEST_REF
): Pick<NodeRunOptions, 'publisher' | 'publish' | 'output'> => ({
  publisher,
  ...bindNodeEvents(publisher, ref),
});

export type EventOf<T extends HeimdallEvent['type']> = Extract<HeimdallEvent, { type: T }>;

export interface EventRecorder {
  /** Pass as `Workflow.run({ onEvent })`. */
  onEvent: EventSink;
  /** Every event received, in order. */
  events: HeimdallEvent[];
  /** A live list of the events of one type received from now on. */
  collect<T extends HeimdallEvent['type']>(type: T): EventOf<T>[];
  /** Calls `listener` for each later event of one type. */
  on<T extends HeimdallEvent['type']>(type: T, listener: (event: EventOf<T>) => void): void;
}

/** A sink for `Workflow.run({ onEvent })` that records what it receives. */
export const recordEvents = (): EventRecorder => {
  const events: HeimdallEvent[] = [];
  const listeners: EventSink[] = [];

  const on = <T extends HeimdallEvent['type']>(
    type: T,
    listener: (event: EventOf<T>) => void
  ): void => {
    listeners.push((event) => {
      if (event.type === type) {
        listener(event as EventOf<T>);
      }
    });
  };

  return {
    onEvent: (event): void => {
      events.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
    events,
    collect: <T extends HeimdallEvent['type']>(type: T): EventOf<T>[] => {
      const collected: EventOf<T>[] = [];
      on(type, (event) => collected.push(event));

      return collected;
    },
    on,
  };
};

/** `node.completed` carries `result: unknown`; tests read it as the node's result record. */
export const resultOf = (event: EventOf<'node.completed'>): Record<string, unknown> =>
  event.data.result as Record<string, unknown>;
