import { defineConfig } from 'vitest/config';

// Single coverage lane. Mirrors ../pels: v8 coverage over the shipped runtime
// surfaces with an 80% gate across branches/functions/lines/statements.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    clearMocks: true,
    passWithNoTests: true,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'lib/**/*.ts',
      ],
      exclude: [
        // Thin SDK / socket adapters — exercised by `homey app validate` and manual
        // runs, not unit tests. The domain logic they wrap is covered below.
        'lib/WaterguardDevice.ts',
        'lib/bacnetTransport.ts',
        'test/**',
        'types/**',
        '**/*.d.ts',
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
