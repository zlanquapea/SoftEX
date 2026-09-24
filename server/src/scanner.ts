import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { extname } from 'node:path';
import type { Config } from './context.js';
import { badRequest } from './util.js';

/** Upload restrictions (§5.3, §9): executable and script types are refused outright. */
export const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.vbe', '.jse', '.wsf', '.jar', '.dll', '.sh', '.app', '.dmg', '.hta', '.cpl', '.lnk', '.reg',
]);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Scan an uploaded file before it becomes visible. Built-in checks always run;
 * when a ClamAV daemon is configured every file is also streamed to it with the
 * INSTREAM command. If the scanner is configured but unreachable, the upload is
 * refused (fail closed) rather than stored unscanned.
 */
export async function scanUpload(config: Config, path: string, originalName: string) {
  const ext = extname(originalName).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) throw badRequest(`Files of type ${ext} are not allowed`);
  const data = readFileSync(path);
  const head = data.subarray(0, 4096);
  if (head.includes(Buffer.from(EICAR))) throw badRequest('This file was flagged by the malware scanner');
  if (head.subarray(0, 2).toString('latin1') === 'MZ' || head.subarray(0, 4).toString('latin1') === '\x7fELF') {
    throw badRequest('Executable files are not allowed');
  }
  if (config.clamav) {
    let verdict: string;
    try {
      verdict = await clamdScan(config.clamav.host, config.clamav.port, data);
    } catch (error) {
      throw badRequest(`The malware scanner is unavailable, so the upload was not accepted. Try again shortly. (${(error as Error).message})`);
    }
    if (/FOUND$/.test(verdict)) throw badRequest(`This file was flagged by the malware scanner (${verdict.replace(/^stream: /, '').replace(/ FOUND$/, '')})`);
    if (!/OK$/.test(verdict)) throw badRequest(`The malware scanner could not check this file (${verdict})`);
  }
}

/** Minimal clamd INSTREAM client: zINSTREAM, length-prefixed chunks, zero-length terminator. */
export function clamdScan(host: string, port: number, data: Buffer, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('scanner timed out')));
    socket.on('error', reject);
    socket.on('data', (d: Buffer) => chunks.push(d));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const size = 64 * 1024;
      for (let i = 0; i < data.length; i += size) {
        const chunk = data.subarray(i, i + size);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        socket.write(len);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}
