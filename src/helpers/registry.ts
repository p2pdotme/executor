export const CONTRACT_AUTOMATION_REGISTRY = [
    // 1. toggleMerchantsOffline — event-triggered, public callable
    {
        key: 'orderPlaced.toggleOffline',
        contract: 'Diamond',
        network: 'base-mainnet',
        functionName: 'toggleMerchantsOffline',
        signature: 'toggleMerchantsOffline(bytes32 currency, address[] merchants)',
        inputs: [
            { name: 'currency', type: 'bytes32', source: 'event' },
            { name: 'merchants', type: 'address[]', source: 'event' },
        ],
        trigger: {
            type: 'event',
            eventName: 'OrderPlaced',
            delaySeconds: 0,
        },
        publicCallable: true,
        description:
            'Marks merchants offline for a given currency. Executed immediately on OrderPlaced, and can also be called manually by anyone at any time.',
    },

    // 2. assignMerchants — event-triggered, internal controlled execution
    {
        key: 'orderPlaced.assignMerchants',
        contract: 'Diamond',
        network: 'base-mainnet',
        functionName: 'assignMerchants',
        signature: 'assignMerchants(uint256 orderId)',
        inputs: [
            { name: 'orderId', type: 'uint256', source: 'event' },
        ],
        trigger: {
            type: 'event',
            eventName: 'OrderPlaced',
            delaySeconds: 90,
        },
        publicCallable: false,
        description:
            'Assigns merchants to an order. Automatically executed 90 seconds after OrderPlaced only if the order is still in Placed state. Public callers may also execute this anytime between 90s–180s after placement if the order is still Placed.',
    },

    // 3. toggleMerchantsOffline — scheduled, public callable
    {
        key: 'toggleSchedule.toggleOffline',
        contract: 'Diamond',
        network: 'base-mainnet',
        functionName: 'toggleMerchantsOffline',
        signature: 'toggleMerchantsOffline(bytes32 currency, address[] merchants)',
        inputs: [
            { name: 'currency', type: 'bytes32', source: 'schedule' },
        ],
        trigger: {
            type: 'schedule',
            interval: '30m',
        },
        publicCallable: true,
        description:
            'Marks merchants offline for a given currency. Executed every 30 minutes.',
    },

    // 4. orderSweeper — scheduled, public callable
    {
        key: 'orderSweeper.sweepOrders',
        contract: 'Diamond',
        network: 'base-mainnet',
        functionName: 'autoCancelExpiredOrders',
        signature: 'autoCancelExpiredOrders(uint256[] orderIds)',
        inputs: [
            { name: 'orderIds', type: 'uint256[]', source: 'schedule' },
        ],
        trigger: {
            type: 'schedule',
            interval: '1m',
        },
        publicCallable: true,
        description:
            'Cancels expired orders. Executed every minute. Fetches tracked orders from database and cancels them if they are expired.',
    }
];
