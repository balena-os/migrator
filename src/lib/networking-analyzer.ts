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
import { tmp, migrator } from 'etcher-sdk';

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
 * Runs a Powershell script.
 * 
 * Localization considerations: We recommend that Powershell commands request the
 * response formatted as a table, and the required columns for the response are
 * specified explicitly. You then may use the readColumns() function to parse the
 * output columns, which avoids actually reading the returned column headings
 * because the request explicitly specified the name and order of the columns.
 * 
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
 * 'wifiAuthType' enum for authentication type, like WPA3_SAE for WPA3-Personal
 * 'wifiKey' is empty for networks with no authentication. 
 * 'ifaceId' identifies the network interface associated with the profile; 
 *           foreign key into Analyzer connMap entries
 * 'isConnected' identifies this profile as currently connected on the interface 'ifaceId'
 */
export interface ConnectionProfile {
	name: string;
	wifiSsid: string;
	wifiAuthType: migrator.WifiAuthType;
	wifiKey: string;
	ifaceId: string;
	isConnected: boolean;
}

/** 
 * Attributes of a network adapter/interface/connection useful for testing connectivity.
 * 'ifaceType' categorizes the connection; 'wifi' or 'ethernet'
 * 'ifaceId' provides a unique handle for an adapter/interface
 * 'ifaceName' Windows user-facing name for the adapter/interface, like "Wi-Fi"
 * 'deviceId' is the OS/hardware device identifier for the adapter/interface
 * 'name' Windows user-facing name for an active connection; uses same name as WiFi ssid
 * 'hasIpv4' if connection is using IPv4 networking
 * 'hasIpv6' if connection is using IPv6 networking
 * 'ipAddress' used by a connection
 * 'isManualAddress' if address was assigned manually
 */
interface NetConnectivity {
	ifaceType: string;
	ifaceId: string;
	ifaceName: string;
	deviceId: string;
	name: string;
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
 * Properties to alter how the analyzer operates.
 * 
 * includeWifi: Look for WiFi network configurations, and test API connectivity if present; default true
 */
export interface AnalyzerOptions {
	includeWifi?: boolean
}

/** 
 * Read column positions from the header separator ('---') line. See the example below.
 * Does not validate column names to avoid localization issues. We assume that the
 * column names can be specified in English for the query, regardless of the output
 * language used in the response.
 * 
 * Name          SignalQuality  SecurityEnabled dot11DefaultAuthAlgorithm dot11DefaultCipherAlgorithm SSID
 * ----          -------------  --------------- ------------------------- --------------------------- ----
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
 * to collect the information. Provides profile information for Etcher SDK, and a
 * test for network connectivity to balena API.
 * 
 * Example use:
 *   const analyzer = new Analyzer('')
 *   await analyzer.run()
 *   const profiles = analyzer.getProfiles()
 *   const connection = await analyzer.testApiConnectivity()
 */
export class Analyzer {
	/** Map of active connections, keyed on interface ID */
	private connMap: Map<string,NetConnectivity> = new Map<string,NetConnectivity>()
	/** WiFi/Ethernet profiles collected from each interface */
	private profiles: ConnectionProfile[] = []
	private psModulePath = ''
	private options: AnalyzerOptions = { includeWifi: true }

	/** 
	 * @param modulePath If using a built-in module path, leave modulePath empty. Otherwise this path
	 * will be added to the Powershell module page for the WiFiProfileManagement module.
	 * @param options Optional properties to alter how the analyzer operates; otherwise uses defaults
	 */
	constructor(modulePath = '', options:AnalyzerOptions = {}) {
		this.psModulePath = modulePath
		if (options) {
			this.options = Object.assign(this.options, options)
		}
	}

