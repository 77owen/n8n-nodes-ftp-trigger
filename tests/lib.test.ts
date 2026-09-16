import { describe, expect, it } from 'vitest';

import {
        buildFileMap,
        formatPrivateKey,
        getErrorMessage,
        getFtpConnectOptions,
        getMimeType,
        getSftpConnectOptions,
        isWithinWatchDir,
        joinRemotePath,
        MAX_TRACKED_ENTRIES,
        normalizeFtpItem,
        normalizeWatchDir,
        pruneFileMap,
        selectEventFiles,
        type FileMapEntry,
        type ReturnFtpItem,
} from '../nodes/FtpTrigger/lib';

function file(path: string, mtime: number, size = 100, type = '-'): ReturnFtpItem {
        return { type, name: path.split('/').pop() as string, size, modifyTime: new Date(mtime), path };
}

const MIN = 60 * 1000;

describe('formatPrivateKey', () => {
        it('expands single-line escaped keys into a proper PEM', () => {
                // Kept small and asserted line-by-line so secret-redacting test output stays readable
                const raw = '-----BEGIN OPENSSH PRIVATE KEY-----\\nAAA\\nBBB\\n-----END OPENSSH PRIVATE KEY-----';
                const formatted = formatPrivateKey(raw);
                const lines = formatted.split('\n');
                expect(lines).toEqual([
                        '-----BEGIN OPENSSH PRIVATE KEY-----',
                        'AAA',
                        'BBB',
                        '-----END OPENSSH PRIVATE KEY-----',
                ]);
                expect(formatted.includes('\\n')).toBe(false);
        });

        it('leaves already multi-line keys untouched', () => {
                const pem =
                        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----\n';
                expect(formatPrivateKey(pem)).toBe(pem);
        });

        it('returns empty strings unchanged', () => {
                expect(formatPrivateKey('')).toBe('');
        });
});

describe('joinRemotePath', () => {
        it('adds a separator when the base path has no trailing slash', () => {
                expect(joinRemotePath('/data', 'a.txt')).toBe('/data/a.txt');
        });

        it('does not double the separator when it already ends with one', () => {
                expect(joinRemotePath('/data/', 'a.txt')).toBe('/data/a.txt');
        });

        it('handles the filesystem root', () => {
                expect(joinRemotePath('/', 'a.txt')).toBe('/a.txt');
        });
});

describe('normalizeWatchDir / isWithinWatchDir', () => {
        it('strips trailing slashes but keeps the root', () => {
                expect(normalizeWatchDir('/data/')).toBe('/data');
                expect(normalizeWatchDir('/data///')).toBe('/data');
                expect(normalizeWatchDir('/')).toBe('/');
                expect(normalizeWatchDir('///')).toBe('/');
        });

        it('matches the watched dir itself and its children', () => {
                expect(isWithinWatchDir('/data', '/data')).toBe(true);
                expect(isWithinWatchDir('/data', '/data/a.txt')).toBe(true);
                expect(isWithinWatchDir('/data/', '/data/a.txt')).toBe(true);
                expect(isWithinWatchDir('/', '/anything/at/all')).toBe(true);
        });

        it('does not match sibling folders with a shared prefix (regression)', () => {
                expect(isWithinWatchDir('/data', '/data-backup/a.txt')).toBe(false);
                expect(isWithinWatchDir('/data', '/database')).toBe(false);
        });
});

