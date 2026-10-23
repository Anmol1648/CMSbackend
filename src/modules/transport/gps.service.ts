import { z } from 'zod';
import { db } from '../../core/db';
import { runAsSystem, runAsTenant } from '../../core/context';
import { badRequest } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { decryptSecret, encryptSecret } from '../../core/encryption';
import { getSettings, setSetting } from '../../core/settings';
import { logger } from '../../core/logger';
import { dayDate, minutesIST, todayIST } from '../attendance/attendance.settings';
import { TRANSPORT } from './transport.settings';
import { endTrip, metres, ping, startTrip } from './tracking.service';

/**
 * GPS devices fitted in vehicles, and Google Maps. With a provider set (Transport → GPS & Maps),
 * the positions of vehicles with a device id are read every few seconds and fed into their running
 * trips (no phone needed); trips can also start and end by themselves at the route's times.
 * Google Maps uses Google's Map Tiles API with the school's key; else OpenStreetMap.
 */

type Fix = { lat: number; lng: number; speed: number | null; at: Date };

const secret = (enc: string) => {
    if (!enc) return '';
    try {
        return decryptSecret(enc);
    } catch {
        return '';
    }
};
const pick = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
const authHeader = (key: string): Record<string, string> => (!key ? {} : key.includes(':') ? { Authorization: `Basic ${Buffer.from(key).toString('base64')}` } : { Authorization: `Bearer ${key}` });

const getJson = async (url: string, key: string) => {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...authHeader(key) }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`The GPS provider answered ${res.status} for ${new URL(url).pathname}`);
    return res.json() as Promise<unknown>;
};

/** The latest position of each device, by its id (Traccar: its id and its unique id / IMEI). */
export const fetchPositions = async (): Promise<Map<string, Fix>> => {
    const s = await getSettings({ provider: TRANSPORT.gpsProvider, url: TRANSPORT.gpsUrl, key: TRANSPORT.gpsKey, fid: TRANSPORT.gpsFieldId, flat: TRANSPORT.gpsFieldLat, flng: TRANSPORT.gpsFieldLng, fspeed: TRANSPORT.gpsFieldSpeed, ftime: TRANSPORT.gpsFieldTime, unit: TRANSPORT.gpsSpeedUnit });
    const out = new Map<string, Fix>();
    if (s.provider === 'none') return out;
    const url = secret(s.url);
    if (!url) throw badRequest('Enter the GPS provider’s web address first');
    const key = secret(s.key);
    if (s.provider === 'traccar') {
        const base = url.replace(/\/+$/, '').replace(/\/api$/, '');
        const [devices, positions] = await Promise.all([getJson(`${base}/api/devices`, key), getJson(`${base}/api/positions`, key)]);
        const unique = new Map(((devices as { id: number; uniqueId: string }[]) ?? []).map((d) => [d.id, d.uniqueId]));
        for (const p of (positions as { deviceId: number; latitude: number; longitude: number; speed?: number; fixTime?: string }[]) ?? []) {
            const fix = { lat: p.latitude, lng: p.longitude, speed: typeof p.speed === 'number' ? Math.round(p.speed * 1.852) : null, at: p.fixTime ? new Date(p.fixTime) : new Date() };
            out.set(String(p.deviceId), fix);
            const u = unique.get(p.deviceId);
            if (u) out.set(u, fix);
        }
        return out;
    }
    const body = await getJson(url, key);
    const list = Array.isArray(body) ? body : ((pick(body, 'data') ?? pick(body, 'positions') ?? pick(body, 'items')) as unknown[]);
    if (!Array.isArray(list)) throw new Error('The GPS provider’s answer isn’t a list of positions');
    const factor = s.unit === 'knots' ? 1.852 : s.unit === 'ms' ? 3.6 : 1;
    for (const p of list) {
        const id = pick(p, s.fid);
        const lat = Number(pick(p, s.flat));
        const lng = Number(pick(p, s.flng));
        if (id === undefined || id === null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const sp = Number(pick(p, s.fspeed));
        const t = pick(p, s.ftime);
        out.set(String(id), { lat, lng, speed: Number.isFinite(sp) ? Math.round(sp * factor) : null, at: t ? new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : (t as string)) : new Date() });
    }
    return out;
};

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** One school: feeds device positions into running trips; starts and ends device trips. */
const pollSchool = async () => {
    const s = await getSettings({ auto: TRANSPORT.gpsAutoTrips, radius: TRANSPORT.stopRadius, lat: TRANSPORT.schoolLat, lng: TRANSPORT.schoolLng });
    const vehicles = await db.vehicle.findMany({ where: { isActive: true, gpsDeviceId: { not: null } }, select: { id: true, gpsDeviceId: true } });
    if (!vehicles.length) return;
    const fixes = await fetchPositions();
    const fixOf = (vehicleId: string | null) => {
        const v = vehicles.find((x) => x.id === vehicleId);
        return v?.gpsDeviceId ? (fixes.get(v.gpsDeviceId) ?? null) : null;
    };
    const today = dayDate(todayIST());
    const running = await db.trip.findMany({ where: { status: 'running', source: { not: 'simulated' }, vehicleId: { in: vehicles.map((v) => v.id) } } });
    for (const t of running) {
        const fix = fixOf(t.vehicleId);
        if (fix && (!t.lastAt || fix.at > t.lastAt)) await ping(t.id, { lat: fix.lat, lng: fix.lng, speed: fix.speed }, null).catch(() => null);
        if (t.source !== 'device') continue;
        // Device trips end by themselves: after the last stop (afternoon), or at school (morning); at most after 3 hours.
        const fresh = await db.trip.findFirst({ where: { id: t.id } });
        const stops = await db.transportStop.count({ where: { routeId: t.routeId, isActive: true } });
        const atSchool = fresh?.lastLat != null && fresh.lastLng != null && metres({ lat: fresh.lastLat, lng: fresh.lastLng }, { lat: s.lat, lng: s.lng }) <= s.radius;
        const done = fresh && fresh.nextStop >= stops && (t.kind !== 'morning' || atSchool);
        if (done || Date.now() - t.startedAt.getTime() > 3 * 3_600_000) await endTrip(t.id, null);
    }
    if (!s.auto) return;
    const now = minutesIST();
    const routes = await db.transportRoute.findMany({ where: { isActive: true, vehicleId: { in: vehicles.map((v) => v.id) } } });
    const trips = await db.trip.findMany({ where: { day: today, routeId: { in: routes.map((r) => r.id) } }, select: { routeId: true, kind: true } });
    for (const r of routes) {
        const fix = fixOf(r.vehicleId);
        // Only a bus that is moving, with a position from the last 5 minutes.
        if (!fix || Date.now() - fix.at.getTime() > 5 * 60_000 || (fix.speed ?? 0) < 5) continue;
        for (const [kind, start] of [['morning', r.morningStart], ['afternoon', r.afternoonStart]] as const) {
            const m = minutesOf(start);
            if (now < m - 15 || now > m + 60 || trips.some((x) => x.routeId === r.id && x.kind === kind)) continue;
            if (running.some((x) => x.routeId === r.id)) continue;
            await startTrip({ routeId: r.id, kind, source: 'device' }, null).catch((err) => logger.warn('GPS trip could not start', { route: r.name, error: (err as Error).message }));
        }
    }
};

