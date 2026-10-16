import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/** Student lists in the master engine (Configuration → Masters → Students). */

defineMasterGroup({ key: 'students', label: 'Students', order: 7 });

defineMaster({
    key: 'admission_type',
    label: 'Admission type',
    plural: 'Admission types',
    group: 'students',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'New admission' }, { name: 'Transfer (from another school)' }, { name: 'Re-admission' }],
});

defineMaster({
    key: 'student_category',
    label: 'Admission category',
    plural: 'Admission categories',
    description: 'Priority categories used at admission (KV categories I–VI), or your own.',
    group: 'students',
    order: 20,
    code: 'optional',
    ordering: 'manual',
    seed: [
        { name: 'Category I – Central Govt. employees (transferable)', code: 'I' },
        { name: 'Category II – Central Govt. autonomous / PSU', code: 'II' },
        { name: 'Category III – State Govt. employees', code: 'III' },
        { name: 'Category IV – State autonomous / PSU', code: 'IV' },
        { name: 'Category V – Others', code: 'V' },
        { name: 'Category VI – Project sector', code: 'VI' },
    ],
});

defineMaster({
    key: 'previous_board',
    label: 'Previous board',
    plural: 'Previous boards',
    group: 'students',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'CBSE' }, { name: 'ICSE / ISC' }, { name: 'Uttarakhand Board (UBSE)' }, { name: 'Other state board' }, { name: 'NIOS' }, { name: 'Other' }],
});

defineMaster({
    key: 'student_document',
    label: 'Student document type',
    plural: 'Student document types',
    group: 'students',
    order: 40,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'required', label: 'Needed at admission', type: 'boolean', help: 'Shown as missing on the student until it is uploaded.' }],
    seed: [
        { name: 'Birth certificate', extra: { required: true } },
        { name: 'Aadhaar card', extra: { required: false } },
        { name: 'Transfer certificate', extra: { required: false } },
        { name: 'Previous marksheet', extra: { required: false } },
        { name: 'Caste certificate', extra: { required: false } },
        { name: 'Income certificate', extra: { required: false } },
        { name: 'Disability certificate', extra: { required: false } },
        { name: 'Parent service certificate', extra: { required: false } },
    ],
});

defineMaster({
    key: 'leaving_reason',
    label: 'Leaving reason',
    plural: 'Leaving reasons',
    group: 'students',
    order: 50,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: "Parent's transfer" }, { name: 'Moved to another school' }, { name: 'Passed out' }, { name: 'Shifted residence' }, { name: 'Long absence' }, { name: 'Other' }],
});
