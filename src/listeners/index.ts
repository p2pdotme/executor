import { ContractCallerConfig } from '../helpers/config';
import { attachOrderPlacedListener } from './orderPlaced';

export async function startListeners(config: ContractCallerConfig) {
    await attachOrderPlacedListener(config);
}
