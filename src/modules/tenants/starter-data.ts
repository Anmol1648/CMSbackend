import { seedMasters } from '../masters/masters.service';
import { seedAcademic } from '../academic/academic.seed';

/**
 * A school's starter data, in order: master lists (states, religions, streams…), then the academic
 * set-up that uses them. Each part only fills what is still empty, so running it again is safe.
 */
export const seedStarterData = async () => ({ masters: await seedMasters(), academic: await seedAcademic() });
