import process from "node:process";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL is required for test:postgres");
