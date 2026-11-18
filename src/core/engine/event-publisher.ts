import type {
  EventData,
  HeimdallEvent,
  NodeEventType,
  NodeRef,
  OutputStream,
  RunEventType,
} from './events.ts';

export type EventSink = (event: HeimdallEvent) => void;

/** Publishes a node event for a NodeRef fixed in advance. */
export type NodeEventPublish = <T extends NodeEventType>(type: T, data: EventData<T>) => void;

/** Publishes one line of node output as `node.output`. */
export type NodeOutput = (stream: OutputStream, text: string) => void;

/** Stamps events with the run's envelope (version, sequence, timestamp, runId) and hands them to sinks. */
export interface EventPublisher {
  readonly runId: string;
  /** Adds a sink. Returns a function that removes it. */
  subscribe(sink: EventSink): () => void;
  publishRunEvent<T extends RunEventType>(type: T, data: EventData<T>): void;
  publishNodeEvent<T extends NodeEventType>(ref: NodeRef, type: T, data: EventData<T>): void;
}

export interface EventPublisherOptions {
  runId: string;
  now?: () => Date;
  /** Called when a sink throws. Defaults to ignoring the error. */
  onSinkError?: (error: unknown, event: HeimdallEvent) => void;
}

export const createEventPublisher = (options: EventPublisherOptions): EventPublisher => {
  const { runId } = options;
  const now = options.now ?? ((): Date => new Date());
  const onSinkError = options.onSinkError ?? ((): void => undefined);
  let sinks: EventSink[] = [];
  let sequence = 0;

  // Sinks run synchronously in subscription order. A throwing sink must not stop the run or the
  // other sinks, so publishing never throws.
  const deliver = (event: HeimdallEvent): void => {
    Object.freeze(event);
    // Iterate a snapshot: a sink that unsubscribes mid-delivery replaces `sinks`, not this array.
    for (const sink of sinks) {
      try {
        sink(event);
      } catch (error) {
        try {
          onSinkError(error, event);
        } catch {
          // Reporting failed too; nothing left to tell.
        }
      }
    }
  };

  const envelope = (): { version: 1; sequence: number; timestamp: string; runId: string } => {
    sequence += 1;

    return { version: 1, sequence, timestamp: now().toISOString(), runId };
  };

  return {
    runId,
    subscribe(sink) {
      sinks = [...sinks, sink];

      return () => {
        sinks = sinks.filter((s) => s !== sink);
      };
    },
    publishRunEvent(type, data): void {
      deliver({ ...envelope(), type, data } as HeimdallEvent);
    },
    publishNodeEvent(ref, type, data): void {
      deliver({ ...envelope(), type, node: ref, data } as HeimdallEvent);
    },
  };
};

/** Binds node event publishing to one node attempt, so the node never builds its own NodeRef. */
export const bindNodeEvents = (
  publisher: EventPublisher,
  ref: NodeRef
): { publish: NodeEventPublish; output: NodeOutput } => ({
  publish: (type, data): void => {
    publisher.publishNodeEvent(ref, type, data);
  },
  output: (stream, text): void => {
    publisher.publishNodeEvent(ref, 'node.output', { stream, text });
  },
});
