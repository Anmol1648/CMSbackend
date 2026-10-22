import type { MasterSeed } from '../masters/masters.registry';
import { codedLabel, codedList } from '../masters/coded-lists';

/** Admission test / interaction results (Masters → Admission test results); enquiries keep the code. */

export const TEST_RESULT_SEED: MasterSeed[] = [
    { name: 'Not needed', code: 'not_needed' },
    { name: 'Pending', code: 'pending' },
    { name: 'Passed', code: 'passed' },
    { name: 'Not cleared', code: 'failed' },
];

export const testResults = () => codedList('admission_test_result', TEST_RESULT_SEED);

export const testResultNames = async () => {
    const list = await testResults();
    return (code: string | null | undefined) => codedLabel(list, code) ?? '';
};
