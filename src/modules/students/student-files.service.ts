import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { deleteFile, FileKind, IMAGE_KINDS, readFile, saveUpload } from '../../core/files';

/** A student's photo and documents (birth certificate, TC…). */

const DOCUMENT_KINDS: FileKind[] = [...IMAGE_KINDS, 'pdf'];

export const setPhoto = async (studentId: string, upload: { data: Buffer; originalName: string }) => {
    const s = await db.student.findUnique({ where: { id: studentId }, select: { photoFileId: true } });
    if (!s) throw notFound('Student not found');
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: 'avatar', allowed: IMAGE_KINDS });
    await db.student.update({ where: { id: studentId }, data: { photoFileId: file.id } });
    if (s.photoFileId) await deleteFile(s.photoFileId);
    await recordAudit({ action: 'update', entity: 'student', entityId: studentId, changes: { photo: [s.photoFileId ? 'photo' : null, 'new photo'] } });
    return { photoUrl: `students/${studentId}/photo?v=${file.id}` };
};

export const removePhoto = async (studentId: string) => {
    const s = await db.student.findUnique({ where: { id: studentId }, select: { photoFileId: true } });
    if (!s) throw notFound('Student not found');
    if (s.photoFileId) {
        await db.student.update({ where: { id: studentId }, data: { photoFileId: null } });
        await deleteFile(s.photoFileId);
        await recordAudit({ action: 'update', entity: 'student', entityId: studentId, changes: { photo: ['photo', null] } });
    }
    return { photoUrl: null };
};

export const readPhoto = async (studentId: string) => {
    const s = await db.student.findUnique({ where: { id: studentId }, select: { photoFileId: true } });
    if (!s?.photoFileId) throw notFound('No photo');
    return readFile(s.photoFileId);
};

export const documentSchema = z.object({ typeId: z.uuid('choose a document type').optional(), note: z.string().trim().max(200).optional() });

export const addDocument = async (studentId: string, upload: { data: Buffer; originalName: string }, meta: z.infer<typeof documentSchema>) => {
    if (!(await db.student.findUnique({ where: { id: studentId }, select: { id: true } }))) throw notFound('Student not found');
    if (meta.typeId && !(await db.masterValue.findFirst({ where: { id: meta.typeId, master: 'student_document' } }))) {
        throw badRequest('Choose a document type from the list', [{ field: 'typeId', message: 'is not a document type' }]);
    }
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: 'document', allowed: DOCUMENT_KINDS });
    const doc = await db.studentDocument.create({ data: { tenantId: getTenantId()!, studentId, typeId: meta.typeId ?? null, fileId: file.id, note: meta.note || null } });
    await recordAudit({ action: 'document_added', entity: 'student', entityId: studentId, changes: { file: upload.originalName } });
    return doc;
};

const getDocument = async (studentId: string, documentId: string) => {
    if (!z.uuid().safeParse(documentId).success) throw notFound('Document not found');
    const d = await db.studentDocument.findFirst({ where: { id: documentId, studentId } });
    if (!d) throw notFound('Document not found');
    return d;
};

export const readDocument = async (studentId: string, documentId: string) => readFile((await getDocument(studentId, documentId)).fileId);

export const removeDocument = async (studentId: string, documentId: string) => {
    const d = await getDocument(studentId, documentId);
    await db.studentDocument.delete({ where: { id: d.id } });
    await deleteFile(d.fileId);
    await recordAudit({ action: 'document_removed', entity: 'student', entityId: studentId });
    return { id: documentId, deleted: true };
};
