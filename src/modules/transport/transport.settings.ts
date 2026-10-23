import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Transport: fees, live tracking, alerts and the map. Who manages, drives or
 * tracks is in Roles & Permissions (transport.*); vehicle types and document types in Masters.
 */

const G = 'Transport';
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });

export const TRANSPORT = {
    feeHeadCode: defineSetting<string>({ key: 'transport.fee_head_code', group: G, label: 'Fee head the transport fee is charged under (its code in Masters → Fee heads)', type: 'text', default: 'TRN', schema: z.string().trim().min(1).max(20) }),
    oneWayPercent: num('transport.one_way_percent', 'Students who use the bus one way only pay this % of the fare', 60, 0, 100),
    pingSeconds: num('transport.ping_seconds', 'The bus sends its position every this many seconds', 10, 5, 120),
    stopRadius: num('transport.stop_radius_m', 'A bus within this many metres of a stop has reached it', 150, 30, 2000),
    nearMinutes: num('transport.near_minutes', 'Tell parents when the bus is this many minutes from their stop', 5, 1, 60),
    lateMinutes: num('transport.late_minutes', 'Tell parents the bus is late when it is this many minutes behind its times', 10, 3, 120),
    overspeed: num('transport.overspeed_kmh', 'Alert the transport in-charge above this speed (km/h)', 50, 10, 150),
    avgSpeed: num('transport.avg_speed_kmh', 'Speed used to work out arrival times when the bus is stopped (km/h)', 25, 5, 100),
    parentsDuringTrip: bool('transport.parents_only_during_trip', 'Parents see the bus on the map only while a trip is running', true),
    keepDays: num('transport.keep_days', 'Keep the tracking history (positions) for this many days', 30, 1, 365),
    mapProvider: defineSetting<string>({
        key: 'transport.map_provider',
        group: G,
        label: 'Map',
        help: 'OpenStreetMap is free. Google Maps needs the school’s key (Transport → Setup).',
        type: 'select',
        default: 'osm',
        schema: z.enum(['osm', 'google']),
        options: [
            { value: 'osm', label: 'OpenStreetMap (free)' },
            { value: 'google', label: 'Google Maps (needs a key)' },
        ],
    }),
    schoolLat: defineSetting<number>({ key: 'transport.school_lat', group: G, label: 'School location: latitude', type: 'number', default: 30.5551, schema: z.number().min(-90).max(90) }),
    schoolLng: defineSetting<number>({ key: 'transport.school_lng', group: G, label: 'School location: longitude', type: 'number', default: 79.5646, schema: z.number().min(-180).max(180) }),
    docRemindDays: num('transport.doc_remind_days', 'Remind about vehicle papers (fitness, insurance…) this many days before they expire', 30, 1, 180),
    gpsProvider: defineSetting<string>({
        key: 'transport.gps_provider',
        group: G,
        label: 'GPS devices in vehicles',
        help: 'Off: the driver’s phone sends the position (the trip screen). A provider: positions come from the devices fitted in the vehicles.',
        type: 'select',
        default: 'none',
        schema: z.enum(['none', 'generic']),
        options: [
            { value: 'none', label: 'None (the driver’s phone)' },
            { value: 'generic', label: 'A GPS tracker provider (keys on Transport → Setup)' },
        ],
    }),
    // Encrypted keys (Transport → Setup).
    googleKey: defineSetting<string>({ key: 'transport.google_key', group: G, label: 'transport.google_key', type: 'text', default: '', schema: z.string().max(2000), hidden: true }),
    gpsUrl: defineSetting<string>({ key: 'transport.gps_url', group: G, label: 'transport.gps_url', type: 'text', default: '', schema: z.string().max(2000), hidden: true }),
    gpsKey: defineSetting<string>({ key: 'transport.gps_key', group: G, label: 'transport.gps_key', type: 'text', default: '', schema: z.string().max(2000), hidden: true }),
};

defineMasterGroup({ key: 'transport', label: 'Transport', order: 17 });
defineMaster({
    key: 'vehicle_type',
    label: 'Vehicle type',
    plural: 'Vehicle types',
    group: 'transport',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'Bus' }, { name: 'Mini bus' }, { name: 'Van' }, { name: 'Car' }, { name: 'E-rickshaw' }],
});
defineMaster({
    key: 'vehicle_document',
    label: 'Vehicle document',
    plural: 'Vehicle documents',
    description: 'The papers each vehicle must have; the school is reminded before they expire.',
    group: 'transport',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'Registration (RC)' }, { name: 'Fitness certificate' }, { name: 'Insurance' }, { name: 'Permit' }, { name: 'Pollution (PUC)' }, { name: 'Road tax' }, { name: 'Speed governor certificate' }, { name: 'Driver’s licence' }],
});
