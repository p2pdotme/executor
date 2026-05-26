import { AssignConfig, ExecutorConfig, ToggleConfig } from '../helpers/config';
import { attachOrderCompletedListener } from './orderCompleted';
import { attachOrderPlacedListener } from './orderPlaced';

export async function startListeners(config: ToggleConfig & AssignConfig & ExecutorConfig) {
    await attachOrderPlacedListener(config);
    await attachOrderCompletedListener(config);
}
