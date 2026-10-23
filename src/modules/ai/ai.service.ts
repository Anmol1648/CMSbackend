import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { AppError } from '../../core/errors';
import { ErrorCode } from '../../core/auth.types';
import { recordAudit } from '../../core/audit';
import { decryptSecret, encryptSecret } from '../../core/encryption';
import { getSettings, setSetting } from '../../core/settings';
import { logger } from '../../core/logger';
import { todayIST } from '../attendance/attendance.settings';
import { AI } from './ai.settings';

/**
 * The AI layer: one way to ask, whatever the provider (Gemini today; others are a new entry in
 * PROVIDERS). It checks the school's limits, records every request (AI Usage) and never shows the key.
 */

export interface AiMessage {
    role: 'user' | 'assistant';
    text: string;
}
export interface AiRequest {
    system: string;
    messages: AiMessage[];
    json?: boolean;
    maxTokens?: number;
    temperature?: number;
}
interface AiReply {
    text: string;
    tokensIn: number;
    tokensOut: number;
}

/** Why AI can't be used now (shown to the person). */
export class AiUnavailableError extends AppError {
    constructor(message: string) {
        // A 400 so the reason is shown on the screen as it is.
        super(message, 400, ErrorCode.VALIDATION_ERROR);
    }
}

const gemini = async (key: string, model: string, r: AiRequest): Promise<AiReply> => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: r.system }] },
            contents: r.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
            generationConfig: { temperature: r.temperature ?? 0.6, maxOutputTokens: r.maxTokens ?? 4096, ...(r.json ? { responseMimeType: 'application/json' } : {}) },
        }),
    });
    const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
        promptFeedback?: { blockReason?: string };
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(data.error?.message ?? 'request failed').slice(0, 200)}`);
    if (data.promptFeedback?.blockReason) throw new Error(`Gemini refused the request (${data.promptFeedback.blockReason})`);
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) throw new Error(`Gemini gave no answer (${data.candidates?.[0]?.finishReason ?? 'empty'})`);
    return { text, tokensIn: data.usageMetadata?.promptTokenCount ?? 0, tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0 };
};

const PROVIDERS: Record<string, (key: string, model: string, r: AiRequest) => Promise<AiReply>> = { gemini };

const keyOf = (enc: string) => {
    if (!enc) return '';
    try {
        return decryptSecret(enc);
    } catch {
        return '';
    }
};

/** Whether AI can be used now, for buttons ("Generate with AI") and the setup screen. */
export const aiStatus = async () => {
    const s = await getSettings({ on: AI.on, provider: AI.provider, model: AI.model, key: AI.key });
    const ready = s.on && !!s.key;
    return { on: s.on, ready, provider: s.provider, model: s.model, keySaved: !!s.key, why: !s.on ? 'AI is switched off (System Settings → AI)' : !s.key ? 'AI isn’t set up yet: enter the key on Learning → AI Setup' : null };
};

const dayStart = () => new Date(`${todayIST()}T00:00:00+05:30`);
const monthStart = () => new Date(`${todayIST().slice(0, 8)}01T00:00:00+05:30`);

/** Asks the AI (checking the limits) and records the request. */
export const askAi = async (feature: string, userId: string | null, r: AiRequest) => {
    const s = await getSettings({ on: AI.on, provider: AI.provider, model: AI.model, key: AI.key, daily: AI.dailyPerUser, monthly: AI.monthly });
    if (!s.on) throw new AiUnavailableError('AI is switched off (System Settings → AI)');
    const key = keyOf(s.key);
    if (!key) throw new AiUnavailableError('AI isn’t set up yet: enter the key on Learning → AI Setup');
    if (userId && (await db.aiUsage.count({ where: { userId, createdAt: { gte: dayStart() }, ok: true } })) >= s.daily) throw new AiUnavailableError(`You have used today’s ${s.daily} AI requests. Try again tomorrow.`);
    if (s.monthly > 0 && (await db.aiUsage.count({ where: { createdAt: { gte: monthStart() }, ok: true } })) >= s.monthly) throw new AiUnavailableError('The school has used this month’s AI requests (System Settings → AI).');
    const call = PROVIDERS[s.provider];
    const base = { tenantId: getTenantId()!, userId, feature, provider: s.provider, model: s.model };
    try {
        const reply = await call(key, s.model, r);
        await db.aiUsage.create({ data: { ...base, tokensIn: reply.tokensIn, tokensOut: reply.tokensOut } });
        return reply.text;
    } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        await db.aiUsage.create({ data: { ...base, ok: false, error: message } });
        logger.warn('AI request failed', { feature, error: message });
        throw new AiUnavailableError(`The AI didn’t answer: ${message}`);
    }
};

/** Asks for JSON and checks it against a schema (the AI sometimes wraps it in ``` fences). */
export const askAiJson = async <T>(feature: string, userId: string | null, r: AiRequest, schema: z.ZodType<T>) => {
    const text = await askAi(feature, userId, { ...r, json: true });
    const raw = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new AiUnavailableError('The AI’s answer wasn’t in the expected form. Try again.');
    }
    const out = schema.safeParse(parsed);
    if (!out.success) throw new AiUnavailableError('The AI’s answer wasn’t in the expected form. Try again.');
    return out.data;
};

