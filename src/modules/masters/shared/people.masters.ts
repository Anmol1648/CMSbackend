import { defineMaster, defineMasterGroup, MasterSeed } from '../masters.registry';

/** Lists shared by students, parents and staff. Starter options follow UDISE+ where it has a list. */

const names = (...list: string[]): MasterSeed[] => list.map((name) => ({ name }));

// ─── Personal ────────────────────────────────────────────────────────────────

defineMasterGroup({ key: 'personal', label: 'Personal', order: 20 });

defineMaster({
    key: 'gender',
    label: 'Gender',
    plural: 'Genders',
    group: 'personal',
    order: 10,
    code: 'optional',
    ordering: 'manual',
    seed: [
        { name: 'Male', code: 'M' },
        { name: 'Female', code: 'F' },
        { name: 'Transgender', code: 'T' },
    ],
});

defineMaster({
    key: 'blood_group',
    label: 'Blood group',
    plural: 'Blood groups',
    group: 'personal',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: names('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'),
});

defineMaster({
    key: 'religion',
    label: 'Religion',
    plural: 'Religions',
    group: 'personal',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: names('Hindu', 'Muslim', 'Christian', 'Sikh', 'Buddhist', 'Jain', 'Parsi', 'Other'),
});

defineMaster({
    key: 'caste_category',
    label: 'Caste category',
    plural: 'Caste categories',
    description: 'Social category (UDISE+), used for reports and concessions.',
    group: 'personal',
    order: 40,
    code: 'optional',
    ordering: 'manual',
    seed: [
        { name: 'General', code: 'GEN' },
        { name: 'OBC', code: 'OBC' },
        { name: 'SC', code: 'SC' },
        { name: 'ST', code: 'ST' },
        { name: 'EWS', code: 'EWS' },
    ],
});

defineMaster({
    key: 'mother_tongue',
    label: 'Mother tongue',
    plural: 'Mother tongues / languages',
    group: 'personal',
    order: 50,
    code: 'none',
    ordering: 'name',
    seed: names(
        'Assamese', 'Bengali', 'Bhotia', 'Bodo', 'Dogri', 'English', 'Garhwali', 'Gujarati', 'Hindi', 'Jaunsari', 'Kannada', 'Kashmiri', 'Konkani',
        'Kumaoni', 'Maithili', 'Malayalam', 'Manipuri', 'Marathi', 'Nepali', 'Odia', 'Punjabi', 'Sanskrit', 'Santali', 'Sindhi', 'Tamil', 'Telugu',
        'Tibetan', 'Urdu', 'Other'
    ),
});

defineMaster({
    key: 'nationality',
    label: 'Nationality',
    plural: 'Nationalities',
    group: 'personal',
    order: 60,
    code: 'none',
    ordering: 'manual',
    seed: names('Indian', 'Nepalese', 'Bhutanese', 'Tibetan', 'Bangladeshi', 'Sri Lankan', 'Other'),
});

defineMaster({
    key: 'disability',
    label: 'Disability type',
    plural: 'Disability types',
    description: 'The 21 disabilities of the RPwD Act 2016, as UDISE+ asks for children with special needs (CWSN).',
    group: 'personal',
    order: 70,
    code: 'none',
    ordering: 'manual',
    seed: names(
        'Blindness', 'Low vision', 'Leprosy cured', 'Hearing impairment', 'Locomotor disability', 'Dwarfism', 'Intellectual disability',
        'Mental illness', 'Autism spectrum disorder', 'Cerebral palsy', 'Muscular dystrophy', 'Chronic neurological conditions',
        'Specific learning disabilities', 'Multiple sclerosis', 'Speech and language disability', 'Thalassemia', 'Haemophilia',
        'Sickle cell disease', 'Multiple disabilities including deaf-blindness', 'Acid attack victim', "Parkinson's disease"
    ),
});

// ─── Family ──────────────────────────────────────────────────────────────────

defineMasterGroup({ key: 'family', label: 'Family', order: 30 });

