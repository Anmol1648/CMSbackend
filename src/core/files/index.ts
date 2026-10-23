import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../db';
import { getContext, getTenantId } from '../context';
import { AppError, badRequest, notFound } from '../errors';
import { ErrorCode } from '../auth.types';
import { defineSetting, getSetting } from '../settings';
import { storage, storageFor } from './storage';

/**
 * Uploaded files. Every upload is checked by its content (not its name or the browser's claim),
 * recorded in `files`, and stored by the configured provider. Access is checked by the owning feature.
 */

export const UPLOADS = {
    maxFileMb: defineSetting<number>({
        key: 'uploads.max_file_mb',
        group: 'Uploads & exports',
        label: 'Largest file people may upload (MB)',
        type: 'number',
        default: 5,
        schema: z.number().int().min(1).max(50),
    }),
    maxImportRows: defineSetting<number>({
        key: 'uploads.max_import_rows',
        group: 'Uploads & exports',
        label: 'Most rows in one Excel import',
        type: 'number',
        default: 1000,
        schema: z.number().int().min(10).max(10000),
    }),
    maxExportRows: defineSetting<number>({
        key: 'exports.max_rows',
        group: 'Uploads & exports',
        label: 'Most rows in one Excel export',
        type: 'number',
        default: 10000,
        schema: z.number().int().min(100).max(100000),
    }),
};

export type FileKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'pdf' | 'xlsx';

const KINDS: Record<FileKind, { mime: string; ext: string }> = {
    png: { mime: 'image/png', ext: 'png' },
    jpeg: { mime: 'image/jpeg', ext: 'jpg' },
    webp: { mime: 'image/webp', ext: 'webp' },
    gif: { mime: 'image/gif', ext: 'gif' },
    pdf: { mime: 'application/pdf', ext: 'pdf' },
    xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
};

export const IMAGE_KINDS: FileKind[] = ['png', 'jpeg', 'webp'];

/** What the bytes really are (magic numbers). */
export const detectKind = (b: Buffer): FileKind | null => {
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'gif';
    if (b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
    // xlsx is a zip whose first entry is usually [Content_Types].xml; a plain zip check plus the name list is enough here.
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && b.includes(Buffer.from('[Content_Types].xml'))) return 'xlsx';
    return null;
};

export const mimeOf = (kind: FileKind) => KINDS[kind].mime;

export interface SaveUploadInput {
    data: Buffer;
    originalName: string;
    purpose: 'logo' | 'background' | 'avatar' | 'import' | 'document' | 'attendance' | 'face' | 'homework';
    allowed: FileKind[];
}

export const saveUpload = async (input: SaveUploadInput) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new Error('saveUpload needs a school in context');
    const maxMb = await getSetting(UPLOADS.maxFileMb);
    if (input.data.length > maxMb * 1024 * 1024) throw new AppError(`The file is larger than ${maxMb} MB`, 413, ErrorCode.PAYLOAD_TOO_LARGE);
    if (!input.data.length) throw badRequest('The file is empty');
    const kind = detectKind(input.data);
    if (!kind || !input.allowed.includes(kind)) {
        throw badRequest(`This file type is not accepted here. Use ${input.allowed.map((k) => KINDS[k].ext.toUpperCase()).join(', ')}.`);
    }
    const key = `${tenantId}/${input.purpose}/${crypto.randomUUID()}.${KINDS[kind].ext}`;
    const store = storage();
    const storageKey = await store.put(key, input.data, KINDS[kind].mime);
    return db.file.create({
        data: {
            tenantId,
            provider: store.name,
            storageKey,
            originalName: input.originalName.slice(0, 200) || `file.${KINDS[kind].ext}`,
            mimeType: KINDS[kind].mime,
            sizeBytes: input.data.length,
            purpose: input.purpose,
            uploadedBy: getContext()?.user?.id ?? null,
        },
    });
};

/** A file of the current school with its bytes. */
export const readFile = async (id: string) => {
    if (!z.string().uuid().safeParse(id).success) throw notFound('File not found');
    const file = await db.file.findUnique({ where: { id } });
    if (!file) throw notFound('File not found');
    try {
        return { file, data: await storageFor(file.provider).get(file.storageKey) };
    } catch {
        // The row is here but the bytes aren't (saved on another server's disk, or that disk was wiped).
        throw notFound('The file is missing from storage. Upload it again.');
    }
};

export const deleteFile = async (id: string) => {
    const file = await db.file.findUnique({ where: { id } });
    if (!file) return;
    await db.file.update({ where: { id }, data: { deletedAt: new Date() } });
    await storageFor(file.provider).remove(file.storageKey).catch(() => undefined);
};
