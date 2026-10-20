import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { deleteFile, FileKind, IMAGE_KINDS, readFile, saveUpload } from '../../core/files';

/** A staff member's photo and documents (appointment letter, certificates…). */

const DOCUMENT_KINDS: FileKind[] = [...IMAGE_KINDS, 'pdf'];

const photoOf = async (staffId: string) => {
    const s = await db.staff.findUnique({ where: { id: staffId }, select: { photoFileId: true } });
    if (!s) throw notFound('Staff member not found');
    return s.photoFileId;
};

export const setPhoto = async (staffId: string, upload: { data: Buffer; originalName: string }) => {
    const old = await photoOf(staffId);
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: 'avatar', allowed: IMAGE_KINDS });
    await db.staff.update({ where: { id: staffId }, data: { photoFileId: file.id } });
    if (old) await deleteFile(old);
    await recordAudit({ action: 'update', entity: 'staff', entityId: staffId, changes: { photo: [old ? 'photo' : null, 'new photo'] } });
    return { photoUrl: `staff/${staffId}/photo?v=${file.id}` };
};

export const removePhoto = async (staffId: string) => {
    const old = await photoOf(staffId);
    if (old) {
        await db.staff.update({ where: { id: staffId }, data: { photoFileId: null } });
        await deleteFile(old);
    }
    return { photoUrl: null };
};

export const readPhoto = async (staffId: string) => {
    const id = await photoOf(staffId);
    if (!id) throw notFound('No photo');
    return readFile(id);
};

export const documentSchema = z.object({ typeId: z.uuid('choose a document type').optional(), note: z.string().trim().max(200).optional() });

export const addDocument = async (staffId: string, upload: { data: Buffer; originalName: string }, meta: z.infer<typeof documentSchema>) => {
    await photoOf(staffId);
    if (meta.typeId && !(await db.masterValue.findFirst({ where: { id: meta.typeId, master: 'staff_document' } }))) {
        throw badRequest('Choose a document type from the list', [{ field: 'typeId', message: 'is not a document type' }]);
    }
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: 'document', allowed: DOCUMENT_KINDS });
    await db.staffDocument.create({ data: { tenantId: getTenantId()!, staffId, typeId: meta.typeId ?? null, fileId: file.id, note: meta.note || null } });
    await recordAudit({ action: 'document_added', entity: 'staff', entityId: staffId, changes: { file: upload.originalName } });
};

const getDocument = async (staffId: string, documentId: string) => {
    if (!z.uuid().safeParse(documentId).success) throw notFound('Document not found');
    const d = await db.staffDocument.findFirst({ where: { id: documentId, staffId } });
    if (!d) throw notFound('Document not found');
    return d;
};

export const readDocument = async (staffId: string, documentId: string) => readFile((await getDocument(staffId, documentId)).fileId);

export const removeDocument = async (staffId: string, documentId: string) => {
    const d = await getDocument(staffId, documentId);
    await db.staffDocument.delete({ where: { id: d.id } });
    await deleteFile(d.fileId);
    await recordAudit({ action: 'document_removed', entity: 'staff', entityId: staffId });
};
