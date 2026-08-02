import { defineConfig } from "prisma/config";
import { loadConfig } from "./src/config.js";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { seed: "tsx prisma/seed.ts" },
  datasource: { url: loadConfig().databaseUrl },
});