const lastPoll = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
/** Reads the devices of every school that has a GPS provider, each at its own interval. */
export const startGpsPoller = () => {
    if (timer || process.env.NODE_ENV === 'test') return;
    timer = setInterval(() => {
        void (async () => {
            const rows = await runAsSystem(() => db.tenantSetting.findMany({ where: { key: 'transport.gps_provider' }, select: { tenantId: true, value: true } }));
            for (const row of rows) {
                if (row.value === 'none' || !row.value) continue;
                await runAsTenant(row.tenantId, async () => {
                    const { every } = await getSettings({ every: TRANSPORT.pingSeconds });
                    if (Date.now() - (lastPoll.get(row.tenantId) ?? 0) < every * 1000) return;
                    lastPoll.set(row.tenantId, Date.now());
                    await pollSchool().catch((err) => logger.warn('GPS provider', { tenant: row.tenantId, error: (err as Error).message }));
                });
            }
        })().catch((err) => logger.warn('GPS poller', { error: (err as Error).message }));
    }, 5000);
    timer.unref();
};

// ─── Transport → GPS & Maps ──────────────────────────────────────────────────

export const connectInfo = async () => {
    const s = await getSettings({ map: TRANSPORT.mapProvider, google: TRANSPORT.googleKey, provider: TRANSPORT.gpsProvider, url: TRANSPORT.gpsUrl, key: TRANSPORT.gpsKey, auto: TRANSPORT.gpsAutoTrips });
    const vehicles = await db.vehicle.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, number: true, gpsDeviceId: true } });
    return { mapProvider: s.map, googleKeySet: !!s.google, gpsProvider: s.provider, gpsUrl: secret(s.url), gpsKeySet: !!s.key, autoTrips: s.auto, vehicles };
};

