import { ExecutorConfig } from '../helpers/config';
import { attachOrderCompletedListener } from './orderCompleted';
import { attachOrderPlacedListener } from './orderPlaced';
import { attachClaimApprovedListener } from './claimApproved';

export async function startListeners(config: ExecutorConfig) {
    await attachOrderPlacedListener(config);
    await attachOrderCompletedListener(config);
    // No-ops when INSURANCE_DIAMOND_ADDRESS is unset.
    await attachClaimApprovedListener(config);
}
