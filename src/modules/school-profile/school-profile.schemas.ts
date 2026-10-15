import { z } from 'zod';

const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
export const DATE_FORMATS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD'] as const;

/** Optional text: trimmed, empty string clears the value (null). */
const text = (max: number, pattern?: RegExp, message?: string) => {
    let s = z.string().trim().max(max);
    if (pattern) s = s.regex(pattern, message);
    return z
        .union([z.literal(''), s])
        .transform((v) => (v === '' ? null : v))
        .nullable()
        .optional();
};

export const updateSchoolProfileSchema = z
    .strictObject({
        legalName: z.string().trim().min(2).max(200).optional(),
        shortName: text(60),
        addressLine1: text(200),
        addressLine2: text(200),
        city: text(100),
        district: text(100),
        state: text(100),
        pincode: text(10, /^[A-Za-z0-9 -]{3,10}$/, 'is not a valid postal code'),
        country: z.string().trim().min(2).max(60).optional(),
        phone: text(20, /^[0-9+ ()-]{6,20}$/, 'is not a valid phone number'),
        email: z
            .union([z.literal(''), z.string().trim().toLowerCase().email('is not a valid email')])
            .transform((v) => (v === '' ? null : v))
            .nullable()
            .optional(),
        website: z
            .union([z.literal(''), z.string().trim().url('must be a full address like https://school.in')])
            .transform((v) => (v === '' ? null : v))
            .nullable()
            .optional(),
        board: text(60),
        affiliationNo: text(60),
        udiseCode: text(20, /^[0-9]{6,20}$/, 'must be digits only'),
        establishedYear: z.number().int().min(1800).max(new Date().getFullYear()).nullable().optional(),
        timeZone: z
            .string()
            .refine((tz) => TIME_ZONES.has(tz), 'is not a known time zone (e.g. Asia/Kolkata)')
            .optional(),
        dateFormat: z.enum(DATE_FORMATS).optional(),
        currency: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z]{3}$/, 'must be a 3-letter code like INR')
            .optional(),
        academicYearStartMonth: z.number().int().min(1).max(12).optional(),
        /** The updatedAt the editor loaded; if the profile changed since, the save is refused (409). */
        updatedAt: z.string().datetime({ offset: true }).optional(),
    })
    .refine((v) => Object.keys(v).some((k) => k !== 'updatedAt'), { message: 'Nothing to update' });

export type UpdateSchoolProfileInput = z.infer<typeof updateSchoolProfileSchema>;
