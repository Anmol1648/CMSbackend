import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/** System Settings → Attendance, and the list of attendance statuses (Configuration → Masters). */

const G = 'Attendance';
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 08:00');
const WEEKDAYS = [
    { value: '1', label: 'Monday' },
    { value: '2', label: 'Tuesday' },
    { value: '3', label: 'Wednesday' },
    { value: '4', label: 'Thursday' },
    { value: '5', label: 'Friday' },
    { value: '6', label: 'Saturday' },
    { value: '7', label: 'Sunday' },
];

export const ATTENDANCE = {
    mode: defineSetting<string>({
        key: 'attendance.student_mode',
        group: G,
        label: 'How often student attendance is taken',
        help: 'Every period needs a published timetable: each period is marked by its teacher (or that day’s substitute); the class teacher can mark any period of their section.',
        type: 'select',
        default: 'daily',
        schema: z.enum(['daily', 'twice', 'period']),
        options: [
            { value: 'daily', label: 'Once a day (class teacher)' },
            { value: 'twice', label: 'Twice a day: morning and afternoon (class teacher)' },
            { value: 'period', label: 'Every period (the teacher of the period, from the timetable)' },
        ],
    }),
    defaultStatus: defineSetting<string>({
        key: 'attendance.default_status',
        group: G,
        label: 'Every student starts as (code of a status)',
        help: 'The register opens with everyone set to this, so teachers only change the few absent. Codes are in Masters → Attendance statuses (P = Present).',
        type: 'text',
        default: 'P',
        schema: z.string().trim().min(1).max(10),
    }),
    subjectTeachersMark: defineSetting<boolean>({
        key: 'attendance.subject_teachers_mark',
        group: G,
        label: 'Subject teachers of a section may also mark its attendance',
        help: 'Off: only the class teacher (and people allowed to mark any section).',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    subjectTeachersSee: defineSetting<boolean>({
        key: 'attendance.subject_teachers_see',
        group: G,
        label: 'Teachers also see the attendance of the sections they teach a subject in',
        help: 'Off: a teacher sees only their own class (the section they are class teacher of).',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    backDays: defineSetting<number>({
        key: 'attendance.back_days',
        group: G,
        label: 'Teachers may mark or change attendance this many days back',
        help: '0 = today only. People allowed to mark any section are not limited.',
        type: 'number',
        default: 2,
        schema: z.number().int().min(0).max(60),
    }),
    editHours: defineSetting<number>({
        key: 'attendance.edit_hours',
        group: G,
        label: 'A register can be changed for this many hours after it is first saved (0 = no limit)',
        help: 'After that only people allowed to mark any section can change it.',
        type: 'number',
        default: 0,
        schema: z.number().int().min(0).max(720),
    }),
    weeklyOff: defineSetting<string[]>({
        key: 'attendance.weekly_off',
        group: G,
        label: 'Weekly off days',
        type: 'multiselect',
        default: ['7'],
        schema: z.array(z.enum(['1', '2', '3', '4', '5', '6', '7'])).max(6),
        options: WEEKDAYS,
    }),
    saturdays: defineSetting<string>({
        key: 'attendance.saturday_rule',
        group: G,
        label: 'Saturdays off',
        help: 'Besides the weekly off days above.',
        type: 'select',
        default: 'none',
        schema: z.enum(['none', '2nd_4th', '1st_3rd', 'all_but_2nd']),
        options: [
            { value: 'none', label: 'No extra Saturdays off' },
            { value: '2nd_4th', label: '2nd and 4th Saturday off' },
            { value: '1st_3rd', label: '1st and 3rd Saturday off' },
            { value: 'all_but_2nd', label: 'Only the 2nd Saturday off' },
        ],
    }),
    minPercent: defineSetting<number>({
        key: 'attendance.min_percent',
        group: G,
        label: 'Minimum attendance % (students below it are highlighted)',
        type: 'number',
        default: 75,
        schema: z.number().min(0).max(100),
    }),
    leaveOnline: defineSetting<boolean>({
        key: 'attendance.leave_online',
        group: G,
        label: 'Parents and students can ask for leave in the app (My Attendance)',
        help: 'The class teacher (or the office) approves it; approved leave fills the register by itself.',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    leaveBackDays: defineSetting<number>({
        key: 'attendance.leave_back_days',
        group: G,
        label: 'Leave can be asked for up to this many days after it (e.g. after being ill)',
        type: 'number',
        default: 7,
        schema: z.number().int().min(0).max(60),
    }),
    staffRequestDays: defineSetting<number>({
        key: 'attendance.staff_request_days',
        group: G,
        label: 'Staff can ask to correct a day up to this many days back',
        type: 'number',
        default: 7,
        schema: z.number().int().min(0).max(60),
    }),
    staffCheckIn: defineSetting<boolean>({
        key: 'attendance.staff_check_in',
        group: G,
        label: 'Staff check in and check out themselves (My Attendance)',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    staffStart: defineSetting<string>({
        key: 'attendance.staff_start',
        group: G,
        label: 'Staff day starts at',
        type: 'text',
        default: '08:00',
        schema: time,
    }),
    staffEnd: defineSetting<string>({
        key: 'attendance.staff_end',
        group: G,
        label: 'Staff day ends at',
        help: 'Checking out before this is shown as leaving early.',
        type: 'text',
        default: '14:30',
        schema: time,
    }),
    staffGrace: defineSetting<number>({
        key: 'attendance.staff_grace_minutes',
        group: G,
        label: 'Minutes after the start a check-in still counts as on time',
        type: 'number',
        default: 10,
        schema: z.number().int().min(0).max(240),
    }),
    staffHalfDay: defineSetting<number>({
        key: 'attendance.staff_half_day_minutes',
        group: G,
        label: 'A check-in this many minutes after the start counts as a half day (0 = never)',
        type: 'number',
        default: 120,
        schema: z.number().int().min(0).max(600),
    }),
    staffPhoto: defineSetting<boolean>({
        key: 'attendance.staff_photo',
        group: G,
        label: 'Staff take a selfie (live camera) every time they check in and out',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    staffFace: defineSetting<boolean>({
        key: 'attendance.staff_face',
        group: G,
        label: 'Check the selfie against the person’s enrolled face',
        help: 'Faces are enrolled in Attendance → Staff Faces. A selfie that doesn’t match (or no enrolled face) sends the check-in for approval.',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    staffFaceStrictness: defineSetting<string>({
        key: 'attendance.staff_face_strictness',
        group: G,
        label: 'How closely the face must match',
        type: 'select',
        default: 'normal',
        schema: z.enum(['relaxed', 'normal', 'strict']),
        options: [
            { value: 'relaxed', label: 'Relaxed (fewer false alarms)' },
            { value: 'normal', label: 'Normal' },
            { value: 'strict', label: 'Strict (more go for approval)' },
        ],
    }),
    staffLiveness: defineSetting<boolean>({
        key: 'attendance.staff_liveness',
        group: G,
        label: 'Liveness: staff turn their head for a second photo (a printed photo can’t)',
        help: 'Two photos at check-in: looking straight, then head turned. Not turned (or not the same person) sends the check-in for approval.',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    staffPhoneLock: defineSetting<string>({
        key: 'attendance.staff_phone_lock',
        group: G,
        label: 'Staff check in only from their own phone',
        help: 'The first phone (browser) a person checks in from becomes theirs; the office can reset it (Staff Faces & Phones).',
        type: 'select',
        default: 'off',
        schema: z.enum(['off', 'pending', 'block']),
        options: [
            { value: 'off', label: 'Off: any phone or computer' },
            { value: 'pending', label: 'Another phone: allowed, waits for the office’s approval' },
            { value: 'block', label: 'Another phone: not allowed' },
        ],
    }),
    staffSelfEnrol: defineSetting<boolean>({
        key: 'attendance.staff_self_enrol',
        group: G,
        label: 'Staff can enrol their own face (the office approves it)',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    staffLocation: defineSetting<boolean>({
        key: 'attendance.staff_location',
        group: G,
        label: 'Check where staff are when they check in (school locations in Attendance → Check-in Locations)',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    staffAccuracy: defineSetting<number>({
        key: 'attendance.staff_location_accuracy',
        group: G,
        label: 'A phone location less accurate than this many metres is not trusted',
        type: 'number',
        default: 150,
        schema: z.number().int().min(10).max(5000),
    }),
    staffOutside: defineSetting<string>({
        key: 'attendance.staff_outside',
        group: G,
        label: 'Checking in outside the school (or face not matching)',
        type: 'select',
        default: 'pending',
        schema: z.enum(['pending', 'block']),
        options: [
            { value: 'pending', label: 'Allowed, but it waits for the office’s approval' },
            { value: 'block', label: 'Not allowed (outside the school); a face mismatch still waits for approval' },
        ],
    }),
    staffPhotoDays: defineSetting<number>({
        key: 'attendance.staff_photo_days',
        group: G,
        label: 'Keep check-in selfies for this many days',
        type: 'number',
        default: 90,
        schema: z.number().int().min(7).max(730),
    }),
    staffNetworks: defineSetting<string>({
        key: 'attendance.staff_networks',
        group: G,
        label: 'Check-in only from these internet addresses (empty = from anywhere)',
        help: 'The school’s Wi-Fi public IP, e.g. 117.205.10.4. Several separated by commas; end with a dot for a range (e.g. 192.168.1.).',
        type: 'text',
        default: '',
        schema: z.string().trim().max(500),
    }),
};

defineMasterGroup({ key: 'attendance', label: 'Attendance', order: 14 });
defineMaster({
    key: 'attendance_status',
    label: 'Attendance status',
    plural: 'Attendance statuses',
    description: 'What a student or staff member can be marked as. “Counts as present” is used for the attendance %: 1 = present, 0.5 = half, 0 = absent. Approved leave can be left out of the % entirely.',
    group: 'attendance',
    order: 10,
    code: 'required',
    ordering: 'manual',
    fields: [
        { key: 'present', label: 'Counts as present (1, 0.5 or 0)', type: 'number', required: true, example: '1' },
        { key: 'excused', label: 'Left out of the attendance % (approved leave)', type: 'boolean' },
    ],
    seed: [
        { name: 'Present', code: 'P', extra: { present: 1, excused: false } },
        { name: 'Absent', code: 'A', extra: { present: 0, excused: false } },
        { name: 'Late', code: 'LT', extra: { present: 1, excused: false } },
        { name: 'Half day', code: 'HD', extra: { present: 0.5, excused: false } },
        { name: 'Leave', code: 'LV', extra: { present: 0, excused: true } },
        { name: 'Medical leave', code: 'ML', extra: { present: 0, excused: true } },
    ],
});

/**
 * Kinds of student leave a parent can ask for. Each fills the register with an attendance status
 * (by its code: LV, ML…). Leave requests keep the CODE: rename freely, don't change a code once used.
 */
export const STUDENT_LEAVE_TYPE_SEED = [
    { name: 'Leave', code: 'leave', extra: { attendance_status: 'LV' } },
    { name: 'Medical (illness)', code: 'medical', extra: { attendance_status: 'ML' } },
];
defineMaster({
    key: 'student_leave_type',
    label: 'Student leave type',
    plural: 'Student leave types',
    description: 'What parents can ask leave for (e.g. Leave, Medical, Sports event, Family function). Each fills the register with an attendance status, by its code (Masters → Attendance statuses: LV, ML…).',
    group: 'attendance',
    order: 20,
    code: 'required',
    ordering: 'manual',
    fields: [{ key: 'attendance_status', label: 'Attendance status it gives (code, e.g. LV)', type: 'text', required: true, upperCase: true, max: 10, example: 'LV' }],
    seed: STUDENT_LEAVE_TYPE_SEED,
});

/** India time: the school's day. */
const IST_MS = 5.5 * 3600_000;
export const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
/** Minutes since midnight in India for a moment (now by default). */
export const minutesIST = (at = new Date()) => {
    const d = new Date(at.getTime() + IST_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** "2026-10-21" + "08:05" (India) → the moment. */
export const atIST = (date: string, hhmm: string) => new Date(new Date(`${date}T${hhmm}:00.000Z`).getTime() - IST_MS);
export const dayDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
export const isoOf = (d: Date) => d.toISOString().slice(0, 10);
