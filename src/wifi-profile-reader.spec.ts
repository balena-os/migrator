/*
 * Copyright 2023 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFile, ChildProcess, ExecFileException } from 'child_process';
import * as _debug from 'debug';
import { promises as fs } from 'fs';
import { platform } from 'os';
import { promisify } from 'util';
import RWMutex = require('rwmutex');

import { tmp } from '@kb2ma/etcher-sdk';

const execFileAsync = promisify(execFile);
const debug = _debug('migrator:wifi-profile-reader');
const MODULE_NAME = 'WiFiProfileManagement'
// Must specify Powershell table output width to ensure does not truncate.
const PWSH_FORMAT_TABLE = '| Format-Table'
const PWSH_OUTPUT_WIDTH = '| Out-String -Stream -Width 300'
const VALID_AUTH_MODES = ['WPA2PSK', 'WPA3SAE', 'open', 'OWE']
const KEYLESS_AUTH_MODES = ['open', 'OWE']

// This code provides a wrapper around the Windows Powershell WiFiProfileManagement 
// module (https://github.com/jcwalker/WiFiProfileManagement) to retrieve profile
// information.

/** Output type for promisified execFile(). */
interface ExecResult {
	child?: ChildProcess;
	stdout: string;
	stderr: string;
}

const execMutex = new RWMutex();

/** Wrapper to ensure provided function is executed only once at a time. */
async function withExecMutex<T>(fn: () => T): Promise<T> {
	const unlock = await execMutex.lock();
	try {
		return await fn();
	} finally {
		unlock();
	}
}

/**
 * @summary Run a Powershell script
 * @param {Array<String>} commands - list of commands to run
 * @return String with stdout from command
 */
const runPowershell = async (commands: string[]): Promise<string> => {
	if (platform() !== 'win32') {
		return '';
	}
	let output = {stdout: '', stderr: ''};
	await tmp.withTmpFile({ keepOpen: false, postfix: '.ps1' }, async (file: tmp.TmpFileResult) => {
		await fs.writeFile(file.path, commands.join('\r\n'));
		await withExecMutex(async () => {
			output = await execFileAsync('powershell', [
				'-NonInteractive',
				'-ExecutionPolicy',
				'RemoteSigned',
				'-File',
				file.path,
			]);
			debug('stdout:', output.stdout);
			debug('stderr:', output.stderr);
		});
	});
	return output.stdout;
};

/** Configuration values for a single WiFi network profile. */
export interface WifiProfile {
	name: string;
	ssid: string;
	key: string;
}

/** Attributes of a WiFi connection useful for testing connectivity. */
export interface WifiConnection {
	profileName: string;
	interfaceIndex: string;
	ipv4Connectivity: string;
	ipv6Connectivity: string;
}

/** 
 * Describes a column in a Powershell table. Positions refer to offset in a given 
 * line of the table.
 */
interface Column {
	title: string;
	startPos: number;
	endPos: number
}

/**
 * Reads WiFi profiles. Allows for separately specifying in the constructor a custom 
 * path to the required Powershell module.
 */
export class ProfileReader {
	private setupCommands: string[] = [];

	/** If on a built-in module path, leave modulePath empty. */
	constructor(modulePath = '') {
		if (modulePath) {
			this.setupCommands.push(`$Env:PSModulePath = "$Env:PSModulePath;${modulePath}"`)
			this.setupCommands.push(`Import-Module ${MODULE_NAME}`)
		}
		debug(`setupCommands: ${this.setupCommands}`)
	}

	/** 
	 * Read column positions from the header separator ('---') line. See the example below.
	 * Does not validate column names.
	 * 
	 * ProfileName          SignalQuality  SecurityEnabled dot11DefaultAuthAlgorithm dot11DefaultCipherAlgorithm SSID
	 * -----------          -------------  --------------- ------------------------- --------------------------- ----
	 */
	private readColumns(columns:Column[] = [], line = '') {
		let linePos = 0
		for (let i = 0; i < columns.length; i++) {
			columns[i].startPos = linePos
			linePos = line.indexOf(' -', linePos)

			if (linePos == -1) {
				if (i == columns.length - 1) {
					// last column
					columns[i].endPos = line.length
					debug(`readColumns: col ${i}: ${columns[i].startPos}, ${columns[i].endPos}`)
				} else {
					throw Error(`readColumns: Only found ${i} columns.`)
				}
			} else {
				columns[i].endPos = linePos
				debug(`readColumns: col ${i}: ${columns[i].startPos}, ${columns[i].endPos}`)
				linePos += 1 // advance past space to next column
			}
		}
	}