describe('connect options', () => {
        it('maps FTP credentials and applies timeouts', () => {
                const options = getFtpConnectOptions({
                        host: 'h',
                        port: 21,
                        username: 'u',
                        password: 'p',
                });
                expect(options).toMatchObject({ host: 'h', port: 21, user: 'u', password: 'p' });
                expect(options.connTimeout).toBeGreaterThan(0);
                expect(options.pasvTimeout).toBeGreaterThan(0);
                expect(options.keepalive).toBeGreaterThan(0);
        });

        it('uses password-only SFTP auth when no private key is set', () => {
                const options = getSftpConnectOptions({
                        host: 'h',
                        port: 22,
                        username: 'u',
                        password: 'p',
                });
                expect(options).toMatchObject({ host: 'h', port: 22, username: 'u', password: 'p' });
                expect(options.privateKey).toBeUndefined();
                expect(options.readyTimeout).toBeGreaterThan(0);
                expect(options.keepaliveInterval).toBeGreaterThan(0);
        });

        it('uses key-based SFTP auth with a formatted key and keeps the password as fallback', () => {
                const raw = '-----BEGIN OPENSSH PRIVATE KEY-----\\nA\\nB\\n-----END OPENSSH PRIVATE KEY-----';
                const options = getSftpConnectOptions({
                        host: 'h',
                        port: 22,
                        username: 'u',
                        password: '',
                        privateKey: raw,
                        passphrase: 'secret',
                });
                expect(options.privateKey?.includes('\\n')).toBe(false);
                expect(options.privateKey?.split('\n').length).toBe(4);
                expect(options.passphrase).toBe('secret');
                expect(options.password).toBeUndefined();
        });
});

describe('getMimeType', () => {
        it('maps common extensions', () => {
                expect(getMimeType('a.txt')).toBe('text/plain');
                expect(getMimeType('b.csv')).toBe('text/csv');
                expect(getMimeType('c.json')).toBe('application/json');
        });

        it('falls back to application/octet-stream', () => {
                expect(getMimeType('d.weird')).toBe('application/octet-stream');
        });
});

describe('normalizeFtpItem', () => {
        it('converts the raw date field to modifyTime and builds the full path', () => {
                const date = new Date('2026-01-02T03:04:05Z');
                const item = normalizeFtpItem(
                        {
                                type: '-',
                                name: 'a.txt',
                                size: 12,
                                date,
                                user: null,
                                group: null,
                                rights: { user: 'r', group: 'r', other: 'r' },
                                rawModifiedAt: '',
                        } as never,
                        '/data',
                );
                expect(item.modifyTime).toBe(date);
                expect(item.path).toBe('/data/a.txt');
                expect((item as unknown as Record<string, unknown>).date).toBeUndefined();
        });
});

describe('buildFileMap / pruneFileMap', () => {
        it('tracks mtime, size and type', () => {
                const map = buildFileMap([file('/a', 5, 7), file('/b', 6, 8, 'd')]);
                expect(map['/a']).toEqual({ mtime: 5, size: 7, type: '-' });
                expect(map['/b']).toEqual({ mtime: 6, size: 8, type: 'd' });
        });

        it('prunes the oldest entries when over the cap', () => {
                const map: Record<string, FileMapEntry> = {};
                for (let i = 0; i < 10; i++) {
                        map[`/f${i}`] = { mtime: i, size: 0, type: '-' };
                }
                pruneFileMap(map, 5);
                expect(Object.keys(map).sort()).toEqual(['/f5', '/f6', '/f7', '/f8', '/f9']);
        });

        it('does nothing under the cap and defaults to MAX_TRACKED_ENTRIES', () => {
                const map = buildFileMap([file('/a', 1)]);
                pruneFileMap(map);
                expect(Object.keys(map)).toEqual(['/a']);
                expect(MAX_TRACKED_ENTRIES).toBeGreaterThan(0);
        });
});

