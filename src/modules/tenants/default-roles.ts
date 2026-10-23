import type { UserKind } from '@prisma/client';

/**
 * Roles every new school starts with. Schools can rename, edit, clone or remove them later
 * (except Super Admin). Their permission sets are filled in by the permission registry (F4).
 */
export interface DefaultRole {
    slug: string;
    name: string;
    description: string;
    isSystem?: boolean;
    defaultFor?: UserKind;
}

export const SUPER_ADMIN_SLUG = 'super-admin';

export const DEFAULT_ROLES: DefaultRole[] = [
    { slug: SUPER_ADMIN_SLUG, name: 'Super Admin', description: 'Full access to everything. Cannot be deleted.', isSystem: true },
    { slug: 'school-admin', name: 'School Admin', description: 'Runs day-to-day administration and setup.' },
    { slug: 'principal', name: 'Principal', description: 'Oversees academics, staff and reports.' },
    { slug: 'teacher', name: 'Teacher', description: 'Teaches subjects; sees assigned classes.', defaultFor: 'staff' },
    { slug: 'class-teacher', name: 'Class Teacher', description: 'Looks after one or more sections (attendance, students).' },
    { slug: 'office-staff', name: 'Office Staff', description: 'Admissions, records and front office.' },
    { slug: 'accountant', name: 'Accountant', description: 'Fees, payments and accounts.' },
    { slug: 'librarian', name: 'Librarian', description: 'Runs the library: books, the issue and return counter, fines.' },
    { slug: 'driver', name: 'Driver / Bus Helper', description: 'Runs the trips of their bus (sends its position, marks students on and off).' },
    { slug: 'student', name: 'Student', description: 'Own timetable, attendance and results.', defaultFor: 'student' },
    { slug: 'guardian', name: 'Guardian', description: "Their children's records.", defaultFor: 'guardian' },
];
