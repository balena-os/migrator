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
import got from 'got';
import * as wifiProfileReader from './wifi-profile-reader.spec'
import { tmp } from '@kb2ma/etcher-sdk';

const execFileAsync = promisify(execFile);
const debug = _debug('migrator:networking-analyzer');
// Must specify Powershell line output width to ensure output does not truncate.
export const PWSH_FORMAT_TABLE = '| Format-Table'
export const PWSH_OUTPUT_WIDTH = '| Out-String -Stream -Width 300'
// These collections are used to qualify acceptable results.
const VALID_AUTH_MODES = ['WPAPSK', 'WPA2PSK', 'WPA3SAE', 'open', 'OWE']
const KEYLESS_AUTH_MODES = ['open', 'OWE']
const INVALID_CONNECTIVITY_MODES = ['Disconnected', 'NoTraffic']
const INVALID_ADDRESS_STATES = ['Duplicate', 'Invalid']

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
export const runPowershell = async (commands: string[]): Promise<string> => {
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

/** 
 * Configuration values for a networking profile.
 * 'wifiSsid' is empty for non-WiFi networks.
 * 'wifiKey' is empty for networks with no authentication. 
 * 'pingedBalenaApi' is true if able to ping balena API via this network; false is inconclusive.
 */
export interface ConnectionProfile {
	name: string;
	interfaceId: string;
	wifiSsid: string;
	wifiKey: string;
	pingedBalenaApi: boolean;
}

/** 
 * Attributes of a network connection useful for testing connectivity.
 * 'connectionType' categorizes the connection and can be a value like 'wifi'.
 * 'interfaceId' helps map a connection to a networking adapter.
 */
interface NetConnection {
	name: string;
	connectionType: string;
	interfaceId: string;
	hasIpv4: boolean;
	hasIpv6: boolean;
	ipAddress: string;
	isManualAddress: boolean;
}

/** 
 * Describes a column in a Powershell table. Positions refer to offset in a given 
 * line of the table.
 */
export interface Column {
	title: string;
	startPos: number;
	endPos: number
}


/** 
 * Read column positions from the header separator ('---') line. See the example below.
 * Does not validate column names.
 * 
 * ProfileName          SignalQuality  SecurityEnabled dot11DefaultAuthAlgorithm dot11DefaultCipherAlgorithm SSID
 * -----------          -------------  --------------- ------------------------- --------------------------- ----
 */
export const readColumns = (columns:Column[] = [], line = ''): void => {
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
 * Collect the list of available WiFi network profiles. Includes profile name, 
 * SSID, and key (passphrase) if any). Validates that we can ping balena API for
 * at least one currently connected network, identified by 'pingedBalenaApi'
 * attribute of profile.
 *
 * @return Array of WifiProfile found; empty if none
 */
export const collectProfiles = (psInstallPath: string): Promise<ConnectionProfile[]> => {
	// First get map of profile names and keys, and populate SSID.
	const wifiReader = new wifiProfileReader.ProfileReader(psInstallPath)
	const profiles = await wifiReader.collectProfiles()

	const connections = await this.readNetConnections()
	await this.readNetAdapters(profiles, connections)
	const profileMap = new Map<string, ConnectionProfile>()
	connectionProfiles.forEach(profile => profileMap.set(profile.interfaceId, profile))

	for (let connection of connections.values()) {
		if (connection.hasIpv4 || connection.hasIpv6) {
			await this.readIpAddress(connection)
			// Not presently accepting manually generated IP addresses
			if (connection.ipAddress && !connection.isManualAddress) {
				let p = profileMap.get(connection.interfaceId)
				if (p) {
					p.pingedBalenaApi = await this.pingApi(connection)
					// Only require one successful ping
					if (p.pingedBalenaApi) {
						break
					}
				} else {
					// unexpected; readNetConnections() already validates profile name
					console.log(`collectWifiProfiles: Can't find profile ${connection.profileName} for network connection`)
				}
			}
		}
	}
	// convert iterator to array
	const pArray:WifiProfile[] = []
	profiles.forEach((value,key,map) => {pArray.push(value)})
	return pArray
}

/** Sends a ping request to balena API. Returns true on success. */
const pingApi = async (connection: NetConnection): Promise<boolean> => {
	const options = {
		localAddress: connection.ipAddress
	}
	debug(`pingApi: sending request from address ${options.localAddress}`)
	const response = await got('https://api.balena-cloud.com/ping')
	debug(`pingApi: response code: ${response.statusCode}`)
	return response.statusCode == 200
}

/** 
 * Reads the IP address for a network connection and updates the connection object 
 * with this value. The connection must have either IPv4 or IPv6 connectivity.
 * Prefers IPv4 address if connection has both IPv4 and IPv6 connectivity. Also 
 * validates reported state of address via INVALID_ADDRESS_STATES.
 */
const readIpAddress = async (connection: NetConnection): Promise<void> => {
	/* Retrieves output formatted like the example below.
	 * 
	 * PS > Get-NetIPAddress -InterfaceIndex 9 -AddressFamily IPv4 | Format-Table -Property IPAddress, AddressState, PrefixOrigin, SuffixOrigin
	 * 
	 * IPAddress     AddressState PrefixOrigin SuffixOrigin
	 * ---------     ------------ ------------ ------------
	 * 192.168.1.217    Preferred         Dhcp         Dhcp
	 */

	let commands = Array.from(this.setupCommands)
	commands.push(`Get-NetIPAddress -InterfaceIndex ${connection.interfaceIndex} -AddressFamily ${connection.hasIpv4 ? 'IPv4' : 'IPv6'}  ${PWSH_FORMAT_TABLE} -Property IPAddress, AddressState, PrefixOrigin, SuffixOrigin ${PWSH_OUTPUT_WIDTH}`)
	let listText = ''
	try {
		listText = await runPowershell(commands);
	} catch (error) {
		throw(`readIpAddress: ${error}`);
	}

	// define columns
	const columnNames = ['IPAddress', 'AddressState', 'PrefixOrigin', 'SuffixOrigin']
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
			debug(`readIpAddress: ${line}`)
			let index = columnNames.indexOf('IPAddress')
			const ipAddress = line.substring(columns[index].startPos, columns[index].endPos).trim()
			if (!ipAddress) {
				// Probably a blank line at end of output
				continue
			}
			// Ensure address state is valid before saving the address.
			index = columnNames.indexOf('AddressState')
			const addressState = line.substring(columns[index].startPos, columns[index].endPos)
			if (INVALID_ADDRESS_STATES.includes(addressState)) {
				continue
			}
			connection.ipAddress = ipAddress
			index = columnNames.indexOf('PrefixOrigin')
			const prefixOrigin = line.substring(columns[index].startPos, columns[index].endPos).trim()
			index = columnNames.indexOf('SuffixOrigin')
			const suffixOrigin = line.substring(columns[index].startPos, columns[index].endPos).trim()
			connection.isManualAddress = (prefixOrigin == 'Manual' || suffixOrigin == 'Manual')
			if (connection.isManualAddress) {
				debug(`IP address ${ipAddress} generated manually`)
			}
		}
	}
}

