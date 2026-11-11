import { MediaType } from "./media-type.ts";

export type ParseEventType = "start" | "end" | "error";

export interface ParseEvent {
  readonly type: ParseEventType;
  readonly resourceName?: string;
  readonly mediaType?: string;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface EventSink {
  emit(event: ParseEvent): void;
}

export interface MetricsSnapshot {
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly totalMillis: number;
  readonly byMediaType: Readonly<Record<string, number>>;
}

/** Accumulates parse lifecycle events for metrics and stats endpoints. */
export class MetricsCollector implements EventSink {
  #started = 0;
  #completed = 0;
  #failed = 0;
  #totalMillis = 0;
  readonly #byMediaType = new Map<string, number>();

  emit(event: ParseEvent): void {
    if (event.type === "start") {
      this.#started++;
      return;
    }
    if (event.type === "end") {
      this.#completed++;
      this.#totalMillis += event.durationMs ?? 0;
      if (event.mediaType !== undefined) {
        // A text parser writes `text/plain; charset=...`: count the type, not each charset it was read as.
        const type = MediaType.parse(event.mediaType)?.getBaseType().toString() ?? event.mediaType;
        this.#byMediaType.set(type, (this.#byMediaType.get(type) ?? 0) + 1);
      }
      return;
    }
    this.#failed++;
  }

  snapshot(): MetricsSnapshot {
    return {
      started: this.#started,
      completed: this.#completed,
      failed: this.#failed,
      totalMillis: this.#totalMillis,
      byMediaType: Object.fromEntries(this.#byMediaType),
    };
  }
}

/** Fan-out sink; failures in one sink do not block parsing. */
export class CompositeEventSink implements EventSink {
  readonly #sinks: readonly EventSink[];

  constructor(sinks: readonly EventSink[]) {
    this.#sinks = sinks;
  }

  emit(event: ParseEvent): void {
    for (const sink of this.#sinks) {
      try {
        sink.emit(event);
      } catch {
        // Metrics/reporting must never fail a parse.
      }
    }
  }
}
