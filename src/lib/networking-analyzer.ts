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
import * as ipaddr from 'ipaddr.js';
import * as wifiProfileReader from './wifi-profile-reader'
import { tmp, migrator } from '@kb2ma/etcher-sdk';

const execFileAsync = promisify(execFile);
const debug = _debug('migrator:networking-analyzer');
// Must specify Powershell line output width to ensure output does not truncate.
export const PWSH_FORMAT_TABLE = '| Format-Table'
export const PWSH_OUTPUT_WIDTH = '| Out-String -Stream -Width 300'
// These collections are used to qualify acceptable results.
const INVALID_CONNECTIVITY_MODES = ['Disconnected', 'LocalNetwork', 'NoTraffic']
const INVALID_ADDRESS_STATES = ['Duplicate', 'Invalid']
/** Includes IPv6 fe80:, which is not routable. */
const INVALID_PREFIX_ORIGINS = ['WellKnown']
const INVALID_IPV6_RANGES = ['linkLocal', 'uniqueLocal']

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
	debug(`Powershell: ${commands.length ? commands[commands.length-1] : "none"}`)
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
 * Configuration attributes for a networking connection.
 * 'name' provided for WiFi and some non-WiFi profiles.
 * 'wifiSsid' is empty for non-WiFi networks.
 * 'wifiKey' is empty for networks with no authentication. 
 * 'ifaceId' identifies the network interface currently used by the profile; 
 *           useful but not really part of the configuration
 */
export interface ConnectionProfile {
	name: string;
	wifiSsid: string;
	wifiAuthType: migrator.WifiAuthType;
	wifiKey: string;
	ifaceId: string;
}

/** 
 * Attributes of a network adapter/interface/connection useful for testing connectivity.
 * 'ifaceType' categorizes the connection; 'wifi' or 'ethernet'.
 * 'ifaceId' provides a unique handle for an adapter/interface.
 * 'profileName' provides a Windows name for an active connection; uses same name as WiFi ssid
 * 'hasIpv4' if connection is using IPv4 networking
 * 'hasIpv6' if connection is using IPv6 networking
 * 'ipAddress' used by a connection
 * 'isManualAddress' if address was assigned manually
 */
interface NetConnectivity {
	ifaceType: string;
	ifaceId: string;
	profileName: string;
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
				//debug(`readColumns: col ${i}: ${columns[i].startPos}, ${columns[i].endPos}`)
			} else {
				throw Error(`readColumns: Only found ${i} columns.`)
			}
		} else {
			columns[i].endPos = linePos
			//debug(`readColumns: col ${i}: ${columns[i].startPos}, ${columns[i].endPos}`)
			linePos += 1 // advance past space to next column
		}
	}
}

/**
 * Analyzes networking connectivity. Always call run() first. Uses Powershell modules
 * to collect the information.
 * 
 * Example use:
 *   const analyzer = new Analyzer('')
 *   await analyzer.run()
 *   const profiles = analyzer.getProfiles()
 *   const connection = await analyzer.testApiConnectivity()
 */
export class Analyzer {
	/** Map keyed on interface ID */
	private connMap: Map<string,NetConnectivity> = new Map<string,NetConnectivity>()
	private profiles: ConnectionProfile[] = []
	private psModulePath = ''

	/** 
	 * If using a built-in module path, leave modulePath empty. Otherwise this path
	 * will be added to the Powershell module page for the WiFiProfileManagement module.
	 */
	constructor(modulePath = '') {
		this.psModulePath = modulePath
	}

	/**
	 * Runs the analyzer. Collect networking profiles and connectivity data. Must
	 * call this before other public methods.
	 */
	public async run(): Promise<void> {
		const wifiReader = new wifiProfileReader.ProfileReader(this.psModulePath)
		this.profiles = await wifiReader.collectProfiles()

		this.connMap = new Map<string, NetConnectivity>()
		// Must call these helper functions in this order.
		await this.readNetConnections()
		await this.readNetAdapters()
	}

	/**
	 * Provides the list of available network profiles. Includes profile name, 
	 * and WiFi SSID and key (passphrase) if any. May also include a profile for
	 * an ethernet based connection.
	 *
	 * @return Array of ConnectionProfile found; empty if none
	 */
	public getProfiles(): ConnectionProfile[] {
		return this.profiles
	}

