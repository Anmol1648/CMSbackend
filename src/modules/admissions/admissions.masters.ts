import { defineMaster, defineMasterGroup, MasterSeed } from '../masters/masters.registry';
import { TEST_RESULT_SEED } from './test-results';

/** Admission lists in the master engine (Configuration → Masters → Admissions). */

defineMasterGroup({ key: 'admissions', label: 'Admissions', order: 6 });

const names = (...list: string[]): MasterSeed[] => list.map((name) => ({ name }));

defineMaster({
    key: 'enquiry_source',
    label: 'Enquiry source',
    plural: 'Enquiry sources',
    description: 'How the family heard of the school (for the conversion report).',
    group: 'admissions',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'online', label: 'Given to website enquiries', type: 'boolean', help: 'Enquiries from the public form get this source.' }],
    seed: [
        ...names('Walk-in', 'Phone call'),
        { name: 'Website', extra: { online: true } },
        ...names('Reference / word of mouth', 'Newspaper', 'Social media', 'Hoarding / banner', 'School event', 'Sibling studying here', 'Other'),
    ],
});

/**
 * The stages of an enquiry, in order. "Won" = admitted (set automatically on conversion); "Lost" =
 * closed without admission (asks for a reason). Every other stage is open and is followed up.
 */
defineMaster({
    key: 'enquiry_stage',
    label: 'Enquiry stage',
    plural: 'Enquiry stages',
    description: 'The steps from first enquiry to admission. Mark one as Won (admitted) and one as Lost.',
    group: 'admissions',
    order: 20,
    code: 'none',
    ordering: 'manual',
    fields: [
        { key: 'won', label: 'Won (admitted)', type: 'boolean' },
        { key: 'lost', label: 'Lost (closed)', type: 'boolean' },
    ],
    seed: [
        { name: 'New enquiry', extra: { won: false, lost: false } },
        { name: 'Contacted', extra: { won: false, lost: false } },
        { name: 'Visit scheduled', extra: { won: false, lost: false } },
        { name: 'Registered', extra: { won: false, lost: false } },
        { name: 'Test / interaction', extra: { won: false, lost: false } },
        { name: 'Selected', extra: { won: false, lost: false } },
        { name: 'Waiting list', extra: { won: false, lost: false } },
        { name: 'Admitted', extra: { won: true, lost: false } },
        { name: 'Lost', extra: { won: false, lost: true } },
    ],
});

defineMaster({
    key: 'follow_up_outcome',
    label: 'Follow-up outcome',
    plural: 'Follow-up outcomes',
    group: 'admissions',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: names('Interested', 'Call back later', 'Visit scheduled', 'Documents pending', 'Fee discussion', 'Not reachable', 'Not interested', 'Wrong number'),
});

defineMaster({
    key: 'enquiry_lost_reason',
    label: 'Lost reason',
    plural: 'Lost reasons',
    group: 'admissions',
    order: 40,
    code: 'none',
    ordering: 'manual',
    seed: names('Fees too high', 'Distance / transport', 'Chose another school', 'No seat available', 'Not eligible (age / marks)', 'Parent transferred', 'No response', 'Other'),
});

defineMaster({
    key: 'admission_test_result',
    label: 'Admission test result',
    plural: 'Admission test results',
    description: 'The result of the admission test / interaction (e.g. Passed, Waitlisted, Re-test). Enquiries keep the code: rename freely, but don’t change a code once used. “not_needed” is the starting value of every enquiry.',
    group: 'admissions',
    order: 60,
    code: 'required',
    ordering: 'manual',
    seed: TEST_RESULT_SEED,
});
