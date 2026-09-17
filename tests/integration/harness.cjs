/*
 * Integration harness: exercises FtpTrigger.poll() against real local FTP & SFTP servers.
 * Runs standalone (`node tests/integration/harness.cjs`, requires `npm run build` first)
 * or via vitest when RUN_INTEGRATION=1 (see tests/integration/run.test.ts).
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const { FtpTrigger } = require(path.join(REPO, 'dist/nodes/FtpTrigger/FtpTrigger.node.js'));
const ssh2 = require('ssh2');
const { Server: SshServer, utils: sshUtils } = ssh2;
const { STATUS_CODE } = ssh2.utils.sftp;
const FtpSrv = require('ftp-srv');

const FTP_PORT = Number(process.env.FTP_PORT) || 2121;
const SFTP_PORT = Number(process.env.SFTP_PORT) || 2222;
const FTP_ROOT = process.env.FTP_ROOT || '/tmp/ftp-root';
const SFTP_ROOT = process.env.SFTP_ROOT || '/tmp/sftp-root';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
        if (cond) {
                passed++;
                console.log(`  ✔ ${name}`);
        } else {
                failed++;
                console.log(`  ✘ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
        }
}

/* ---------------- Mock poll context (mirrors n8n IPollFunctions) ---------------- */
function makeContext({ params, credentials, mode = 'trigger' }) {
        const staticData = { node: {} };
        const ctx = {
                params,
                getNodeParameter(name, fallbackValue, options) {
                        const value = params[name] !== undefined ? params[name] : fallbackValue;
                        if (options?.extractValue && value && typeof value === 'object' && 'value' in value) {
                                return value.value;
                        }
                        return value;
                },
                async getCredentials(type) {
                        return credentials[type];
                },
                getWorkflowStaticData(type) {
                        if (!staticData[type]) staticData[type] = {};
                        return staticData[type];
                },
                getMode() {
                        return mode;
                },
                getNode() {
                        return {
                                name: 'FTP Trigger',
                                type: 'n8n-nodes-ftp-trigger.ftpTrigger',
                                typeVersion: 1,
                        };
                },
                helpers: {
                        returnJsonArray(d) {
                                if (Array.isArray(d))
                                        return d.map((x) => (x && x.json ? { ...x, json: x.json } : { json: x }));
                                return [{ json: d }];
                        },
                        async prepareBinaryData(buffer, fileName, mimeType) {
                                return { data: Buffer.from(buffer).toString('base64'), fileName, mimeType };
                        },
                },
                logger: { warn() {}, info() {}, error() {}, debug() {} },
        };
        return ctx;
}

function items(result) {
        if (!result) return [];
        return result[0].map((i) => i.json);
}

const node = new FtpTrigger();

/* ---------------- SFTP server (in-process, ssh2, chrooted to SFTP_ROOT) ---------------- */
function longnameFor(st, name) {
        const perms = st.isDirectory() ? 'drwxr-xr-x' : st.isSymbolicLink() ? 'lrwxrwxrwx' : '-rw-r--r--';
        return `${perms} 1 owner group ${st.size} Jan  1 00:00 ${name}`;
}

function chroot(p) {
        return path.join(SFTP_ROOT, p);
}

