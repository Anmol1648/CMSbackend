import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import { getSetting } from '../../core/settings';
import { ACADEMIC } from '../academic/academic.settings';
import './cocurricular.settings';

registerPermissions({ key: 'cocurricular', label: 'Co-curricular', order: 53 }, [
    { resource: 'cocurricular', action: 'view', label: 'See houses, clubs, competitions and students’ achievements' },
    { resource: 'house', action: 'manage', label: 'Allocate houses and choose house masters and captains' },
    { resource: 'house', action: 'points', label: 'Give or take house points by hand' },
    { resource: 'club', action: 'manage', label: 'Add and change clubs, and run any club' },
    { resource: 'club', action: 'run', label: 'Run the clubs they are in-charge of (members, requests, meetings, grades)' },
    { resource: 'competition', action: 'manage', label: 'Add competitions, entries and results, and print certificates' },
    { resource: 'achievement', action: 'record', label: 'Record students’ outside achievements (district, state…)' },
    { resource: 'cocurricular', action: 'mine', label: 'See their own (or their children’s) house, clubs and results, and ask to join clubs' },
]);

registerMenuGroup({ key: 'cocurricular', label: 'Co-curricular', order: 22 });
registerMenuItems([
    { key: 'houses', app: false, label: 'Houses', icon: 'shield', href: '/houses', group: 'cocurricular', order: 10, anyPermission: ['cocurricular.view', 'house.manage', 'house.points'], visible: () => getSetting(ACADEMIC.housesEnabled) },
    { key: 'clubs', app: false, label: 'Clubs', icon: 'diversity_3', href: '/clubs', group: 'cocurricular', order: 20, anyPermission: ['cocurricular.view', 'club.manage', 'club.run'] },
    { key: 'competitions', app: false, label: 'Competitions', icon: 'emoji_events', href: '/competitions', group: 'cocurricular', order: 30, anyPermission: ['cocurricular.view', 'competition.manage'] },
    { key: 'achievements', label: 'Achievements', icon: 'military_tech', href: '/achievements', group: 'cocurricular', order: 40, anyPermission: ['cocurricular.view', 'achievement.record'] },
    { key: 'my-activities', label: 'Activities', icon: 'emoji_events', href: '/my-activities', group: 'main', order: 35, permission: 'cocurricular.mine' },
]);

registerMasterUsage('club_category', { label: 'clubs', count: (ids) => db.club.count({ where: { categoryId: { in: ids } } }) });
registerMasterUsage('competition_category', { label: 'competitions and achievements', count: async (ids) => (await db.competition.count({ where: { categoryId: { in: ids } } })) + (await db.achievement.count({ where: { categoryId: { in: ids } } })) });
registerMasterUsage('competition_level', { label: 'competitions and achievements', count: async (ids) => (await db.competition.count({ where: { levelId: { in: ids } } })) + (await db.achievement.count({ where: { levelId: { in: ids } } })) });
registerMasterUsage('house', { label: 'house points or officials', count: async (ids) => (await db.housePoint.count({ where: { houseId: { in: ids } } })) + (await db.houseOfficial.count({ where: { houseId: { in: ids } } })) });
