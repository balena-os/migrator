import {Command, Flags} from '@oclif/core';
// Must use CommonJS version of inquirer due to limitations of vercel/pkg.
import * as inquirer from 'inquirer';
import { migrator } from '@kb2ma/etcher-sdk';
import { Analyzer, ConnectionProfile } from '../../lib/networking-analyzer'

export default class AnalyzerCommand extends Command {
	static description = 'Analyze migration of this device to balenaOS';

	static examples = [
		'migrator analyze -i \\Users\\John\\balena-flasher.img',
	];

	static flags = {
		image: Flags.string({
			char: 'i',
			required: true,
			description: "balenaOS image path name",
		}),
	};
	static args = {};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(AnalyzerCommand)
		const winPartition = "C";
		const deviceName = "\\\\.\\PhysicalDrive0";
		const efiLabel = "M";

		const skipTasks = 'shrink,copy,config,bootloader,reboot'
		const options:migrator.MigrateOptions = { omitTasks: skipTasks, connectionProfiles: []}

		// Run a networking analyzer
		const psInstallPath = `${process.cwd()}\\modules`
		const analyzer = new Analyzer(psInstallPath)
		await analyzer.run()
		// Collect WiFi profiles
		const profiles = analyzer.getProfiles().filter(p => p.wifiSsid)
		console.log(`Found WiFi profiles: ${profiles.length ? profiles.map(p => " " + p.name) : "<none>"}`)
		profiles.forEach(p => options.connectionProfiles.push(p))

		// Verify at least one network interface can ping balena API.
		const connection = await analyzer.testApiConnectivity()
		if (!connection) {
			throw Error("balena API not reachable from any connected interface")
		}
		console.log(`balena API is reachable from ${connection.profileName} (${connection.ifaceType})\n`)

		//console.log(`${flags.image}, ${winPartition}, ${deviceName}, ${efiLabel}, ${options.omitTasks}`)
		migrator.migrate(flags.image, winPartition, deviceName, efiLabel, options)
			.then(console.log)
			.catch(console.log);
	}
}
