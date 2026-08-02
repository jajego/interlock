import { cpus, platform, release } from "node:os";

export interface SampleReport {
  name: string;
  iterations: number;
  warmups: number;
  rounds: number;
  roundMeansMs: readonly number[];
  coefficientOfVariation: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  operationsPerSecond: number;
}

function percentile(sorted: readonly number[], value: number) {
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ??
    0
  );
}

export async function measure(
  name: string,
  operation: (iteration: number) => Promise<void>,
  options: { warmups?: number; iterations?: number } = {},
): Promise<SampleReport> {
  const warmups = options.warmups ?? 10;
  const iterations = options.iterations ?? 50;
  const rounds = 3;
  const samples: number[] = [];
  const roundMeansMs: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < warmups; index += 1)
      await operation(round * (warmups + iterations) + index);
    const roundSamples: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = process.hrtime.bigint();
      await operation(round * (warmups + iterations) + warmups + index);
      roundSamples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
    }
    samples.push(...roundSamples);
    roundMeansMs.push(
      roundSamples.reduce((sum, value) => sum + value, 0) / roundSamples.length,
    );
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const meanMs =
    samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const standardDeviation = Math.sqrt(
    roundMeansMs.reduce((sum, value) => sum + Math.pow(value - meanMs, 2), 0) /
      roundMeansMs.length,
  );
  return {
    name,
    iterations,
    warmups,
    rounds,
    roundMeansMs,
    coefficientOfVariation: meanMs === 0 ? 0 : standardDeviation / meanMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    meanMs,
    operationsPerSecond: 1_000 / meanMs,
  };
}

export function environment(extra: Record<string, unknown> = {}) {
  return {
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    ...extra,
  };
}
