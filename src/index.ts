import {run, Args, Command, Flags} from '@oclif/core';
// Must use CommonJS version of inquirer due to limitations of vercel/pkg.
import * as inquirer from 'inquirer';
import { migrator } from 'etcher-sdk';
import * as wifiProfileReader from './wifi-profile-reader.spec'

export default class Migrator extends Command {
	static description = 'Migrate this device to balenaOS';

	static examples = [
		'migrator -i \\Users\\John\\balena-flasher.img',
	];

	static flags = {
		image: Flags.string({
			char: 'i',
			required: true,
			description: "balenaOS image path name",
		}),
		'non-interactive': Flags.boolean({
			char: 'y',
			default: false,
			description: "no user input; use defaults"
		}),
		analyze: Flags.boolean({
			default: false,
			exclusive: ['last-task', 'skip-tasks'],
			description: "only analyze work to do; don't modify computer",
		}),
		'last-task': Flags.string({
			// See etcher-sdk migrate() function for list of valid tasks.
			// Presently this option is for development/debugging only.
			// Tasks are executed in order, 'analyze,shrink,copy,bootloader,reboot'.
			default: '',
			hidden: true,
			exclusive: ['skip-tasks'],
			description: "make this task the last to perform"
		}),
		'skip-tasks': Flags.string({
			// See etcher-sdk migrate() function for list of valid tasks.
			// Use some separator character between tasks, like a comma.
			// Unless you really want to skip a task out of sequence, just use
			// 'last-task' -- it's simpler.
			// Presently this option is for development/debugging only.
			default: '',
			hidden: true,
			description: "don't perform these tasks"
		}),
	};
	static args = {};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Migrator)
		const winPartition = "C";
		const deviceName = "\\\\.\\PhysicalDrive0";
		const efiLabel = "M";

		if (!flags['non-interactive'] && !flags.analyze) {
			console.log("Warning! This tool will overwrite the operating system and all data on this computer.");
			let responses: any = await inquirer.prompt([{
				name: 'continue',
				message: "Continue with migration?",
				type: 'confirm',
				default: false,
			}]);
			if (!responses.continue) {
				return;
			}
		}

		if (flags.analyze) {
			// Migrator API requires skip-tasks, so convert.
			flags['last-task'] = 'analyze'
		}
		if (flags['last-task']) {
			// Migrator API requires skip-tasks, so convert. Build list from last to first.
			let foundTask = false
			for (const task of ['reboot', 'bootloader', 'copy', 'shrink', 'analyze']) {
				if (flags['last-task'] == task) {
					foundTask = true
					break
				}
				flags['skip-tasks'] = task + ',' + flags['skip-tasks']
			}
			if (!foundTask) {
				throw Error(`last-task option '${flags['last-task']}' not understood`)
			}
		}
		const options = { omitTasks: flags['skip-tasks'] }

		// Check for WiFi networks to be configured.
		const psInstallPath = `${process.cwd()}\\modules`
		const wifiReader = new wifiProfileReader.ProfileReader(psInstallPath)
		const wifiProfiles = await wifiReader.collectWifiProfiles()
		console.log(`\nFound WiFi profiles: ${wifiProfiles.length ? wifiProfiles.map(p => p.name) : "<none>"}`)
		// just using the first one for now
		//const wifiProfile:wifiProfileReader.WifiProfile = wifiProfiles ? wifiProfiles[0] : {name: '', key: ''}

		migrator.migrate(flags.image, winPartition, deviceName, efiLabel, options)
			.then(console.log)
			.catch(console.log);
	}
}