	/**
	 * Validates that at least one currently connected network interface with a
	 * networking profile can ping balena API.
	 *
	 * @return Connection used to reach the API
	 */
	public async testApiConnectivity(): Promise<NetConnectivity | null> {
		for (let connection of this.connMap.values()) {
			if (connection.hasIpv4 || connection.hasIpv6) {
				await this.readIpAddress(connection)
				if (!connection.ipAddress) {
					continue
				}
				if (connection.isManualAddress) {
					console.log(`Ignoring connection with manual address ${connection.ipAddress}`)
					continue
				}
				// Sanity check; there should be a profile for this connection, 
				// including for DHCP ethernet.
				const profile = this.profiles.find(p => p.ifaceId == connection.ifaceId)
				if (profile == undefined) {
					debug(`testApiConnectivity: Can't find profile for interface ${connection.ifaceId}`)
					continue
				}
				const pingOk = await this.pingApi(connection)
				if (pingOk) {
					// Only require ping to one connection
					return connection
				}
			}
		}
		return null
	}

	/** Sends a ping request to balena API. Returns true on success. */
	private async pingApi(connection: NetConnectivity): Promise<boolean> {
		const options = {
			localAddress: connection.ipAddress
		}
		debug(`pingApi: sending request from address ${options.localAddress}`)

		try {
			const response = await got('https://api.balena-cloud.com/ping', options)
			debug(`pingApi: response code: ${response.statusCode}`)
			return response.statusCode == 200
		} catch (error) {
			console.log(`balena API not reachable from ${connection.profileName} (${connection.ifaceType}): ${error}`)
			return false
		}
	}

	/** 
	 * Reads the IP address for a network connection and updates the connection object 
	 * with this value. The connection must have either IPv4 or IPv6 connectivity.
	 * Prefers IPv6 address if connection has both IPv4 and IPv6 connectivity. Also 
	 * validates reported state of address via INVALID_ADDRESS_STATES.
	 */
	private async readIpAddress(connection: NetConnectivity): Promise<void> {
		/* Retrieves output formatted like the example below.
		 * 
		 * PS > Get-NetIPAddress -InterfaceIndex 9 -AddressFamily IPv4 | Format-Table -Property IPAddress, AddressState, PrefixOrigin, SuffixOrigin
		 * 
		 * IPAddress     AddressState PrefixOrigin SuffixOrigin
		 * ---------     ------------ ------------ ------------
		 * 192.168.1.217    Preferred         Dhcp         Dhcp
		 */

		let commands:string[] = []
		commands.push(`Get-NetIPAddress -InterfaceIndex ${connection.ifaceId} -AddressFamily ${connection.hasIpv6 ? 'IPv6' : 'IPv4'}  ${PWSH_FORMAT_TABLE} -Property IPAddress, AddressState, PrefixOrigin, SuffixOrigin ${PWSH_OUTPUT_WIDTH}`)
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
					readColumns(columns, line)
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
					debug(`IP address state ${addressState} not usable`)
					continue
				}
				// Ensure prefix is valid before saving the address.
				index = columnNames.indexOf('PrefixOrigin')
				const prefixOrigin = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (INVALID_PREFIX_ORIGINS.includes(prefixOrigin)) {
					debug(`IP address prefix ${prefixOrigin} not usable`)
					continue
				}
				// Ensure IPv6 address is globally routable.
				if (connection.hasIpv6) {
					try {
						const addr = ipaddr.parse(ipAddress)
						if (INVALID_IPV6_RANGES.includes(addr.range())) {
							debug(`IPv6 address ${ipAddress} range not usable`)
							continue
						}
					} catch (error) {
						debug(`IPv6 address ${ipAddress} not valid`)
						continue
					}
				}
				connection.ipAddress = ipAddress

