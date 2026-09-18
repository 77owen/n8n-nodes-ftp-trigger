import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	ILoadOptionsFunctions,
	IBinaryData,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeListSearchItems,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

import picomatch from 'picomatch';
import { basename } from 'path';

import ftpClient from 'promise-ftp';
import sftpClient from 'ssh2-sftp-client';

import {
	downloadFile,
	getErrorMessage,
	getFtpConnectOptions,
	getMimeType,
	getSftpConnectOptions,
	normalizeFtpItem,
	normalizeSftpItem,
	pruneFileMap,
	selectEventFiles,
	statWatchedPath,
	type FileMapEntry,
	type ReturnFtpItem,
} from './lib';

export class FtpTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'FTP Trigger',
		name: 'ftpTrigger',
		icon: 'file:ftpTrigger.svg',
		iconColor: 'dark-blue',
		group: ['trigger'],
		version: 1,
		description: 'Trigger a workflow on FTP or SFTP filesystem changes',
		subtitle: '={{$parameter["protocol"] + ": " + $parameter["event"]}}',
		defaults: {
			name: 'FTP Trigger',
		},
		credentials: [
			{
				// nodelinter-ignore-next-line
				name: 'ftp',
				required: true,
				displayOptions: {
					show: {
						protocol: ['ftp'],
					},
				},
				testedBy: 'ftpConnectionTest',
			},
			{
				// nodelinter-ignore-next-line
				name: 'sftp',
				required: true,
				displayOptions: {
					show: {
						protocol: ['sftp'],
					},
				},
				testedBy: 'sftpConnectionTest',
			},
		],
		polling: true,
		inputs: [],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Protocol',
				name: 'protocol',
				type: 'options',
				options: [
					{
						name: 'FTP',
						value: 'ftp',
					},
					{
						name: 'SFTP',
						value: 'sftp',
					},
				],
				default: 'ftp',
				description: 'File transfer protocol',
			},
			{
				displayName: 'Trigger On',
				name: 'triggerOn',
				type: 'options',
				required: true,
				default: 'specificFolder',
				options: [
					{
						name: 'Changes to a Specific File',
						value: 'specificFile',
					},
					{
						name: 'Changes Involving a Specific Folder',
						value: 'specificFolder',
					},
				],
			},
			{
				displayName: 'File',
				name: 'fileToWatch',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				modes: [
					{
						displayName: 'File',
						name: 'list',
						type: 'list',
						placeholder: 'Select a file...',
						typeOptions: {
							searchListMethod: 'fileSearch',
							searchable: true,
						},
					},
					{
						displayName: 'Path',
						name: 'path',
						type: 'string',
						placeholder: '/etc/hosts',
					},
				],
				displayOptions: {
					show: {
						triggerOn: ['specificFile'],
					},
				},
			},
			{
				displayName: 'Watch For',
				name: 'event',
				type: 'options',
				displayOptions: {
					show: {
						triggerOn: ['specificFile'],
					},
				},
				required: true,
				default: 'fileUpdated',
				options: [
					{
						name: 'File Updated',
						value: 'fileUpdated',
					},
				],
				description: 'When to trigger this node',
			},
			{
				displayName: 'Folder',
				name: 'folderToWatch',
				type: 'resourceLocator',
				default: { mode: 'path', value: '' },
				required: true,
				modes: [
					{
						displayName: 'By Path',
						name: 'path',
						type: 'string',
						placeholder: '/home/user/',
					},
				],
				displayOptions: {
					show: {
						triggerOn: ['specificFolder'],
					},
				},
			},
			{
				displayName: 'Watch For',
				name: 'event',
				type: 'options',
				displayOptions: {
					show: {
						triggerOn: ['specificFolder'],
					},
				},
				required: true,
				default: 'fileCreated',
				options: [
					{
						name: 'File Created',
						value: 'fileCreated',
						description: 'When a file is created in the watched folder',
					},
					{
						name: 'File Deleted',
						value: 'fileDeleted',
						description: 'When a file is deleted in the watched folder',
					},
					{
						name: 'File Updated',
						value: 'fileUpdated',
						description: 'When a file is updated in the watched folder',
					},
					{
						name: 'Folder Created',
						value: 'folderCreated',
						description: 'When a folder is created in the watched folder',
					},
					{
						name: 'Folder Deleted',
						value: 'folderDeleted',
						description: 'When a folder is deleted in the watched folder',
					},
					{
						name: 'Folder Updated',
						value: 'folderUpdated',
						description: 'When a folder is updated in the watched folder',
					},
					{
						name: 'Watch Folder Updated',
						value: 'watchFolderUpdated',
						description: 'When the watched folder itself is modified',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						triggerOn: ['specificFolder'],
					},
				},
				options: [
					{
						displayName: 'Filename Filter',
						name: 'fileNamePattern',
						type: 'string',
						default: '',
						placeholder: '*.csv',
						description:
							'Glob pattern to filter files by name (e.g. "HR_Feed*.csv"). Leave empty to match all files.',
					},
					{
						displayName: 'Ignore Files Modified Within Last',
						name: 'ignoreModifiedWithinSeconds',
						type: 'number',
						default: 0,
						typeOptions: {
							minValue: 0,
							maxValue: 86400,
						},
						description:
							'Wait until files have not been modified for this many seconds before triggering, so files that are still being uploaded are not picked up too early. Their event is emitted on a later poll once the file is stable. Set to 0 to disable. Applies to created and updated events.',
					},
					{
						displayName: 'Include File Content',
						name: 'includeFileContent',
						type: 'boolean',
						default: false,
						description:
							'Whether to download the file and include its content as binary data (property "data") in each emitted item. Only applies to file created and file updated events; ignored otherwise.',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						triggerOn: ['specificFile'],
					},
				},
				options: [
					{
						displayName: 'Ignore Files Modified Within Last',
						name: 'ignoreModifiedWithinSeconds',
						type: 'number',
						default: 0,
						typeOptions: {
							minValue: 0,
							maxValue: 86400,
						},
						description:
							'Wait until the file has not been modified for this many seconds before triggering, so it is not picked up while it is still being written. The event is emitted on a later poll once the file is stable. Set to 0 to disable.',
					},
					{
						displayName: 'Include File Content',
						name: 'includeFileContent',
						type: 'boolean',
						default: false,
						description: 'Whether to download the file and include its content as binary data (property "data") in the emitted item',
					},
				],
			},
			{
				displayName: "Changes within subfolders won't trigger this node",
				name: 'subfoldersNotice',
				type: 'notice',
				displayOptions: {
					show: {
						triggerOn: ['specificFolder'],
					},
					hide: {
						event: ['watchFolderUpdated'],
					},
				},
				default: '',
			},
		],
	};

	methods = {
		credentialTest: {
			async ftpConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as ICredentialDataDecryptedObject;
				const ftp = new ftpClient();
				try {
					await ftp.connect(getFtpConnectOptions(credentials));
				} catch (error) {
					await ftp.end().catch(() => {});
					return {
						status: 'Error',
						message: getErrorMessage(error),
					};
				}
				await ftp.end();
				return {
					status: 'OK',
					message: 'Connection successful!',
				};
			},
			async sftpConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as ICredentialDataDecryptedObject;
				const sftp = new sftpClient();
				try {
					await sftp.connect(getSftpConnectOptions(credentials));
				} catch (error) {
					await sftp.end().catch(() => {});
					return {
						status: 'Error',
						message: getErrorMessage(error),
					};
				}
				await sftp.end();
				return {
					status: 'OK',
					message: 'Connection successful!',
				};
			},
		},
		listSearch: {
			async fileSearch(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const protocol = (this.getCurrentNodeParameter('protocol') as string) || 'ftp';
				const credentials = await this.getCredentials(protocol === 'sftp' ? 'sftp' : 'ftp');

				let ftp: ftpClient | undefined;
				let sftp: sftpClient | undefined;
				try {
					if (protocol === 'sftp') {
						sftp = new sftpClient();
						await sftp.connect(getSftpConnectOptions(credentials));
					} else {
						ftp = new ftpClient();
						await ftp.connect(getFtpConnectOptions(credentials));
					}

					const responseData = protocol === 'sftp' ? await sftp!.list('.') : await ftp!.list('.');

					const lowerFilter = (filter ?? '').toLowerCase();
					const results: INodeListSearchItems[] = responseData
						.filter((item) => typeof item !== 'string')
						.map((item) => {
							const element = item as ftpClient.ListingElement;
							return {
								name: element.type === 'd' ? `${element.name}/` : element.name,
								value: element.name,
								description: element.type === 'd' ? 'Folder' : `File (${element.size} bytes)`,
							};
						})
						.filter((item) => !lowerFilter || item.name.toLowerCase().includes(lowerFilter))
						.slice(0, 50);
					return { results };
				} finally {
					if (sftp) {
						await sftp.end().catch(() => {});
					}
					if (ftp) {
						await ftp.end().catch(() => {});
					}
				}
			},
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const protocol = this.getNodeParameter('protocol') as string;
		const triggerOn = this.getNodeParameter('triggerOn') as string;
		const event = this.getNodeParameter('event') as string;
		const webhookData = this.getWorkflowStaticData('node');
		const now = Date.now();

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const fileNamePattern = (options.fileNamePattern as string) || '';
		const isMatch = fileNamePattern ? picomatch(fileNamePattern, { dot: true }) : null;
		const stabilityWindowSeconds = Number(options.ignoreModifiedWithinSeconds ?? 0) || 0;
		const includeFileContent = options.includeFileContent === true;
		// During manual test runs ("Fetch Test Event") the stability window is
		// bypassed, otherwise a just-uploaded file could not be fetched at all.
		const stabilityWindowMs = this.getMode() === 'manual' ? 0 : stabilityWindowSeconds * 1000;

		const credentials = await this.getCredentials(protocol === 'sftp' ? 'sftp' : 'ftp');

		const watchedPath =
			triggerOn === 'specificFile'
				? (this.getNodeParameter('fileToWatch', '', { extractValue: true }) as string)
				: (this.getNodeParameter('folderToWatch', '', { extractValue: true }) as string);

		// Reset the tracked state when the watched path is changed
		const isFirstRun = webhookData.fileMap === undefined;
		if (webhookData.watchedPath !== undefined && webhookData.watchedPath !== watchedPath) {
			webhookData.fileMap = undefined;
		}
		webhookData.watchedPath = watchedPath;
		const previousMap = ((webhookData.fileMap as Record<string, FileMapEntry>) || {}) as Record<
			string,
			FileMapEntry
		>;

		let ftp: ftpClient | undefined;
		let sftp: sftpClient | undefined;

		try {
			if (protocol === 'sftp') {
				sftp = new sftpClient();
				await sftp.connect(getSftpConnectOptions(credentials));
			} else {
				ftp = new ftpClient();
				await ftp.connect(getFtpConnectOptions(credentials));
			}

			let currentFiles: ReturnFtpItem[] = [];

			if (triggerOn === 'specificFolder' && event !== 'watchFolderUpdated') {
				const responseData =
					protocol === 'sftp' ? await sftp!.list(watchedPath) : await ftp!.list(watchedPath);
				currentFiles = responseData
					.filter((item) => typeof item !== 'string')
					.map((item) =>
						protocol === 'sftp'
							? normalizeSftpItem(item as sftpClient.FileInfo, watchedPath)
							: normalizeFtpItem(item as ftpClient.ListingElement, watchedPath),
					);
			} else {
				// 'watchFolderUpdated' and 'specificFile' both track a single path
				// (the watched folder itself, or the watched file) via stat instead
				// of a directory listing
				const entry = await statWatchedPath(protocol, ftp, sftp, watchedPath);
				if (entry) {
					currentFiles = [entry];
				}
			}

			if (isMatch) {
				currentFiles = currentFiles.filter(
					(file) => file.type !== '-' || isMatch(file.name),
				);
			}

			// On the very first run only record the current state without emitting
			// events, so that pre-existing files don't all trigger 'fileCreated'
			if (isFirstRun && this.getMode() !== 'manual') {
				const initialMap: Record<string, FileMapEntry> = {};
				for (const file of currentFiles) {
					initialMap[file.path] = {
						mtime: file.modifyTime.getTime(),
						size: file.size ?? 0,
						type: file.type,
					};
				}
				pruneFileMap(initialMap);
				webhookData.fileMap = initialMap;
				return null;
			}

			const { emit: files, nextMap } = selectEventFiles({
				event,
				watchedPath,
				previousMap,
				currentFiles,
				now,
				stabilityWindowMs,
			});

			pruneFileMap(nextMap);
			webhookData.fileMap = nextMap;

			// Optionally download the content of each emitted file and attach it
			// as binary data. Folder events and file deletions have no content.
			const binaries = new Map<string, IBinaryData>();
			if (includeFileContent && event.startsWith('file') && event !== 'fileDeleted') {
				for (const file of files) {
					try {
						const buffer = await downloadFile(protocol, ftp, sftp, file.path);
						const fileName = basename(file.path);
						binaries.set(
							file.path,
							await this.helpers.prepareBinaryData(buffer, fileName, getMimeType(fileName)),
						);
					} catch (error) {
						file.downloadError = getErrorMessage(error);
					}
				}
			}

			if (files.length) {
				const returnItems: INodeExecutionData[] = files.map((file) => {
					const item: INodeExecutionData = { json: file as unknown as IDataObject };
					const binary = binaries.get(file.path);
					if (binary) {
						item.binary = { data: binary };
					}
					return item;
				});
				return [returnItems];
			}

			if (this.getMode() === 'manual') {
				throw new NodeApiError(this.getNode(), {
					message: 'No data with the current filter could be found',
				});
			}

			return null;
		} finally {
			if (sftp) {
				await sftp.end().catch(() => {});
			}
			if (ftp) {
				await ftp.end().catch(() => {});
			}
		}
	}
}
