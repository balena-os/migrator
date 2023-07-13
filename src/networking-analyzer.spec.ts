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
/** Includes IPv6 fe80:, which is not routable. */
const INVALID_PREFIX_ORIGINS = ['WellKnown']

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
	wifiKey: string;
	ifaceId: string;
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
}
