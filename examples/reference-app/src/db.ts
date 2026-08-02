import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

export function createDatabase(connectionString: string) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 10 }),
  });
}

export type Database = ReturnType<typeof createDatabase>;
export type Transaction = Prisma.TransactionClient;
