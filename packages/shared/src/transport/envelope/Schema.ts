// Generated from Envelope.proto by scripts/generate-transport-protobuf.mjs.
// Do not edit manually.
export const envelopeSchema = {
    "nested": {
        "devshell": {
            "nested": {
                "transport": {
                    "nested": {
                        "Address": {
                            "fields": {
                                "host": {
                                    "type": "string",
                                    "id": 1
                                },
                                "port": {
                                    "type": "string",
                                    "id": 2
                                }
                            }
                        },
                        "Envelope": {
                            "fields": {
                                "source": {
                                    "type": "Address",
                                    "id": 1
                                },
                                "dest": {
                                    "type": "Address",
                                    "id": 2
                                },
                                "packet": {
                                    "type": "Packet",
                                    "id": 3
                                }
                            }
                        },
                        "Packet": {
                            "oneofs": {
                                "value": {
                                    "oneof": [
                                        "json",
                                        "streamData"
                                    ]
                                }
                            },
                            "fields": {
                                "json": {
                                    "type": "bytes",
                                    "id": 1
                                },
                                "streamData": {
                                    "type": "StreamData",
                                    "id": 2
                                }
                            }
                        },
                        "StreamData": {
                            "fields": {
                                "id": {
                                    "type": "string",
                                    "id": 1
                                },
                                "seq": {
                                    "type": "uint64",
                                    "id": 2
                                },
                                "data": {
                                    "type": "bytes",
                                    "id": 3
                                }
                            }
                        }
                    }
                }
            }
        }
    }
} as const;
