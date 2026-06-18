import type { Config } from 'drizzle-kit';

export default {
  schema: ['./src/core/database/schema.ts', './src/core/database/schema-extensions.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
