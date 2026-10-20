import { defineMaster, defineMasterGroup, MasterSeed } from '../masters/masters.registry';

/** Staff lists in the master engine (Configuration → Masters → Staff). */

defineMasterGroup({ key: 'staff', label: 'Staff', order: 8 });

const names = (...list: string[]): MasterSeed[] => list.map((name) => ({ name }));

defineMaster({
    key: 'department',
    label: 'Department',
    plural: 'Departments',
    group: 'staff',
    order: 10,
    code: 'optional',
    ordering: 'name',
    seed: names('Administration', 'Accounts', 'Primary', 'Languages', 'Mathematics', 'Science', 'Social Science', 'Commerce', 'Computer Science', 'Physical Education', 'Arts', 'Library', 'Support staff', 'Transport'),
});

defineMaster({
    key: 'staff_type',
    label: 'Staff type',
    plural: 'Staff types',
    description: 'Teaching staff can be class teachers and subject teachers.',
    group: 'staff',
    order: 20,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'teaching', label: 'Teaches classes', type: 'boolean' }],
    seed: [
        { name: 'Teaching', extra: { teaching: true } },
        { name: 'Non-teaching', extra: { teaching: false } },
    ],
});

defineMaster({
    key: 'designation',
    label: 'Designation',
    plural: 'Designations',
    group: 'staff',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: names(
        'Principal', 'Vice Principal', 'Head Master', 'PGT', 'TGT', 'PRT', 'Librarian', 'Sports Coach', 'Computer Instructor', 'Counsellor', 'Nurse',
        'Administrative Officer', 'Accountant', 'Senior Secretariat Assistant', 'Junior Secretariat Assistant', 'Lab Assistant', 'Driver', 'Sub Staff (MTS)', 'Security Guard', 'Gardener'
    ),
});

defineMaster({
    key: 'employment_type',
    label: 'Employment type',
    plural: 'Employment types',
    group: 'staff',
    order: 40,
    code: 'none',
    ordering: 'manual',
    seed: names('Permanent', 'Contract', 'Guest / part-time', 'Deputation', 'Outsourced'),
});

defineMaster({
    key: 'teaching_post',
    label: 'Teaching post',
    plural: 'Teaching posts',
    description: 'Post / pay level of teachers.',
    group: 'staff',
    order: 50,
    code: 'optional',
    ordering: 'manual',
    seed: [
        { name: 'PGT (Post Graduate Teacher)', code: 'PGT' },
        { name: 'TGT (Trained Graduate Teacher)', code: 'TGT' },
        { name: 'PRT (Primary Teacher)', code: 'PRT' },
        { name: 'Balvatika teacher', code: 'BVT' },
    ],
});

defineMaster({
    key: 'marital_status',
    label: 'Marital status',
    plural: 'Marital statuses',
    group: 'staff',
    order: 60,
    code: 'none',
    ordering: 'manual',
    seed: names('Single', 'Married', 'Widowed', 'Divorced'),
});

defineMaster({
    key: 'staff_document',
    label: 'Staff document type',
    plural: 'Staff document types',
    group: 'staff',
    order: 70,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'required', label: 'Needed on joining', type: 'boolean', help: 'Shown as missing on the staff record until uploaded.' }],
    seed: [
        { name: 'Appointment letter', extra: { required: true } },
        { name: 'Joining report', extra: { required: false } },
        { name: 'Educational certificates', extra: { required: true } },
        { name: 'Experience certificate', extra: { required: false } },
        { name: 'Aadhaar card', extra: { required: false } },
        { name: 'PAN card', extra: { required: false } },
        { name: 'Police verification', extra: { required: false } },
        { name: 'Medical certificate', extra: { required: false } },
    ],
});

defineMaster({
    key: 'relieving_reason',
    label: 'Relieving reason',
    plural: 'Relieving reasons',
    group: 'staff',
    order: 80,
    code: 'none',
    ordering: 'manual',
    seed: names('Transfer', 'Resignation', 'Retirement', 'End of contract', 'Promotion elsewhere', 'Other'),
});
