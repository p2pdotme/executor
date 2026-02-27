export const DIAMOND_EVENTS = [
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "uint256",
                "name": "orderId",
                "type": "uint256"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "user",
                "type": "address"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "merchant",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            },
            {
                "indexed": false,
                "internalType": "enum OrderProcessorStorage.OrderType",
                "name": "orderType",
                "type": "uint8"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "placedTimestamp",
                "type": "uint256"
            },
            {
                "components": [
                    {
                        "internalType": "uint256",
                        "name": "amount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "fiatAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "placedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "completedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "userCompletedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "acceptedMerchant",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "user",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "recipientAddr",
                        "type": "address"
                    },
                    {
                        "internalType": "string",
                        "name": "pubkey",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "encUpi",
                        "type": "string"
                    },
                    {
                        "internalType": "bool",
                        "name": "userCompleted",
                        "type": "bool"
                    },
                    {
                        "internalType": "enum OrderProcessorStorage.OrderStatus",
                        "name": "status",
                        "type": "uint8"
                    },
                    {
                        "internalType": "enum OrderProcessorStorage.OrderType",
                        "name": "orderType",
                        "type": "uint8"
                    },
                    {
                        "components": [
                            {
                                "internalType": "enum OrderProcessorStorage.Entity",
                                "name": "raisedBy",
                                "type": "uint8"
                            },
                            {
                                "internalType": "enum OrderProcessorStorage.DisputeStatus",
                                "name": "status",
                                "type": "uint8"
                            },
                            {
                                "internalType": "uint256",
                                "name": "redactTransId",
                                "type": "uint256"
                            },
                            {
                                "internalType": "uint256",
                                "name": "accountNumber",
                                "type": "uint256"
                            }
                        ],
                        "internalType": "struct OrderProcessorStorage.Dispute",
                        "name": "disputeInfo",
                        "type": "tuple"
                    },
                    {
                        "internalType": "uint256",
                        "name": "id",
                        "type": "uint256"
                    },
                    {
                        "internalType": "string",
                        "name": "userPubKey",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "encMerchantUpi",
                        "type": "string"
                    },
                    {
                        "internalType": "uint256",
                        "name": "acceptedAccountNo",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256[]",
                        "name": "assignedAccountNos",
                        "type": "uint256[]"
                    },
                    {
                        "internalType": "bytes32",
                        "name": "currency",
                        "type": "bytes32"
                    },
                    {
                        "internalType": "uint256",
                        "name": "preferredPaymentChannelConfigId",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "circleId",
                        "type": "uint256"
                    }
                ],
                "indexed": false,
                "internalType": "struct OrderProcessorStorage.Order",
                "name": "_order",
                "type": "tuple"
            }
        ],
        "name": "OrderPlaced",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "uint256",
                "name": "orderId",
                "type": "uint256"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "merchant",
                "type": "address"
            },
            {
                "components": [
                    {
                        "internalType": "uint256",
                        "name": "amount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "fiatAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "placedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "completedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "userCompletedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "acceptedMerchant",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "user",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "recipientAddr",
                        "type": "address"
                    },
                    {
                        "internalType": "string",
                        "name": "pubkey",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "encUpi",
                        "type": "string"
                    },
                    {
                        "internalType": "bool",
                        "name": "userCompleted",
                        "type": "bool"
                    },
                    {
                        "internalType": "enum OrderProcessorStorage.OrderStatus",
                        "name": "status",
                        "type": "uint8"
                    },
                    {
                        "internalType": "enum OrderProcessorStorage.OrderType",
                        "name": "orderType",
                        "type": "uint8"
                    },
                    {
                        "components": [
                            {
                                "internalType": "enum OrderProcessorStorage.Entity",
                                "name": "raisedBy",
                                "type": "uint8"
                            },
                            {
                                "internalType": "enum OrderProcessorStorage.DisputeStatus",
                                "name": "status",
                                "type": "uint8"
                            },
                            {
                                "internalType": "uint256",
                                "name": "redactTransId",
                                "type": "uint256"
                            },
                            {
                                "internalType": "uint256",
                                "name": "accountNumber",
                                "type": "uint256"
                            }
                        ],
                        "internalType": "struct OrderProcessorStorage.Dispute",
                        "name": "disputeInfo",
                        "type": "tuple"
                    },
                    {
                        "internalType": "uint256",
                        "name": "id",
                        "type": "uint256"
                    },
                    {
                        "internalType": "string",
                        "name": "userPubKey",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "encMerchantUpi",
                        "type": "string"
                    },
                    {
                        "internalType": "uint256",
                        "name": "acceptedAccountNo",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256[]",
                        "name": "assignedAccountNos",
                        "type": "uint256[]"
                    },
                    {
                        "internalType": "bytes32",
                        "name": "currency",
                        "type": "bytes32"
                    },
                    {
                        "internalType": "uint256",
                        "name": "preferredPaymentChannelConfigId",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "circleId",
                        "type": "uint256"
                    }
                ],
                "indexed": false,
                "internalType": "struct OrderProcessorStorage.Order",
                "name": "_order",
                "type": "tuple"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "accountNo",
                "type": "uint256"
            }
        ],
        "name": "MerchantAssignedNewOrder",
        "type": "event"
    }
]