	/**
	 * Runs the analyzer. Collects networking profiles, which are passed to Etcher SDK
	 * to be written for balenaOS. Also collects connectivity data for testing connectivity
	 * to balena API.
	 * 
	 * Must call this method before other public methods.
	 */
	public async run(): Promise<void> {
		this.connMap = new Map<string, NetConnectivity>()
		// Must call these helper functions in this order.
		// Creates entries in 'connMap' for active connections
		await this.readNetAdapters()
		await this.readNetConnections()

		if (this.options.includeWifi) {
			const wifiReader = new wifiProfileReader.ProfileReader(this.psModulePath)
			// Collect profiles for each interface. Profile names may be duplicated across interfaces.
			for (let connection of this.connMap.values()) {
				if (connection.ifaceType == 'wifi') {
					const connProfiles = await wifiReader.collectProfiles(connection.ifaceName)
					connProfiles.forEach(p => p.ifaceId = connection.ifaceId)
					this.profiles.push(...connProfiles)
				}
			}
			// Match WiFi connection to profile by interface and SSID
			await this.readWlanInterfaces()
		}

		// Adds a profile for 802.3 ethernet connections for consistency with WiFi
		for (let connection of this.connMap.values()) {
			if (connection.ifaceType == 'ethernet') {
				const profile = { name: connection.name, wifiSsid: '', wifiAuthType: migrator.WifiAuthType.NONE, 
						wifiKey: '', ifaceId: connection.ifaceId, isConnected: true}
				this.profiles.push(profile)
			}
		}
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
				const profile = this.profiles.find(p => p.ifaceId == connection.ifaceId && p.isConnected)
				if (profile == undefined) {
					debug(`testApiConnectivity: Can't find connected profile for interface ${connection.ifaceId}`)
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
			console.log(`balena API not reachable from ${connection.name} (${connection.ifaceType}): ${error}`)
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
				//debug(`readIpAddress: ${line}`)
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
					// Don't accept manual/static address
					debug(`IP address ${ipAddress} generated manually; not usable`)
				} else {
					// May be multiple addresses; just use the first acceptable one.
					break
				}
			}
		}
	}

	/**
	 * Matches connection/interface/adapter to a connection profile via GUID
	 * for the adapter to SSID for the profile. Requires that the key/title for the
	 * "GUID" and "SSID" rows match those names exactly, so possibly subject to
	 * localization changes. Requires use of a legacy 'netsh' command, whose output
	 * cannot be formatted with the flexibility of a Powershell command.
	 */
	private async readWlanInterfaces(): Promise<void> {
		/* Retrieves output formatted like the example below. netsh is the only
		 * tool to link a WiFi profile to a network connection; no native Powershell command.
		 * 
		/* PS > (netsh wlan show interfaces)
		 *
		 * There is 1 interface on the system:
		 *
		 *    Name                   : Wi-Fi
		 *    Description            : Intel(R) Wireless-AC 9560 160MHz
		 *    GUID                   : 99d15e59-1ff4-4308-af12-4204ef73b20d
		 *    Physical address       : 54:8d:5a:65:1b:52
		 *    State                  : connected
		 *    SSID                   : gal47lows
		 *    BSSID                  : c0:4a:00:9a:71:9d
		 *    Network type           : Infrastructure
		 *    Radio type             : 802.11n
		 *    Authentication         : WPA2-Personal
		 *    Cipher                 : CCMP
		 *    Connection mode        : Auto Connect
		 *    Channel                : 6
		 *    Receive rate (Mbps)    : 144.4
		 *    Transmit rate (Mbps)   : 144.4
		 *    Signal                 : 82%
		 *    Profile                : gal47lows
		 *
		 *    Hosted network status  : Not available
		 */

		let commands:string[] = []
		commands.push(`(netsh wlan show interfaces)`)
		let listText = ''
		try {
			listText = await runPowershell(commands);
		} catch (error) {
			throw(`readWlanInterfaces: ${error}`);
		}

		// Assume that multiple interfaces are separated by a blank line.
		// Within an interface there is a GUID line and an SSID line.
		// When both GUID and SSID are found, match with profile.
		let guid = ''
		let ssid = ''
		for (let line of listText.split('\n')) {
			//debug(`line: ${line}`)
			const guidMatch = line.match(/^\s+GUID\s+:\s([0-9a-fA-F\-]+)/)
			if (guidMatch) {
				guid = guidMatch[1].toUpperCase()
			} else {
				// characters for SSID are arbitrary; just read rest of line
				const ssidMatch = line.match(/^\s+SSID\s+:\s(.+)/)
				if (ssidMatch) {
					ssid = ssidMatch[1]
				}
			}
			if (guid && ssid) {
				// match connection to profile
				for (const conn of this.connMap.values()) {
					if (conn.ifaceType == 'wifi' && conn.deviceId == guid) {
						const profile = this.profiles.find(p => p.ifaceId == conn.ifaceId && p.wifiSsid == ssid)
						if (profile == undefined) {
							debug(`readWlanInterfaces: Can't find profile for SSID ${ssid} on interface ${conn.ifaceName}`)
							continue
						}
						profile.isConnected = true
						debug(`readWlanInterfaces: Matched connection ${conn.name} on interface ${conn.ifaceName} to profile SSID: ${ssid}`)
						break
					}
				}
				guid = ''
				ssid = ''
			} else {
				// May find a GUID without an SSID (not connected), so must blank
				// at end of interface.
				const blankMatch = line.match(/^\s*$/)
				if (blankMatch) {
					guid = ''
					ssid = ''
				}
			}
		}
	}

	/** 
	 * Reads network interfaces/adapters for the computer, and adds interfaces with
	 * an active connection to 'connMap'. Disregards interfaces without an active
	 * connection.
	 */
	private async readNetAdapters(): Promise<void> {
		/* Retrieves output formatted like the example below.
		 * 
		 * PS > Get-NetAdapter | Format-Table -Property ifIndex, PhysicalMediaType, MediaConnectionState, Name, DeviceID
		 * 
		 * ifIndex PhysicalMediaType MediaConnectionState Name                         DeviceID
		 * ------- ----------------- -------------------- ----                         --------
		 *      13 802.3                     Disconnected Ethernet                     {C79407AC-16DA-4EF6-9459-BF82522FB452}
		 *      12 BlueTooth                 Disconnected Bluetooth Network Connection {B0F7EB96-706B-4905-A56E-6C084AF169A7}
		 *       9 Native 802.11                Connected Wi-Fi                        {99D15E59-1FF4-4308-AF12-4204EF73B20D}
		 
		 */

		let commands:string[] = []
		commands.push(`Get-NetAdapter ${PWSH_FORMAT_TABLE} -Property ifIndex, PhysicalMediaType, MediaConnectionState, Name, DeviceID ${PWSH_OUTPUT_WIDTH}`)
		let listText = ''
		try {
			listText = await runPowershell(commands);
		} catch (error) {
			throw(`readNetAdapters: ${error}`);
		}

		// define columns
		const columnNames = ['ifIndex', 'PhysicalMediaType', 'MediaConnectionState', 'Name', 'DeviceID']
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
				//debug(`readNetAdapters: ${line}`)
				// Create connection
				let index = columnNames.indexOf('ifIndex')
				const ifIndex = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (!ifIndex) {
					// probably blank line
					continue
				}
				let connection = {ifaceType: '', ifaceId: ifIndex, ifaceName: '', deviceId: '', name: '', hasIpv4: false, hasIpv6: false, ipAddress: '', isManualAddress: false }

				index = columnNames.indexOf('MediaConnectionState')
				const connectionState = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (connectionState != 'Connected') {
					debug(`readNetAdapters: Not considering unconnected interfaceIndex ${ifIndex}`)
					continue
				}

				index = columnNames.indexOf('PhysicalMediaType')
				const mediaType = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (mediaType.includes('802.11')) {
					connection.ifaceType = 'wifi'
				} else if (mediaType.includes('802.3')) {
					connection.ifaceType = 'ethernet'
				} else {
					console.log(`Not considering connection of type ${mediaType}`)
					continue
				}
				this.connMap.set(ifIndex, connection)
				debug(`readNetAdapters: Created connection for interfaceIndex ${ifIndex}`)

				index = columnNames.indexOf('Name')
				const ifaceName = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.ifaceName = ifaceName
				index = columnNames.indexOf('DeviceID')
				const deviceId = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (deviceId && deviceId.charAt(0) == '{' && deviceId.charAt(deviceId.length-1) == '}') {
					connection.deviceId = deviceId.substring(1, deviceId.length-1).toUpperCase()
				} else {
					connection.deviceId = deviceId.toUpperCase()
				}
			}
		}
	}

	/** 
	 * Updates connections with connection name and IP connectivity attributes.
	 */
	private async readNetConnections(): Promise<void> {
		/* Retrieves output formatted like the example below.
		 * 
		 * PS > Get-NetConnectionProfile | Format-Table -Property InterfaceIndex, Name, IPv4Connectivity, IPv6Connectivity
		 * 
		 * InterfaceIndex Name      IPv4Connectivity IPv6Connectivity
		 * -------------- ----      ---------------- ----------------
		 *              9 gal47lows          Internet        NoTraffic
		 */

		let commands:string[] = []
		commands.push(`Get-NetConnectionProfile ${PWSH_FORMAT_TABLE} -Property InterfaceIndex, Name, IPv4Connectivity, IPv6Connectivity ${PWSH_OUTPUT_WIDTH}`)
		let listText = ''
		try {
			listText = await runPowershell(commands);
		} catch (error) {
			throw(`readNetConnections: ${error}`);
		}

		// define columns
		const columnNames = ['InterfaceIndex', 'Name', 'IPv4Connectivity', 'IPv6Connectivity']
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
				//debug(`readNetConnections: ${line}`)
				let index = columnNames.indexOf('InterfaceIndex')
				const ifIndex = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (!ifIndex) {
					// probably blank line
					continue
				}
				const connection = this.connMap.get(ifIndex)
				if (connection == undefined) {
					debug(`readNetConnections: Can't find interfaceIndex ${ifIndex}`)
					continue
				}

				index = columnNames.indexOf('Name')
				const name = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.name = name
				index = columnNames.indexOf('IPv4Connectivity')
				const ipv4Connectivity = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.hasIpv4 = !INVALID_CONNECTIVITY_MODES.includes(ipv4Connectivity)
				index = columnNames.indexOf('IPv6Connectivity')
				const ipv6Connectivity = line.substring(columns[index].startPos, columns[index].endPos).trim()
				connection.hasIpv6 = !INVALID_CONNECTIVITY_MODES.includes(ipv6Connectivity)
			}
		}
	}
}
