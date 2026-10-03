import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Los tests comparten la base agenda_test: corren uno tras otro.
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgres://agenda:agenda@localhost:5432/agenda_test',
    },
  },
});