				index = columnNames.indexOf('SuffixOrigin')
				const suffixOrigin = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.isManualAddress = (prefixOrigin == 'Manual' || suffixOrigin == 'Manual')
				if (connection.isManualAddress) {
					debug(`IP address ${ipAddress} generated manually`)
				} else {
					// May be multiple addresses; just use the first acceptable one.
					break
				}
			}
		}
	}

	/** 
	 * Uses the interface index to correlate a connection/interface/adapter to 
	 * a connection profile. Determines the type of interface -- WiFi or Ethernet.
	 * Updates internal 'connMap' and 'profiles'.
	 * Disregards interfaces that are not connected currently.
	 */
	private async readNetAdapters(): Promise<void> {
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

		let commands:string[] = []
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
					readColumns(columns, line)
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
				index = columnNames.indexOf('MediaConnectionState')
				const connectionState = line.substring(columns[index].startPos, columns[index].endPos).trim()
				const isConnected = (connectionState == 'Connected')
				if (!isConnected) {
					debug(`readNetAdapters: Not considering unconnected interfaceIndex ${ifIndex}`)
					// No need to 'continue' here; won't find connection below
				}
				const connection = this.connMap.get(ifIndex)
				if (connection == undefined) {
					debug(`readNetAdapters: Can't find interfaceIndex ${ifIndex}`)
					continue
				}

				debug(`readNetAdapters: ${line}`)
				index = columnNames.indexOf('PhysicalMediaType')
				const mediaType = line.substring(columns[index].startPos, columns[index].endPos).trim()

				let profile: ConnectionProfile | undefined
				if (mediaType.includes('802.11')) {
					connection.ifaceType = 'wifi'
					// Connection (Network) name may include a sequence number suffix, like "MySsid 2", so match
					// on start of network name.
					profile = this.profiles.find(p => connection.profileName.startsWith(p.name) && p.wifiSsid)
					if (profile == undefined) {
						debug(`readNetAdapters: Can't find profile named ${connection.profileName} for wifi`)
						continue
					}
					profile.ifaceId = ifIndex

				} else if (mediaType.includes('802.3')) {
					connection.ifaceType = 'ethernet'
					profile = this.profiles.find(p => connection.profileName.startsWith(p.name) && !p.wifiSsid)
					// sanity check; shouldn't happen
					if (profile) {
						debug(`readNetAdapters: Profile named ${connection.profileName} for ethernet already exists`)
						continue
					}
					profile = { name: connection.profileName, wifiSsid: '', wifiAuthType: migrator.WifiAuthType.NONE, wifiKey: '', ifaceId: ifIndex}
					this.profiles.push(profile)
					debug(`readNetAdapters: Collected profile named ${connection.profileName} for ethernet`)
				}
			}
		}
	}

	/** 
	 * Queries for active network connections, and adds them to this object's 'connMap'
	 */
	private async readNetConnections(): Promise<void> {
		/* Retrieves output formatted like the example below.
		 * 
		 * PS > Get-NetConnectionProfile | Format-Table -Property Name, InterfaceIndex, IPv4Connectivity, IPv6Connectivity
		 * 
		 * Name      InterfaceIndex IPv4Connectivity IPv6Connectivity
		 * ----      -------------- ---------------- ----------------
		 * gal47lows              9         Internet        NoTraffic
		 */

		let commands:string[] = []
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

		let foundHeader = false
		for (let line of listText.split('\n')) {
			if (!columns[0].endPos) {
				if(line.indexOf('-----') >= 0) {
					readColumns(columns, line)
				} else {
					continue
				}
			} else {
				debug(`readNetConnections: ${line}`)
				let index = columnNames.indexOf('Name')
				const name = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (!name) {
					// name is blank
					continue
				}
				let connection = {ifaceType: '', ifaceId: '', profileName: name, hasIpv4: false, hasIpv6: false, ipAddress: '', isManualAddress: false }
				index = columnNames.indexOf('InterfaceIndex')
				const ifaceIndex = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.ifaceId = ifaceIndex
				index = columnNames.indexOf('IPv4Connectivity')
				const ipv4Connectivity = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.hasIpv4 = !INVALID_CONNECTIVITY_MODES.includes(ipv4Connectivity)
				index = columnNames.indexOf('IPv6Connectivity')
				const ipv6Connectivity = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.hasIpv6 = !INVALID_CONNECTIVITY_MODES.includes(ipv6Connectivity)
				this.connMap.set(ifaceIndex, connection)
			}
		}
	}
}
