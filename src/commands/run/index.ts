import { Flags } from '@oclif/core';
// Must use CommonJS version of inquirer due to limitations of vercel/pkg.
import * as inquirer from 'inquirer';
import { migrator } from 'etcher-sdk';
import { Analyzer, ConnectionProfile } from '../../lib/networking-analyzer'
import { MigratorCommand } from '../../lib/migrator-command'
import * as debug from 'debug';

export default class RunCommand extends MigratorCommand {
	static description = 'Run migration of this device to balenaOS';

	static examples = [
		'migrator run -i \\Users\\John\\balena-flasher.img',
	];

	static flags = {
		image: Flags.string({
			char: 'i',
			required: true,
			description: "balenaOS image path name",
		}),
		'no-wifi': Flags.boolean({
			default: false,
			description: "do not migrate WiFi network configurations"
		}),
		'non-interactive': Flags.boolean({
			char: 'y',
			default: false,
			description: "no user input; use defaults"
		}),
		'last-task': Flags.string({
			// See etcher-sdk migrate() function for list of valid tasks.
			// Presently this option is for development/debugging only.
			// Tasks are executed in order, 'analyze,shrink,copy,config,bootloader,reboot'.
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
		'verbose': Flags.boolean({
			default: false,
			description: "display detailed output from operations"
		})
	};
	static args = {};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(RunCommand)
		const winPartition = "C";
		const deviceName = "\\\\.\\PhysicalDrive0";
		const efiLabel = "M";

		if (flags.verbose) {
			// avoid essentially trace level logging on the copy step
			debug.enable('*,-etcher:writer*,-rwmutex')
		}

		if (!flags['non-interactive']) {
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

		if (flags['last-task']) {
			// Migrator API requires skip-tasks, so convert. Build list from last to first.
			let foundTask = false
			for (const task of ['reboot', 'bootloader', 'config', 'copy', 'shrink', 'analyze']) {
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
		let options:migrator.MigrateOptions = { omitTasks: flags['skip-tasks'], connectionProfiles: []}

		try {
			// Run networking analyzer to collect profiles and validate connectivity.
			const psInstallPath = `${process.cwd()}\\modules`
			const analyzerOptions = { includeWifi: !flags['no-wifi'] }
			const analyzer = new Analyzer(psInstallPath, analyzerOptions)
			await analyzer.run()

			const profiles = await this.validateAnalyzer(analyzer)
			profiles.forEach(p => options.connectionProfiles.push(p))

			//console.log(`${flags.image}, ${winPartition}, ${deviceName}, ${efiLabel}, ${options.omitTasks}`)
			migrator.migrate(flags.image, winPartition, deviceName, efiLabel, options)
		} catch (error) {
			console.log("Can't proceed with migration:", error);
		}
	}
}
