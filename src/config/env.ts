import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

/**
 * Every environment variable the backend reads, validated once at startup.
 * A missing or malformed value stops the server with the variable's name (never its value).
 */

const optional = z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8000),
    // Behind a reverse proxy (Render, Nginx…) set to the number of proxies so req.ip is the client's IP.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // Comma-separated list of allowed browser origins. Empty in development = localhost / LAN.
    CORS_ORIGINS: optional,

    DATABASE_URL: z.string().min(1, 'is required'),
    // School used when the web address doesn't match any school's domain (single-school setups).
    DEFAULT_TENANT_CODE: optional,
    REDIS_URL: optional,

    JWT_PRIVATE_KEY: z.string().min(1, 'is required'),
    MFA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)'),
    SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(10),

    SMTP_HOST: optional,
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: optional,
    SMTP_PASS: optional,
    SMTP_FROM: optional,

    // Where uploaded files are kept: local disk (development / single server) or Cloudinary.
    STORAGE_PROVIDER: z.enum(['local', 'cloudinary']).default('local'),
    STORAGE_DIR: optional,

    CLOUDINARY_CLOUD_NAME: optional,
    CLOUDINARY_API_KEY: optional,
    CLOUDINARY_API_SECRET: optional,
});

export type Env = z.infer<typeof envSchema>;

/** Parses a raw environment; throws one error listing every problem. Exported for tests. */
export const parseEnv = (raw: Record<string, string | undefined>): Env => {
    const result = envSchema.safeParse(raw);
    if (!result.success) {
        const problems = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid environment configuration:\n${problems}`);
    }
    return result.data;
};

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
