import { ExecutorConfig } from '../helpers/config';
import { attachOrderCompletedListener } from './orderCompleted';
import { attachOrderPlacedListener } from './orderPlaced';

export async function startListeners(config: ExecutorConfig) {
    await attachOrderPlacedListener(config);
    await attachOrderCompletedListener(config);
}
