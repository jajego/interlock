import { cpus, platform, release } from "node:os";

export interface PreparedOperation {
  run(): Promise<void>;
  cleanup?(): Promise<void>;
}

export interface BenchmarkPath {
  name: string;
  prepare(iteration: number): Promise<PreparedOperation>;
}

export interface SampleReport {
  name: string;
  iterationsPerRound: number;
  warmups: number;
  rounds: number;
  sampleCount: number;
  percentileMethod: "nearest-rank";
  roundMeansMs: readonly number[];
  coefficientOfVariation: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms?: number;
  meanMs: number;
  standardDeviationMs: number;
  minMs: number;
  maxMs: number;
  serialEquivalentOperationsPerSecond: number;
}

function percentile(sorted: readonly number[], value: number) {
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ??
    0
  );
}

function report(
  path: BenchmarkPath,
  rounds: readonly (readonly number[])[],
  warmups: number,
): SampleReport {
  const samples = rounds.flat();
  const sorted = [...samples].sort((left, right) => left - right);
  const meanMs =
    samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const standardDeviationMs = Math.sqrt(
    samples.reduce((sum, value) => sum + Math.pow(value - meanMs, 2), 0) /
      samples.length,
  );
  const roundMeansMs = rounds.map(
    (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
  );
  const roundMean =
    roundMeansMs.reduce((sum, value) => sum + value, 0) / roundMeansMs.length;
  const roundDeviation = Math.sqrt(
    roundMeansMs.reduce(
      (sum, value) => sum + Math.pow(value - roundMean, 2),
      0,
    ) / roundMeansMs.length,
  );
  return {
    name: path.name,
    iterationsPerRound: rounds[0]?.length ?? 0,
    warmups,
    rounds: rounds.length,
    sampleCount: samples.length,
    percentileMethod: "nearest-rank",
    roundMeansMs,
    coefficientOfVariation: roundMean === 0 ? 0 : roundDeviation / roundMean,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    ...(samples.length >= 200 ? { p99Ms: percentile(sorted, 0.99) } : {}),
    meanMs,
    standardDeviationMs,
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    serialEquivalentOperationsPerSecond: 1_000 / meanMs,
  };
}

export async function measurePaths(
  paths: readonly BenchmarkPath[],
  options: { warmups?: number; iterations?: number; rounds?: number } = {},
): Promise<SampleReport[]> {
  const warmups = options.warmups ?? 10;
  const iterations = options.iterations ?? 50;
  const roundCount = options.rounds ?? 3;
  for (const path of paths)
    for (let index = 0; index < warmups; index += 1) {
      const operation = await path.prepare(index);
      await operation.run();
      await operation.cleanup?.();
    }

  const samples = new Map(paths.map((path) => [path, [] as number[][]]));
  let sequence = warmups;
  for (let round = 0; round < roundCount; round += 1) {
    const ordered = round % 2 === 0 ? paths : [...paths].reverse();
    for (const path of ordered) {
      const roundSamples: number[] = [];
      for (let index = 0; index < iterations; index += 1) {
        const operation = await path.prepare(sequence++);
        const started = process.hrtime.bigint();
        await operation.run();
        roundSamples.push(
          Number(process.hrtime.bigint() - started) / 1_000_000,
        );
        await operation.cleanup?.();
      }
      samples.get(path)?.push(roundSamples);
    }
  }
  return paths.map((path) => report(path, samples.get(path) ?? [], warmups));
}

export async function measure(
  name: string,
  prepare: BenchmarkPath["prepare"],
  options?: Parameters<typeof measurePaths>[1],
) {
  const result = (await measurePaths([{ name, prepare }], options))[0];
  if (!result) throw new Error("Benchmark did not produce a report.");
  return result;
}

export async function measureThroughput(
  name: string,
  operations: readonly (() => Promise<void>)[],
  concurrency: number,
) {
  let completed = 0;
  let errors = 0;
  let next = 0;
  const started = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        const operation = operations[index];
        if (!operation) return;
        try {
          await operation();
          completed += 1;
        } catch {
          errors += 1;
        }
      }
    }),
  );
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    name,
    concurrency,
    attempted: operations.length,
    completed,
    errors,
    durationMs,
    measuredOperationsPerSecond: completed / (durationMs / 1_000),
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