	/**
	 * Collect the list of available WiFi network profiles. Network must use
	 * WPA2PSK authentication.
	 *
	 * @return Array of WifiProfile found; empty if none
	 */
	public async collectWifiProfiles(): Promise<WifiProfile[]> {
		// First get list of profile names and keys.
		const profiles = await this.readWifiProfiles()
		// Update SSID for each profile
		await this.readSsid(profiles)
		

		return profiles
	}

	/** Reads the SSID for each profile in the provided list. */
	public async readConnectionProfile(profiles: WifiProfile[]) {
		/* Retrieves output formatted like the example below.
		 * 
		 * PS > Get-NetConnectionProfile | Format-Table -Property Name, InterfaceIndex, IPv4Connectivity, IPv6Connectivity
		 * 
		 * Name      InterfaceIndex IPv4Connectivity IPv6Connectivity
		 * ----      -------------- ---------------- ----------------
		 * gal47lows              9         Internet        NoTraffic
		 */

		let commands = Array.from(this.setupCommands)
		commands.push(`Get-NetConnectionProfile ${PWSH_FORMAT_TABLE} -Property Name, InterfaceIndex, IPv4Connectivity, IPv6Connectivity ${PWSH_OUTPUT_WIDTH}`)
		let listText = ''
		try {
			listText = await runPowershell(commands);
		} catch (error) {
			throw(`readConnectionProfile: ${error}`);
		}

		// define columns
		const columnNames = ['Name', 'InterfaceIndex', 'IPv4Connectivity', 'IPv6Connectivity']
		const columns:Column[] = columnNames.map(name => ({title: name, startPos: 0, endPos: 0}))

		let foundHeader = false
		for (let line of listText.split('\n')) {
			if (!columns[0].endPos) {
				if(line.indexOf('-----') >= 0) {
					this.readColumns(columns, line)
				} else {
					continue
				}
			} else {
				// Find profile
				let index = columnNames.indexOf('Name')
				const name = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (!name) {
					// name is blank
					continue
				}
				let profile:WifiProfile = {name: '', key: '', ssid: ''}
				for (let p of profiles) {
					if (p.name == name) {
						profile = p
					}
				}
				if (profile.name) {
					debug(`readConnectionProfile: ${line}`)
					index = columnNames.indexOf('InterfaceIndex')
					const interfaceIndex = line.substring(columns[index].startPos, columns[index].endPos)
					profile.interfaceIndex = interfaceIndex.trim()

					index = columnNames.indexOf('IPv4Connectivity')
					const ipv4Connectivity = line.substring(columns[index].startPos, columns[index].endPos)
					profile.ipv4Connectivity = ipv4Connectivity.trim()
					index = columnNames.indexOf('IPv6Connectivity')
					const ipv6Connectivity = line.substring(columns[index].startPos, columns[index].endPos)
					profile.ipv6Connectivity = ipv6Connectivity.trim()
				} else {
					debug(`readConnectionProfile: Can't find profile named ${name}`)
				}
			}
		}
	}

