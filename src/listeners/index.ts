import { AssignConfig, ToggleConfig } from '../helpers/config';
import { attachOrderPlacedListener } from './orderPlaced';

export async function startListeners(config: ToggleConfig & AssignConfig) {
    await attachOrderPlacedListener(config);
}
