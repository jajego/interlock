import type {
  InterlockObservation,
  InterlockObserver,
} from "@jajego/interlock";

export interface AppLogger {
  info(fields: Record<string, unknown>, message?: string): void;
}

type CompletedLabels = {
  mode: "assess" | "transition";
  lifecycle: string;
  event: string;
  outcome: Extract<
    InterlockObservation,
    { type: "interlock.operation.completed" }
  >["outcome"];
};

type FailureLabels = {
  lifecycle: string;
  event: string;
  code: Extract<
    InterlockObservation,
    { type: "interlock.operation.failed" }
  >["code"];
  phase: Extract<
    InterlockObservation,
    { type: "interlock.operation.failed" }
  >["phase"];
};

type OperationCount = {
  labels: CompletedLabels;
  count: number;
};

type DurationSummary = {
  labels: Omit<CompletedLabels, "outcome">;
  count: number;
  totalMs: number;
  maxMs: number;
};

type FailureCount = {
  labels: FailureLabels;
  count: number;
};

function metricEvent(observation: InterlockObservation): string {
  return observation.type === "interlock.operation.completed" &&
    observation.outcome === "unknown-event"
    ? "__unknown__"
    : observation.event;
}

/** Small bounded in-memory aggregation example, not a production metrics backend. */
export class ReferenceMetrics {
  readonly operationCounts = new Map<string, OperationCount>();
  readonly durationSummaries = new Map<string, DurationSummary>();
  readonly failureCounts = new Map<string, FailureCount>();

  recordCompleted(labels: CompletedLabels, durationMs: number): void {
    const operationKey = JSON.stringify([
      labels.mode,
      labels.lifecycle,
      labels.event,
      labels.outcome,
    ]);
    const operation = this.operationCounts.get(operationKey);
    if (operation) operation.count += 1;
    else
      this.operationCounts.set(operationKey, {
        labels: Object.freeze({ ...labels }),
        count: 1,
      });

    const durationLabels = Object.freeze({
      mode: labels.mode,
      lifecycle: labels.lifecycle,
      event: labels.event,
    });
    const durationKey = JSON.stringify([
      durationLabels.mode,
      durationLabels.lifecycle,
      durationLabels.event,
    ]);
    const summary = this.durationSummaries.get(durationKey);
    if (summary) {
      summary.count += 1;
      summary.totalMs += durationMs;
      summary.maxMs = Math.max(summary.maxMs, durationMs);
    } else
      this.durationSummaries.set(durationKey, {
        labels: durationLabels,
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
      });
  }

  recordFailure(labels: FailureLabels): void {
    const key = JSON.stringify([
      labels.lifecycle,
      labels.event,
      labels.code,
      labels.phase,
    ]);
    const failure = this.failureCounts.get(key);
    if (failure) failure.count += 1;
    else
      this.failureCounts.set(key, {
        labels: Object.freeze({ ...labels }),
        count: 1,
      });
  }
}

export function createInterlockObserver(
  logger: AppLogger,
  metrics: ReferenceMetrics,
): InterlockObserver {
  return {
    observe(observation) {
      logger.info(
        { category: "interlock", ...observation },
        "interlock operation",
      );
      if (observation.type === "interlock.operation.completed") {
        const event = metricEvent(observation);
        metrics.recordCompleted(
          {
            mode: observation.mode,
            lifecycle: observation.lifecycle,
            event,
            outcome: observation.outcome,
          },
          observation.durationMs,
        );
      } else if (observation.type === "interlock.operation.failed")
        metrics.recordFailure({
          lifecycle: observation.lifecycle,
          event: observation.event,
          code: observation.code,
          phase: observation.phase,
        });
    },
  };
}
