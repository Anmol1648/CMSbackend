import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        env: { NODE_ENV: 'test' },
        // Integration tests share one database; keep files sequential.
        fileParallelism: false,
        testTimeout: 20_000,
    },
});