export const DIAMOND_FUNCTIONS = [
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "orderId",
                "type": "uint256"
            }
        ],
        "name": "getOrdersById",
        "outputs": [
            {
                "components": [
                    {
                        "internalType": "uint256",
                        "name": "amount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "fiatAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "placedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "completedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "userCompletedTimestamp",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "acceptedMerchant",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "user",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "recipientAddr",
                        "type": "address"
                    },
                    {
                        "internalType": "string",
                        "name": "pubkey",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "encUpi",
                        "type": "string"
                    },
                    {
                        "internalType": "bool",
                        "name": "userCompleted",
                        "type": "bool"
                    },
                    {
                        "internalType": "enum OrderProcessorStorage.OrderStatus",
                        "name": "status",
                        "type": "uint8"
                    },
                    {
                        "internalType": "enum OrderProcessorStorage.OrderType",
                        "name": "orderType",
                        "type": "uint8"
                    },
                    {
                        "components": [
                            {
                                "internalType": "enum OrderProcessorStorage.Entity",
                                "name": "raisedBy",
                                "type": "uint8"
                            },
                            {
                                "internalType": "enum OrderProcessorStorage.DisputeStatus",
                                "name": "status",
                                "type": "uint8"
                            },
                            {
                                "internalType": "uint256",
                                "name": "redactTransId",
                                "type": "uint256"
                            },
                            {
                                "internalType": "uint256",
                                "name": "accountNumber",
                                "type": "uint256"
                            }
                        ],
                        "internalType": "struct OrderProcessorStorage.Dispute",
                        "name": "disputeInfo",
                        "type": "tuple"
                    },
                    {
                        "internalType": "uint256",
                        "name": "id",
                        "type": "uint256"
                    },
                    {
                        "internalType": "string",
                        "name": "userPubKey",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "encMerchantUpi",
                        "type": "string"
                    },
                    {
                        "internalType": "uint256",
                        "name": "acceptedAccountNo",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256[]",
                        "name": "assignedAccountNos",
                        "type": "uint256[]"
                    },
                    {
                        "internalType": "bytes32",
                        "name": "currency",
                        "type": "bytes32"
                    },
                    {
                        "internalType": "uint256",
                        "name": "preferredPaymentChannelConfigId",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "circleId",
                        "type": "uint256"
                    }
                ],
                "internalType": "struct OrderProcessorStorage.Order",
                "name": "",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "currency",
                "type": "bytes32"
            },
            {
                "internalType": "address[]",
                "name": "merchants",
                "type": "address[]"
            }
        ],
        "name": "toggleMerchantsOffline",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "_orderId",
                "type": "uint256"
            }
        ],
        "name": "assignMerchants",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "uint256[]",
                "name": "orderIds",
                "type": "uint256[]"
            }
        ],
        "name": "autoCancelExpiredOrders",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "orderId",
                "type": "uint256"
            }
        ],
        "name": "isOrderExpired",
        "outputs": [
            {
                "internalType": "bool",
                "name": "",
                "type": "bool"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "merchant",
                "type": "address"
            }
        ],
        "name": "getPendingAssignStreak",
        "outputs": [
            {
                "internalType": "uint16",
                "name": "",
                "type": "uint16"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "getAssignedOrdersThreshold",
        "outputs": [
            {
                "internalType": "uint16",
                "name": "",
                "type": "uint16"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "currency",
                "type": "bytes32"
            },
            {
                "internalType": "address[]",
                "name": "prevs",
                "type": "address[]"
            },
            {
                "internalType": "address[]",
                "name": "targets",
                "type": "address[]"
            }
        ],
        "name": "removeNonEligibleMerchants",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "currency",
                "type": "bytes32"
            },
            {
                "internalType": "uint256",
                "name": "limit",
                "type": "uint256"
            }
        ],
        "name": "getNonEligibleMerchants",
        "outputs": [
            {
                "internalType": "address[]",
                "name": "prevs",
                "type": "address[]"
            },
            {
                "internalType": "address[]",
                "name": "targets",
                "type": "address[]"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
]

export const DIAMOND_ABI = [...DIAMOND_EVENTS, ...DIAMOND_FUNCTIONS] as const;
