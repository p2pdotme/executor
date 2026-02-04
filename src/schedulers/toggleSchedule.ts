import { ethers } from 'ethers';
import { initToggleScheduleQueue } from '../queue';

export async function startToggleSchedule() {
    const queue = initToggleScheduleQueue();
    const every30m = 30 * 60 * 1000;

    const currencies: Record<string, string> = {
        INR: ethers.encodeBytes32String('INR'),
        IDR: ethers.encodeBytes32String('IDR'),
        BRL: ethers.encodeBytes32String('BRL'),
        ARS: ethers.encodeBytes32String('ARS'),
        MEX: ethers.encodeBytes32String('MEX'),
        VEN: ethers.encodeBytes32String('VEN'),
    };

    for (const [code, bytes32] of Object.entries(currencies)) {
        await queue.add(
            'ToggleSchedule',
            { currency: bytes32 as string },
            {
                jobId: `toggle-schedule-${code}`, // prevent duplicate repeat jobs
                repeat: { every: every30m },
            },
        );
    }
}
