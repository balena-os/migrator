import {Command} from '@oclif/core';
import { Analyzer, ConnectionProfile } from './networking-analyzer'

export abstract class MigratorCommand extends Command {
	/**
	 * Validates a run of the analyzer. Ensures a network connection can reach balena
	 * API. Collects WiFi profiles and ensures profile name is unique. 
	 */
	async validateAnalyzer(analyzer: Analyzer): Promise<ConnectionProfile[]> {
		// Collect WiFi profiles
		let profiles = analyzer.getProfiles().filter(p => p.wifiSsid)
		console.log(`Found WiFi profiles: ${profiles.length ? profiles.map(p => " " + p.name) : "<none>"}`)

		// Verify at least one network interface can ping balena API.
		const connection = await analyzer.testApiConnectivity()
		if (!connection) {
			throw Error("balena API not reachable from any connected interface")
		}
		// Find profile/configuration for the verified connection for console output.
		const p = analyzer.getProfiles().find(p => p.ifaceId == connection.ifaceId && p.isConnected)
		if (p == undefined) {
			// We expect the testApiConnectivity() validates a profile exists, so
			// just being extra safe here.
			throw Error(`Can't find profile for connection ${connection.name}`)
		}
		console.log(`balena API is reachable from ${p.name} (${connection.ifaceType})\n`)

		// Ensure profile names are unique; may be duplicates across interfaces.
		// First, sort so equal names are sequential.
		let lastName = ''
		let seq = 0
		profiles.sort((a, b) => {return (a.name < b.name) ? -1 : (a.name == b.name) ? 0 : 1})
		for (let profile of profiles) {
			if (profile.name == lastName) {
				seq += 1
				profile.name = profile.name + seq
			} else {
				lastName = profile.name
				seq = 0
			}
		}

		return profiles
	}
}
