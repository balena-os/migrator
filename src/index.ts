import {run, Args, Command, Flags} from '@oclif/core';
// Must use CommonJS version of inquirer due to limitations of vercel/pkg.
import * as inquirer from 'inquirer';
import { migrator } from 'etcher-sdk';

export default class Migrator extends Command {
	static description = 'Migrate this device to balenaOS';

	static examples = [
		'> migrate \\Users\\Bob\\balenaos.img',
	];

	static args = {
		sourceImagePath: Args.string({description: 'balenaOS image path', required: true}),
	};

	static flags = {
		noninteractive: Flags.boolean({
			aliases: [ 'non-interactive' ],
			default: false,
		}),
	};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Migrator)
		const winPartition = "C";
		const deviceName = "\\\\.\\PhysicalDrive0";
		const efiLabel = "M";

		if (!flags.noninteractive) {
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
		migrator.migrate(args.sourceImagePath, winPartition, deviceName, efiLabel)
			.then(console.log)
			.catch(console.log);
	}
}