function startSftpServer(hostKeys) {
        return new Promise((resolve, reject) => {
                const server = new SshServer({ hostKeys }, (client) => {
                        client.on('authentication', (ctx) => {
                                // Accept everything: key-format parsing happens client-side,
                                // which is exactly what we want to test
                                ctx.accept();
                        });
                        client.on('ready', () => {
                                client.on('session', (accept) => {
                                        const session = accept();
                                        session.on('sftp', (acceptSftp) => {
                                                const sftpStream = acceptSftp();
                                                const dirHandles = new Map();
                                                let handleSeq = 0;

                                                sftpStream.on('REALPATH', (reqid, p) => {
                                                        sftpStream.name(reqid, [
                                                                {
                                                                        filename: p,
                                                                        longname: longnameFor(fs.statSync(SFTP_ROOT), '.'),
                                                                        attrs: { mode: 0o755 | 0o040000, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
                                                                },
                                                        ]);
                                                });

                                                const replyStat = (reqid, p) => {
                                                        try {
                                                                const st = fs.statSync(chroot(p));
                                                                sftpStream.attrs(reqid, {
                                                                        mode: st.mode,
                                                                        uid: st.uid,
                                                                        gid: st.gid,
                                                                        size: st.size,
                                                                        atime: Math.floor(st.atimeMs / 1000),
                                                                        mtime: Math.floor(st.mtimeMs / 1000),
                                                                });
                                                        } catch (e) {
                                                                sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                                                        }
                                                };

                                                sftpStream.on('STAT', replyStat);
                                                sftpStream.on('LSTAT', replyStat);

                                                sftpStream.on('OPENDIR', (reqid, p) => {
                                                        const id = `h${handleSeq++}`;
                                                        dirHandles.set(id, { dir: p, sent: false });
                                                        sftpStream.handle(reqid, Buffer.from(id));
                                                });

                                                sftpStream.on('READDIR', (reqid, handleBuf) => {
                                                        const h = dirHandles.get(handleBuf.toString());
                                                        if (!h || h.sent) {
                                                                sftpStream.status(reqid, STATUS_CODE.EOF);
                                                                return;
                                                        }
                                                        h.sent = true;
                                                        const dirPath = chroot(h.dir);
                                                        const entries = fs.readdirSync(dirPath).map((name) => {
                                                                const st = fs.statSync(path.join(dirPath, name));
                                                                return {
                                                                        filename: name,
                                                                        longname: longnameFor(st, name),
                                                                        attrs: {
                                                                                mode: st.mode,
                                                                                uid: st.uid,
                                                                                gid: st.gid,
                                                                                size: st.size,
                                                                                atime: Math.floor(st.atimeMs / 1000),
                                                                                mtime: Math.floor(st.mtimeMs / 1000),
                                                                        },
                                                                };
                                                        });
                                                        sftpStream.name(reqid, entries);
                                                });

                                                sftpStream.on('CLOSE', (reqid) => {
                                                        sftpStream.status(reqid, STATUS_CODE.OK);
                                                });
                                                                                               /*
                                                                                                * OPEN + READ: file downloads (sftp.get) for the Include File Content option.
                                                                                                * Only read mode (flags === 1) is supported - enough for downloads.
                                                                                                */
                                                                                               const fileHandles = new Map();
                                                                                               
                                                                                               sftpStream.on('OPEN', (reqid, p, flags) => {
                                                                                               	try {
                                                                                               		if (flags === 1) {
                                                                                               			// READ: open a fd and hand out a SFTP handle for it
                                                                                               			const fd = fs.openSync(chroot(p), 'r');
                                                                                               			const id = 'f' + handleSeq++;
                                                                                               			fileHandles.set(id, fd);
                                                                                               			sftpStream.handle(reqid, Buffer.from(id));
                                                                                               		} else {
                                                                                               			sftpStream.status(reqid, STATUS_CODE.PERMISSION_DENIED);
                                                                                               		}
                                                                                               	} catch (e) {
                                                                                               		sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                                                                                               	}
                                                                                               });
                                                                                               
                                                                                               sftpStream.on('READ', (reqid, handleBuf, offset, len) => {
                                                                                               	const fd = fileHandles.get(handleBuf.toString());
                                                                                               	if (fd === undefined) {
                                                                                               		sftpStream.status(reqid, STATUS_CODE.FAILURE);
                                                                                               		return;
                                                                                               	}
                                                                                               	const buf = Buffer.alloc(Math.min(len, 32768));
                                                                                               	let bytesRead;
                                                                                               	try {
                                                                                               		bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
                                                                                               	} catch (e) {
                                                                                               		sftpStream.status(reqid, STATUS_CODE.FAILURE);
                                                                                               		return;
                                                                                               	}
                                                                                               	if (bytesRead <= 0) {
                                                                                               		sftpStream.status(reqid, STATUS_CODE.EOF);
                                                                                               		return;
                                                                                               	}
                                                                                               	sftpStream.data(reqid, buf.subarray(0, bytesRead));
                                                                                               });
                                        });
                                });
                        });
                });
                server.on('error', reject);
                server.listen(SFTP_PORT, '127.0.0.1', () => resolve(server));
        });
}

/* ---------------- param builders ---------------- */
function folderParams(protocol, event, folder = '/', options) {
        const p = {
                protocol,
                triggerOn: 'specificFolder',
                event,
                folderToWatch: { mode: 'path', value: folder },
        };
        if (options) p.options = options;
        return p;
}

const ftpCredentials = { ftp: { host: '127.0.0.1', port: FTP_PORT, username: 'test', password: 'test' } };

/* ---------------- FTP scenarios ---------------- */
async function runFtpScenarios() {
        console.log('\n=== FTP scenarios ===');
        const P = (event, folder, options) => folderParams('ftp', event, folder, options);
        const F = (name) => path.join(FTP_ROOT, name);
        // minute-granular LIST times: bump by 2 minutes to make mtime changes visible
        const bump = (name) => {
                const t = new Date(Date.now() + 120 * 1000);
                fs.utimesSync(F(name), t, t);
        };

        let ctx = makeContext({ params: P('fileCreated', '/'), credentials: ftpCredentials });
        let result = await node.poll.call(ctx);
        check('first run returns null (no flood of false "created" events)', result === null);
        check(
                'first run records state',
                Object.keys(ctx.getWorkflowStaticData('node').fileMap).length >= 1,
                ctx.getWorkflowStaticData('node').fileMap,
        );

        fs.writeFileSync(F('a.txt'), 'hello');
        result = await node.poll.call(ctx);
        check(
                'fileCreated triggers for new file',
                items(result).length === 1 && items(result)[0].name === 'a.txt',
                items(result),
        );
        check(
                'item has path + modifyTime',
                items(result)[0].path === '/a.txt' && items(result)[0].modifyTime instanceof Date,
                items(result)[0],
        );
        result = await node.poll.call(ctx);
        check('no changes -> null', result === null);

        const ctxU = makeContext({ params: P('fileUpdated', '/'), credentials: ftpCredentials });
        await node.poll.call(ctxU);
        bump('a.txt');
        result = await node.poll.call(ctxU);
        check(
                'fileUpdated triggers on mtime change',
                items(result).length === 1 && items(result)[0].name === 'a.txt',
                items(result),
        );
        result = await node.poll.call(ctxU);
        check('fileUpdated does not re-trigger without change', result === null);

        fs.writeFileSync(F('b.txt'), 'bye');
        const ctxD = makeContext({ params: P('fileDeleted', '/'), credentials: ftpCredentials });
        await node.poll.call(ctxD);
        fs.unlinkSync(F('b.txt'));
        result = await node.poll.call(ctxD);
        check(
                'fileDeleted triggers for removed file',
                items(result).length === 1 && items(result)[0].name === 'b.txt',
                items(result),
        );

        fs.writeFileSync(F('x.txt'), 'no');
        fs.writeFileSync(F('y.csv'), 'yes');
        const ctxF = makeContext({
                params: P('fileCreated', '/', { fileNamePattern: '*.csv' }),
                credentials: ftpCredentials,
        });
        result = await node.poll.call(ctxF);
        check('filename filter: first run records state', result === null);
        fs.writeFileSync(F('z.csv'), 'yes2');
        result = await node.poll.call(ctxF);
        check(
                'filename filter: matching csv triggers',
                items(result).length === 1 && items(result)[0].name === 'z.csv',
                items(result),
        );
        fs.writeFileSync(F('w.txt'), 'no2');
        result = await node.poll.call(ctxF);
        check('filename filter: non-matching txt does not trigger', result === null, items(result));

        fs.mkdirSync(F('data'), { recursive: true });
        const ctxW = makeContext({ params: P('watchFolderUpdated', '/data'), credentials: ftpCredentials });
        result = await node.poll.call(ctxW);
        check('watchFolderUpdated: first run returns null', result === null);
        bump('data');
        result = await node.poll.call(ctxW);
        check(
                'watchFolderUpdated triggers when folder mtime changes',
                items(result).length === 1 && items(result)[0].type === 'd',
                items(result),
        );

        fs.writeFileSync(F('manual.txt'), 'm');
        const ctxM = makeContext({
                params: P('fileCreated', '/'),
                credentials: ftpCredentials,
                mode: 'manual',
        });
        result = await node.poll.call(ctxM);
        check('manual mode: first fetch returns current listing as test data', items(result).length >= 1);

        const ctxR = makeContext({ params: P('fileCreated', '/data'), credentials: ftpCredentials });
        await node.poll.call(ctxR);
        ctxR.params.folderToWatch = { mode: 'path', value: '/' };
        result = await node.poll.call(ctxR);
        check('changing watched folder works (state reset)', result === null || Array.isArray(result));

        // stability window: files written moments ago are deferred until stable
        const ctxSW = makeContext({
                params: P('fileCreated', '/', { ignoreModifiedWithinSeconds: 300 }),
                credentials: ftpCredentials,
        });
        await node.poll.call(ctxSW); // first run: baseline only
        fs.writeFileSync(F('upload.csv'), 'partial');
        result = await node.poll.call(ctxSW);
        check('stability window: just-written file is deferred', result === null, items(result));
        check(
                'stability window: deferred file tracked as pending',
                ctxSW.getWorkflowStaticData('node').fileMap['/upload.csv']?.pending === true,
                ctxSW.getWorkflowStaticData('node').fileMap['/upload.csv'],
        );
        const old = new Date(Date.now() - 600 * 1000);
        fs.utimesSync(F('upload.csv'), old, old);
        result = await node.poll.call(ctxSW);
        check(
                'stability window: settled file triggers on a later poll',
                items(result).length === 1 && items(result)[0].name === 'upload.csv',
                items(result),
        );
        check(
                'stability window: pending flag cleared after emission',
                ctxSW.getWorkflowStaticData('node').fileMap['/upload.csv']?.pending === undefined,
        );

        // includeFileContent: emitted items carry the file content as binary data
        const ctxB = makeContext({
                params: P('fileCreated', '/', { includeFileContent: true }),
                credentials: ftpCredentials,
        });
        await node.poll.call(ctxB); // first run: baseline only
        fs.writeFileSync(F('payload.csv'), 'id,name\n1,Ada\n');
        result = await node.poll.call(ctxB);
        const binary = result?.[0]?.[0]?.binary?.data;
        check(
                'includeFileContent: item carries binary data',
                binary?.data === Buffer.from('id,name\n1,Ada\n').toString('base64'),
                binary,
        );
        check('includeFileContent: mimeType detected', binary?.mimeType === 'text/csv', binary);
        check('includeFileContent: fileName set', binary?.fileName === 'payload.csv', binary);
}

/* ---------------- SFTP scenarios ---------------- */
async function runSftpScenarios(credentials) {
        console.log('\n=== SFTP scenarios ===');
        const P = (event, folder, options) => folderParams('sftp', event, folder, options);
        const F = (name) => path.join(SFTP_ROOT, name);

        let ctx = makeContext({ params: P('fileCreated', '/'), credentials });
        let result = await node.poll.call(ctx);
        check('first run returns null', result === null);
        check(
                'first run records state',
                Object.keys(ctx.getWorkflowStaticData('node').fileMap).length >= 1,
                ctx.getWorkflowStaticData('node').fileMap,
        );

        fs.writeFileSync(F('a.txt'), 'hello');
        result = await node.poll.call(ctx);
        check(
                'fileCreated triggers for new file',
                items(result).length === 1 && items(result)[0].name === 'a.txt',
                items(result),
        );
        result = await node.poll.call(ctx);
        check('no changes -> null', result === null);

        const ctxU = makeContext({ params: P('fileUpdated', '/'), credentials });
        await node.poll.call(ctxU);
        const t = new Date(Date.now() + 5000);
        fs.utimesSync(F('a.txt'), t, t);
        result = await node.poll.call(ctxU);
        check(
                'fileUpdated triggers on mtime change',
                items(result).length === 1,
                items(result),
        );

        fs.writeFileSync(F('b.txt'), 'bye');
        const ctxD = makeContext({ params: P('fileDeleted', '/'), credentials });
        await node.poll.call(ctxD);
        fs.unlinkSync(F('b.txt'));
        result = await node.poll.call(ctxD);
        check(
                'fileDeleted triggers for removed file',
                items(result).length === 1 && items(result)[0].name === 'b.txt',
                items(result),
        );

        const ctxW = makeContext({ params: P('watchFolderUpdated', '/'), credentials });
        result = await node.poll.call(ctxW);
        check('watchFolderUpdated: first run returns null', result === null);
        const t2 = new Date(Date.now() + 150 * 1000);
        fs.utimesSync(SFTP_ROOT, t2, t2);
        result = await node.poll.call(ctxW);
        check(
                'watchFolderUpdated triggers when root dir mtime changes',
                items(result).length === 1 && items(result)[0].type === 'd',
                items(result),
        );

        fs.writeFileSync(F('watched.csv'), 'v1');
        const fileParams = {
                protocol: 'sftp',
                triggerOn: 'specificFile',
                event: 'fileUpdated',
                fileToWatch: { mode: 'path', value: '/watched.csv' },
        };
        const ctxS = makeContext({ params: fileParams, credentials });
        result = await node.poll.call(ctxS);
        check('specificFile: first run returns null', result === null);
        const t3 = new Date(Date.now() + 9000);
        fs.writeFileSync(F('watched.csv'), 'v2');
        fs.utimesSync(F('watched.csv'), t3, t3);
        result = await node.poll.call(ctxS);
        check(
                'specificFile: fileUpdated triggers',
                items(result).length === 1 && items(result)[0].name === 'watched.csv',
                items(result),
        );

        // listSearch.fileSearch (resource locator "from list")
        const loadCtx = makeContext({ params: {}, credentials });
        loadCtx.getCurrentNodeParameter = (name) => (name === 'protocol' ? 'sftp' : undefined);
        const search = await node.methods.listSearch.fileSearch.call(loadCtx, 'a.txt');
        check(
                'fileSearch finds a.txt',
                search.results.length === 1 && search.results[0].value === 'a.txt',
                search,
        );
        const searchAll = await node.methods.listSearch.fileSearch.call(loadCtx);
        check(
                'fileSearch returns listing with descriptions',
                searchAll.results.length >= 2 && searchAll.results.every((r) => r.description),
                searchAll,
        );

        // includeFileContent over SFTP
        fs.writeFileSync(F('seed2.txt'), 'seed2');
        const ctxB = makeContext({
                params: P('fileCreated', '/', { includeFileContent: true }),
                credentials,
        });
        result = await node.poll.call(ctxB);
        check('includeFileContent (SFTP): first run records state', result === null);
        fs.writeFileSync(F('downloaded.txt'), 'sftp-bytes');
        result = await node.poll.call(ctxB);
        const sftpBinary = result?.[0]?.[0]?.binary?.data;
        check(
                'includeFileContent (SFTP): binary data attached',
                sftpBinary?.data === Buffer.from('sftp-bytes').toString('base64') &&
                        sftpBinary?.mimeType === 'text/plain' &&
                        sftpBinary?.fileName === 'downloaded.txt',
                sftpBinary,
        );
}

/* ---------------- credential tests ---------------- */
async function runCredentialTests(credentials) {
        console.log('\n=== Credential tests ===');
        const ftpResult = await node.methods.credentialTest.ftpConnectionTest.call(
                {},
                { data: credentials.ftp },
        );
        check('ftpConnectionTest OK', ftpResult.status === 'OK', ftpResult);
        const sftpResult = await node.methods.credentialTest.sftpConnectionTest.call(
                {},
                { data: credentials.sftp },
        );
        check('sftpConnectionTest OK', sftpResult.status === 'OK', sftpResult);
        const badResult = await node.methods.credentialTest.sftpConnectionTest.call(
                {},
                { data: { host: '127.0.0.1', port: 1, username: 'x', password: 'y' } },
        );
        check(
                'sftpConnectionTest reports error for unreachable host',
                badResult.status === 'Error',
                badResult,
        );
}

/* ---------------- main ---------------- */
(async () => {
        fs.rmSync(FTP_ROOT, { recursive: true, force: true });
        fs.rmSync(SFTP_ROOT, { recursive: true, force: true });
        fs.mkdirSync(FTP_ROOT, { recursive: true });
        fs.mkdirSync(SFTP_ROOT, { recursive: true });
        fs.writeFileSync(path.join(FTP_ROOT, 'seed.txt'), 'seed');
        fs.writeFileSync(path.join(SFTP_ROOT, 'seed.txt'), 'seed');

        const ftpServer = new FtpSrv({
                url: `ftp://127.0.0.1:${FTP_PORT}`,
                anonymous: true,
                pasv_url: '127.0.0.1',
                pasv_min: 2130,
                pasv_max: 2140,
        });
        ftpServer.on('login', (data, accept) => {
                accept({ root: FTP_ROOT });
        });
        await ftpServer.listen();

        const hostKey = sshUtils.generateKeyPairSync('ed25519');
        await startSftpServer([hostKey.private]);

        const sftpPasswordCredentials = {
                sftp: { host: '127.0.0.1', port: SFTP_PORT, username: 'u', password: 'p' },
        };

        // private key with literal \n escapes, like keys pasted single-line into n8n (issue #1)
        const rawKey = hostKey.private;
        const escapedKey = rawKey.replace(/\n/g, '\\n');
        const sftpKeyCredentials = {
                sftp: {
                        host: '127.0.0.1',
                        port: SFTP_PORT,
                        username: 'u',
                        password: '',
                        privateKey: escapedKey,
                },
        };

        try {
                await runFtpScenarios();
                await runSftpScenarios(sftpPasswordCredentials);
                console.log('\n=== SFTP with private key (single-line \\n-escaped, issue #1) ===');
                const ctxKey = makeContext({
                        params: folderParams('sftp', 'fileCreated', '/'),
                        credentials: sftpKeyCredentials,
                });
                await node.poll.call(ctxKey);
                check('poll connects with escaped private key', true);
                const ctxKeyBad = makeContext({
                        params: folderParams('sftp', 'fileCreated', '/'),
                        credentials: {
                                sftp: { host: '127.0.0.1', port: SFTP_PORT, username: 'u', password: '', privateKey: 'not a key' },
                        },
                });
                try {
                        await node.poll.call(ctxKeyBad);
                        check('invalid key rejected', false, 'expected error');
                } catch (e) {
                        check('invalid key rejected', /privateKey|parse|key|format/i.test(e.message), e.message);
                }
                await runCredentialTests({ ftp: ftpCredentials.ftp, sftp: sftpPasswordCredentials.sftp });
        } catch (e) {
                failed++;
                console.error('HARNESS ERROR:', e);
        }

        console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
        process.exit(failed ? 1 : 0);
})().catch((e) => {
        console.error(e);
        process.exit(1);
});
