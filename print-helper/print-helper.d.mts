import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type Printer = { host: string; port?: number };
export type HelperConfig = { port?: number; token: string; allowedOrigins: string[]; printers: Record<string, Printer> };
export function sendToPrinter(printer: Printer, bytes: Uint8Array, timeoutMs?: number): Promise<void>;
export function createHandler(config: HelperConfig, send?: (printer: Printer, bytes: Uint8Array) => Promise<void>): (req: IncomingMessage, res: ServerResponse) => void;
export function startHelper(config: HelperConfig): Promise<Server>;
