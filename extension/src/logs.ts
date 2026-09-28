import { EventBuffer } from './event-buffer';
export const extensionLogs = new EventBuffer();
let installed = false;
export function captureExtensionLogs(): void {
  if (installed) return;
  installed = true;
  for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const message = args.map(v => { try { return typeof v === 'string' ? v : v instanceof Error ? v.stack ?? v.message : JSON.stringify(v); } catch { return String(v); } }).join(' ');
      extensionLogs.push({ level, message });
      original(...args);
    };
  }
  self.addEventListener('error', event => extensionLogs.push({ level: 'error', message: event.message }));
  self.addEventListener('unhandledrejection', event => extensionLogs.push({ level: 'error', message: String(event.reason) }));
}
