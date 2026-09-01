import type { Config } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for drizzle-kit configuration");
}

export default {
  schema: [
    "./src/core/database/schema.ts",
    "./src/core/database/schema-extensions.ts",
    "./src/core/database/schema-reporting.ts",
    "./src/core/database/schema-intelligence.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
