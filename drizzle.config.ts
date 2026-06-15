import type { Config } from 'drizzle-kit';

export default {
  schema: './src/core/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://l9bot:l9bot_secure_password@localhost:5432/l9_seo_bot',
  },
} satisfies Config;
