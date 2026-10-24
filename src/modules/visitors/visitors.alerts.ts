import { getSettings } from '../../core/settings';
import { defineAlert } from '../alerts/alerts.registry';
import { defineDailyJob } from '../alerts/jobs';
import { VISITORS } from './visitors.settings';
import { autoCheckOut } from './visitors.service';

/** Visitor and pickup alerts (Alerts → Built-in Alerts), and the end-of-day check-out. */

defineAlert({ key: 'visitor_arrived', label: 'Visitor at the gate for you', description: 'When a visitor comes to meet a staff member (and, if approval is on, waits for their OK).', type: 'notices', when: 'instant', recipients: [{ key: 'host', label: 'The staff member they meet' }], fields: [{ key: 'visitor', label: 'Visitor', example: 'Ramesh Negi' }, { key: 'mobile', label: 'Mobile', example: '98765 43210' }, { key: 'purpose', label: 'Purpose', example: 'Parent: about my child' }, { key: 'people', label: 'People', example: '2' }, { key: 'time', label: 'Time', example: '10:42 am' }, { key: 'action', label: 'What to do', example: 'Please allow or refuse on My Visitors.' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['host'], priority: 'important', subject: '{{visitor}} is at the gate to meet you', body: '{{visitor}} ({{mobile}}, {{people}} people) came at {{time}} for {{purpose}}. {{action}}', shortText: '{{visitor}} at the gate for you ({{purpose}}).' }, link: '/visitors/mine' });
defineAlert({ key: 'pickup_done', label: 'Child collected early', description: 'When a student is collected from school early: to the parents (System Settings → Visitors) and the class teacher.', type: 'notices', when: 'instant', recipients: [{ key: 'parent', label: 'Parents' }, { key: 'class_teacher', label: 'Class teacher' }], fields: [{ key: 'student', label: 'Student', example: 'Shubham Nautiyal' }, { key: 'by', label: 'Collected by', example: 'Mahesh Nautiyal (Father)' }, { key: 'time', label: 'Time', example: '11:20 am' }, { key: 'reason', label: 'Reason', example: 'Doctor’s appointment' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['parent', 'class_teacher'], priority: 'important', subject: '{{student}} left school at {{time}}', body: 'Dear {{name}},\n\n{{student}} was collected from school at {{time}} by {{by}}. Reason: {{reason}}.', shortText: '{{school}}: {{student}} collected at {{time}} by {{by}}.' }, link: { parent: '/my-pickup', class_teacher: '/visitors/pickup' } });
defineAlert({ key: 'pickup_unknown', label: 'Pickup by someone not on the list', description: 'When someone not on a student’s pickup list wants to collect them: to those who can approve.', type: 'notices', when: 'instant', recipients: [{ key: 'office', label: 'Those who manage visitors' }], fields: [{ key: 'student', label: 'Student', example: 'Shubham Nautiyal' }, { key: 'by', label: 'Who', example: 'Suresh Rawat (Uncle), 98765 43210' }, { key: 'reason', label: 'Reason', example: 'Family function' }, { key: 'time', label: 'Time', example: '11:20 am' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['office'], priority: 'emergency', required: true, subject: 'Approve pickup: {{student}}', body: '{{by}} wants to collect {{student}} ({{time}}). Reason: {{reason}}. They are not on the pickup list: call the parents, then allow or refuse on Student Pickup.', shortText: 'Pickup approval needed: {{student}} by {{by}}.' }, link: '/visitors/pickup' });

defineDailyJob({
    key: 'visitors_auto_out',
    at: async () => {
        const { at } = await getSettings({ at: VISITORS.autoOut });
        return at || '23:59';
    },
    run: async () => {
        const { at } = await getSettings({ at: VISITORS.autoOut });
        if (!at) return 'off';
        return `${await autoCheckOut()} visits closed`;
    },
});