describe('selectEventFiles — created/updated events', () => {
        it('emits all current files as created on a first diff', () => {
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileCreated',
                        watchedPath: '/',
                        previousMap: {},
                        currentFiles: [file('/a.txt', 10)],
                        now: 20,
                });
                expect(emit.map((f) => f.path)).toEqual(['/a.txt']);
                expect(nextMap['/a.txt']).toEqual({ mtime: 10, size: 100, type: '-' });
        });

        it('does not re-emit unchanged files', () => {
                const previousMap = buildFileMap([file('/a.txt', 10)]);
                const { emit } = selectEventFiles({
                        event: 'fileCreated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/a.txt', 10)],
                        now: 20,
                });
                expect(emit).toEqual([]);
        });

        it('emits updated files on mtime change only', () => {
                const previousMap = buildFileMap([file('/a.txt', 10)]);
                const { emit } = selectEventFiles({
                        event: 'fileUpdated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/a.txt', 15)],
                        now: 20,
                });
                expect(emit.map((f) => f.path)).toEqual(['/a.txt']);
        });

        it('emits updated files on a size-only change (same mtime)', () => {
                const previousMap = buildFileMap([file('/a.txt', 10, 100)]);
                const { emit } = selectEventFiles({
                        event: 'fileUpdated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/a.txt', 10, 250)],
                        now: 20,
                });
                expect(emit.map((f) => f.path)).toEqual(['/a.txt']);
        });

        it('does not emit on an mtime that went backwards', () => {
                const previousMap = buildFileMap([file('/a.txt', 15)]);
                const { emit } = selectEventFiles({
                        event: 'fileUpdated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/a.txt', 10)],
                        now: 20,
                });
                expect(emit).toEqual([]);
        });

        it('does not emit brand-new files for updated events', () => {
                const { emit } = selectEventFiles({
                        event: 'fileUpdated',
                        watchedPath: '/',
                        previousMap: buildFileMap([file('/other.txt', 10)]),
                        currentFiles: [file('/other.txt', 10), file('/new.txt', 12)],
                        now: 20,
                });
                expect(emit).toEqual([]);
        });

        it('handles watchFolderUpdated on the folder entry itself', () => {
                const previousMap = buildFileMap([file('/data', 10, 0, 'd')]);
                const { emit } = selectEventFiles({
                        event: 'watchFolderUpdated',
                        watchedPath: '/data',
                        previousMap,
                        currentFiles: [file('/data', 30, 0, 'd')],
                        now: 40,
                });
                expect(emit.map((f) => f.path)).toEqual(['/data']);
                expect(emit[0].type).toBe('d');
        });

        it('ignores size changes for folder entries', () => {
                const previousMap = buildFileMap([file('/data', 10, 0, 'd')]);
                const { emit } = selectEventFiles({
                        event: 'watchFolderUpdated',
                        watchedPath: '/data',
                        previousMap,
                        currentFiles: [file('/data', 10, 999, 'd')],
                        now: 20,
                });
                expect(emit).toEqual([]);
        });
});

describe('selectEventFiles — deleted events', () => {
        it('emits a stub for files that disappeared', () => {
                const previousMap = buildFileMap([file('/a.txt', 10), file('/b.txt', 11)]);
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileDeleted',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/b.txt', 11)],
                        now: 20,
                });
                expect(emit.length).toBe(1);
                expect(emit[0]).toMatchObject({ path: '/a.txt', name: 'a.txt', type: '-' });
                expect(emit[0].modifyTime.getTime()).toBe(20);
                expect(nextMap['/a.txt']).toBeUndefined();
        });

        it('ignores tracked paths outside the watched folder (regression)', () => {
                const previousMap = { '/data-backup/gone.txt': { mtime: 10, size: 1, type: '-' } };
                const { emit } = selectEventFiles({
                        event: 'fileDeleted',
                        watchedPath: '/data',
                        previousMap,
                        currentFiles: [],
                        now: 20,
                });
                expect(emit).toEqual([]);
        });

        it('matches the event type against the tracked entry type', () => {
                const previousMap = buildFileMap([file('/folder', 10, 0, 'd'), file('/a.txt', 10)]);
                const filesResult = selectEventFiles({
                        event: 'fileDeleted',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [],
                        now: 20,
                });
                expect(filesResult.emit.map((f) => f.path)).toEqual(['/a.txt']);
                const foldersResult = selectEventFiles({
                        event: 'folderDeleted',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [],
                        now: 20,
                });
                expect(foldersResult.emit.map((f) => f.path)).toEqual(['/folder']);
        });

        it('does not emit delete events for pending files that vanish', () => {
                const previousMap: Record<string, FileMapEntry> = {
                        '/a.txt': { mtime: 15, size: 1, type: '-', pending: true, isNew: true },
                };
                const { emit } = selectEventFiles({
                        event: 'fileDeleted',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [],
                        now: 20,
                });
                expect(emit).toEqual([]);
        });
});

