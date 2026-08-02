export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
  bodyLimit: number;
}

export function loadConfig(environment = process.env): AppConfig {
  const testUrl = environment.TEST_DATABASE_URL;
  const databaseUrl =
    environment.DATABASE_URL ??
    (testUrl
      ? (() => {
          const url = new URL(testUrl);
          url.pathname = "/interlock_reference";
          return url.toString();
        })()
      : undefined);
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const port = Number(environment.PORT ?? 3100);
  const bodyLimit = Number(environment.BODY_LIMIT_BYTES ?? 65_536);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("PORT must be an integer from 0 through 65535.");
  if (!Number.isInteger(bodyLimit) || bodyLimit < 1)
    throw new Error("BODY_LIMIT_BYTES must be a positive integer.");
  return {
    databaseUrl,
    host: environment.HOST ?? "127.0.0.1",
    port,
    bodyLimit,
  };
}