defineMaster({
    key: 'relation',
    label: 'Relation',
    plural: 'Relations',
    description: "A parent's or guardian's relation to the student.",
    group: 'family',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: names('Father', 'Mother', 'Guardian', 'Grandfather', 'Grandmother', 'Uncle', 'Aunt', 'Brother', 'Sister', 'Other'),
});

defineMaster({
    key: 'occupation',
    label: 'Occupation',
    plural: 'Occupations',
    group: 'family',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: names(
        'Central government service', 'State government service', 'Defence / paramilitary', 'Private service', 'Business', 'Self-employed',
        'Farmer', 'Labourer', 'Teacher', 'Doctor', 'Engineer', 'Lawyer', 'Homemaker', 'Retired', 'Not working', 'Other'
    ),
});

defineMaster({
    key: 'qualification',
    label: 'Qualification',
    plural: 'Qualifications',
    description: 'Used for parents and staff.',
    group: 'family',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: names(
        'Not literate', 'Primary', 'Middle (8th)', 'High school (10th)', 'Intermediate (12th)', 'ITI', 'Diploma', 'Graduate', 'Post graduate',
        'B.Ed', 'M.Ed', 'M.Phil', 'PhD', 'Other'
    ),
});

defineMaster({
    key: 'income_range',
    label: 'Annual income range',
    plural: 'Annual income ranges',
    group: 'family',
    order: 40,
    code: 'none',
    ordering: 'manual',
    seed: names('Below ₹1 lakh', '₹1–2.5 lakh', '₹2.5–5 lakh', '₹5–10 lakh', 'Above ₹10 lakh'),
});

// ─── Bank ────────────────────────────────────────────────────────────────────

defineMasterGroup({ key: 'finance', label: 'Bank', order: 40 });

/** The first four letters of every IFSC identify the bank, so an account's IFSC can be checked. */
const bank = (name: string, ifscPrefix: string): MasterSeed => ({ name, extra: { ifscPrefix } });

defineMaster({
    key: 'bank',
    label: 'Bank',
    plural: 'Banks',
    description: "Banks for staff salary accounts and fee payments. The branch and IFSC are kept with each person's account.",
    group: 'finance',
    order: 10,
    code: 'none',
    ordering: 'name',
    fields: [
        {
            key: 'ifscPrefix',
            label: 'IFSC prefix',
            type: 'text',
            upperCase: true,
            pattern: /^[A-Z]{4}$/,
            patternMessage: 'must be the 4 letters every IFSC of this bank starts with',
            help: 'The first 4 letters of the IFSC, e.g. SBIN for State Bank of India.',
            example: 'SBIN',
        },
    ],
    seed: [
        bank('State Bank of India', 'SBIN'),
        bank('Punjab National Bank', 'PUNB'),
        bank('Bank of Baroda', 'BARB'),
        bank('Canara Bank', 'CNRB'),
        bank('Union Bank of India', 'UBIN'),
        bank('Bank of India', 'BKID'),
        bank('Indian Bank', 'IDIB'),
        bank('Central Bank of India', 'CBIN'),
        bank('Indian Overseas Bank', 'IOBA'),
        bank('UCO Bank', 'UCBA'),
        bank('Bank of Maharashtra', 'MAHB'),
        bank('Punjab & Sind Bank', 'PSIB'),
        bank('HDFC Bank', 'HDFC'),
        bank('ICICI Bank', 'ICIC'),
        bank('Axis Bank', 'UTIB'),
        bank('Kotak Mahindra Bank', 'KKBK'),
        bank('IndusInd Bank', 'INDB'),
        bank('Yes Bank', 'YESB'),
        bank('IDBI Bank', 'IBKL'),
        bank('Federal Bank', 'FDRL'),
        bank('IDFC First Bank', 'IDFB'),
        bank('India Post Payments Bank', 'IPOS'),
        bank('The Nainital Bank', 'NTBL'),
        { name: 'Uttarakhand Gramin Bank' },
        { name: 'District Co-operative Bank' },
    ],
});
