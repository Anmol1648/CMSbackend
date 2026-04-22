/**
 * Widget Seeds — Default widget definitions for the dashboard.
 * All queries target tables that exist in the auth-service database.
 *
 * Usage: npx tsx src/utils/widgetSeeds.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const widgetSeeds = [
    // ─── Stat Cards ──────────────────────────────────────────────────────────────
    {
        title: 'Total Users',
        widget_type: 'stat',
        sub_type: 'stat_card',
        display_name: 'Total Users',
        query: `SELECT COUNT(*)::int as value FROM users WHERE is_active = true`,
        config: { label: 'Total Users', prefix: '', suffix: '' },
        customization: { icon: 'groups', color: 'bg-primary-fixed', trend_query: null },
        range_enabled: false,
    },
    {
        title: 'Active Roles',
        widget_type: 'stat',
        sub_type: 'stat_card',
        display_name: 'Active Roles',
        query: `SELECT COUNT(*)::int as value FROM roles WHERE deleted_at IS NULL`,
        config: { label: 'Active Roles', prefix: '', suffix: '' },
        customization: { icon: 'shield_person', color: 'bg-tertiary-fixed', trend_query: null },
        range_enabled: false,
    },
    {
        title: 'Permissions Defined',
        widget_type: 'stat',
        sub_type: 'stat_card',
        display_name: 'Permissions Defined',
        query: `SELECT COUNT(*)::int as value FROM permissions`,
        config: { label: 'Permissions Defined', prefix: '', suffix: '' },
        customization: { icon: 'lock', color: 'bg-secondary-fixed', trend_query: null },
        range_enabled: false,
    },
    {
        title: 'MFA Adoption Rate',
        widget_type: 'stat',
        sub_type: 'stat_card',
        display_name: 'MFA Adoption',
        query: `SELECT COALESCE(ROUND(COUNT(*) FILTER (WHERE mfa_enabled = true) * 100.0 / NULLIF(COUNT(*), 0), 1), 0) as value FROM users`,
        config: { label: 'MFA Adoption Rate', prefix: '', suffix: '%' },
        customization: { icon: 'security', color: 'bg-error-container', trend_query: null },
        range_enabled: false,
    },

    // ─── Chart Widgets ───────────────────────────────────────────────────────────
    {
        title: 'Users by Role',
        widget_type: 'chart',
        sub_type: 'bar',
        display_name: 'Users by Role',
        query: `SELECT r.name as label, COUNT(ur.id)::int as value FROM roles r LEFT JOIN user_roles ur ON r.id = ur.role_id WHERE r.deleted_at IS NULL GROUP BY r.name ORDER BY value DESC LIMIT 10`,
        config: {
            xKey: 'label',
            yKey: 'value',
            colors: ['#6366f1', '#818cf8', '#a5b4fc'],
            xAxisLabel: 'Role',
            yAxisLabel: 'Users',
        },
        customization: { icon: 'bar_chart' },
        range_enabled: false,
    },
    {
        title: 'User Registration Trend',
        widget_type: 'chart',
        sub_type: 'line',
        display_name: 'Registration Trend',
        query: `SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'Mon YYYY') as label, COUNT(*)::int as value FROM users GROUP BY DATE_TRUNC('month', "createdAt") ORDER BY DATE_TRUNC('month', "createdAt") ASC`,
        config: {
            xKey: 'label',
            yKey: 'value',
            colors: ['#10b981'],
            xAxisLabel: 'Month',
            yAxisLabel: 'New Users',
            smooth: true,
        },
        customization: { icon: 'trending_up' },
        range_enabled: true,
    },
    {
        title: 'Permission Coverage',
        widget_type: 'chart',
        sub_type: 'pie',
        display_name: 'Permission Coverage',
        query: `SELECT p.resource as label, COUNT(rp.id)::int as value FROM permissions p LEFT JOIN role_permissions rp ON p.id = rp.permission_id GROUP BY p.resource ORDER BY value DESC`,
        config: {
            nameKey: 'label',
            valueKey: 'value',
            colors: ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899'],
        },
        customization: { icon: 'pie_chart' },
        range_enabled: false,
    },
    {
        title: 'Menu Module Distribution',
        widget_type: 'chart',
        sub_type: 'donut',
        display_name: 'Menu Modules',
        query: `SELECT COALESCE(module, 'Uncategorized') as label, COUNT(*)::int as value FROM menus GROUP BY module ORDER BY value DESC`,
        config: {
            nameKey: 'label',
            valueKey: 'value',
            colors: ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444'],
            innerRadius: 60,
        },
        customization: { icon: 'donut_large' },
        range_enabled: false,
    },

    // ─── Table Widgets ───────────────────────────────────────────────────────────
    {
        title: 'Recent Audit Activity',
        widget_type: 'table',
        sub_type: 'audit_log',
        display_name: 'Audit Log',
        query: `SELECT table_name as "Table", operation as "Operation", user_id as "User ID", TO_CHAR(timestamp, 'DD Mon YYYY HH24:MI') as "Timestamp" FROM audit_logs ORDER BY timestamp DESC LIMIT 50`,
        config: {
            columns: ['Table', 'Operation', 'User ID', 'Timestamp'],
            highlightColumn: 'Operation',
        },
        customization: { icon: 'history' },
        range_enabled: true,
    },
    {
        title: 'User Directory',
        widget_type: 'table',
        sub_type: 'user_list',
        display_name: 'User Directory',
        query: `SELECT u.email as "Email", u.first_name as "First Name", u.last_name as "Last Name", CASE WHEN u.is_active THEN 'Active' ELSE 'Inactive' END as "Status", CASE WHEN u.mfa_enabled THEN 'Enabled' ELSE 'Disabled' END as "MFA", TO_CHAR(u."createdAt", 'DD Mon YYYY') as "Joined" FROM users u ORDER BY u."createdAt" DESC LIMIT 50`,
        config: {
            columns: ['Email', 'First Name', 'Last Name', 'Status', 'MFA', 'Joined'],
            highlightColumn: 'Status',
        },
        customization: { icon: 'people' },
        range_enabled: false,
    },

    // ─── Feed Widget ─────────────────────────────────────────────────────────────
    {
        title: 'System Activity Feed',
        widget_type: 'feed',
        sub_type: 'notification',
        display_name: 'Activity Feed',
        query: `SELECT operation as title, table_name as category, record_id as description, TO_CHAR(timestamp, 'DD Mon YYYY HH24:MI') as timestamp FROM audit_logs ORDER BY timestamp DESC LIMIT 20`,
        config: {
            titleKey: 'title',
            categoryKey: 'category',
            descriptionKey: 'description',
            timestampKey: 'timestamp',
        },
        customization: { icon: 'notifications' },
        range_enabled: false,
    },
];

async function seed() {
    console.log('🌱 Seeding widgets...');

    for (const widget of widgetSeeds) {
        const existing = await prisma.widget.findFirst({
            where: { title: widget.title }
        });

        if (!existing) {
            await prisma.widget.create({
                data: {
                    ...widget,
                    is_active: true,
                }
            });
            console.log(`  ✅ Created widget: ${widget.title}`);
        } else {
            console.log(`  ⏭️  Widget already exists: ${widget.title}`);
        }
    }

    console.log('✨ Widget seeding complete!');
}

seed()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