describe('selectEventFiles — stability window', () => {
        it('defers newly seen files modified within the window', () => {
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileCreated',
                        watchedPath: '/',
                        previousMap: {},
                        currentFiles: [file('/uploading.csv', 18 * MIN)],
                        now: 20 * MIN,
                        stabilityWindowMs: 10 * MIN,
                });
                expect(emit).toEqual([]);
                expect(nextMap['/uploading.csv']).toMatchObject({
                        pending: true,
                        isNew: true,
                        mtime: 18 * MIN,
                });
        });

        it('emits the deferred created event once the file is stable and outside the window', () => {
                const previousMap: Record<string, FileMapEntry> = {
                        '/uploading.csv': { mtime: 18 * MIN, size: 100, type: '-', pending: true, isNew: true },
                };
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileCreated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/uploading.csv', 18 * MIN, 100)],
                        now: 30 * MIN,
                        stabilityWindowMs: 10 * MIN,
                });
                expect(emit.map((f) => f.path)).toEqual(['/uploading.csv']);
                expect(nextMap['/uploading.csv'].pending).toBeUndefined();
        });

        it('keeps deferring while the file keeps growing', () => {
                const previousMap: Record<string, FileMapEntry> = {
                        '/uploading.csv': { mtime: 18 * MIN, size: 100, type: '-', pending: true, isNew: true },
                };
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileCreated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/uploading.csv', 25 * MIN, 250)],
                        now: 30 * MIN,
                        stabilityWindowMs: 10 * MIN,
                });
                expect(emit).toEqual([]);
                expect(nextMap['/uploading.csv']).toMatchObject({
                        pending: true,
                        isNew: true,
                        size: 250,
                        mtime: 25 * MIN,
                });
        });

        it('does not emit a still-pending file that is stable but still inside the window', () => {
                const previousMap: Record<string, FileMapEntry> = {
                        '/uploading.csv': { mtime: 18 * MIN, size: 100, type: '-', pending: true, isNew: true },
                };
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileCreated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/uploading.csv', 18 * MIN, 100)],
                        now: 22 * MIN,
                        stabilityWindowMs: 10 * MIN,
                });
                expect(emit).toEqual([]);
                expect(nextMap['/uploading.csv'].pending).toBe(true);
        });

        it('re-baselines a settled pending file without emitting when the event does not match', () => {
                // File was deferred as "created", but this trigger listens for "updated":
                // the settled created file must be re-baselined silently.
                const previousMap: Record<string, FileMapEntry> = {
                        '/new.txt': { mtime: 18 * MIN, size: 100, type: '-', pending: true, isNew: true },
                };
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileUpdated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/new.txt', 18 * MIN, 100)],
                        now: 30 * MIN,
                        stabilityWindowMs: 10 * MIN,
                });
                expect(emit).toEqual([]);
                expect(nextMap['/new.txt'].pending).toBeUndefined();
        });

        it('emits the deferred updated event for a settled pending modification', () => {
                const previousMap: Record<string, FileMapEntry> = {
                        '/a.txt': { mtime: 18 * MIN, size: 100, type: '-', pending: true, isNew: false },
                };
                const { emit, nextMap } = selectEventFiles({
                        event: 'fileUpdated',
                        watchedPath: '/',
                        previousMap,
                        currentFiles: [file('/a.txt', 18 * MIN, 100)],
                        now: 30 * MIN,
                        stabilityWindowMs: 10 * MIN,
                });
                expect(emit.map((f) => f.path)).toEqual(['/a.txt']);
                expect(nextMap['/a.txt'].pending).toBeUndefined();
        });

        it('emits immediately when the window is disabled', () => {
                const { emit } = selectEventFiles({
                        event: 'fileCreated',
                        watchedPath: '/',
                        previousMap: {},
                        currentFiles: [file('/a.csv', 19 * MIN)],
                        now: 20 * MIN,
                        stabilityWindowMs: 0,
                });
                expect(emit.length).toBe(1);
        });
});

describe('getErrorMessage', () => {
        it('extracts messages from Error objects and stringifies anything else', () => {
                expect(getErrorMessage(new Error('boom'))).toBe('boom');
                expect(getErrorMessage('plain')).toBe('plain');
                expect(getErrorMessage(42)).toBe('42');
        });
});
