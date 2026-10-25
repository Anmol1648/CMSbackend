import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Co-curricular (house points per result, club limits, house allocation) and its
 * lists (Masters → Co-curricular): club categories, competition categories and levels. Houses
 * themselves are Masters → Houses (switched on in System Settings → Academic). Who manages houses,
 * runs clubs or enters results is in Roles & Permissions (house.*, club.*, competition.*).
 */

const G = 'Co-curricular';
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });

export const COCURRICULAR = {
    pointsFirst: num('cocurricular.points_first', 'House points for 1st place', 10, 0, 1000),
    pointsSecond: num('cocurricular.points_second', 'House points for 2nd place', 7, 0, 1000),
    pointsThird: num('cocurricular.points_third', 'House points for 3rd place', 5, 0, 1000),
    pointsTakingPart: num('cocurricular.points_participation', 'House points for taking part (each entry without a place)', 1, 0, 1000, '0 = none.'),
    teamTimes: num('cocurricular.team_multiplier', 'Team events give this many times the points', 2, 1, 10, 'A relay or a group dance counts more than one student’s race.'),
    achievementPoints: bool('cocurricular.achievement_points', 'Outside achievements (district, state…) can give house points too', true),
    maxClubs: num('cocurricular.max_clubs', 'Clubs one student may be in at a time (0 = no limit)', 2, 0, 20),
    siblingsTogether: bool('cocurricular.siblings_together', 'Automatic house allocation puts brothers and sisters in the same house', true),
    balanceGender: bool('cocurricular.balance_gender', 'Automatic house allocation balances boys and girls in each house', true),
    resultsToParents: bool('cocurricular.results_alert', 'Tell students and parents when results they are in come out', true),
};

/** Points for a result (position null = took part), before the team multiplier. */
export const POSITIONS = [1, 2, 3] as const;

defineMasterGroup({ key: 'cocurricular', label: 'Co-curricular', order: 24 });

defineMaster({
    key: 'club_category',
    label: 'Club category',
    plural: 'Club categories',
    group: 'cocurricular',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: ['Science & technology', 'Arts & music', 'Literary', 'Sports & fitness', 'Social service', 'Uniformed (NCC, Scouts & Guides)', 'Environment', 'Other'].map((name) => ({ name })),
});

defineMaster({
    key: 'competition_category',
    label: 'Competition category',
    plural: 'Competition categories',
    group: 'cocurricular',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: ['Sports', 'Cultural (dance, music, drama)', 'Literary (debate, essay, recitation)', 'Academic (quiz, olympiad, science fair)', 'Art & craft', 'Other'].map((name) => ({ name })),
});

defineMaster({
    key: 'competition_level',
    label: 'Competition level',
    plural: 'Competition levels',
    description: 'Where a competition is held. Levels in the school can give house points; outside ones are achievements.',
    group: 'cocurricular',
    order: 30,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'inSchool', label: 'Held in the school', type: 'boolean' }],
    seed: [
        { name: 'Class level', extra: { inSchool: true } },
        { name: 'Inter-house', extra: { inSchool: true } },
        { name: 'Inter-school', extra: { inSchool: false } },
        { name: 'Zonal / district', extra: { inSchool: false } },
        { name: 'Regional / state', extra: { inSchool: false } },
        { name: 'National', extra: { inSchool: false } },
        { name: 'International', extra: { inSchool: false } },
    ],
});
