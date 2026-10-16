import { defineMaster, defineMasterGroup, MasterSeed } from '../masters.registry';
import { INDIA_DISTRICTS } from './india-districts';

/** Addresses of students, parents, staff and the school: country → state → district → city / town. */

defineMasterGroup({ key: 'location', label: 'Location', order: 10 });

const INDIA = 'India';

/** Vehicle-registration style codes (TG for Telangana since 2024). */
const STATE_CODES: Record<string, string> = {
    'Andaman and Nicobar Islands': 'AN',
    'Andhra Pradesh': 'AP',
    'Arunachal Pradesh': 'AR',
    Assam: 'AS',
    Bihar: 'BR',
    Chandigarh: 'CH',
    Chhattisgarh: 'CG',
    'Dadra and Nagar Haveli and Daman and Diu': 'DD',
    Delhi: 'DL',
    Goa: 'GA',
    Gujarat: 'GJ',
    Haryana: 'HR',
    'Himachal Pradesh': 'HP',
    'Jammu and Kashmir': 'JK',
    Jharkhand: 'JH',
    Karnataka: 'KA',
    Kerala: 'KL',
    Ladakh: 'LA',
    Lakshadweep: 'LD',
    'Madhya Pradesh': 'MP',
    Maharashtra: 'MH',
    Manipur: 'MN',
    Meghalaya: 'ML',
    Mizoram: 'MZ',
    Nagaland: 'NL',
    Odisha: 'OD',
    Puducherry: 'PY',
    Punjab: 'PB',
    Rajasthan: 'RJ',
    Sikkim: 'SK',
    'Tamil Nadu': 'TN',
    Telangana: 'TG',
    Tripura: 'TR',
    'Uttar Pradesh': 'UP',
    Uttarakhand: 'UK',
    'West Bengal': 'WB',
};

/** Towns of Uttarakhand by district (the school's state); others are added or imported as needed. */
const UTTARAKHAND_TOWNS: Record<string, string[]> = {
    Almora: ['Almora', 'Bhikiyasain', 'Chaukhutia', 'Dwarahat', 'Jageshwar', 'Ranikhet', 'Someshwar'],
    Bageshwar: ['Bageshwar', 'Garur', 'Kanda', 'Kapkot'],
    Chamoli: ['Badrinath', 'Chamoli', 'Dewal', 'Gairsain', 'Gauchar', 'Gopeshwar', 'Joshimath (Jyotirmath)', 'Karnaprayag', 'Nandprayag', 'Pokhari', 'Tharali'],
    Champawat: ['Banbasa', 'Champawat', 'Lohaghat', 'Pati', 'Tanakpur'],
    Dehradun: ['Chakrata', 'Dehradun', 'Doiwala', 'Herbertpur', 'Kalsi', 'Mussoorie', 'Raiwala', 'Rishikesh', 'Sahaspur', 'Selaqui', 'Vikasnagar'],
    Haridwar: ['Bhagwanpur', 'Haridwar', 'Jhabrera', 'Laksar', 'Landhaura', 'Manglaur', 'Roorkee'],
    Nainital: ['Betalghat', 'Bhimtal', 'Bhowali', 'Haldwani', 'Kaladhungi', 'Kathgodam', 'Lalkuan', 'Mukteshwar', 'Nainital', 'Ramnagar'],
    'Pauri Garhwal': ['Dugadda', 'Kotdwar', 'Lansdowne', 'Pauri', 'Satpuli', 'Srinagar', 'Thalisain'],
    Pithoragarh: ['Berinag', 'Dharchula', 'Didihat', 'Gangolihat', 'Munsiyari', 'Pithoragarh'],
    Rudraprayag: ['Agastyamuni', 'Guptkashi', 'Kedarnath', 'Rudraprayag', 'Ukhimath'],
    'Tehri Garhwal': ['Chamba', 'Devprayag', 'Ghansali', 'Kirtinagar', 'Muni Ki Reti', 'Narendra Nagar', 'New Tehri'],
    'Udham Singh Nagar': ['Bajpur', 'Dineshpur', 'Gadarpur', 'Jaspur', 'Kashipur', 'Khatima', 'Kichha', 'Nanakmatta', 'Rudrapur', 'Sitarganj'],
    Uttarkashi: ['Barkot', 'Bhatwari', 'Chinyalisaur', 'Mori', 'Naugaon', 'Purola', 'Uttarkashi'],
};

export const COUNTRY = defineMaster({
    key: 'country',
    label: 'Country',
    plural: 'Countries',
    group: 'location',
    order: 10,
    code: 'optional',
    ordering: 'name',
    seed: [{ name: INDIA, code: 'IN' }],
});

export const STATE = defineMaster({
    key: 'state',
    label: 'State',
    plural: 'States / UTs',
    description: 'States and union territories.',
    group: 'location',
    order: 20,
    parent: 'country',
    code: 'optional',
    ordering: 'name',
    seed: () => Object.keys(INDIA_DISTRICTS).map((name): MasterSeed => ({ name, code: STATE_CODES[name], parent: [INDIA] })),
});

export const DISTRICT = defineMaster({
    key: 'district',
    label: 'District',
    plural: 'Districts',
    group: 'location',
    order: 30,
    parent: 'state',
    code: 'optional',
    ordering: 'name',
    seed: () => Object.entries(INDIA_DISTRICTS).flatMap(([state, districts]) => districts.map((name): MasterSeed => ({ name, parent: [INDIA, state] }))),
});

export const CITY = defineMaster({
    key: 'city',
    label: 'City / town',
    plural: 'Cities / towns',
    description: 'Cities, towns and villages. Starter list: towns of Uttarakhand; add or import others.',
    group: 'location',
    order: 40,
    parent: 'district',
    code: 'none',
    ordering: 'name',
    seed: () =>
        Object.entries(UTTARAKHAND_TOWNS).flatMap(([district, towns]) => towns.map((name): MasterSeed => ({ name, parent: [INDIA, 'Uttarakhand', district] }))),
});