/** 
 * Queries for the active network connection, if any, for each profile in the 
 * provided Map. Uses INVALID_CONNECTIVITY_MODES to qualify connection state
 * for IPv4 (hasIpv4) and IPv6 (hasIpv6). Generates a map that associates a 
 * profile with the network connection.
 *
 * @return Map of NetConnection found, keyed on profile name; empty if none
 */
const readNetAdapters = async (profiles: Map<string,ConnectionProfile>, connections: Map<string,NetConnection>): Promise<void> => {
	/* Retrieves output formatted like the example below.
	 * 
	 * PS > Get-NetAdapter | Format-Table -Property ifIndex, PhysicalMediaType, MediaConnectionState
	 * 
	 * ifIndex PhysicalMediaType MediaConnectionState
	 * ------- ----------------- --------------------
	 *      13 802.3                        Connected
	 *      12 BlueTooth                 Disconnected
	 *       9 Native 802.11                Connected
	 */

	let commands = Array.from(this.setupCommands)
	commands.push(`Get-NetAdapter ${PWSH_FORMAT_TABLE} -Property ifIndex, PhysicalMediaType, MediaConnectionState ${PWSH_OUTPUT_WIDTH}`)
	let listText = ''
	try {
		listText = await runPowershell(commands);
	} catch (error) {
		throw(`readNetAdapters: ${error}`);
	}

	// define columns
	const columnNames = ['ifIndex', 'PhysicalMediaType', 'MediaConnectionState']
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
			// Find connection
			let index = columnNames.indexOf('ifIndex')
			const ifIndex = line.substring(columns[index].startPos, columns[index].endPos).trim()
			if (!ifIndex) {
				continue
			}
			const connection = connections.get(ifIndex)
			if (connection == undefined) {
				debug(`readNetAdapters: Can't find interfaceIndex named ${ifIndex}`)
				continue
			}

			debug(`readNetAdapters: ${line}`)
			index = columnNames.indexOf('PhysicalMediaType')
			const mediaType = line.substring(columns[index].startPos, columns[index].endPos).trim()
			index = columnNames.indexOf('MediaConnectionState')
			const connectionState = line.substring(columns[index].startPos, columns[index].endPos).trim()
			const isConnected = (connectionState == 'Connected')

			if (isConnected && mediaType.includes('802.11')) {
				connection.connectionType = 'wifi'
				// find profile
				const profile = profiles.get(connection.name)
				if (profile == undefined) {
					debug(`readNetAdapters: Can't find profile named ${connection.name}`)
					continue
				}
				profile.interfaceId = ifIndex
			}
		}
	}
}