	/** Reads the SSID for each profile in the provided list. */
	public async readSsid(profiles: WifiProfile[]) {
		/* Retrieves output formatted like the example below.
		 *
		 *  > Get-WiFiAvailableNetwork
		 * 
		 * ProfileName          SignalQuality  SecurityEnabled dot11DefaultAuthAlgorithm dot11DefaultCipherAlgorithm SSID
		 * -----------          -------------  --------------- ------------------------- --------------------------- ----
		 * gal47lows            83             True            DOT11_AUTH_ALGO_RSNA_PSK  DOT11_CIPHER_ALGO_CCMP      gal47lows
		 *                      83             True            DOT11_AUTH_ALGO_RSNA_PSK  DOT11_CIPHER_ALGO_CCMP      gal47lows
		 */
		let commands = Array.from(this.setupCommands)
		commands.push(`Get-WiFiAvailableNetwork ${PWSH_FORMAT_TABLE} ${PWSH_OUTPUT_WIDTH}`)
		let listText = ''
		try {
			listText = await runPowershell(commands);
		} catch (error) {
			throw(`readSsid: ${error}`);
		}

		// define columns
		const columnNames = ['ProfileName', 'SignalQuality', 'SecurityEnabled', 'dot11DefaultAuthAlgorithm', 'dot11DefaultCipherAlgorithm', 'SSID']
		const columns:Column[] = columnNames.map(name => ({title: name, startPos: 0, endPos: 0}))

		let foundHeader = false
		for (let line of listText.split('\n')) {
			if (!columns[0].endPos) {
				if(line.indexOf('-----') >= 0) {
					this.readColumns(columns, line)
				} else {
					continue
				}
			} else {
				// Find profile
				let index = columnNames.indexOf('ProfileName')
				const name = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (!name) {
					// name is blank
					continue
				}
				let profile:WifiProfile = {name: '', key: '', ssid: ''}
				for (let p of profiles) {
					if (p.name == name) {
						profile = p
					}
				}
				if (profile.name) {
					debug(`readSsid: ${line}`)
					index = columnNames.indexOf('SSID')
					const ssid = line.substring(columns[index].startPos, columns[index].endPos)
					profile.ssid = ssid.trim()
				} else {
					debug(`readSsid: Can't find profile named ${name}`)
				}
			}
		}
	}

	/**
	 * Reads the table of WiFi profiles, and returns an array of profiles with
	 * WPA2 PSK authentication. Writes to stdout for a profile that does not use
	 * this authentication.
	 *
	 * @return Array of WifiProfile found; empty if none
	 */
	private async readWifiProfiles(): Promise<WifiProfile[]> {
		/* Retrieves output formatted like the example below.
		 *
		 * > Get-WiFiProfile -ClearKey
		 *
		 * ProfileName               ConnectionMode Authentication Encryption Password
		 * -----------               -------------- -------------- ---------- --------
		 * gal47lows                 auto           WPA2PSK        AES        xxxxx
		 */

		let commands = Array.from(this.setupCommands)
		commands.push(`Get-WiFiProfile -ClearKey ${PWSH_FORMAT_TABLE} ${PWSH_OUTPUT_WIDTH}`)
		let listText = ''
		try {
			listText = await runPowershell(commands);
		} catch (error) {
			throw(`readWifiProfiles: ${error}`);
		}

		// Search for content in specific columns, in a language independent way.
		// define columns
		const columnNames = ['ProfileName', 'ConnectionMode', 'Authentication', 'Encryption', 'Password']
		const columns:Column[] = columnNames.map(name => ({title: name, startPos: 0, endPos: 0}))

		let profiles:WifiProfile[] = []
		for (let line of listText.split('\n')) {
			if (!columns[0].endPos) {
				if(line.indexOf('-----') >= 0) {
					this.readColumns(columns, line)
				} else {
					continue
				}
			} else {
				let profile:WifiProfile = { name: '', key: '', ssid: ''}
				let index = columnNames.indexOf('ProfileName')
				const name = line.substring(columns[index].startPos, columns[index].endPos)
				if (!name.trim()) {
					// skip blank lines, etc.
					continue
				}
				profile.name = name.trim()

				index = columnNames.indexOf('Authentication')
				const auth = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (VALID_AUTH_MODES.includes(auth)) {
					debug(`readWifiProfiles: ${line}`)
					index = columnNames.indexOf('Password')
					const password = line.substring(columns[index].startPos, columns[index].endPos)
					profile.key = password.trim()
					if (!profile.key && !KEYLESS_AUTH_MODES.includes(auth)) {
						console.log(`Reject WiFi profile ${profile.name} with auth ${auth} but no passphrase`)
					} else {
						profiles.push(profile)
					}
				} else {
					console.log(`Reject WiFi profile ${profile.name} with auth ${auth}`)
				}
			}
		}
		return profiles
	};
}
