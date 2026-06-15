-- L9 SEO Bot - Database Initialization
-- Creates both the bot database and the PostHog database

CREATE DATABASE posthog;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE posthog TO l9admin;
