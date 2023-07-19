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

import * as _debug from 'debug';
import { ConnectionProfile, Column, readColumns, runPowershell, PWSH_FORMAT_TABLE, 
	PWSH_OUTPUT_WIDTH } from './networking-analyzer';
import { migrator } from '@kb2ma/etcher-sdk';

const debug = _debug('migrator:wifi-profile-reader');
const MODULE_NAME = 'WiFiProfileManagement'
// These collections are used to qualify acceptable results. 'open' means no authentication.
const KEYLESS_AUTH_MODES = ['open']

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
	 * Collect the list of available WiFi network profiles. Includes profile name, 
	 * SSID, and key (passphrase) if any. Validates that we can ping balena API for
	 * at least one currently connected network.
	 *
	 * @return Array of WifiProfile found; empty if none
	 */
	public async collectProfiles(): Promise<ConnectionProfile[]> {
		// First get map of profile names and keys, and populate SSID.
		const profiles = await this.readProfiles()
		await this.readAvailableSsid(profiles)
		// If WiFi network for a profile is not available, assume SSID matches profile name.
		for (let p of profiles.values()) {
			if (!p.wifiSsid) {
				p.wifiSsid = p.name
			}
		}

		// convert map iterator to array
		const pArray:ConnectionProfile[] = []
		profiles.forEach((value,key,map) => {pArray.push(value)})
		return pArray
	}

	/** 
	 * Reads the SSID from available WiFi networks for each profile in the provided list 
	 * and updates the ssid property.
	 */
	private async readAvailableSsid(profileMap: Map<string,ConnectionProfile>) {
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
			throw(`readAvailableSsid: ${error}`);
		}

		// define columns
		const columnNames = ['ProfileName', 'SignalQuality', 'SecurityEnabled', 'dot11DefaultAuthAlgorithm', 'dot11DefaultCipherAlgorithm', 'SSID']
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
				// Find profile
				let index = columnNames.indexOf('ProfileName')
				const name = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (!name) {
					// name is blank
					continue
				}
				const profile = profileMap.get(name)
				if (profile == undefined) {
					debug(`readAvailableSsid: Can't find profile for profile ${name}`)
					continue
				}

				//debug(`readAvailableSsid: ${line}`)
				index = columnNames.indexOf('SSID')
				const ssid = line.substring(columns[index].startPos, columns[index].endPos).trim()
				profile.wifiSsid = ssid
			}
		}
	}

	/**
	 * Reads the table of WiFi profiles for this computer and returns acceptable
	 * profiles based on VALID_AUTH_MODES.
	 *
	 * @return Map of WifiProfile found, keyed on profile name; empty if none
	 */
	private async readProfiles(): Promise<Map<string,ConnectionProfile>> {
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

		let profileMap = new Map<string, ConnectionProfile>()
		for (let line of listText.split('\n')) {
			if (!columns[0].endPos) {
				if(line.indexOf('-----') >= 0) {
					readColumns(columns, line)
				} else {
					continue
				}
			} else {
				let profile:ConnectionProfile = { name: '', wifiSsid: '', wifiAuthType: migrator.WifiAuthType.NONE, wifiKey: '', ifaceId: ''}
				let index = columnNames.indexOf('ProfileName')
				const name = line.substring(columns[index].startPos, columns[index].endPos).trim()
				if (!name) {
					// skip blank lines, etc.
					continue
				}
				profile.name = name

				index = columnNames.indexOf('Authentication')
				const auth = line.substring(columns[index].startPos, columns[index].endPos).trim()
				//debug(`readWifiprofileMap: ${line}`)
				switch (auth) {
					case 'open':
						profile.wifiAuthType = migrator.WifiAuthType.NONE
						break
					case 'WPA2PSK':
						profile.wifiAuthType = migrator.WifiAuthType.WPA2_PSK
						break
					case 'WPA3SAE':
						profile.wifiAuthType = migrator.WifiAuthType.WPA3_SAE
						break
					default:
						console.log(`WiFi profile ${profile.name} with auth ${auth} not supported`)
						continue
				}
				index = columnNames.indexOf('Password')
				const password = line.substring(columns[index].startPos, columns[index].endPos).trim()
				profile.wifiKey = password
				if (!profile.wifiKey && !KEYLESS_AUTH_MODES.includes(auth)) {
					debug(`Rejected WiFi profile ${profile.name} with auth ${auth} but no passphrase`)
				} else {
					profileMap.set(profile.name, profile)
				}
			}
		}
		return profileMap
	}
}
