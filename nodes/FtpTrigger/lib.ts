import type {
        ICredentialDataDecryptedObject,
} from 'n8n-workflow';
import type ftpClient from 'promise-ftp';
import type sftpClient from 'ssh2-sftp-client';
import type { Readable } from 'stream';

import { lookup as mimeTypeLookup } from 'mime-types';
import { basename, dirname } from 'path';

/**
 * Maximum number of entries kept in the workflow static data file map.
 * Folders with more files than this would otherwise grow the persisted
 * static data without bound (it is stored in n8n's database).
 */
export const MAX_TRACKED_ENTRIES = 10000;

/** Timeouts applied to every FTP/SFTP connection so a half-dead server cannot hang a poll. */
export const CONNECT_TIMEOUT_MS = 20000;
export const KEEPALIVE_INTERVAL_MS = 10000;

export interface FileMapEntry {
        mtime: number;
        size: number;
        type: string;
        /** Set when emission was deferred because the file was modified too recently (stability window). */
        pending?: boolean;
        /** For pending entries: whether the file was first seen as new (created) or as a modification (updated). */
        isNew?: boolean;
}

export interface ReturnFtpItem {
        type: string;
        name: string;
        size: number;
        accessTime?: Date;
        modifyTime: Date;
        rights?: {
                user: string;
                group: string;
                other: string;
        };
        owner?: string | number;
        group?: string | number;
        target?: string;
        sticky?: boolean;
        path: string;
        /** Set when downloading the file content (Include File Content option) failed for this item. */
        downloadError?: string;
}

export interface SelectEventFilesParams {
        event: string;
        watchedPath: string;
        previousMap: Record<string, FileMapEntry>;
        currentFiles: ReturnFtpItem[];
        /** Poll time (ms since epoch) — the reference for the stability window. */
        now: number;
        /** 0 disables the stability window. */
        stabilityWindowMs?: number;
}

/**
 * Normalize PEM private keys that were pasted into n8n as single-line strings
 * containing literal `\n` sequences. Without this, such keys fail with
 * "Cannot parse privateKey: Unsupported key format".
 */
export function formatPrivateKey(privateKey: string): string {
        if (!privateKey || /\n/.test(privateKey)) {
                return privateKey;
        }

        let formattedPrivateKey = '';
        const parts = privateKey.split('-----').filter((item) => item !== '');

        parts.forEach((part) => {
                if (/(PRIVATE KEY|CERTIFICATE)/.test(part)) {
                        formattedPrivateKey += `-----${part}-----`;
                } else {
                        if (/Proc-Type|DEK-Info/.test(part)) {
                                part = part.replace(/:\s+/g, ':');
                        }
                        formattedPrivateKey += part.replace(/\\n/g, '\n').replace(/\s+/g, '\n');
                }
        });

        return formattedPrivateKey;
}

export function getFtpConnectOptions(credentials: ICredentialDataDecryptedObject): ftpClient.Options {
        return {
                host: credentials.host as string,
                port: credentials.port as number,
                user: credentials.username as string,
                password: credentials.password as string,
                connTimeout: CONNECT_TIMEOUT_MS,
                pasvTimeout: CONNECT_TIMEOUT_MS,
                keepalive: KEEPALIVE_INTERVAL_MS,
        };
}

export function getSftpConnectOptions(
        credentials: ICredentialDataDecryptedObject,
): sftpClient.ConnectOptions {
        if (credentials.privateKey) {
                // Key-based authentication (password is kept as a fallback)
                return {
                        host: credentials.host as string,
                        port: credentials.port as number,
                        username: credentials.username as string,
                        password: (credentials.password as string) || undefined,
                        privateKey: formatPrivateKey(credentials.privateKey as string),
                        passphrase: (credentials.passphrase as string) || undefined,
                        readyTimeout: CONNECT_TIMEOUT_MS,
                        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
                };
        }
        // Password-only authentication. The private key must not be passed here,
        // otherwise ssh2 would try (and fail) to parse the empty string.
        return {
                host: credentials.host as string,
                port: credentials.port as number,
                username: credentials.username as string,
                password: credentials.password as string,
                readyTimeout: CONNECT_TIMEOUT_MS,
                keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        };
}

export function joinRemotePath(path: string, name: string): string {
        return `${path}${path.endsWith('/') ? '' : '/'}${name}`;
}

/**
 * Normalize a watched folder path for prefix comparisons: no trailing slash,
 * except for the filesystem root which stays `/`.
 */
export function normalizeWatchDir(path: string): string {
        const trimmed = path.replace(/\/+$/, '');
        return trimmed === '' ? '/' : trimmed;
}

