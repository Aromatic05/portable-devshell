export type JsonPrimitive = boolean | number | null | string;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