/** 
 * Queries for the active network connection, if any, for each profile in the 
 * provided Map. Uses INVALID_CONNECTIVITY_MODES to qualify connection state
 * for IPv4 (hasIpv4) and IPv6 (hasIpv6). Generates a map that associates a 
 * profile with the network connection.
 *
 * @return Map of NetConnection found, keyed on profile name; empty if none
 */
const readNetConnections = async (): Promise<Map<string,NetConnection>> => {
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
		throw(`readNetConnections: ${error}`);
	}

	// define columns
	const columnNames = ['Name', 'InterfaceIndex', 'IPv4Connectivity', 'IPv6Connectivity']
	const columns:Column[] = columnNames.map(name => ({title: name, startPos: 0, endPos: 0}))

	let connections = new Map<string, NetConnection>()

	let foundHeader = false
	for (let line of listText.split('\n')) {
		if (!columns[0].endPos) {
			if(line.indexOf('-----') >= 0) {
				this.readColumns(columns, line)
			} else {
				continue
			}
		} else {
			let connection = {name: name, connectionType: '', interfaceId: '', hasIpv4: false, hasIpv6: false, ipAddress: '', isManualAddress: false }
			debug(`readNetConnections: ${line}`)
			let index = columnNames.indexOf('Name')
			const name = line.substring(columns[index].startPos, columns[index].endPos).trim()
			if (!name) {
				// name is blank
				continue
			}
			index = columnNames.indexOf('InterfaceIndex')
			const interfaceIndex = line.substring(columns[index].startPos, columns[index].endPos).trim()
			connection.interfaceId = interfaceIndex
			index = columnNames.indexOf('IPv4Connectivity')
			const ipv4Connectivity = line.substring(columns[index].startPos, columns[index].endPos).trim()
			connection.hasIpv4 = !INVALID_CONNECTIVITY_MODES.includes(ipv4Connectivity)
			index = columnNames.indexOf('IPv6Connectivity')
			const ipv6Connectivity = line.substring(columns[index].startPos, columns[index].endPos).trim()
			connection.hasIpv6 = !INVALID_CONNECTIVITY_MODES.includes(ipv6Connectivity)
			connections.set(interfaceIndex, connection)
		}
	}
	return connections
}