/**
 * Strict containment check: `path` is the watched dir itself or lives inside it.
 * Unlike a plain `startsWith(watchedPath)` this does not match sibling folders
 * (`/data` does not match `/data-backup/file.txt`).
 */
export function isWithinWatchDir(watchDir: string, path: string): boolean {
        const dir = normalizeWatchDir(watchDir);
        if (dir === '/') {
                return path.startsWith('/');
        }
        return path === dir || path.startsWith(`${dir}/`);
}

export function normalizeFtpItem(input: ftpClient.ListingElement, path: string): ReturnFtpItem {
        const item = input as unknown as ReturnFtpItem;
        item.modifyTime = input.date;
        item.path = joinRemotePath(path, item.name);
        //@ts-expect-error The raw `date` field is replaced by `modifyTime`
        delete item.date;
        return item;
}

export function normalizeSftpItem(input: sftpClient.FileInfo, path: string): ReturnFtpItem {
        const item = input as unknown as ReturnFtpItem;
        item.accessTime = new Date(input.accessTime);
        item.modifyTime = new Date(input.modifyTime);
        item.path = joinRemotePath(path, item.name);
        return item;
}

export function getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
                return error.message;
        }
        return String(error);
}

export function getMimeType(filePath: string): string {
        const mime = mimeTypeLookup(filePath);
        return mime || 'application/octet-stream';
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
        return Object.prototype.hasOwnProperty.call(obj, key);
}

function toFileMapEntry(file: ReturnFtpItem): FileMapEntry {
        return {
                mtime: file.modifyTime.getTime(),
                size: file.size ?? 0,
                type: file.type,
        };
}

export function buildFileMap(files: ReturnFtpItem[]): Record<string, FileMapEntry> {
        const map: Record<string, FileMapEntry> = {};
        for (const file of files) {
                map[file.path] = toFileMapEntry(file);
        }
        return map;
}

/**
 * Keep the tracked-state map from growing without bound: when over the cap,
 * drop the entries with the oldest mtime first. Pending (in-flight) entries
 * carry recent mtimes, so they survive pruning naturally.
 */
export function pruneFileMap(map: Record<string, FileMapEntry>, max = MAX_TRACKED_ENTRIES): void {
        const keys = Object.keys(map);
        if (keys.length <= max) {
                return;
        }
        const sorted = keys.sort((a, b) => map[a].mtime - map[b].mtime);
        for (const key of sorted.slice(0, keys.length - max)) {
                delete map[key];
        }
}

/**
 * Pure diff engine: given the previous tracked state and the current listing,
 * compute which files should be emitted for the configured event and what the
 * next tracked state should be.
 *
 * Also implements the "stability window": files modified within the last
 * `stabilityWindowMs` are not emitted yet (they may still be uploading);
 * they are marked `pending` in the tracked state and emitted on a later
 * poll once their mtime/size have been unchanged for the whole window.
 */
