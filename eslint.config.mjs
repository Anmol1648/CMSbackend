import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'scripts/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // Existing code from the old services still uses `any`; new code should not. Tightened per module rewrite.
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
            'no-console': 'error',
        },
    },
    {
        // The logger is the one place allowed to write to the console; seeds are CLI scripts.
        files: ['src/core/logger.ts', 'src/seeds/**'],
        rules: { 'no-console': 'off' },
    }
);
