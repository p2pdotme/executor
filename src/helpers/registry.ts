export const CONTRACT_AUTOMATION_REGISTRY = [
    // 1. Remove non-eligible merchants — event-triggered
    {
        key: 'orderPlaced.removeNonEligibleMerchants',
        contract: 'Diamond',
        network: 'base-mainnet',
        functionName: 'removeNonEligibleMerchants',
        signature:
            'removeNonEligibleMerchants(bytes32 currency, address[] prevs, address[] targets)',
        inputs: [
            { name: 'currency', type: 'bytes32', source: 'event' },
            { name: 'prevs', type: 'address[]', source: 'getNonEligibleMerchants' },
            { name: 'targets', type: 'address[]', source: 'getNonEligibleMerchants' },
        ],
        trigger: {
            type: 'event',
            eventName: 'OrderPlaced',
            delaySeconds: 0,
        },
        publicCallable: true,
        description:
            'Removes inactive or non-eligible merchants from the merchant list. Triggered immediately on OrderPlaced. Uses on-chain scanning via getNonEligibleMerchants.',
    },

    // 2. assignMerchants — delayed after OrderPlaced
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
            'Assigns merchants to an order if it is still in Placed state. Executed 90 seconds after OrderPlaced.',
    },

    // 3. Scheduled merchant cleanup — every 30 minutes
    {
        key: 'toggleSchedule.removeNonEligibleMerchants',
        contract: 'Diamond',
        network: 'base-mainnet',
        functionName: 'removeNonEligibleMerchants',
        signature:
            'removeNonEligibleMerchants(bytes32 currency, address[] prevs, address[] targets)',
        inputs: [
            { name: 'currency', type: 'bytes32', source: 'schedule' },
            { name: 'prevs', type: 'address[]', source: 'getNonEligibleMerchants' },
            { name: 'targets', type: 'address[]', source: 'getNonEligibleMerchants' },
        ],
        trigger: {
            type: 'schedule',
            interval: '30m',
        },
        publicCallable: true,
        description:
            'Periodically cleans up inactive or non-eligible merchants for each currency using on-chain scanning.',
    },

    // 4. Order sweeper — cancels expired orders
    {
        key: 'orderSweeper.autoCancelExpiredOrders',
        contract: 'Diamond',
        network: 'base-mainnet',
        functionName: 'autoCancelExpiredOrders',
        signature: 'autoCancelExpiredOrders(uint256[] orderIds)',
        inputs: [
            { name: 'orderIds', type: 'uint256[]', source: 'database' },
        ],
        trigger: {
            type: 'schedule',
            interval: '1m',
        },
        publicCallable: true,
        description:
            'Cancels expired orders every minute. Uses tracked orderIds from Redis/database maintained by listeners and scanner.',
    },
];