export function selectEventFiles({
        event,
        watchedPath,
        previousMap,
        currentFiles,
        now,
        stabilityWindowMs = 0,
}: SelectEventFilesParams): { emit: ReturnFtpItem[]; nextMap: Record<string, FileMapEntry> } {
        const watchDir = normalizeWatchDir(watchedPath);
        const isDeletedEvent = event === 'fileDeleted' || event === 'folderDeleted';
        const isCreatedEvent = event === 'fileCreated' || event === 'folderCreated';
        const wantFile = event.startsWith('file');

        const nextMap = buildFileMap(currentFiles);
        const emit: ReturnFtpItem[] = [];

        if (isDeletedEvent) {
                for (const path of Object.keys(previousMap)) {
                        if (!isWithinWatchDir(watchDir, path)) {
                                continue;
                        }
                        if (hasOwn(nextMap, path)) {
                                continue;
                        }
                        const previous = previousMap[path];
                        // An in-flight file that was never emitted and is now gone (e.g. a
                        // partial upload that was cleaned up) must not fire a delete event.
                        if (previous.pending) {
                                continue;
                        }
                        if (wantFile !== (previous.type === '-')) {
                                continue;
                        }
                        emit.push({
                                type: previous.type,
                                name: basename(path),
                                size: 0,
                                modifyTime: new Date(now),
                                path,
                        });
                }
                return { emit, nextMap };
        }

        for (const file of currentFiles) {
                const mtime = file.modifyTime.getTime();
                const size = file.size ?? 0;
                const previous = hasOwn(previousMap, file.path) ? previousMap[file.path] : undefined;

                let isNew: boolean;
                let changed: boolean;
                let settledWhilePending = false;

                if (!previous) {
                        isNew = true;
                        changed = true;
                } else if (previous.pending) {
                        isNew = previous.isNew ?? true;
                        changed = mtime !== previous.mtime || (file.type === '-' && size !== previous.size);
                        settledWhilePending = !changed;
                } else {
                        isNew = false;
                        changed = mtime > previous.mtime || (file.type === '-' && size !== previous.size);
                }

                const withinStabilityWindow = stabilityWindowMs > 0 && mtime > now - stabilityWindowMs;

                if (settledWhilePending) {
                        // The file stopped changing while we were waiting for it to stabilize.
                        if (withinStabilityWindow) {
                                // Still inside the window: keep waiting for it to age out.
                                nextMap[file.path] = { ...toFileMapEntry(file), pending: true, isNew };
                                continue;
                        }
                        // Settled and outside the window: re-baseline the entry and emit the
                        // deferred event if this node's event type matches what we deferred
                        // (created vs. updated).
                        nextMap[file.path] = toFileMapEntry(file);
                        const matchesEvent = isCreatedEvent ? isNew : !isNew;
                        if (matchesEvent) {
                                emit.push(file);
                        }
                        continue;
                }

                const shouldEmit = isCreatedEvent ? isNew : !isNew && changed;
                if (!shouldEmit) {
                        continue;
                }

                if (withinStabilityWindow) {
                        // Defer emission: record the file as pending so a later poll can
                        // emit it once it has been stable for the whole window.
                        nextMap[file.path] = { ...toFileMapEntry(file), pending: true, isNew };
                        continue;
                }

                emit.push(file);
        }

        return { emit, nextMap };
}

/**
 * Track a single path (the watched file, or the watched folder itself) without a
 * full directory listing. SFTP supports stat directly; for FTP the entry is
 * looked up in its parent folder's listing instead.
 */
export async function statWatchedPath(
        protocol: string,
        ftp: ftpClient | undefined,
        sftp: sftpClient | undefined,
        targetPath: string,
): Promise<ReturnFtpItem | undefined> {
        if (protocol === 'sftp') {
                try {
                        const stats = await sftp!.stat(targetPath);
                        return {
                                type: stats.isDirectory ? 'd' : '-',
                                name: basename(targetPath) || targetPath,
                                size: stats.size,
                                accessTime: new Date(stats.accessTime),
                                modifyTime: new Date(stats.modifyTime),
                                path: targetPath,
                        };
                } catch {
                        // The path no longer exists (or cannot be accessed) — nothing to track
                        return undefined;
                }
        }

        const trimmedPath = targetPath.replace(/\/+$/, '') || '/';
        const parentPath = dirname(trimmedPath) || '/';
        const entryName = basename(trimmedPath);

        if (parentPath === trimmedPath) {
                // The filesystem root itself cannot be looked up via FTP LIST
                return undefined;
        }

        try {
                const listing = await ftp!.list(parentPath);
                const entry = listing.find((item) => typeof item !== 'string' && item.name === entryName) as
                        ftpClient.ListingElement | undefined;
                if (!entry) {
                        return undefined;
                }
                const item = normalizeFtpItem(entry, parentPath);
                item.path = targetPath;
                return item;
        } catch {
                return undefined;
        }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
                // Depending on protocol/library and stream mode, chunks can arrive as
                // Buffers, Uint8Arrays, raw byte numbers (ssh2-sftp-client) or strings.
                if (Buffer.isBuffer(chunk)) {
                        chunks.push(chunk);
                } else if (typeof chunk === 'number') {
                        chunks.push(Buffer.from([chunk]));
                } else if (chunk instanceof Uint8Array) {
                        chunks.push(Buffer.from(chunk));
                } else {
                        chunks.push(Buffer.from(String(chunk)));
                }
        }
        return Buffer.concat(chunks);
}

/**
 * Download a remote file and return its contents as a Buffer.
 * Used by the "Include File Content" option.
 */
export async function downloadFile(
        protocol: string,
        ftp: ftpClient | undefined,
        sftp: sftpClient | undefined,
        remotePath: string,
): Promise<Buffer> {
        if (protocol === 'sftp') {
                const stream = await sftp!.get(remotePath);
                if (!stream) {
                        throw new Error(`Unable to download ${remotePath}`);
                }
                return streamToBuffer(stream as unknown as Readable);
        }
        const stream = await ftp!.get(remotePath);
        if (!stream) {
                throw new Error(`Unable to download ${remotePath}`);
        }
        return streamToBuffer(stream as unknown as Readable);
}