// ─── AI Setup and usage ──────────────────────────────────────────────────────

export const setupInfo = async () => {
    const st = await aiStatus();
    const [today, month, failed] = await Promise.all([
        db.aiUsage.count({ where: { createdAt: { gte: dayStart() }, ok: true } }),
        db.aiUsage.count({ where: { createdAt: { gte: monthStart() }, ok: true } }),
        db.aiUsage.findFirst({ where: { ok: false }, orderBy: { createdAt: 'desc' }, select: { error: true, createdAt: true } }),
    ]);
    const { monthly, daily } = await getSettings({ monthly: AI.monthly, daily: AI.dailyPerUser });
    return { ...st, usage: { today, month, monthlyLimit: monthly, dailyPerUser: daily }, lastError: failed };
};

export const keySchema = z.strictObject({ key: z.string().trim().min(1).max(500) });
/** Saves the key ("-" removes it). */
export const saveKey = async (key: string, userId: string) => {
    await setSetting(AI.key, key === '-' ? undefined : encryptSecret(key), userId);
    await recordAudit({ action: key === '-' ? 'ai_key_removed' : 'ai_key_saved', entity: 'ai', entityId: 'key', changes: {} });
    return setupInfo();
};

/** A tiny request, to see the key and model work. */
export const testAi = async (userId: string) => {
    const text = await askAi('test', userId, { system: 'Reply with one short sentence.', messages: [{ role: 'user', text: 'Say hello to the school in one sentence.' }], maxTokens: 60 });
    return { reply: text.slice(0, 300) };
};

export const usageQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });
export const usage = async (q: z.infer<typeof usageQuery>) => {
    const month = q.month ?? todayIST().slice(0, 7);
    const from = new Date(`${month}-01T00:00:00+05:30`);
    const [y, m] = month.split('-').map(Number);
    const to = new Date(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00:00+05:30`);
    const where = { createdAt: { gte: from, lt: to } };
    const [byFeature, byUser, totals] = await Promise.all([
        db.aiUsage.groupBy({ by: ['feature', 'ok'], where, _count: { _all: true }, _sum: { tokensIn: true, tokensOut: true } }),
        db.aiUsage.groupBy({ by: ['userId'], where: { ...where, ok: true }, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 20 }),
        db.aiUsage.aggregate({ where: { ...where, ok: true }, _count: { _all: true }, _sum: { tokensIn: true, tokensOut: true } }),
    ]);
    const users = new Map((await db.user.findMany({ where: { id: { in: byUser.map((u) => u.userId!).filter(Boolean) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const features = new Map<string, { feature: string; requests: number; failed: number; tokens: number }>();
    for (const f of byFeature) {
        const g = features.get(f.feature) ?? { feature: f.feature, requests: 0, failed: 0, tokens: 0 };
        if (f.ok) g.requests += f._count._all;
        else g.failed += f._count._all;
        g.tokens += (f._sum.tokensIn ?? 0) + (f._sum.tokensOut ?? 0);
        features.set(f.feature, g);
    }
    return {
        month,
        requests: totals._count._all,
        tokens: (totals._sum.tokensIn ?? 0) + (totals._sum.tokensOut ?? 0),
        features: [...features.values()].sort((a, b) => b.requests - a.requests),
        people: byUser.map((u) => ({ name: u.userId ? (users.get(u.userId) ?? '—') : 'System', requests: u._count._all })),
    };
};
