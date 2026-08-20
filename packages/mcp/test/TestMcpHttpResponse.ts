export function parseMcpHttpResponse<T>(text: string): T {
    const data = text
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
    return JSON.parse(data.at(-1) ?? text) as T;
}