export const connectSchema = z.strictObject({
    mapProvider: z.enum(['osm', 'google']),
    /** Left out: keep the saved key; "-": remove it. */
    googleKey: z.string().trim().max(500).optional(),
    gpsProvider: z.enum(['none', 'traccar', 'generic']),
    gpsUrl: z.string().trim().max(500).refine((u) => !u || /^https?:\/\//.test(u), 'must start with https://'),
    gpsKey: z.string().trim().max(500).optional(),
    autoTrips: z.boolean(),
});

export const saveConnect = async (input: z.infer<typeof connectSchema>, userId: string) => {
    const keyValue = (k: string | undefined) => (k === '-' ? undefined : encryptSecret(k!));
    if (input.googleKey) await setSetting(TRANSPORT.googleKey, keyValue(input.googleKey), userId);
    if (input.gpsKey) await setSetting(TRANSPORT.gpsKey, keyValue(input.gpsKey), userId);
    const { google } = await getSettings({ google: TRANSPORT.googleKey });
    if (input.mapProvider === 'google' && !google) throw badRequest('Enter the Google Maps key to use Google Maps', [{ field: 'googleKey', message: 'is required for Google Maps' }]);
    if (input.gpsProvider !== 'none' && !input.gpsUrl) throw badRequest('Enter the GPS provider’s web address', [{ field: 'gpsUrl', message: 'is required' }]);
    await setSetting(TRANSPORT.mapProvider, input.mapProvider, userId);
    await setSetting(TRANSPORT.gpsProvider, input.gpsProvider, userId);
    await setSetting(TRANSPORT.gpsUrl, input.gpsUrl ? encryptSecret(input.gpsUrl) : undefined, userId);
    await setSetting(TRANSPORT.gpsAutoTrips, input.autoTrips, userId);
    googleSession.clear();
    await recordAudit({ action: 'transport_connect_saved', entity: 'transport', entityId: 'connect', changes: { map: input.mapProvider, gps: input.gpsProvider, googleKey: input.googleKey ? 'changed' : 'kept', gpsKey: input.gpsKey ? 'changed' : 'kept' } });
    return connectInfo();
};

/** Reads the provider now and shows which vehicles it found (Test it). */
export const testGps = async () => {
    const { provider } = await getSettings({ provider: TRANSPORT.gpsProvider });
    if (provider === 'none') throw badRequest('Choose a GPS provider and save first');
    let fixes: Map<string, Fix>;
    try {
        fixes = await fetchPositions();
    } catch (err) {
        throw badRequest(`Couldn’t read the GPS provider: ${(err as Error).message}`);
    }
    const vehicles = await db.vehicle.findMany({ where: { isActive: true, gpsDeviceId: { not: null } }, orderBy: { name: 'asc' }, select: { name: true, number: true, gpsDeviceId: true } });
    return {
        positions: fixes.size,
        vehicles: vehicles.map((v) => {
            const f = fixes.get(v.gpsDeviceId!);
            return { name: v.name, number: v.number, deviceId: v.gpsDeviceId, found: !!f, lat: f?.lat ?? null, lng: f?.lng ?? null, speed: f?.speed ?? null, at: f?.at ?? null };
        }),
    };
};

// ─── The map's tiles ─────────────────────────────────────────────────────────

const OSM = { provider: 'osm', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 };
const googleSession = new Map<string, { session: string; until: number }>();

/** Which tiles the maps use: Google's (a session made with the school's key), else OpenStreetMap. */
export const mapTiles = async (tenantId: string) => {
    const { map, google } = await getSettings({ map: TRANSPORT.mapProvider, google: TRANSPORT.googleKey });
    const key = map === 'google' ? secret(google) : '';
    if (!key) return OSM;
    let s = googleSession.get(tenantId);
    if (!s || s.until < Date.now()) {
        try {
            const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapType: 'roadmap', language: 'en-IN', region: 'IN' }), signal: AbortSignal.timeout(10_000) });
            const data = (await res.json()) as { session?: string; expiry?: string; error?: { message?: string } };
            if (!res.ok || !data.session) throw new Error(data.error?.message ?? `Google answered ${res.status}`);
            // Renewed well before Google's expiry (about two weeks).
            s = { session: data.session, until: Math.min(Number(data.expiry ?? 0) * 1000, Date.now() + 86_400_000) || Date.now() + 86_400_000 };
            googleSession.set(tenantId, s);
        } catch (err) {
            logger.warn('Google Maps session', { error: (err as Error).message });
            return { ...OSM, note: 'Google Maps couldn’t be used (check the key and that the Map Tiles API is on); showing OpenStreetMap.' };
        }
    }
    return { provider: 'google', url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${s.session}&key=${key}`, attribution: 'Map data &copy; Google', maxZoom: 22 };
};
