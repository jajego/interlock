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

export class ReferenceMetrics {
  readonly operations: CompletedLabels[] = [];
  readonly durations: Array<
    Omit<CompletedLabels, "outcome"> & { durationMs: number }
  > = [];
  readonly failures: FailureLabels[] = [];

  recordCompleted(labels: CompletedLabels, durationMs: number): void {
    this.operations.push(Object.freeze({ ...labels }));
    this.durations.push(
      Object.freeze({
        mode: labels.mode,
        lifecycle: labels.lifecycle,
        event: labels.event,
        durationMs,
      }),
    );
  }

  recordFailure(labels: FailureLabels): void {
    this.failures.push(Object.freeze({ ...labels }));
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
      if (observation.type === "interlock.operation.completed")
        metrics.recordCompleted(
          {
            mode: observation.mode,
            lifecycle: observation.lifecycle,
            event: observation.event,
            outcome: observation.outcome,
          },
          observation.durationMs,
        );
      else if (observation.type === "interlock.operation.failed")
        metrics.recordFailure({
          lifecycle: observation.lifecycle,
          event: observation.event,
          code: observation.code,
          phase: observation.phase,
        });
    },
  };
}
