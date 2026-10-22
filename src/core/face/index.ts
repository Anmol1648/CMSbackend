import path from 'path';
import jpeg from 'jpeg-js';
import type * as FaceApi from '@vladmandic/face-api';
import { AppError, badRequest } from '../errors';
import { ErrorCode } from '../index';
import { logger } from '../logger';

/**
 * Face recognition on our own server (no outside service): face-api with TensorFlow.js on WebAssembly,
 * models from the package (nothing downloaded at run time). A photo gives one "face descriptor" (128
 * numbers); two faces are the same person when their descriptors are close (distance below ~0.5).
 */

type Api = typeof FaceApi;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const load = (): Api => require('@vladmandic/face-api/dist/face-api.node-wasm.js');

let ready: Promise<Api> | null = null;

const start = () => {
    if (!ready) {
        ready = (async () => {
            const tf = load().tf as unknown as { setBackend: (b: string) => Promise<boolean>; ready: () => Promise<void> };
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const wasm = require('@tensorflow/tfjs-backend-wasm') as { setWasmPaths: (p: string, usePlatformFetch?: boolean) => void };
            const wasmDir = path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + path.sep;
            wasm.setWasmPaths(wasmDir);
            await tf.setBackend('wasm');
            await tf.ready();
            const api = load();
            const models = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
            await api.nets.ssdMobilenetv1.loadFromDisk(models);
            await api.nets.tinyFaceDetector.loadFromDisk(models);
            await api.nets.faceLandmark68Net.loadFromDisk(models);
            await api.nets.faceRecognitionNet.loadFromDisk(models);
            logger.info('Face recognition ready');
            return api;
        })().catch((err) => {
            ready = null;
            logger.error('Face recognition could not start', { error: (err as Error).message });
            throw new AppError('Face recognition is not available on the server right now', 503, ErrorCode.INTERNAL_SERVER_ERROR);
        });
    }
    return ready;
};

export interface FaceResult {
    /** How many faces are in the photo. */
    faces: number;
    /** The biggest face's descriptor (null when there is no face). */
    descriptor: number[] | null;
    /** How sure the detector is that it is a face (0–1). */
    confidence: number | null;
    /** Head turn: the nose's offset from the middle of the eyes, in eye widths (0 = straight, ±0.3 = clearly turned). */
    yaw: number | null;
}

/** Finds the face in a JPEG photo and returns its descriptor. */
export const describeFace = async (photo: Buffer): Promise<FaceResult> => {
    const api = await start();
    let decoded: { width: number; height: number; data: Uint8Array };
    try {
        decoded = jpeg.decode(photo, { useTArray: true, maxMemoryUsageInMB: 256 });
    } catch {
        throw badRequest('The photo could not be read (send a JPEG)');
    }
    const tf = api.tf as unknown as {
        tidy: <T>(fn: () => T) => T;
        tensor3d: (v: Uint8Array | Int32Array, shape: [number, number, number], dtype: 'int32') => unknown;
        dispose: (t: unknown) => void;
    };
    // RGBA → RGB (height × width × 3), as taken and brightened (dark / backlit webcam photos).
    const n = decoded.width * decoded.height;
    const rgb = new Int32Array(n * 3);
    let sum = 0;
    for (let i = 0, j = 0; i < decoded.data.length; i += 4, j += 3) {
        rgb[j] = decoded.data[i];
        rgb[j + 1] = decoded.data[i + 1];
        rgb[j + 2] = decoded.data[i + 2];
        sum += 0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2];
    }
    const mean = sum / n;
    // Lift a dark photo towards a middle brightness (never darken a normal one).
    const gain = mean < 110 ? Math.min(2.2, 120 / Math.max(mean, 20)) : 1;
    const bright = gain > 1 ? Int32Array.from(rgb, (v) => Math.min(255, Math.round(v * gain))) : rgb;

    const shape: [number, number, number] = [decoded.height, decoded.width, 3];
    // Try strict first, then gentler: the same model less strict, then the webcam model (on the brightened photo).
    const attempts: { pixels: Int32Array; options: () => unknown }[] = [
        { pixels: rgb, options: () => new api.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 5 }) },
        { pixels: bright, options: () => new api.SsdMobilenetv1Options({ minConfidence: 0.3, maxResults: 5 }) },
        { pixels: bright, options: () => new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }) },
    ];
    for (const a of attempts) {
        const tensor = tf.tensor3d(a.pixels, shape, 'int32');
        try {
            const found = await api.detectAllFaces(tensor as never, a.options() as never).withFaceLandmarks().withFaceDescriptors();
            if (!found.length) continue;
            const biggest = [...found].sort((x, y) => y.detection.box.area - x.detection.box.area)[0];
            // Only faces of a fair size count as "more than one face" (not a poster far behind).
            const others = found.filter((f) => f !== biggest && f.detection.box.area > biggest.detection.box.area * 0.25).length;
            const pts = biggest.landmarks.positions;
            const eyeL = pts[36];
            const eyeR = pts[45];
            const nose = pts[30];
            const width = Math.abs(eyeR.x - eyeL.x) || 1;
            const yaw = Math.round(((nose.x - (eyeL.x + eyeR.x) / 2) / width) * 1000) / 1000;
            return { faces: 1 + others, descriptor: Array.from(biggest.descriptor), confidence: Math.round(biggest.detection.score * 100) / 100, yaw };
        } finally {
            tf.dispose(tensor);
        }
    }
    logger.info('No face found in a photo', { width: decoded.width, height: decoded.height, brightness: Math.round(mean) });
    return { faces: 0, descriptor: null, confidence: null, yaw: null };
};

/** Distance between two faces: about 0.3 for the same person, 0.6+ for different people. */
export const faceDistance = (a: number[], b: number[]) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));

/** The closest of the enrolled faces to a face (smaller = more alike). */
export const closestFace = (face: number[], enrolled: number[][]) => (enrolled.length ? Math.min(...enrolled.map((e) => faceDistance(face, e))) : null);

/** Loads the models in the background (so the first check-in isn't slow). */
export const warmUpFaces = () => {
    start().catch(() => undefined);
};
