import { afterEach } from "vitest";

const ownedKeys = [
  "TELEGRAM_WEBHOOK_SECRET",
  "OPERATOR_SECRET",
  "CRON_SECRET",
  "E2E_TEST_ROUTES",
  "VERCEL_ENV",
];

afterEach(() => {
  for (const key of ownedKeys) {
    delete process.env[key];
  }
});
